"""Job queue: validate and prepare requests, call promptbrush in a thread pool,
and write the results back into the version tree."""

import re
import threading
import time
from collections import deque
from collections.abc import Callable, Sequence
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor
from dataclasses import dataclass

import requests
from PIL import Image

import promptbrush as pb

from brushgraft import imaging
from brushgraft.config import Settings
from brushgraft.errors import NotFound, UserError
from brushgraft.events import EventBus
from brushgraft.prompts import Lang, compile_prompt
from brushgraft.store import (ASSET_REF, NOTE_ASPECT_MISMATCH, NOTE_OVERALL, NOTE_PART_FAILED,
                              NOTE_PASTE_FAILED, NOTE_REFRAMED, NOTE_SPILL_GROWN,
                              NOTE_SPILL_TOO_LARGE, Store, add_usage)

LOG_LINES_PER_JOB = 200


@dataclass(frozen=True)
class _Part:
    """One request of an edit sent in parts: a close-up of some regions, or the whole image
    with all of them."""
    box: tuple[int, int, int, int] | None  # the close-up; None for the whole image
    regions: tuple[int, ...]       # the regions it shows, by index
    prompt: str
    size: str
    images: tuple[bytes, ...]      # sent in order: what is edited, annotated, references...
    mask: bytes                    # its regions' mask on what is edited (PNG)
    annot: bytes                   # the annotated image as sent
    annot_image: str               # ... as stored

    def record(self) -> dict:
        """As jobs.requests lists it."""
        return {"prompt": self.prompt, "box": list(self.box) if self.box else None,
                "regions": list(self.regions), "size": self.size,
                "annot_image": self.annot_image}


class _Once:
    """A value made when it is first asked for, once, whichever thread asks."""

    def __init__(self, make: Callable[[], _Part]):
        self._make = make
        self._lock = threading.Lock()
        self._value: _Part | None = None

    def get(self) -> _Part:
        with self._lock:
            if self._value is None:
                self._value = self._make()
            return self._value


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
    # A small edit of a large image goes in parts instead (each variant sends them all): the
    # regions in close-ups, and the whole image with every region when some are too large for
    # one. ``whole`` makes that part; a close-up may call for it too (see imaging.merge_parts)
    parts: tuple[_Part, ...] = ()
    whole: _Once | None = None


# English log lines for job errors and paste-back notes (the UI shows the codes
# in the user's language elsewhere; the log is a raw trace)
_ERROR_LOG = {
    "moderated": "Blocked by content moderation",
    "prompt_too_long": "The API turned the prompt down as too long",
    "api_error": "The API returned an error",
    "network": "Network request failed",
    "no_image": "The API returned no image",
    "save_failed": "Couldn't save the result",
    "interrupted": "Interrupted",
    "internal": "Internal error",
}
_NOTE_LOG = {
    NOTE_OVERALL: ("The overall request changed the whole image; using the model's whole "
                   "output (the pasted-back version is kept)"),
    NOTE_PASTE_FAILED: "Pasting back failed; kept the model's whole output",
    NOTE_REFRAMED: "The model redrew the scene (different framing); not pasted back",
    NOTE_SPILL_GROWN: "New content went past the region; grew the paste-back area",
    NOTE_SPILL_TOO_LARGE: "New content spread too far; pasted back the region only",
    NOTE_PART_FAILED: "Some requests failed; their regions are left as they were",
}
_ASK_LOG = {
    "overall": "The overall request changed the whole close-up; sending the whole image as well",
    "unusable": "A close-up couldn't be pasted back; sending the whole image as well",
}


def _error(code: str, detail: str = "", variant: str = "") -> dict:
    """A job error as stored in jobs.errors; the web UI translates ``code``."""
    return {"code": code, "detail": detail, "variant": variant}


# An API that turns a prompt down as too long answers 413, or (relays seen) 400/500 with text that
# says so; nothing else in these errors looks like that
_TOO_LONG = re.compile(r"(?i)\binput_too_large\b|context_length|maximum context|too long"
                       r"|过长|超出.*长度")


def _outcome(future: Future, variant: str) -> tuple[pb.Generation | None, dict | None]:
    """A request's result, or the error it ended with."""
    try:
        return future.result(), None
    except pb.ImageAPIError as exc:
        return None, _error(_api_error_code(exc), str(exc), variant)
    except requests.exceptions.RequestException as exc:  # named: a timeout, a proxy...
        return None, _error("network", f"{type(exc).__name__}: {exc}", variant)
    except CancelledError:  # the server is shutting down
        return None, _error("interrupted", "", variant)
    except Exception as exc:  # never let a worker exception vanish
        return None, _error("internal", f"{type(exc).__name__}: {exc}", variant)


def _total(usages: Sequence[dict | None]) -> dict | None:
    """Usages summed (numbers only)."""
    total = None
    for usage in usages:
        total = add_usage(total, usage)
    return total


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
        # Relay services answer 429 when pushed too hard: at most this many requests at once, as
        # in the CLI. A job's variants run in the first pool, the requests they send in the
        # second (an edit sent in parts sends several at once)
        self._pool = ThreadPoolExecutor(max_parallel,
                                        thread_name_prefix="brushgraft-job")
        self._calls = ThreadPoolExecutor(max_parallel,
                                         thread_name_prefix="brushgraft-request")
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
        mask_sha = annot_sha = whole = None
        parts: list[_Part] = []
        refs_api = [imaging.for_api(self.store.read_image(sha), imaging.REF_MAX_PIXELS)
                    for sha in ref_images]
        if parent:
            parent_bytes = self.store.read_image(parent["image"])
        if parent and regions:
            original = imaging.open_image(parent_bytes)
            mask = imaging.union_mask(original.size, regions)
            if mask.getbbox() is None:
                raise UserError("empty_region", "The region is empty; draw it again")
            mask_bytes = imaging.png_bytes(mask)
            mask_sha = self.store.put_image(mask_bytes)["sha"]
            # A small edit of a large image goes in close-ups, to be pasted back within them: not
            # for a model that redraws the scene (nothing of its output is pasted back), nor when
            # the whole output is wanted
            info = pb.MODELS.get(model)
            boxes, plan = [], []
            if composite and (info is None or info.aligned):
                boxes = [imaging.region_mask(original.size, r["shapes"]).getbbox()
                         for r in regions]
                plan = imaging.zoom_parts(original.size, boxes)
            if plan:
                whole = _Once(lambda: self._whole_part(original, regions, full_prompt, size,
                                                       parent_bytes, mask_bytes, refs_api))
                shown = {i for _, numbers in plan for i in numbers}
                if any(b is not None and i not in shown for i, b in enumerate(boxes)):
                    parts.append(whole.get())
                parts += [self._close_up(original, regions, box, numbers, prompt,
                                         len(ref_images), lang, refs_api)
                          for box, numbers in plan]
                annot_sha = parts[0].annot_image
            else:
                annot_bytes = imaging.png_bytes(imaging.annotate(original, regions))
                annot_sha = self.store.put_image(annot_bytes)["sha"]
                images += [imaging.for_api(parent_bytes), imaging.for_api(annot_bytes)]
        elif parent:
            images.append(imaging.for_api(parent_bytes))
        images += refs_api

        job = self.store.create_job(
            project_id=project_id, parent_id=parent_id,
            kind="edit" if parent else "generate", prompt=prompt.strip(),
            full_prompt=full_prompt, regions=regions, refs=list(refs), ref_images=ref_images,
            model=model, size=size, n=n, composite=composite and bool(regions),
            mask_image=mask_sha, annot_image=annot_sha,
            requests=[p.record() for p in parts],
            parent_image=parent["image"] if parent else None)
        req = _Request(job_id=job["id"], n=n, prompt=full_prompt, model=model,
                       size=size, images=tuple(images), api_key=api_key,
                       base_url=self.settings.base_url, parent=parent_bytes,
                       mask=mask_bytes if job["composite"] else None,
                       annot=annot_bytes, overall=bool(job["prompt"]),
                       parts=tuple(parts), whole=whole)
        with self._lock:
            self._logs[job["id"]] = deque(maxlen=LOG_LINES_PER_JOB)
        self.bus.publish({"type": "job", "job": job})
        for k in range(n):
            self._pool.submit(self._run_one, req, k)
        return job

    def _close_up(self, original: Image.Image, regions: list[dict],
                  box: tuple[int, int, int, int], numbers: list[int], prompt: str,
                  ref_count: int, lang: Lang, refs: list[bytes]) -> _Part:
        """The request for the regions ``numbers``, shown in the close-up ``box``: they keep
        their numbers and colors."""
        shown = original.crop(box)
        some = imaging.shift_regions([regions[i] for i in numbers], -box[0], -box[1])
        annot = imaging.png_bytes(imaging.annotate(shown, some, numbers))
        return _Part(
            box=box, regions=tuple(numbers),
            prompt=compile_prompt(prompt, some, has_parent=True, ref_count=ref_count, lang=lang,
                                  numbers=numbers),
            size=imaging.zoom_size(box),
            images=(imaging.for_api(imaging.png_bytes(shown)), imaging.for_api(annot), *refs),
            mask=imaging.png_bytes(imaging.union_mask(shown.size, some)), annot=annot,
            annot_image=self.store.put_image(annot)["sha"])

    def _whole_part(self, original: Image.Image, regions: list[dict], full_prompt: str,
                    size: str, parent_bytes: bytes, mask_bytes: bytes,
                    refs: list[bytes]) -> _Part:
        """The request for the whole image, with every region: as an edit not sent in parts."""
        annot = imaging.png_bytes(imaging.annotate(original, regions))
        return _Part(box=None, regions=tuple(range(len(regions))), prompt=full_prompt,
                     size=size, images=(imaging.for_api(parent_bytes), imaging.for_api(annot),
                                        *refs),
                     mask=mask_bytes, annot=annot,
                     annot_image=self.store.put_image(annot)["sha"])

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

        started = time.monotonic()
        with pb.log_sink(sink):
            run = self._run_parts if req.parts else self._run_whole
            try:
                nodes, error, usage = run(req, variant, sink)
            except Exception as exc:  # a bug, or the disk: the job must still settle
                nodes, usage = [], None
                error = _error("internal", f"{type(exc).__name__}: {exc}", variant)
            if error:
                pb.log("error", f"{_ERROR_LOG[error['code']]}{': ' if error['detail'] else ''}"
                                f"{error['detail']}")
            else:
                pb.log("ok", f"Done in {time.monotonic() - started:.0f}s")

        try:
            job = self.store.record_attempt(req.job_id, ok=bool(nodes), error=error, usage=usage)
        except NotFound:  # the project was deleted meanwhile
            return
        except Exception as exc:  # the database is locked or the disk full: try once more, bare
            pb.log("error", f"Couldn't record the outcome ({type(exc).__name__}: {exc})")
            job = self.store.record_attempt(req.job_id, ok=bool(nodes), error=_error(
                "save_failed", f"{type(exc).__name__}: {exc}", variant))
        for node in nodes:
            self.bus.publish({"type": "node", "node": node})
        self.bus.publish({"type": "job", "job": job})

    def _send(self, req: _Request, prompt: str, images: Sequence[bytes], size: str,
              sink: Callable[[str, str], None], what: str = "") -> Future:
        """Send one request, in the request pool (so the cap holds across jobs)."""
        def run() -> pb.Generation:
            with pb.log_sink(sink):
                pb.log("info", f"Requesting {req.model} at {size}{what}")
                return pb.create_image(prompt, images=images, model=req.model, size=size,
                                       api_key=req.api_key, base_url=req.base_url)
        try:
            return self._calls.submit(run)
        except RuntimeError:  # shutting down
            future: Future = Future()
            future.cancel()
            return future

    def _run_whole(self, req: _Request, variant: str, sink: Callable[[str, str], None]
                   ) -> tuple[list[dict], dict | None, dict | None]:
        """One request; its image (if it is an edit of regions) pasted back."""
        gen, error = _outcome(self._send(req, req.prompt, req.images, req.size, sink), variant)
        nodes = []
        for data in gen.images if gen else []:
            try:
                nodes.append(self._save_result(req, data))
            except Exception as exc:
                error = _error("save_failed", f"{type(exc).__name__}: {exc}", variant)
        if gen and not gen.images and not error:
            error = _error("no_image", "", variant)
        return nodes, error, gen.usage if gen else None

    def _save_result(self, req: _Request, data: bytes) -> dict:
        job = self.store.get_job(req.job_id)
        common = {"project_id": job["project_id"], "parent_id": job["parent_id"],
                  "job_id": job["id"]}
        raw = self.store.put_image(data)["sha"]
        if req.mask is None or req.parent is None:
            return self.store.add_node(image=raw, **common)
        try:
            original = imaging.open_image(req.parent)
            result = imaging.open_image(data)
        except Exception as exc:  # the image is paid for: kept as it came
            pb.log("warn", f"{_NOTE_LOG[NOTE_PASTE_FAILED]} ({type(exc).__name__}: {exc})")
            return self.store.add_node(image=raw, note=NOTE_PASTE_FAILED, **common)
        if not imaging.same_aspect(original.size, result.size):
            pb.log("warn", f"Output is {result.width}x{result.height}, a different "
                           "aspect ratio from the original; not pasted back")
            return self.store.add_node(image=raw, note=NOTE_ASPECT_MISMATCH,
                                       **common)
        annotated = imaging.open_image(req.annot) if req.annot is not None else None
        try:
            mask = imaging.open_image(req.mask)
            # on the original's pixel grid: scaled back as it is, it can sit a few pixels off
            result = imaging.register(original, result, mask)
            merged, note = imaging.paste_back(original, result, mask, annotated,
                                              overall=req.overall)
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

    def _run_parts(self, req: _Request, variant: str, sink: Callable[[str, str], None]
                   ) -> tuple[list[dict], dict | None, dict | None]:
        """The parts of an edit, all at once (and the whole image after them if a close-up
        calls for it), put back together into one version. When some fail, the others (paid
        for) still make the version, with their regions only, and the error is recorded."""
        parts = list(req.parts)
        numbers = list(range(len(parts)))  # each part's place in jobs.requests
        outputs, usages, error = self._send_parts(req, parts, variant, sink)
        usage = _total(usages)
        if not any(outputs):
            return [], error, usage
        full = imaging.open_image(req.parent)
        try:
            done = imaging.merge_parts(full, self._pieces(parts, outputs), req.overall,
                                       ask_whole=not error)
            if "ask" in done:
                pb.log("info", _ASK_LOG[done["ask"]])
                part = req.whole.get()
                try:
                    numbers.append(self.store.add_job_request(req.job_id, part.record()))
                except NotFound:  # the project was deleted meanwhile
                    numbers.append(len(parts))
                more, more_usages, error = self._send_parts(req, [part], variant, sink)
                usage = add_usage(usage, _total(more_usages))
                parts.append(part)
                outputs += more
                usages += more_usages
                done = imaging.merge_parts(full, self._pieces(parts, outputs), req.overall,
                                           ask_whole=False)
        except Exception as exc:  # the images are paid for: never lose them to a paste-back problem
            pb.log("warn", f"{_NOTE_LOG[NOTE_PASTE_FAILED]} ({type(exc).__name__}: {exc})")
            try:
                return [self._save_unmerged(req, full, parts, outputs)], error, usage
            except Exception as exc2:
                return [], _error("save_failed", f"{type(exc2).__name__}: {exc2}", variant), usage
        if error:
            done["note"] = NOTE_PART_FAILED
        try:
            return [self._save_parts(req, done, parts, outputs, numbers, usages)], error, usage
        except Exception as exc:
            return [], _error("save_failed", f"{type(exc).__name__}: {exc}", variant), usage

    def _send_parts(self, req: _Request, parts: Sequence[_Part], variant: str,
                    sink: Callable[[str, str], None]
                    ) -> tuple[list[bytes | None], list[dict | None], dict | None]:
        """Send ``parts`` at once: (each one's image, None where it failed; each one's usage;
        the first error)."""
        futures = []
        for i, part in enumerate(parts):
            label = f"Request {i + 1}/{len(parts)}: " if len(parts) > 1 else ""
            if part.box:
                x0, y0, x1, y1 = part.box
                what = (f" (regions {', '.join(str(k + 1) for k in part.regions)}, a close-up of "
                        f"{x1 - x0}x{y1 - y0} at ({x0}, {y0}))")
            else:
                what = " (the whole image)"
            futures.append(self._send(req, part.prompt, part.images, part.size,
                                      lambda level, msg, label=label: sink(level, label + msg),
                                      what))
        outputs, usages, error = [], [], None
        for future in futures:  # all of them, so none is still running after the error
            gen, failed = _outcome(future, variant)
            if gen and not gen.images:
                failed = _error("no_image", "", variant)
            outputs.append(gen.images[0] if gen and gen.images else None)
            usages.append(gen.usage if gen else None)
            error = error or failed
        return outputs, usages, error

    @staticmethod
    def _pieces(parts: Sequence[_Part], outputs: Sequence[bytes | None]) -> list[tuple]:
        """The parts that came back, as merge_parts takes them."""
        return [(p.box, imaging.open_image(data), imaging.open_image(p.mask),
                 imaging.open_image(p.annot))
                for p, data in zip(parts, outputs, strict=True) if data is not None]

    def _save_parts(self, req: _Request, done: dict, parts: Sequence[_Part],
                    outputs: Sequence[bytes | None], numbers: Sequence[int],
                    usages: Sequence[dict | None]) -> dict:
        # the parts that came back, as merge_parts saw them
        back = [i for i, o in enumerate(outputs) if o is not None]
        parts, outputs = [parts[i] for i in back], [outputs[i] for i in back]
        numbers, usages = [numbers[i] for i in back], [usages[i] for i in back]
        job = self.store.get_job(req.job_id)
        common = {"project_id": job["project_id"], "parent_id": job["parent_id"],
                  "job_id": job["id"],
                  "parts": self._part_records(done["parts"], numbers, usages)}
        note = done["note"]
        if done["merged"] is None:  # the whole image's output can't be pasted back: use it
            data = next(o for p, o in zip(parts, outputs, strict=True) if p.box is None)
            if note == NOTE_ASPECT_MISMATCH:
                pb.log("warn", "The whole image's output has a different aspect ratio from the "
                               "original; not pasted back")
            else:
                pb.log("warn", _NOTE_LOG[note])
            return self.store.add_node(image=self.store.put_image(data)["sha"], note=note,
                                       **common)
        if note:
            pb.log("warn" if note == NOTE_PART_FAILED else "info", _NOTE_LOG[note])
        raw = self.store.put_image(imaging.png_bytes(done["raw"]))["sha"]
        final = self.store.put_image(imaging.png_bytes(done["merged"]))["sha"]
        if note == NOTE_OVERALL:  # adopt the whole output; the pasted-back one stays beside it
            return self.store.add_node(image=raw, raw_image=raw, merged_image=final, note=note,
                                       **common)
        return self.store.add_node(image=final, raw_image=raw, note=note, **common)

    def _part_records(self, made: Sequence[dict], numbers: Sequence[int],
                      usages: Sequence[dict | None]) -> list[dict]:
        """What each request made on its own, as nodes.parts records it (see Store.add_node)."""
        if len(made) < 2:  # one request: the version is what it made
            return []

        def stored(placed: tuple | None) -> tuple:
            if placed is None:
                return None, None
            (x0, y0, *_), im = placed
            return self.store.put_image(imaging.png_bytes(im))["sha"], [x0, y0]

        records = []
        for k, part, usage in zip(numbers, made, usages, strict=True):
            raw, raw_at = stored(part["raw"])
            merged, merged_at = stored(part["merged"])
            records.append({"request": k, "note": part["note"], "usage": _total([usage]),
                            "raw_image": raw, "raw_at": raw_at, "merged_image": merged,
                            "merged_at": merged_at})
        return records

    def _save_unmerged(self, req: _Request, full: Image.Image, parts: Sequence[_Part],
                       outputs: Sequence[bytes]) -> dict:
        """The outputs put in place as they came: the whole image's first, then the close-ups."""
        job = self.store.get_job(req.job_id)
        image = full.convert("RGBA" if full.has_transparency_data else "RGB")
        placed = sorted(((p, o) for p, o in zip(parts, outputs, strict=True) if o is not None),
                        key=lambda p: p[0].box is not None)
        for part, data in placed:
            x0, y0, x1, y1 = part.box or (0, 0, *full.size)
            out = imaging.open_image(data)
            image.paste(out.resize((x1 - x0, y1 - y0), Image.Resampling.LANCZOS), (x0, y0))
        return self.store.add_node(image=self.store.put_image(imaging.png_bytes(image))["sha"],
                                   note=NOTE_PASTE_FAILED, project_id=job["project_id"],
                                   parent_id=job["parent_id"], job_id=job["id"])

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
        self._calls.shutdown(wait=False, cancel_futures=True)

    def wait(self) -> None:
        """Until the requests already sent are done and saved (after shutdown)."""
        while self.active:
            time.sleep(0.2)
        self._pool.shutdown(wait=True)
        self._calls.shutdown(wait=True)
