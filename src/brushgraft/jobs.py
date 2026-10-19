"""Job queue: validate and prepare requests, call promptbrush in a thread pool,
and write the results back into the version tree."""

import re
import threading
import time
from collections import deque
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import requests

import promptbrush as pb

from brushgraft import imaging
from brushgraft.config import Settings
from brushgraft.errors import NotFound, UserError
from brushgraft.events import EventBus
from brushgraft.prompts import Lang, compile_prompt
from brushgraft.store import (ASSET_REF, NOTE_ASPECT_MISMATCH, NOTE_OVERALL, NOTE_PASTE_FAILED,
                              NOTE_REFRAMED, NOTE_SPILL_GROWN, NOTE_SPILL_TOO_LARGE, Store)

LOG_LINES_PER_JOB = 200


@dataclass(frozen=True)
class _Request:
    """Inputs shared by the n requests of a job; prepared once, read-only."""
    job_id: str
    n: int
    prompt: str
    model: str
    size: str
    images: tuple[bytes, ...]      # sent in order: original, annotated, references...
    api_key: str
    base_url: str
    parent: bytes | None           # the original, for pasting back
    mask: bytes | None             # region mask (PNG), for pasting back
    annot: bytes | None            # annotated image as sent, to spot copied marks
    overall: bool                  # the user wrote an overall request besides the regions
    zoom: tuple[int, int, int, int] | None = None  # the close-up sent instead of the whole image


# English log lines for job errors and paste-back notes (the UI shows the codes
# in the user's language elsewhere; the log is a raw trace)
_ERROR_LOG = {
    "moderated": "Blocked by content moderation",
    "prompt_too_long": "The API turned the prompt down as too long",
    "api_error": "The API returned an error",
    "network": "Network request failed",
    "no_image": "The API returned no image",
    "save_failed": "Couldn't save the result",
    "internal": "Internal error",
}
_NOTE_LOG = {
    NOTE_OVERALL: ("The overall request changed the whole image; using the model's whole "
                   "output (the pasted-back version is kept)"),
    NOTE_PASTE_FAILED: "Pasting back failed; kept the model's whole output",
    NOTE_REFRAMED: "The model redrew the scene (different framing); not pasted back",
    NOTE_SPILL_GROWN: "New content went past the region; grew the paste-back area",
    NOTE_SPILL_TOO_LARGE: "New content spread too far; pasted back the region only",
}


def _error(code: str, detail: str = "", variant: str = "") -> dict:
    """A job error as stored in jobs.errors; the web UI translates ``code``."""
    return {"code": code, "detail": detail, "variant": variant}


# An API that turns a prompt down as too long answers 413, or (relays seen) 400/500 with text that
# says so; nothing else in these errors looks like that
_TOO_LONG = re.compile(r"(?i)\binput_too_large\b|context_length|maximum context|too long"
                       r"|过长|超出.*长度")


def _api_error_code(exc: pb.ImageAPIError) -> str:
    if exc.moderated:
        return "moderated"
    if exc.code == pb.NO_IMAGE:
        return "no_image"
    if exc.status == 413 or _TOO_LONG.search(str(exc)):
        return "prompt_too_long"
    return "api_error"


class JobRunner:
    def __init__(self, store: Store, settings: Settings, bus: EventBus,
                 max_parallel: int = pb.MAX_PARALLEL):
        self.store = store
        self.settings = settings
        self.bus = bus
        # Relay services answer 429 when pushed too hard; same cap as the CLI
        self._pool = ThreadPoolExecutor(max_parallel,
                                        thread_name_prefix="brushgraft-job")
        self._logs: dict[str, deque] = {}
        self._lock = threading.Lock()
        self._active = 0

    # -- submit -------------------------------------------------------------
    def _ref_image(self, ref: str, project_id: str) -> str:
        """A reference's image: an asset from the library (any project may use it), or a
        version of this project."""
        if ref.startswith(ASSET_REF):
            return self.store.get_asset(ref.removeprefix(ASSET_REF))["image"]
        node = self.store.get_node(ref)
        if node["project_id"] != project_id:
            raise UserError("cross_project", "Images must come from the same project")
        return node["image"]

    def submit(self, *, project_id: str, prompt: str, model: str, n: int,
               parent_id: str | None = None, regions: Sequence[dict] = (),
               refs: Sequence[str] = (), size: str | None = None,
               composite: bool = True, lang: Lang = "en") -> dict:
        """Validate, prepare the images and queue the job; return the job record.

        Raises UserError / NotFound for bad input, unknown nodes or a missing
        API key, before any billed request is made.
        """
        api_key = self.settings.api_key
        if not api_key:
            raise UserError("api_key_missing",
                            "No API key is configured; add one in Settings")
        if not model.strip():
            raise UserError("model_required", "Choose a model")
        regions = [dict(r) for r in regions]

        parent = self.store.get_node(parent_id) if parent_id else None
        if parent and parent["project_id"] != project_id:
            raise UserError("cross_project", "Images must come from the same project")
        ref_images = [self._ref_image(r, project_id) for r in refs]
        full_prompt = compile_prompt(prompt, regions, has_parent=bool(parent),
                                     ref_count=len(ref_images), lang=lang)
        if parent:
            # Edits keep the original's aspect ratio, so paste-back and
            # comparison line up pixel for pixel
            size = size or pb.fit_size(parent["width"], parent["height"])
        elif not size:
            raise UserError("size_required", "Choose a size")
        if not pb.SIZE_PATTERN.match(size):
            raise UserError("size_format", f"Size must look like 1536x1024 or auto, not {size!r}",
                            size=size)
        try:
            pb.check_size(model, size)
        except ValueError as exc:
            raise UserError("size_invalid", str(exc), detail=str(exc), model=model,
                            size=size) from None

        images: list[bytes] = []
        parent_bytes = mask_bytes = annot_bytes = None
        mask_sha = annot_sha = zoom = None
        if parent:
            parent_bytes = self.store.read_image(parent["image"])
            images.append(imaging.for_api(parent_bytes))
        if parent and regions:
            original = imaging.open_image(parent_bytes)
            mask = imaging.union_mask(original.size, regions)
            box = mask.getbbox()
            if box is None:
                raise UserError("empty_region", "The region is empty; draw it again")
            # A small edit of a large image goes as a close-up, to be pasted back within it: not
            # with an overall request (that is about the whole image), nor for a model that
            # redraws the scene (nothing of its output is pasted back)
            info = pb.MODELS.get(model)
            if composite and not prompt.strip() and (info is None or info.aligned):
                zoom = imaging.zoom_box(original.size, box)
            shown, shown_regions = original, regions
            if zoom:
                shown = original.crop(zoom)
                shown_regions = imaging.shift_regions(regions, -zoom[0], -zoom[1])
                images[0] = imaging.for_api(imaging.png_bytes(shown))
                size = imaging.zoom_size(zoom)
            mask_bytes = imaging.png_bytes(mask)
            annot_bytes = imaging.png_bytes(imaging.annotate(shown, shown_regions))
            mask_sha = self.store.put_image(mask_bytes)["sha"]
            annot_sha = self.store.put_image(annot_bytes)["sha"]
            images.append(imaging.for_api(annot_bytes))
        images += [imaging.for_api(self.store.read_image(sha), imaging.REF_MAX_PIXELS)
                   for sha in ref_images]

        job = self.store.create_job(
            project_id=project_id, parent_id=parent_id,
            kind="edit" if parent else "generate", prompt=prompt.strip(),
            full_prompt=full_prompt, regions=regions, refs=list(refs), ref_images=ref_images,
            model=model, size=size, n=n, composite=composite and bool(regions),
            mask_image=mask_sha, annot_image=annot_sha,
            parent_image=parent["image"] if parent else None)
        req = _Request(job_id=job["id"], n=n, prompt=full_prompt, model=model,
                       size=size, images=tuple(images), api_key=api_key,
                       base_url=self.settings.base_url, parent=parent_bytes,
                       mask=mask_bytes if job["composite"] else None,
                       annot=annot_bytes, overall=bool(job["prompt"]), zoom=zoom)
        with self._lock:
            self._logs[job["id"]] = deque(maxlen=LOG_LINES_PER_JOB)
        self.bus.publish({"type": "job", "job": job})
        for k in range(n):
            self._pool.submit(self._run_one, req, k)
        return job

    # -- run ----------------------------------------------------------------
    def _run_one(self, req: _Request, k: int) -> None:
        with self._lock:
            self._active += 1
        try:
            self._attempt(req, k)
        finally:
            with self._lock:
                self._active -= 1

    def _attempt(self, req: _Request, k: int) -> None:
        self.store.set_job_running(req.job_id)
        self.bus.publish({"type": "job", "job": self.store.get_job(req.job_id)})
        variant = f"{k + 1}/{req.n}" if req.n > 1 else ""
        tag = f"[{variant}] " if variant else ""

        def sink(level: str, msg: str) -> None:
            self._log(req.job_id, level, tag + msg)

        gen = None
        error = None
        nodes = []
        with pb.log_sink(sink):
            pb.log("info", f"Requesting {req.model} at {req.size}")
            if req.zoom:
                x0, y0, x1, y1 = req.zoom
                pb.log("info", f"Sending a close-up of the regions: {x1 - x0}x{y1 - y0} at "
                               f"({x0}, {y0})")
            try:
                gen = pb.create_image(req.prompt, images=req.images,
                                      model=req.model, size=req.size,
                                      api_key=req.api_key,
                                      base_url=req.base_url)
            except pb.ImageAPIError as exc:
                error = _error(_api_error_code(exc), str(exc), variant)
            except requests.exceptions.RequestException as exc:  # named: a timeout, a proxy...
                error = _error("network", f"{type(exc).__name__}: {exc}", variant)
            except Exception as exc:  # never let a worker exception vanish
                error = _error("internal", f"{type(exc).__name__}: {exc}", variant)

            for data in gen.images if gen else []:
                try:
                    nodes.append(self._save_result(req, data))
                except Exception as exc:
                    error = _error("save_failed", f"{type(exc).__name__}: {exc}",
                                   variant)
            if gen and not gen.images and not error:
                error = _error("no_image", "", variant)
            if error:
                pb.log("error", f"{_ERROR_LOG[error['code']]}{': ' if error['detail'] else ''}"
                                f"{error['detail']}")
            else:
                pb.log("ok", f"Done in {gen.elapsed:.0f}s")

        try:
            job = self.store.record_attempt(
                req.job_id, ok=bool(nodes), error=error,
                usage=gen.usage if gen else None)
        except NotFound:  # the project was deleted meanwhile
            return
        for node in nodes:
            self.bus.publish({"type": "node", "node": node})
        self.bus.publish({"type": "job", "job": job})

    def _save_result(self, req: _Request, data: bytes) -> dict:
        job = self.store.get_job(req.job_id)
        common = {"project_id": job["project_id"], "parent_id": job["parent_id"],
                  "job_id": job["id"]}
        raw = self.store.put_image(data)["sha"]
        if req.mask is None or req.parent is None:
            return self.store.add_node(image=raw, **common)
        full = imaging.open_image(req.parent)
        # what was sent: the whole original, or a close-up of it
        original = full.crop(req.zoom) if req.zoom else full
        result = imaging.open_image(data)
        if not imaging.same_aspect(original.size, result.size):
            pb.log("warn", f"Output is {result.width}x{result.height}, a different "
                           "aspect ratio from the original; not pasted back")
            return self.store.add_node(image=raw, note=NOTE_ASPECT_MISMATCH,
                                       **common)
        annotated = imaging.open_image(req.annot) if req.annot is not None else None
        try:
            mask = imaging.open_image(req.mask)
            if req.zoom:
                mask = mask.crop(req.zoom)
            # on the original's pixel grid: scaled back as it is, it can sit a few pixels off
            result = imaging.register(original, result, mask)
            if req.zoom:
                # the model's whole output, for a close-up: the original with the close-up replaced
                whole = full.copy()
                whole.paste(result, req.zoom[:2])
                raw = self.store.put_image(imaging.png_bytes(whole))["sha"]
            merged, note = imaging.paste_back(original, result, mask, annotated,
                                              overall=req.overall)
            if req.zoom and merged is not None:
                done = full.copy()
                done.paste(merged, req.zoom[:2])
                merged = done
        except Exception as exc:  # the image is paid for: never lose it to a paste-back problem
            pb.log("warn", f"{_NOTE_LOG[NOTE_PASTE_FAILED]} ({type(exc).__name__}: {exc})")
            return self.store.add_node(image=raw, note=NOTE_PASTE_FAILED, **common)
        if note:
            pb.log("info" if merged is not None else "warn", _NOTE_LOG[note])
        if merged is None:  # the model redrew the scene: its output can't be put back
            return self.store.add_node(image=raw, note=note, **common)
        final = self.store.put_image(imaging.png_bytes(merged))["sha"]
        if note == NOTE_OVERALL:  # adopt the whole output; the pasted-back one stays beside it
            return self.store.add_node(image=raw, raw_image=raw, merged_image=final, note=note,
                                       **common)
        return self.store.add_node(image=final, raw_image=raw, note=note,
                                   **common)

    # -- logs and lifecycle -------------------------------------------------
    def _log(self, job_id: str, level: str, msg: str) -> None:
        line = {"t": time.time(), "level": level, "msg": msg}
        with self._lock:
            if job_id in self._logs:
                self._logs[job_id].append(line)
        self.bus.publish({"type": "log", "job_id": job_id, **line})

    def logs(self, job_id: str) -> list[dict]:
        with self._lock:
            return list(self._logs.get(job_id, ()))

    @property
    def active(self) -> int:
        """Requests currently waiting on the API."""
        with self._lock:
            return self._active

    def shutdown(self) -> None:
        """Cancel queued requests; requests already sent finish and are saved."""
        self._pool.shutdown(wait=False, cancel_futures=True)

    def wait(self) -> None:
        """Until the requests already sent are done and saved (after shutdown)."""
        while self.active:
            time.sleep(0.2)
        self._pool.shutdown(wait=True)
