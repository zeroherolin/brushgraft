"""Write the fixtures the web parity tests compare the TypeScript port against.

The browser build re-implements the image operations of brushgraft.imaging in
TypeScript. This script runs the Python versions on a set of inputs and saves
inputs and outputs as PNG and JSON under web/.parity/ (not committed);
``npm test`` then runs the TypeScript versions on the same inputs and compares.

    python scripts/parity_fixtures.py               # synthetic cases (what CI runs)
    python scripts/parity_fixtures.py --real DIR    # also real model outputs: DIR/<case>/
        {original,result,annot}.png and regions.json (see _real_cases)
"""

import argparse
import hashlib
import io
import json
import math
import shutil
import sys
from pathlib import Path

import numpy as np
import PIL
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

from brushgraft import imaging

OUT = Path(__file__).resolve().parent.parent / "web" / ".parity"


def _noise(w: int, h: int, mode: str, seed: int) -> Image.Image:
    rng = np.random.default_rng(seed)
    bands = {"L": 1, "RGB": 3, "RGBA": 4}[mode]
    arr = rng.integers(0, 256, (h, w, bands), dtype=np.uint8)
    return Image.fromarray(arr[..., 0] if bands == 1 else arr, mode)


def scene(size: tuple[int, int], seed: int) -> Image.Image:
    """Smooth blobs of colour and some texture: an image with structure, like a photo."""
    rng = np.random.default_rng(seed)
    w, h = size
    im = Image.new("RGB", size, tuple(int(v) for v in rng.integers(60, 200, 3)))
    draw = ImageDraw.Draw(im)
    for _ in range(40):
        x, y = rng.integers(0, w), rng.integers(0, h)
        r = int(rng.integers(w // 40, w // 6))
        color = tuple(int(v) for v in rng.integers(10, 246, 3))
        draw.ellipse((x - r, y - r, x + r, y + r), fill=color)
    im = im.filter(ImageFilter.GaussianBlur(3))
    grain = rng.normal(0, 4, (h, w, 3))
    return Image.fromarray(np.clip(np.asarray(im, np.float64) + grain, 0, 255).astype(np.uint8))


def _save(im: Image.Image, path: Path) -> dict:
    im.save(path)
    return {"file": path.name, "mode": im.mode}


def primitives(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    cases = []

    def case(op: str, src: Image.Image, dst: Image.Image, **args) -> None:
        k = len(cases)
        cases.append({"op": op, "args": args, "in": _save(src, out / f"{k}_in.png"),
                      "out": _save(dst, out / f"{k}_out.png")})

    for mode, (w, h), seed in (("L", (37, 23), 1), ("RGB", (64, 41), 2), ("RGB", (5, 90), 3)):
        src = _noise(w, h, mode, seed)
        for radius in (1, 2, 3, 4.5, 9, 23):
            case("blur", src, src.filter(ImageFilter.GaussianBlur(radius)), radius=radius)
        for scale in (2, 3, 4):
            size = (max(1, w // scale), max(1, h // scale))
            case("box", src, src.resize(size, Image.Resampling.BOX), size=size)
        for size in ((w * 3 + 1, h * 2 + 3), (max(1, w // 2 + 1), max(1, h // 3 + 2))):
            case("bilinear", src, src.resize(size, Image.Resampling.BILINEAR), size=size)
            case("lanczos", src, src.resize(size, Image.Resampling.LANCZOS), size=size)
            case("nearest", src, src.resize(size, Image.Resampling.NEAREST), size=size)
        if mode == "RGB":
            case("gray", src, src.convert("L"))
    rgba = _noise(40, 30, "RGBA", 4)
    case("lanczos", rgba, rgba.resize((23, 17), Image.Resampling.LANCZOS), size=(23, 17))
    # a part of the source with fractional edges, as register resamples a model's output
    rng = np.random.default_rng(9)
    for mode, (w, h), seed in (("RGB", (64, 41), 5), ("RGB", (90, 70), 6), ("L", (37, 23), 7)):
        src = _noise(w, h, mode, seed)
        for _ in range(4):
            x0, y0 = float(rng.uniform(0, w * 0.1)), float(rng.uniform(0, h * 0.1))
            x1, y1 = float(rng.uniform(w * 0.9, w)), float(rng.uniform(h * 0.9, h))
            size = (int(rng.integers(w // 2, w * 2)), int(rng.integers(h // 2, h * 2)))
            box = (x0, y0, x1, y1)
            case("lanczos", src, src.resize(size, Image.Resampling.LANCZOS, box=box), size=size,
                 box=box)
        box = (0, 0.75, w, h - 0.25)  # only shifted, one way
        case("lanczos", src, src.resize((w, h), Image.Resampling.LANCZOS, box=box), size=(w, h),
             box=box)
    (out / "cases.json").write_text(json.dumps(cases, indent=1))


def _random_regions(size: tuple[int, int], rng: np.random.Generator,
                    kinds: tuple[str, ...] = ("rect", "ellipse", "lasso", "brush"),
                    ops: bool = False) -> list[dict]:
    w, h = size
    regions = []
    for _ in range(int(rng.integers(1, 3))):
        kind = rng.choice(kinds)
        x, y = float(rng.uniform(0.1, 0.6) * w), float(rng.uniform(0.1, 0.6) * h)
        rw, rh = float(rng.uniform(0.08, 0.3) * w), float(rng.uniform(0.08, 0.3) * h)
        if kind in ("rect", "ellipse"):
            shape = {"type": str(kind), "x": x, "y": y, "w": rw, "h": rh}
        elif kind == "lasso":
            n = int(rng.integers(5, 12))
            pts = [[x + rw / 2 + rw / 2 * math.cos(t) * rng.uniform(0.6, 1),
                    y + rh / 2 + rh / 2 * math.sin(t) * rng.uniform(0.6, 1)]
                   for t in np.linspace(0, 2 * math.pi, n, endpoint=False)]
            shape = {"type": "lasso", "points": pts}
        else:
            pts = [[x + rw * t, y + rh * math.sin(3 * t)] for t in np.linspace(0, 1, 12)]
            shape = {"type": "brush", "radius": float(rng.uniform(4, 30)), "points": pts}
        shapes = [shape]
        if ops:  # cut a piece out, then maybe keep only part: as with Alt and Shift+Alt
            shapes.append({"type": "ellipse", "x": x + rw * 0.3, "y": y + rh * 0.3, "w": rw * 0.4,
                           "h": rh * 0.4, "op": "subtract"})
            if rng.random() < 0.5:
                shapes.append({"type": "rect", "x": x - rw * 0.2, "y": y + rh * 0.1,
                               "w": rw * 0.9, "h": rh * 1.2, "op": "intersect"})
        regions.append({"shapes": shapes, "instruction": ""})
    return regions


def _fake_edit(original: Image.Image, mask: Image.Image, rng: np.random.Generator,
               kind: str) -> Image.Image:
    """What a model might return: the region repainted, the rest drifted a little."""
    w, h = original.size
    arr = np.asarray(original, np.float64)
    gain = rng.uniform(0.93, 1.07, 3)
    offset = rng.uniform(-12, 12, 3)
    drifted = np.clip(arr * gain + offset + rng.normal(0, 2, arr.shape), 0, 255)
    out = Image.fromarray(drifted.astype(np.uint8))
    bbox = mask.getbbox()
    draw = ImageDraw.Draw(out)
    x0, y0, x1, y1 = bbox
    color = tuple(int(v) for v in rng.integers(0, 256, 3))
    if kind == "spill":  # the new object reaches past the region
        dx, dy = (x1 - x0) * 0.4, (y1 - y0) * 0.4
        draw.ellipse((x0 - dx, y0 - dy, x1 + dx, y1 + dy), fill=color)
    elif kind == "inside":
        draw.ellipse((x0, y0, x1, y1), fill=color)
    elif kind == "reframed":
        out = out.transform(out.size, Image.Transform.AFFINE, (0.8, 0, w * 0.1, 0, 0.8, h * 0.1))
    elif kind == "everything":
        out = Image.fromarray(255 - np.asarray(out))
    elif kind == "global":  # a new look everywhere (an overcast sky), the drawing kept in place
        gray = np.asarray(original.convert("L"), np.float64)[..., None]
        tint = gray * np.array([0.55, 0.6, 0.7]) + np.array([20, 30, 70])
        out = Image.fromarray(np.clip(tint, 0, 255).astype(np.uint8))
        ImageDraw.Draw(out).ellipse((x0, y0, x1, y1), fill=color)
    elif kind == "cold":  # new light everywhere (a winter day): a tone shift match_tone would undo
        cold = arr * np.array([0.88, 0.9, 1.0]) + np.array([-28, -18, 26])
        out = Image.fromarray(np.clip(cold, 0, 255).astype(np.uint8))
        ImageDraw.Draw(out).ellipse((x0, y0, x1, y1), fill=color)
    return out


def _text_page(size: tuple[int, int], word: str, seed: int) -> Image.Image:
    """A screenshot: rows of text between thin rules, ``word`` in the middle of row 5."""
    rng = np.random.default_rng(seed)
    im = Image.new("RGB", size, (250, 250, 248))
    d = ImageDraw.Draw(im)
    font = ImageFont.load_default(size=26)
    for row, y in enumerate(range(30, size[1] - 30, 46)):
        d.line((20, y - 8, size[0] - 20, y - 8), fill=(190, 190, 195), width=1)
        for x in range(30, size[0] - 120, 150):
            if not (row == 5 and x == 480):
                d.text((x, y), "".join(rng.choice(list("abcdefgh0123456789"), 5)), font=font,
                       fill=(30, 30, 40))
    d.text((480, 260), word, font=font, fill=(30, 30, 40))
    return im


def _drawn_at(page: Image.Image, size: tuple[int, int], kx: float, tx: float, ky: float,
              ty: float) -> Image.Image:
    """``page`` drawn by a model at ``size``: its pixel at c lands at (1 + k) c + t (in the
    page's pixels) once resized back."""
    w, h = page.size
    pad = 60
    padded = Image.fromarray(np.pad(np.asarray(page), ((pad, pad), (pad, pad), (0, 0)),
                                    mode="edge"))
    box = (pad - tx / (1 + kx), pad - ty / (1 + ky), pad + (w - tx) / (1 + kx),
           pad + (h - ty) / (1 + ky))
    return padded.resize(size, Image.Resampling.LANCZOS, box=box)


def paste_cases(out: Path, real: Path | None) -> None:
    out.mkdir(parents=True, exist_ok=True)
    cases = []

    def record(name: str, original: Image.Image, raw: Image.Image, regions: list[dict],
               annotated: Image.Image | None, overall: bool = False) -> None:
        """``raw`` as the model returned it: registered onto the original, then pasted back."""
        d = out / name
        d.mkdir(exist_ok=True)
        mask = imaging.union_mask(original.size, regions)
        original.save(d / "original.png")
        raw.save(d / "raw.png")
        box = imaging.registration_box(original, raw, mask)
        result = imaging.register(original, raw, mask)
        result.save(d / "result.png")
        mask.save(d / "mask.png")
        if annotated is not None:
            annotated.save(d / "annot.png")
        merged, note = imaging.paste_back(original, result, mask, annotated, overall=overall)
        toned = imaging.match_tone(original, result, mask)
        toned.save(d / "toned.png")
        if merged is not None:
            merged.save(d / "merged.png")
        echo = imaging.echoed_marks(original, annotated, toned) if annotated is not None else None
        cases.append({"name": name, "note": note, "merged": merged is not None, "overall": overall,
                      "aligned": imaging.aligned(original, result, mask), "regions": regions,
                      "annot": annotated is not None, "echo": None if echo is None else
                      int(echo.histogram()[255]),
                      "box": None if box is None else {"pad": box[0], "box": list(box[1])},
                      "rgba": original.mode == "RGBA"})

    rng = np.random.default_rng(7)
    kinds = ["inside", "spill", "spill", "inside", "reframed", "everything", "global", "global",
             "cold"]
    for k, kind in enumerate(kinds * 2):
        size = [(320, 240), (480, 300), (200, 400), (640, 427), (96, 96), (1000, 667),
                (640, 480), (900, 600)][k % 8]
        original = scene(size, 100 + k)
        regions = _random_regions(size, rng)
        mask = imaging.union_mask(size, regions)
        if mask.getbbox() is None:
            continue
        result = _fake_edit(original, mask, rng, kind)
        annotated = imaging.annotate(original, regions)
        if k % 3 == 0:  # the model copied the boxes into its output
            result = Image.composite(annotated, result, ImageChops.difference(
                annotated, original).convert("L").point(lambda v: 255 if v > 48 else 0))
        # with an overall request: global changes are kept whole, others pasted back as usual
        record(f"syn{k:02d}_{kind}", original, result, regions, annotated if k % 4 else None,
               overall=kind in ("global", "cold") or k % 5 == 0)

    # Screenshots: the model's output a little off and drawn at its own size (register), with
    # the word rewritten past the region or beside it (whole_pieces)
    word = [{"type": "rect", "x": 474, "y": 256, "w": 30, "h": 30}]
    beside = [{"type": "rect", "x": 400, "y": 300, "w": 60, "h": 40}]
    other = [{"type": "rect", "x": 170, "y": 160, "w": 90, "h": 40}]
    text_cases = [
        ("word", word, "12.3us", (924, 534), (0.002, -1.4, -0.011, 0.8)),
        ("beside", beside, "12.3us", (900, 520), (0.0, 0.0, 0.0, 0.0)),
        ("shifted", other, "41.1us", (900, 520), (0.0, 1.5, 0.0, -2.5)),
        ("larger", word, "77.0ms", (1312, 758), (-0.004, 2.2, 0.003, -1.9)),
    ]
    for k, (kind, shapes, new, out_size, (kx, tx, ky, ty)) in enumerate(text_cases):
        page = _text_page((900, 520), "41.1us", 3)
        drawn = _text_page((900, 520), new, 3)
        if kind == "shifted":  # only the region changed: a block drawn over it
            ImageDraw.Draw(drawn).rectangle((180, 168, 250, 192), fill=(200, 60, 40))
        regions = [{"shapes": shapes, "instruction": "x"}]
        record(f"text{k}_{kind}", page, _drawn_at(drawn, out_size, kx, tx, ky, ty), regions,
               imaging.annotate(page, regions) if k % 2 else None)

    # A whole line rewritten, running far past a region over its first half (a poster's date)
    def line_page(line: str) -> Image.Image:
        im = Image.new("RGB", (1536, 1024), (250, 248, 240))
        d = ImageDraw.Draw(im)
        font = ImageFont.load_default(size=44)
        for y in (100, 230, 640, 770):
            d.text((90, y), "lorem ipsum dolor sit amet", font=font, fill=(90, 40, 20))
        d.text((90, 420), line, font=font, fill=(90, 40, 20))
        return im

    page = line_page("2026-10-25  Sat  14:00")
    regions = [{"shapes": [{"type": "rect", "x": 80, "y": 410, "w": 330, "h": 75}],
                "instruction": "x"}]
    record("text4_line", page, _drawn_at(line_page("2026-11-08  Sun  15:00"), (1536, 1024),
                                         0.001, 0.8, -0.002, -1.2), regions, None)
    # "1234" became "99" in a proportional font: the rest of the line moved left
    sum_page = Image.new("RGB", (1536, 1024), (245, 245, 240))
    for x in range(0, 1536, 64):
        ImageDraw.Draw(sum_page).line((x, 0, x, 1024), fill=(200, 200, 200))
    shorter = sum_page.copy()
    font = ImageFont.load_default(size=48)
    ImageDraw.Draw(sum_page).text((200, 300), "Total: 1234 USD per month", font=font, fill=20)
    ImageDraw.Draw(shorter).text((200, 300), "Total: 99 USD per month", font=font, fill=20)
    record("text5_reflow", sum_page, shorter, [{"shapes": [
        {"type": "rect", "x": 345, "y": 300, "w": 125, "h": 60}], "instruction": "x"}], None)

    # A sticker on transparency: the model returns the hidden part white, the edit inside
    sticker = scene((640, 480), 77).convert("RGBA")
    yy, xx = np.mgrid[0:480, 0:640]
    shows = ((xx - 320) / 230) ** 2 + ((yy - 240) / 190) ** 2 <= 1
    sticker.putalpha(Image.fromarray((shows * 255).astype(np.uint8)))
    regions = [{"shapes": [{"type": "rect", "x": 260, "y": 190, "w": 120, "h": 100}]}]
    flat = _fake_edit(sticker.convert("RGB"), imaging.union_mask((640, 480), regions), rng,
                      "inside")
    flat.paste((255, 255, 255), mask=Image.fromarray((~shows * 255).astype(np.uint8)))
    record("alpha_sticker", sticker, flat, regions, None)

    for d in sorted(real.iterdir()) if real else []:
        if not (d / "regions.json").exists():
            continue
        original = imaging.open_image((d / "original.png").read_bytes())
        result = imaging.open_image((d / "result.png").read_bytes())
        if not imaging.same_aspect(original.size, result.size):
            continue
        annot = d / "annot.png"
        record(f"real_{d.name}", original, result, json.loads((d / "regions.json").read_text()),
               imaging.open_image(annot.read_bytes()) if annot.exists() else None,
               overall=(d / "overall").exists())
    (out / "cases.json").write_text(json.dumps(cases, indent=1))


def mask_cases(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(11)
    cases = []
    # regions that run to the image's edge, where the number must not go: a sky, a strip, a side
    edges = [[{"shapes": [{"type": "rect", "x": 0, "y": 0, "w": 400, "h": 110}]}],
             [{"shapes": [{"type": "rect", "x": 60, "y": 2, "w": 200, "h": 5}]}],
             [{"shapes": [{"type": "rect", "x": 250, "y": 0, "w": 150, "h": 300}]},
              {"shapes": [{"type": "rect", "x": 0, "y": 250, "w": 120, "h": 50}]}]]
    for k in range(18 + len(edges)):
        size = (int(rng.integers(60, 400)), int(rng.integers(60, 400))) if k < 18 else (400, 300)
        # the last six random ones are rectangles only, whose masks (and so boxes) match
        # Pillow's exactly, as do the edge cases
        regions = edges[k - 18] if k >= 18 else _random_regions(
            size, rng, ("rect",) if k >= 12 else ("rect", "ellipse", "lasso", "brush"),
            ops=6 <= k < 12)
        base = scene(size, k)
        imaging.union_mask(size, regions).save(out / f"{k}.png")
        base.save(out / f"{k}_orig.png")
        imaging.annotate(base, regions).save(out / f"{k}_annot.png")
        # where the numbered badges are (the numbers use different fonts, so tests skip them)
        w, h = size
        badge = imaging.annotation_badge(size)
        occupied = imaging.union_mask(size, regions)
        badges = [list(imaging._badge_center(occupied, anchors, badge))
                  for ring, anchors in imaging.annotation_layout(size, regions) if ring is not None]
        cases.append({"size": size, "regions": regions, "badges": badges, "badge": badge,
                      "exact": k >= 12,
                      "feather": imaging.feather_radius(size)})
    (out / "cases.json").write_text(json.dumps(cases, indent=1))


def rules_cases(out: Path) -> None:
    """Prompts and size rules: plain values, compared as JSON."""
    import itertools

    import promptbrush as pb

    from brushgraft.errors import UserError
    from brushgraft.prompts import compile_prompt

    out.mkdir(parents=True, exist_ok=True)
    prompts = []
    from brushgraft.prompts import MAX_FULL_PROMPT, MAX_INSTRUCTION, MAX_PROMPT

    # Lengths are counted alike (code points: an emoji is one character, as in Python), at and
    # past each limit
    texts = ["", "  ", "a cat", "  make it blue \n", "红色的帽子"]
    instrs = [[], [""], ["a hat"], ["a hat", ""], ["a hat", "  a scarf  "], ["x"] * 20, ["x"] * 21]
    for prompt, instr, parent, refs, lang in itertools.product(
            texts, instrs, (False, True), (0, 1, 3), ("en", "zh")):
        regions = [{"instruction": i, "shapes": []} for i in instr]
        try:
            res = {"text": compile_prompt(prompt, regions, has_parent=parent, ref_count=refs,
                                          lang=lang)}
        except UserError as exc:
            res = {"error": exc.code, "params": exc.params, "message": str(exc)}
        prompts.append({"prompt": prompt, "regions": regions, "parent": parent, "refs": refs,
                        "lang": lang, **res})
    # At and past each limit (a few cases: the texts are long)
    long = [("猫" * MAX_PROMPT, [], False), ("🐈" * MAX_PROMPT + "x", [], False),
            ("", ["a", "y" * (MAX_INSTRUCTION + 1)], True),
            ("", ["z" * (MAX_FULL_PROMPT // 2)] * 2, True), ("w" * 100, ["v" * 100], True)]
    for prompt, instr, parent in long:
        regions = [{"instruction": i, "shapes": []} for i in instr]
        try:
            res = {"text": compile_prompt(prompt, regions, has_parent=parent, lang="zh")}
        except UserError as exc:
            res = {"error": exc.code, "params": exc.params, "message": str(exc)}
        prompts.append({"prompt": prompt, "regions": regions, "parent": parent, "refs": 0,
                        "lang": "zh", **res})
    sizes = []
    dims = [(1, 1), (640, 480), (1024, 1024), (1536, 1024), (4000, 3000), (5000, 100), (100, 5000),
            (3840, 2160), (800, 600), (1200, 1600), (333, 777), (4096, 4096), (97, 31),
            (2048, 1152), (1600, 1200), (3000, 1000), (3001, 1000), (7680, 4320)]
    rng = np.random.default_rng(5)
    dims += [(int(a), int(b)) for a, b in rng.integers(1, 6000, (80, 2))]
    for w, h in dims:
        sizes.append({"w": w, "h": h, "fit": pb.fit_size(w, h)})
    checks = []
    quiet = pb.log_sink(lambda level, msg: None)  # the size warnings are expected here
    quiet.__enter__()
    for model in ("gpt-image-2.5-flare", "gpt-image-2", "gemini-3-pro-image"):
        for size in ("auto", "1024x1024", "1536x1024", "1000x1000", "4000x2000", "3840x2160",
                     "16x16", "4096x1024", "2048x512", "1600x1200", "8000x8000", "1024x10240"):
            try:
                pb.check_size(model, size)
                checks.append({"model": model, "size": size, "ok": True})
            except ValueError as exc:
                checks.append({"model": model, "size": size, "ok": False, "message": str(exc)})
    quiet.__exit__(None, None, None)
    (out / "rules.json").write_text(json.dumps(
        {"prompts": prompts, "sizes": sizes, "checks": checks}, ensure_ascii=False))


def archive_cases(out: Path) -> None:
    """A project zip and an asset pack written by Python, for the TypeScript reader to open."""
    from brushgraft import archive

    out.mkdir(parents=True, exist_ok=True)
    img = []
    for k in range(3):
        buf = io.BytesIO()
        scene((64 + k * 8, 48), 30 + k).save(buf, "PNG")
        img.append(buf.getvalue())
    sha = [hashlib.sha256(b).hexdigest() for b in img]
    region = {"shapes": [{"type": "rect", "x": 4, "y": 5, "w": 20.5, "h": 9},
                         {"type": "lasso", "points": [[1, 1], [9, 2], [5, 12]]},
                         {"type": "brush", "radius": 6, "points": [[3, 3], [20, 9]]}],
              "instruction": "a red 椅子"}
    project = {"name": "Chairs — ünï", "created_at": 1700000000.5, "updated_at": 1700000100.25}
    nodes = [
        {"id": "aa11", "parent_id": None, "job_id": None, "image": sha[0], "raw_image": None,
         "merged_image": None, "note": "", "label": "room.png", "starred": True,
         "created_at": 1700000001.0},
        {"id": "bb22", "parent_id": "aa11", "job_id": "j1", "image": sha[1], "raw_image": sha[2],
         "merged_image": sha[1], "note": "spill_grown", "label": "", "starred": False,
         "created_at": 1700000050.0},
    ]
    jobs = [{"id": "j1", "parent_id": "aa11", "kind": "edit", "prompt": "", "full_prompt": "x",
             "regions": [region], "refs": ["aa11", "asset:hat1"],
             "ref_images": [sha[0], sha[2]], "model": "gpt-image-2", "size": "1536x1024",
             "n": 1, "composite": True, "mask_image": None, "annot_image": None, "status": "done",
             "done": 1, "failed": 0,
             "errors": [{"code": "network", "detail": "boom", "variant": "1/2"}],
             "usage": {"total_tokens": 12}, "created_at": 1700000040.0,
             "finished_at": 1700000049.0}]
    with open(out / "project.zip", "wb") as f:
        archive.write_archive(f, project, nodes, jobs, dict(zip(sha, img, strict=True)), "0.0.0")
    (out / "expected.json").write_text(json.dumps(
        {"project": project, "nodes": nodes, "jobs": jobs, "images": sha}, ensure_ascii=False))
    assets = [{"name": "帽子 hat", "image": sha[2], "created_at": 1700000200.5},
              {"name": "room", "image": sha[0], "created_at": 1700000100.0}]
    (out / "assets.zip").write_bytes(archive.asset_pack_bytes(
        assets, {sha[2]: img[2], sha[0]: img[0]}, "0.0.0"))
    (out / "assets.json").write_text(json.dumps({"assets": assets}, ensure_ascii=False))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--real", type=Path, help="directory of real model outputs")
    args = parser.parse_args(argv)
    # the TypeScript resize follows Pillow 13, which runs the vertical pass first when the
    # height shrinks much more than the width; older versions round differently there
    if int(PIL.__version__.split(".")[0]) < 13:
        print(f"Pillow {PIL.__version__}: the fixtures need Pillow 13 or later "
              "(pip install -U pillow; Python 3.11+)", file=sys.stderr)
        return 1
    if OUT.exists():
        shutil.rmtree(OUT)
    primitives(OUT / "primitives")
    mask_cases(OUT / "masks")
    paste_cases(OUT / "paste", args.real)
    rules_cases(OUT / "rules")
    archive_cases(OUT / "archive")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
