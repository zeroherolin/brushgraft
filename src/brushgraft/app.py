"""HTTP API and the static web UI.

A local server still needs guarding: every image costs money, and any web page
open in the browser can send requests to 127.0.0.1. So:
  - the Host header is checked, which stops DNS rebinding;
  - /api needs the token: the browser first opens the ?token= link, and the UI
    trades it for an HttpOnly, SameSite=Strict cookie that cross-site requests
    don't carry; scripts can send an Authorization header instead.

Errors answer with ``{"detail", "code", "params"}``: ``detail`` is English,
``code`` and ``params`` let the UI show the message in the user's language.
"""

import asyncio
import json
import re
import secrets
import shutil
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import FastAPI, File, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Receive, Scope, Send

import promptbrush as pb

from brushgraft import __version__, archive, imaging
from brushgraft.config import Settings
from brushgraft.errors import NotFound, UserError
from brushgraft.events import EventBus
from brushgraft.jobs import JobRunner
from brushgraft.prompts import MAX_INSTRUCTION, MAX_PROMPT, MAX_REGIONS
from brushgraft.store import Store, new_id

STATIC_DIR = Path(__file__).parent / "static"
COOKIE = "brushgraft_token"
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "[::1]"})
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
# Body size limit, enforced before multipart parsing writes temp files
MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024
MAX_ARCHIVE_REQUEST_BYTES = archive.MAX_TOTAL_BYTES + 1024 * 1024
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
SIZE_PRESETS = ["1024x1024", "1536x1024", "1024x1536", "1600x1200",
                "1200x1600", "2048x1152", "1152x2048", "3840x2160", "auto"]
IMMUTABLE = {"Cache-Control": "private, max-age=31536000, immutable"}


def _error(status: int, code: str, message: str, **params: object) -> JSONResponse:
    return JSONResponse({"detail": message, "code": code, "params": params}, status)


def attachment(filename: str) -> str:
    """A Content-Disposition for a download named ``filename``, which may be in any language.

    HTTP headers are Latin-1, so a name in Chinese can't go in ``filename`` as it is: it goes in
    ``filename*`` encoded as UTF-8 (RFC 6266, which every current browser reads), with an ASCII
    stand-in in ``filename`` for anything older.
    """
    fallback = filename.encode("ascii", "replace").decode().replace("?", "_").replace('"', "_")
    if fallback == filename:
        return f'attachment; filename="{filename}"'
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------
Point = tuple[float, float]
# How a shape combines with the shapes before it in its region (see imaging.region_mask)
Op = Literal["add", "subtract", "intersect"]


class RectShape(BaseModel):
    type: Literal["rect"]
    x: float
    y: float
    w: float = Field(gt=0)
    h: float = Field(gt=0)
    op: Op = "add"


class EllipseShape(BaseModel):
    type: Literal["ellipse"]
    x: float
    y: float
    w: float = Field(gt=0)
    h: float = Field(gt=0)
    op: Op = "add"


class LassoShape(BaseModel):
    type: Literal["lasso"]
    points: list[Point] = Field(min_length=3, max_length=20000)
    op: Op = "add"


class BrushShape(BaseModel):
    type: Literal["brush"]
    points: list[Point] = Field(min_length=1, max_length=20000)
    radius: float = Field(gt=0, le=4000)
    op: Op = "add"


Shape = Annotated[RectShape | EllipseShape | LassoShape | BrushShape,
                  Field(discriminator="type")]


class Region(BaseModel):
    shapes: list[Shape] = Field(min_length=1, max_length=200)
    # compile_prompt checks the length of what is sent (trimmed), and names the field; this
    # only keeps an absurd body out
    instruction: str = Field("", max_length=4 * MAX_INSTRUCTION)


class JobIn(BaseModel):
    project_id: str
    parent_id: str | None = None
    prompt: str = Field("", max_length=4 * MAX_PROMPT)
    regions: list[Region] = Field([], max_length=MAX_REGIONS)
    refs: list[str] = Field([], max_length=8)
    model: str = Field(pb.DEFAULT_MODEL, min_length=1, max_length=100)
    size: str | None = Field(None, max_length=20)  # checked by JobRunner
    n: int = Field(1, ge=1, le=4)
    composite: bool = True
    lang: Literal["en", "zh"] = "en"  # language of the text wrapped around the prompt


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class AssetIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class AssetFromNode(BaseModel):
    node_id: str
    name: str = Field(min_length=1, max_length=100)


class FromAsset(BaseModel):
    asset_id: str


class NodePatch(BaseModel):
    starred: bool | None = None
    label: str | None = Field(None, max_length=200)
    use_raw: bool | None = None  # adopt the model's whole output, not the paste-back


class SettingsIn(BaseModel):
    api_key: str | None = Field(None, max_length=500)
    base_url: str | None = Field(None, max_length=500)


class SessionIn(BaseModel):
    token: str


# ---------------------------------------------------------------------------
# Access control
# ---------------------------------------------------------------------------
class _Guard:
    """Check the Host header, the request size and the access token.

    A plain ASGI middleware rather than @app.middleware: the latter can't
    cancel a streaming response (the event stream), which stalls shutdown.
    """

    def __init__(self, app: ASGIApp, token: str,
                 allowed_hosts: frozenset[str] | None):
        self.app = app
        self.token = token.encode()
        self.allowed_hosts = allowed_hosts

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        conn = HTTPConnection(scope)
        if self.allowed_hosts is not None:
            host = conn.headers.get("host", "")
            hostname = host if host.endswith("]") else host.rsplit(":", 1)[0]
            if hostname not in self.allowed_hosts:
                return await _error(403, "bad_host", "Host not allowed")(
                    scope, receive, send)
        path = conn.url.path
        length = conn.headers.get("content-length", "")
        archive_path = path in ("/api/projects/import", "/api/assets/import")
        limit = MAX_ARCHIVE_REQUEST_BYTES if archive_path else MAX_REQUEST_BYTES
        if length.isdigit() and int(length) > limit:
            if archive_path:
                return await _archive_too_large(path)(scope, receive, send)
            return await _upload_too_large(413)(scope, receive, send)
        if path.startswith("/api/") and path != "/api/session":
            presented = conn.cookies.get(COOKIE) or \
                conn.headers.get("authorization", "").removeprefix("Bearer ")
            if not secrets.compare_digest(presented.encode(), self.token):
                return await _error(
                    401, "token_required",
                    "Access token required; open the link printed in the terminal")(
                    scope, receive, send)
        await self.app(scope, receive, send)


def _archive_too_large(path: str) -> JSONResponse:
    if path == "/api/assets/import":
        return _error(400, "bad_asset_pack", "This isn't a brushgraft asset pack: it is too large",
                      detail="too large")
    return _error(400, "bad_archive", "This isn't a brushgraft project file: it is too large",
                  detail="too large")


def _upload_too_large(status: int) -> JSONResponse:
    max_mb = MAX_UPLOAD_BYTES // 1024 // 1024
    return _error(status, "upload_too_large",
                  f"Images can't be larger than {max_mb} MB", max_mb=max_mb)


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------
def create_app(store: Store, settings: Settings, token: str, *,
               allowed_hosts: frozenset[str] | None = LOOPBACK_HOSTS,
               bus: EventBus | None = None,
               runner: JobRunner | None = None) -> FastAPI:
    """With ``allowed_hosts`` None the Host header isn't checked (non-local bind)."""
    bus = bus or EventBus()
    runner = runner or JobRunner(store, settings, bus)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        bus.bind(asyncio.get_running_loop())
        yield
        runner.shutdown()

    app = FastAPI(title="brushgraft", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store, app.state.runner, app.state.bus = store, runner, bus

    app.add_middleware(_Guard, token=token, allowed_hosts=allowed_hosts)

    @app.exception_handler(NotFound)
    async def not_found(request: Request, exc: NotFound):
        return _error(404, exc.code, str(exc), **exc.params)

    @app.exception_handler(UserError)
    async def user_error(request: Request, exc: UserError):
        return _error(400, exc.code, str(exc), **exc.params)

    @app.exception_handler(ValueError)
    async def invalid_value(request: Request, exc: ValueError):
        # Anything not raised as a UserError on purpose, e.g. a damaged file
        return _error(400, "invalid_request", f"Invalid request: {exc}", detail=str(exc))

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError):
        detail = "; ".join(f"{'.'.join(map(str, e['loc'][1:]))}: {e['msg']}"
                           for e in exc.errors())
        return _error(422, "invalid_request", detail or "Invalid request",
                      detail=detail)

    # -- session and settings -----------------------------------------------
    @app.post("/api/session", status_code=204)
    def open_session(body: SessionIn, response: Response):
        if not secrets.compare_digest(body.token.encode(), token.encode()):
            return _error(401, "token_invalid", "Wrong access token")
        response.set_cookie(COOKIE, token, max_age=365 * 86400, httponly=True,
                            samesite="strict")

    @app.get("/api/config")
    def get_config():
        key, key_source = settings.lookup("API_KEY")
        base, base_source = settings.lookup("BASE_URL")
        return {
            "version": __version__,
            "promptbrush_version": pb.__version__,
            "models": [{"name": name, **vars(info)}
                       for name, info in pb.MODELS.items()],
            "default_model": pb.DEFAULT_MODEL,
            "lenient_model": pb.LENIENT_MODERATION_MODEL,
            "size_presets": SIZE_PRESETS,
            "default_size": pb.DEFAULT_SIZE,
            "region_colors": imaging.REGION_COLORS,
            "max_regions": MAX_REGIONS,
            "settings": {
                "api_key_set": bool(key), "api_key_source": key_source,
                "base_url": base or pb.DEFAULT_BASE_URL,
                "base_url_source": base_source,
                "env_file": str(settings.env_file),
            },
            "home": str(store.home),
        }

    @app.put("/api/settings")
    def put_settings(body: SettingsIn):
        if body.base_url and not re.fullmatch(r"https?://\S+", body.base_url):
            raise UserError("invalid_base_url",
                            "The base URL must start with http:// or https://")
        settings.save(api_key=body.api_key, base_url=body.base_url)
        return get_config()["settings"]

    # -- projects -----------------------------------------------------------
    @app.get("/api/projects")
    def list_projects():
        return store.list_projects()

    @app.post("/api/projects", status_code=201)
    def create_project(body: ProjectIn):
        return store.create_project(body.name.strip())

    @app.patch("/api/projects/{project_id}")
    def rename_project(project_id: str, body: ProjectIn):
        return store.rename_project(project_id, body.name.strip())

    @app.delete("/api/projects/{project_id}", status_code=204)
    def delete_project(project_id: str):
        store.delete_project(project_id)

    @app.get("/api/projects/{project_id}/tree")
    def project_tree(project_id: str):
        return store.project_tree(project_id)

    @app.post("/api/projects/{project_id}/uploads", status_code=201)
    def upload(project_id: str, file: Annotated[UploadFile, File()]):
        store.get_project(project_id)
        data = file.file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            return _upload_too_large(400)
        image = store.put_image(imaging.normalize_upload(data))
        node = store.add_node(project_id=project_id, image=image["sha"],
                              label=Path(file.filename or "").name[:200])
        bus.publish({"type": "node", "node": node})
        return node

    @app.get("/api/projects/{project_id}/export")
    def export_project(project_id: str):
        project = store.get_project(project_id)
        tree = store.project_tree(project_id)
        data = archive.to_bytes(project, tree["nodes"], tree["jobs"],
                                store.project_images(project_id), __version__)
        name = re.sub(r"[^\w.-]+", "_", project["name"]).strip("_")[:60] or "project"
        return Response(data, media_type="application/zip",
                        headers={"Content-Disposition": attachment(f"brushgraft-{name}.zip")})

    @app.post("/api/projects/import", status_code=201)
    def import_project(file: Annotated[UploadFile, File()]):
        # zipfile needs a real, seekable file: the upload's own spool isn't one before Python 3.11.
        # A temp file keeps a large project out of memory until its images are read one by one
        with tempfile.TemporaryFile() as spool:
            shutil.copyfileobj(file.file, spool)
            spool.seek(0)
            manifest, images = archive.read_archive(spool)
        nodes, jobs = archive.remap_ids(manifest, new_id)
        return store.import_project(manifest["project"], nodes, jobs, images)

    @app.post("/api/projects/{project_id}/from-asset", status_code=201)
    def add_from_asset(project_id: str, body: FromAsset):
        """An asset as a new root version of the project."""
        store.get_project(project_id)
        asset = store.get_asset(body.asset_id)
        node = store.add_node(project_id=project_id, image=asset["image"], label=asset["name"])
        bus.publish({"type": "node", "node": node})
        return node

    # -- the asset library: images every project can use ---------------------
    def _assets_changed():
        bus.publish({"type": "assets"})

    @app.get("/api/assets")
    def list_assets():
        return store.list_assets()

    @app.post("/api/assets", status_code=201)
    def add_asset(file: Annotated[UploadFile, File()]):
        data = file.file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            return _upload_too_large(400)
        image = store.put_image(imaging.normalize_upload(data))
        name = Path(file.filename or "").stem.strip()[:100] or "Untitled"
        asset = store.add_asset(image["sha"], name)
        _assets_changed()
        return asset

    @app.post("/api/assets/from-node", status_code=201)
    def asset_from_node(body: AssetFromNode):
        asset = store.add_asset(store.get_node(body.node_id)["image"], body.name.strip())
        _assets_changed()
        return asset

    @app.patch("/api/assets/{asset_id}")
    def rename_asset(asset_id: str, body: AssetIn):
        asset = store.rename_asset(asset_id, body.name.strip())
        _assets_changed()
        return asset

    @app.delete("/api/assets/{asset_id}", status_code=204)
    def delete_asset(asset_id: str):
        store.delete_asset(asset_id)
        _assets_changed()

    @app.get("/api/assets/export")
    def export_assets():
        assets = store.list_assets()
        data = archive.asset_pack_bytes(assets, {a["image"]: store.read_image(a["image"])
                                                 for a in assets}, __version__)
        return Response(data, media_type="application/zip",
                        headers={"Content-Disposition": attachment("brushgraft-assets.zip")})

    @app.post("/api/assets/import")
    def import_assets(file: Annotated[UploadFile, File()]):
        with tempfile.TemporaryFile() as spool:
            shutil.copyfileobj(file.file, spool)
            spool.seek(0)
            manifest, images = archive.read_asset_pack(spool)
        added, skipped = store.import_assets(manifest["assets"], images)
        _assets_changed()
        return {"added": added, "skipped": skipped}

    # -- nodes --------------------------------------------------------------
    @app.patch("/api/nodes/{node_id}")
    def patch_node(node_id: str, body: NodePatch):
        node = store.update_node(node_id, starred=body.starred, label=body.label,
                                 use_raw=body.use_raw)
        bus.publish({"type": "node", "node": node})
        return node

    @app.delete("/api/nodes/{node_id}", status_code=204)
    def delete_node(node_id: str):
        node = store.get_node(node_id)
        store.delete_node(node_id)
        bus.publish({"type": "tree", "project_id": node["project_id"]})

    # -- jobs ---------------------------------------------------------------
    @app.post("/api/jobs", status_code=202)
    def create_job(body: JobIn):
        store.get_project(body.project_id)
        return runner.submit(
            project_id=body.project_id, parent_id=body.parent_id,
            prompt=body.prompt, regions=[r.model_dump() for r in body.regions],
            refs=body.refs, model=body.model.strip(), size=body.size,
            n=body.n, composite=body.composite, lang=body.lang)

    @app.get("/api/jobs/{job_id}/logs")
    def job_logs(job_id: str):
        store.get_job(job_id)
        return runner.logs(job_id)

    @app.delete("/api/jobs/{job_id}", status_code=204)
    def delete_job(job_id: str):
        job = store.get_job(job_id)
        store.delete_job(job_id)
        bus.publish({"type": "tree", "project_id": job["project_id"]})

    # -- images -------------------------------------------------------------
    def _checked_sha(sha: str) -> str:
        if not SHA_RE.match(sha):
            raise NotFound("image", sha)
        return sha

    @app.get("/api/images/{sha}")
    def get_image(sha: str, download: str | None = None):
        path = store.image_path(_checked_sha(sha))
        if download:
            name = re.sub(r"[^\w.-]", "_", download)[:100] or "image"
            return FileResponse(path, filename=name + path.suffix,
                                headers=IMMUTABLE)
        return FileResponse(path, headers=IMMUTABLE)

    @app.get("/api/thumbs/{sha}")
    def get_thumb(sha: str):
        return FileResponse(store.thumb_path(_checked_sha(sha)),
                            media_type="image/webp", headers=IMMUTABLE)

    # -- event stream -------------------------------------------------------
    @app.get("/api/events")
    async def events(request: Request):
        async def stream():
            queue = bus.subscribe()
            try:
                yield "retry: 2000\n\n"
                while not await request.is_disconnected():
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=15)
                    except asyncio.TimeoutError:
                        yield ": keep-alive\n\n"
                        continue
                    if event is None:  # the server is shutting down
                        break
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            finally:
                bus.unsubscribe(queue)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache"})

    # -- web UI -------------------------------------------------------------
    if (STATIC_DIR / "index.html").exists():
        app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="web")
    else:
        @app.get("/", response_class=HTMLResponse)
        def frontend_missing():
            return ("<!doctype html><meta charset=utf-8><title>brushgraft</title>"
                    "<p>The web UI hasn't been built. Run <code>npm --prefix web ci "
                    "&amp;&amp; npm --prefix web run build</code> in the project "
                    "directory, then restart brushgraft.")

    return app
