"""A project as one .zip: ``project.json`` (versions and how each was made) plus
``images/<sha256>.<ext>``; and the asset library as one: ``assets.json`` plus the same
``images/``.

The browser build (web/src/lib/backend/archive.ts) reads and writes the same file,
so a project moves between the local server and the website. A file from outside is
untrusted: the manifest is checked field by field, every image must hash to its
name and be an image, and sizes are bounded before anything is unpacked.
"""

import hashlib
import io
import json
import re
import zipfile
import zlib
from typing import Any

from PIL import Image

import promptbrush as pb

from brushgraft.errors import UserError
from brushgraft.imaging import MAX_COORD
from brushgraft.prompts import (MAX_FULL_PROMPT, MAX_INSTRUCTION, MAX_PROMPT, MAX_REGIONS,
                               MAX_SHAPES)

FORMAT = "brushgraft-project"
# 2: jobs record the image of each reference (ref_images), and may refer to assets
VERSION = 2
ASSETS_FORMAT = "brushgraft-assets"
ASSETS_VERSION = 1
MAX_NODES = 5000
MAX_ASSETS = 5000
MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_TOTAL_BYTES = 1024 * 1024 * 1024

_SHA = re.compile(r"^[0-9a-f]{64}$")
_ID = re.compile(r"^[\w-]{1,64}$")
_REF = re.compile(r"^(asset:)?[\w-]{1,64}$")
_IMAGE_NAME = re.compile(r"^images/([0-9a-f]{64})\.(png|jpg|webp|gif)$")
_STATUS = {"queued", "running", "done", "failed"}


def _bad(detail: str) -> UserError:
    return UserError("bad_archive", f"This isn't a brushgraft project file: {detail}",
                     detail=detail)


def _bad_pack(detail: str) -> UserError:
    return UserError("bad_asset_pack", f"This isn't a brushgraft asset pack: {detail}",
                     detail=detail)


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------
def node_record(node: dict) -> dict:
    keys = ("id", "parent_id", "job_id", "image", "raw_image", "merged_image", "note", "label",
            "starred", "created_at")
    return {k: node[k] for k in keys}


def job_record(job: dict) -> dict:
    keys = ("id", "parent_id", "kind", "prompt", "full_prompt", "regions", "refs", "ref_images",
            "model", "size", "n", "composite", "mask_image", "annot_image", "status", "done",
            "failed", "errors", "usage", "created_at", "finished_at")
    return {k: job[k] for k in keys}


def write_archive(out: Any, project: dict, nodes: list[dict], jobs: list[dict],
                  images: dict[str, bytes], app_version: str) -> None:
    """Write the project to ``out`` (a binary file object)."""
    manifest = {
        "format": FORMAT, "version": VERSION, "exported_by": f"brushgraft {app_version}",
        "project": {k: project[k] for k in ("name", "created_at", "updated_at")},
        "nodes": [node_record(n) for n in nodes],
        "jobs": [job_record(j) for j in jobs],
    }
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:  # images are compressed already
        z.writestr("project.json", json.dumps(manifest, ensure_ascii=False, indent=1))
        for sha, data in images.items():
            z.writestr(f"images/{sha}{pb.detect_image_ext(data) or ''}", data)


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
def _text(v: Any, what: str, limit: int, optional: bool = False) -> str:
    if optional and v is None:
        return ""
    if not isinstance(v, str) or len(v) > limit:
        raise _bad(f"{what} is not text")
    return v


def _number(v: Any, what: str, limit: float = 1e15) -> float:
    # not abs(v) <= limit: also NaN, and an int too large for a float or for SQLite
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not abs(v) <= limit:
        raise _bad(f"{what} is not a number")
    return v


def _sha(v: Any, what: str, optional: bool = False) -> str | None:
    if optional and v is None:
        return None
    if not isinstance(v, str) or not _SHA.match(v):
        raise _bad(f"{what} is not an image hash")
    return v


def _id(v: Any, what: str) -> str:
    if not isinstance(v, str) or not _ID.match(v):
        raise _bad(f"{what} is not an id")
    return v


def _opt_id(v: Any, what: str) -> str | None:
    return None if v is None else _id(v, what)


def _ref(v: Any) -> str:
    if not isinstance(v, str) or not _REF.match(v):
        raise _bad("a reference is not an id")
    return v


def _points(v: Any, low: int) -> list[list[float]]:
    if not isinstance(v, list) or not low <= len(v) <= 20000:
        raise _bad("a shape has the wrong number of points")
    out = []
    for p in v:
        if not isinstance(p, list) or len(p) != 2:
            raise _bad("a point is malformed")
        out.append([_number(p[0], "x", MAX_COORD), _number(p[1], "y", MAX_COORD)])
    return out


def _shape(s: Any) -> dict:
    if not isinstance(s, dict):
        raise _bad("a shape is malformed")
    # kept only when given, so a file reads back exactly as it was written
    op = {"op": s["op"]} if "op" in s else {}
    if op and op["op"] not in ("add", "subtract", "intersect"):
        raise _bad("a shape has an unknown operation")
    if s.get("type") in ("rect", "ellipse"):
        w, h = _number(s.get("w"), "w", 2 * MAX_COORD), _number(s.get("h"), "h", 2 * MAX_COORD)
        if w <= 0 or h <= 0:
            raise _bad("a rectangle is empty")
        return {"type": s["type"], "x": _number(s.get("x"), "x", MAX_COORD),
                "y": _number(s.get("y"), "y", MAX_COORD), "w": w, "h": h, **op}
    if s.get("type") == "lasso":
        return {"type": "lasso", "points": _points(s.get("points"), 3), **op}
    if s.get("type") == "brush":
        radius = _number(s.get("radius"), "radius")
        if not 0 < radius <= 4000:
            raise _bad("a brush radius is out of range")
        return {"type": "brush", "points": _points(s.get("points"), 1), "radius": radius, **op}
    raise _bad("a shape has an unknown type")


def _region(r: Any) -> dict:
    shapes = r.get("shapes") if isinstance(r, dict) else None
    if not isinstance(shapes, list) or not 1 <= len(shapes) <= MAX_SHAPES:
        raise _bad("a region is malformed")
    return {"shapes": [_shape(s) for s in shapes],
            "instruction": _text(r.get("instruction"), "an instruction", MAX_INSTRUCTION,
                                 optional=True)}


def _job_error(e: Any) -> Any:
    if isinstance(e, str):
        return e[:2000]
    if not isinstance(e, dict):
        raise _bad("an error entry is malformed")
    return {"code": _text(e.get("code"), "an error code", 64),
            "detail": _text(e.get("detail"), "an error detail", 5000, optional=True),
            "variant": _text(e.get("variant"), "a variant", 20, optional=True)}


def _node(n: Any) -> dict:
    if not isinstance(n, dict):
        raise _bad("a version is malformed")
    return {
        "id": _id(n.get("id"), "a version id"),
        "parent_id": _opt_id(n.get("parent_id"), "a parent id"),
        "job_id": _opt_id(n.get("job_id"), "a job id"),
        "image": _sha(n.get("image"), "a version's image"),
        "raw_image": _sha(n.get("raw_image"), "a raw image", True),
        "merged_image": _sha(n.get("merged_image"), "a merged image", True),
        "note": _text(n.get("note"), "a note", 64, optional=True),
        "label": _text(n.get("label"), "a label", 200, optional=True),
        "starred": n.get("starred") is True,
        "created_at": _number(n.get("created_at"), "a version's time"),
    }


def _job(j: Any) -> dict:
    if not isinstance(j, dict):
        raise _bad("a job is malformed")
    if j.get("kind") not in ("generate", "edit"):
        raise _bad("a job has an unknown kind")
    regions, refs, ref_images = j.get("regions"), j.get("refs"), j.get("ref_images")
    if not isinstance(regions, list) or len(regions) > MAX_REGIONS:
        raise _bad("a job has too many regions")
    if not isinstance(refs, list) or len(refs) > 8:
        raise _bad("a job has too many references")
    if ref_images is not None and (not isinstance(ref_images, list)
                                   or len(ref_images) != len(refs)):
        raise _bad("a job's reference images don't match its references")
    n = _number(j.get("n"), "a job's count")
    if n != int(n) or not 1 <= n <= 4:
        raise _bad("a job's count is out of range")
    errors = j.get("errors")
    usage = j.get("usage")
    status = j.get("status")
    finished = j.get("finished_at")
    return {
        "id": _id(j.get("id"), "a job id"),
        "parent_id": _opt_id(j.get("parent_id"), "a job's parent"),
        "kind": j["kind"],
        "prompt": _text(j.get("prompt"), "a prompt", MAX_PROMPT, optional=True),
        "full_prompt": _text(j.get("full_prompt"), "a full prompt", MAX_FULL_PROMPT,
                             optional=True),
        "regions": [_region(r) for r in regions],
        "refs": [_ref(r) for r in refs],
        # None in a version 1 file: parse_manifest fills them in from the versions
        "ref_images": None if ref_images is None else [
            _sha(s, "a reference's image", True) for s in ref_images],
        "model": _text(j.get("model"), "a model", 100),
        "size": _text(j.get("size"), "a size", 20, optional=True),
        "n": int(n),
        "composite": j.get("composite") is True,
        "mask_image": _sha(j.get("mask_image"), "a mask", True),
        "annot_image": _sha(j.get("annot_image"), "an annotated image", True),
        "status": status if isinstance(status, str) and status in _STATUS else "failed",
        "done": min(int(n), max(0, int(_number(j.get("done", 0), "done")))),
        "failed": min(int(n), max(0, int(_number(j.get("failed", 0), "failed")))),
        "errors": [_job_error(e) for e in errors[:50]] if isinstance(errors, list) else [],
        # NaN would be stored, then break every reply that lists the job
        "usage": ({k: v for k, v in usage.items() if isinstance(v, (int, float))
                   and not isinstance(v, bool) and abs(v) <= 2 ** 53}
                  if isinstance(usage, dict) else None),
        "created_at": _number(j.get("created_at"), "a job's time"),
        "finished_at": None if finished is None else _number(finished, "a finish time"),
    }


def parse_manifest(raw: Any) -> dict:
    """Check a project.json and return {"project", "nodes", "jobs"}. Raises UserError."""
    if not isinstance(raw, dict) or raw.get("format") != FORMAT:
        raise _bad("project.json is missing or has another format")
    version = raw.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version > VERSION:
        raise UserError("archive_newer",
                        "This project file was made by a newer brushgraft; upgrade to open it")
    p, nodes, jobs = raw.get("project"), raw.get("nodes"), raw.get("jobs")
    if not isinstance(p, dict) or not isinstance(nodes, list) or not isinstance(jobs, list):
        raise _bad("project.json is incomplete")
    if len(nodes) > MAX_NODES or len(jobs) > MAX_NODES:
        raise _bad("it has too many versions")
    project = {"name": _text(p.get("name"), "the project name", 100).strip() or "Untitled",
               "created_at": _number(p.get("created_at"), "created_at"),
               "updated_at": _number(p.get("updated_at"), "updated_at")}
    nodes = [_node(n) for n in nodes]
    jobs = [_job(j) for j in jobs]
    images = {n["id"]: n["image"] for n in nodes}
    for j in jobs:
        if j["ref_images"] is None:
            j["ref_images"] = [images.get(r) for r in j["refs"]]

    node_ids = {n["id"] for n in nodes}
    job_ids = {j["id"] for j in jobs}
    if len(node_ids) != len(nodes) or len(job_ids) != len(jobs):
        raise _bad("an id appears twice")
    for n in nodes:
        if n["parent_id"] and n["parent_id"] not in node_ids:
            raise _bad("a version's parent is missing")
        if n["job_id"] and n["job_id"] not in job_ids:
            raise _bad("a version's job is missing")
    for j in jobs:
        if j["parent_id"] and j["parent_id"] not in node_ids:
            raise _bad("a job's parent is missing")
    parent = {n["id"]: n["parent_id"] for n in nodes}
    for n in nodes:
        at, hops = n["id"], 0
        while at:
            hops += 1
            if hops > len(nodes) + 1:
                raise _bad("versions refer to each other in a loop")
            at = parent.get(at)
    return {"project": project, "nodes": nodes, "jobs": jobs}


def referenced_images(manifest: dict) -> set[str]:
    out = set()
    for n in manifest["nodes"]:
        out.update(s for s in (n["image"], n["raw_image"], n["merged_image"]) if s)
    for j in manifest["jobs"]:
        out.update(s for s in (j["mask_image"], j["annot_image"], *j["ref_images"]) if s)
    return out


# What reading a damaged zip member raises: a bad CRC or header, broken deflate data, an
# encrypted member, a compression method Python doesn't have
_UNREADABLE = (zipfile.BadZipFile, OSError, zlib.error, RuntimeError, NotImplementedError,
               EOFError)


def _opens(data: bytes) -> bool:
    """Whether the image's header reads, as on upload (Pillow refuses absurdly large ones)."""
    try:
        with Image.open(io.BytesIO(data)):
            return True
    except (OSError, SyntaxError, ValueError, Image.DecompressionBombError):
        return False


def _read_zip(file: Any, name: str, parse, referenced, bad) -> tuple[dict, dict[str, bytes]]:
    """Open a zip of ``name`` (checked by ``parse``) and images/: (manifest, {sha: bytes}),
    with every image ``referenced`` names there. Sizes are checked before anything is unpacked."""
    try:
        z = zipfile.ZipFile(file)
    except (zipfile.BadZipFile, OSError):
        raise bad("it can't be opened as a zip file") from None
    with z:
        infos = z.infolist()
        if len(infos) > MAX_NODES * 4:
            raise bad("it has too many files")
        total = 0
        for info in infos:
            if info.file_size > MAX_FILE_BYTES:
                raise bad(f"{info.filename} is too large")
            total += info.file_size
            if total > MAX_TOTAL_BYTES:
                raise bad("it is too large")
        try:
            raw = json.loads(z.read(name).decode("utf-8"))
        except KeyError:
            raise bad(f"{name} is missing") from None
        except _UNREADABLE:
            raise bad(f"{name} can't be read") from None
        except (ValueError, RecursionError):
            raise bad(f"{name} is not valid JSON") from None
        manifest = parse(raw)
        images: dict[str, bytes] = {}
        for info in infos:
            m = _IMAGE_NAME.match(info.filename)
            if not m:
                continue
            try:
                data = z.read(info)
            except _UNREADABLE:
                raise bad(f"{info.filename} can't be read") from None
            if hashlib.sha256(data).hexdigest() != m.group(1):
                raise bad(f"{info.filename} doesn't match its name")
            if pb.detect_image_ext(data) is None or not _opens(data):
                raise bad(f"{info.filename} is not an image")
            images[m.group(1)] = data
    for sha in referenced(manifest):
        if sha not in images:
            raise bad(f"the image {sha[:8]}… is missing")
    return manifest, images


def read_archive(file: Any) -> tuple[dict, dict[str, bytes]]:
    """Open a project file (a binary file object): (manifest, {sha: bytes}). Raises UserError."""
    return _read_zip(file, "project.json", parse_manifest, referenced_images, _bad)


def remap_ids(manifest: dict, new_id) -> tuple[list[dict], list[dict]]:
    """Fresh ids for the versions and jobs, so an import never collides with what exists."""
    node_map = {n["id"]: new_id() for n in manifest["nodes"]}
    job_map = {j["id"]: new_id() for j in manifest["jobs"]}
    nodes = [{**n, "id": node_map[n["id"]],
              "parent_id": node_map[n["parent_id"]] if n["parent_id"] else None,
              "job_id": job_map[n["job_id"]] if n["job_id"] else None}
             for n in manifest["nodes"]]
    # A reference to a version that isn't in the file, or to an asset, stays as it is: it finds
    # nothing here (the library is another one), and its image is in ref_images
    jobs = [{**j, "id": job_map[j["id"]],
             "parent_id": node_map[j["parent_id"]] if j["parent_id"] else None,
             "refs": [node_map.get(r, r) for r in j["refs"]]}
            for j in manifest["jobs"]]
    return nodes, jobs


def to_bytes(project: dict, nodes: list[dict], jobs: list[dict], images: dict[str, bytes],
             app_version: str) -> bytes:
    buf = io.BytesIO()
    write_archive(buf, project, nodes, jobs, images, app_version)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Asset packs: the asset library as a .zip
# ---------------------------------------------------------------------------
def asset_record(asset: dict) -> dict:
    return {k: asset[k] for k in ("name", "image", "created_at")}


def asset_pack_bytes(assets: list[dict], images: dict[str, bytes], app_version: str) -> bytes:
    manifest = {"format": ASSETS_FORMAT, "version": ASSETS_VERSION,
                "exported_by": f"brushgraft {app_version}",
                "assets": [asset_record(a) for a in assets]}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("assets.json", json.dumps(manifest, ensure_ascii=False, indent=1))
        for sha, data in images.items():
            z.writestr(f"images/{sha}{pb.detect_image_ext(data) or ''}", data)
    return buf.getvalue()


def parse_asset_manifest(raw: Any) -> dict:
    """Check an assets.json and return {"assets": [{name, image, created_at}]}."""
    if not isinstance(raw, dict) or raw.get("format") != ASSETS_FORMAT:
        raise _bad_pack("assets.json is missing or has another format")
    version = raw.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version > ASSETS_VERSION:
        raise UserError("archive_newer",
                        "This file was made by a newer brushgraft; upgrade to open it")
    assets = raw.get("assets")
    if not isinstance(assets, list) or len(assets) > MAX_ASSETS:
        raise _bad_pack("it has no list of assets, or too many")
    out = []
    for a in assets:
        if not isinstance(a, dict):
            raise _bad_pack("an asset is malformed")
        name = a.get("name")
        image = a.get("image")
        created = a.get("created_at")
        if not isinstance(name, str) or len(name) > 100:
            raise _bad_pack("an asset's name is not text")
        if not isinstance(image, str) or not _SHA.match(image):
            raise _bad_pack("an asset's image is not an image hash")
        if isinstance(created, bool) or not isinstance(created, (int, float)) \
                or not abs(created) <= 1e15:
            raise _bad_pack("an asset's time is not a number")
        out.append({"name": name.strip() or "Untitled", "image": image, "created_at": created})
    return {"assets": out}


def read_asset_pack(file: Any) -> tuple[dict, dict[str, bytes]]:
    """Open an asset pack (a binary file object): (manifest, {sha: bytes}). Raises UserError."""
    return _read_zip(file, "assets.json", parse_asset_manifest,
                     lambda m: {a["image"] for a in m["assets"]}, _bad_pack)
