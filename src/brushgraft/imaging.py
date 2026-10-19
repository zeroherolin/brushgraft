"""Region masks, the annotated image, paste-back, and image normalization.

All coordinates are pixels of the original image, independent of the UI zoom.
Measured behavior (see promptbrush.MODELS): models change the whole image a
little when editing, but "original + annotated copy" lets every model find the
right spot. So an edit sends the annotated copy, which outlines each region
along its own shape, to say where, and the result is pasted back onto the
original, leaving the pixels outside the region and the new content untouched
(see paste_back).
"""

import io
import math
from collections.abc import Sequence

import numpy as np
from PIL import Image, ImageChops, ImageCms, ImageDraw, ImageFilter, ImageFont, ImageOps

import promptbrush as pb

from brushgraft.errors import UserError
from brushgraft.store import (NOTE_ASPECT_MISMATCH, NOTE_OVERALL, NOTE_REFRAMED, NOTE_SPILL_GROWN,
                              NOTE_SPILL_TOO_LARGE)

# Region colors by index; the web UI uses the same list (see /api/config)
REGION_COLORS = ("#ff3b30", "#007aff", "#34c759", "#ff9500", "#af52de",
                 "#ff2d55", "#00c7be", "#ffcc00")
# Don't paste back when output and original aspect ratios differ by more than
# this (gemini models, for one, always return a square)
ASPECT_TOLERANCE = 0.02
# Shape coordinates, in px, are taken within ±MAX_COORD: far past any image, while drawing what
# lies beyond takes time (Pillow spends seconds on an ellipse a million pixels across)
MAX_COORD = 100_000
# Space between a region and its outline, in outline widths: close, so the outline shows the
# region's own shape (an eraser's cut too), without covering the pixels at its edge
ANNOT_GAP = 1
# Copied annotation marks count only when at least this share of them is reproduced
ECHO_MIN_SHARE = 0.15
# Paste-back works on copies at 1/SPILL_SCALE size (less on small images)
SPILL_SCALE = 4
# Growing the paste-back area to take in new content that belongs to the region
SPILL_MIN_DELTA = 12.0     # a "strong" change: Lab distance of at least this much
SPILL_DRIFT_FACTOR = 3.5   # and clearly more than the model's overall drift
SPILL_NEAR = 16            # px: drift is measured beyond this distance from the region
BRIDGE_RADII = 8           # large patches within this many feather radii count as touching
SPILL_MIN_PATCH = 384      # px^2: patches smaller than this are never bridged to
SPILL_PATCH_SHARE = 0.02   # ... nor are patches smaller than this share of the region
SPILL_MAX_GROWTH = 6.0     # growth adds at most 6 times the region's area
SPILL_MAX_SHARE = 0.4      # and at most 40% of the image
SPILL_ESCALATE = 4         # thresholds tried (x1.6 each) before growth counts as runaway
SPILL_NOTE_GROWTH = 0.1    # only report growth beyond 10% of the region
# Judging the output against the original takes the area this far from the region
ALIGN_MARGIN = 120         # px
ALIGN_MIN_CORR = 0.5       # fine-detail correlation below this: the output was reframed
# Putting the output on the original's pixel grid (register): offsets are measured on patches
# away from the regions, first on a copy about REGISTER_COARSE px across, then at full size
REGISTER_COARSE = 384      # px: the long side of the copy the first search runs on
REGISTER_REACH = 0.02      # the farthest offset looked for, as a share of the long side
REGISTER_TILE = 32         # px: the patches measured at full size (16 on the small copy)
REGISTER_MAX_TILES = 400   # patches measured at most, spread over the image
REGISTER_MIN_SHIFT = 0.5   # px: an output nowhere further off than this is left as it is
REGISTER_MAX_SPREAD = 0.75  # px: patches must agree with the fitted offsets to within this
REGISTER_NEAR = 256        # px: patches this close to the regions settle what is left near them
# Whole pieces in the feathered edge (whole_pieces): where the output differs strongly from the
# original near the area (a letter rewritten, an object redrawn), blending the two shows both
PIECE_BLUR = 1.5           # px: smooths away the edge jitter of text the model only redrew
PIECE_WEAK = 24            # levels: how far a piece of change extends
PIECE_CORE = 96            # levels: a piece counts only with a core this strong. Measured after
#                            registration: letters the model only redrew reach it 1% of the time,
#                            letters it rewrote always do
PIECE_ZONE = 40            # feather radii: how far from the area pieces are looked at. A rewritten
#                            line (a date, a price) often runs well past the region, and when a
#                            word changes length the rest of its line moves along
# An overall request that changed the whole image (a new sky): far from the regions, more than
# this share changed by more than this much. Measured on 397 edits with regions only, models
# changed at most 18% of the far field that much on their own; a requested overcast sky, 30%.
# Read before the tone drift is undone: a change of light or color is mostly a shift of tones
OVERALL_DELTA = 20.0       # Lab distance
OVERALL_SHARE = 0.2
# Undoing the model's overall tone drift
TONE_MAX_GAIN = 0.15       # never scales a channel by more than 15%
TONE_MAX_OFFSET = 30.0     # or shifts it by more than this many levels
TONE_MIN_SPAN = 80         # levels the fit must span to estimate a gain (else offset only)
TONE_FADE = 40             # beyond the measured levels the correction fades out over this many
TONE_KEEP = 60             # percent of pixels, the best-fitting, the fit is made on
# Images sent to the API are shrunk beyond this size, to keep uploads fast
API_MAX_BYTES = 8 * 1024 * 1024
# Reference images only convey content and style; full resolution isn't needed
REF_MAX_PIXELS = 1536 * 1536
# Uploads in these formats are kept as is; others (GIF, rotated JPEG) become PNG
KEEP_UPLOAD_FORMATS = {"PNG", "JPEG", "WEBP"}
# A small edit in a large image is sent as a close-up: the area around the regions, in the image's
# proportions. Shown whole, a large image is scaled down to the model's working size first, and a
# region a few hundred pixels across is then too small to edit (measured on a 416x107 box in a
# 3840x2160 diagram, gpt-image-2: sent whole, left as it was 2 times out of 2; as a 1366x769
# close-up, fixed 1 of 2; as a 1024x576 one, fixed 4 of 5). The result is pasted back within the
# close-up, as usual. Regions far apart get a close-up each (see zoom_parts).
ZOOM_CONTEXT = 2.0               # the close-up is at least twice the regions' extent
ZOOM_MIN_PIXELS = 768 * 768      # and covers at least this many of the image's pixels, for context
ZOOM_MAX_SHARE = 0.35            # used only when it is at most this share of the image
ZOOM_OUTPUT_PIXELS = 1536 * 1024  # asked for at least this size, scaled back down: finer detail
ZOOM_MAX_PARTS = 4               # close-ups per edit at most (each is a request)


def region_color(index: int) -> str:
    return REGION_COLORS[index % len(REGION_COLORS)]


def zoom_box(size: tuple[int, int], box: tuple[int, int, int, int]
             ) -> tuple[int, int, int, int] | None:
    """The close-up to send for regions within ``box`` (their bounding box, ends exclusive) on an
    image of ``size``, as (left, top, right, bottom); None to send the whole image."""
    width, height = size
    x0, y0, x1, y1 = box
    aspect = width / height
    w = max((x1 - x0) * ZOOM_CONTEXT, (y1 - y0) * ZOOM_CONTEXT * aspect)
    if w * (w / aspect) < ZOOM_MIN_PIXELS:
        w = math.sqrt(ZOOM_MIN_PIXELS * aspect)
    w = math.ceil(w)
    h = math.ceil(w / aspect)
    if w > width or h > height or w * h > ZOOM_MAX_SHARE * width * height:
        return None
    left = math.floor(min(max((x0 + x1) / 2 - w / 2, 0), width - w))
    top = math.floor(min(max((y0 + y1) / 2 - h / 2, 0), height - h))
    return left, top, left + w, top + h


def zoom_parts(size: tuple[int, int], boxes: Sequence[tuple[int, int, int, int] | None]
               ) -> list[tuple[tuple[int, int, int, int], list[int]]]:
    """The close-ups to send regions in, given each one's bounding box on an image of ``size``
    (None for an empty region): [(close-up, the regions' indices)], in the regions' order.

    Regions close together share a close-up: the two whose shared one is smallest are put
    together, as long as one fits. Regions too large for any are left out, and so are the
    largest close-ups past ZOOM_MAX_PARTS: those regions go with the whole image.
    """
    def union(group: list[int]) -> tuple[int, int, int, int]:
        bs = [boxes[i] for i in group]
        return (min(b[0] for b in bs), min(b[1] for b in bs),
                max(b[2] for b in bs), max(b[3] for b in bs))

    def area(z: tuple[int, int, int, int]) -> int:
        return (z[2] - z[0]) * (z[3] - z[1])

    groups = [[i] for i, b in enumerate(boxes) if b is not None and zoom_box(size, b)]
    while True:
        best = None
        for a in range(len(groups)):
            for b in range(a + 1, len(groups)):
                z = zoom_box(size, union(groups[a] + groups[b]))
                if z and (best is None or area(z) < best[0]):
                    best = (area(z), a, b)
        if best is None:
            break
        _, a, b = best
        groups[a] = sorted(groups[a] + groups[b])
        del groups[b]
    parts = [(zoom_box(size, union(g)), g) for g in groups]
    if len(parts) > ZOOM_MAX_PARTS:
        kept = sorted(parts, key=lambda p: area(p[0]))[:ZOOM_MAX_PARTS]
        parts = [p for p in parts if p in kept]
    return parts


def zoom_size(box: tuple[int, int, int, int]) -> str:
    """The size to ask for a close-up in: its proportions, at least ZOOM_OUTPUT_PIXELS."""
    w, h = box[2] - box[0], box[3] - box[1]
    k = max(1.0, math.sqrt(ZOOM_OUTPUT_PIXELS / (w * h)))
    return pb.fit_size(math.floor(w * k), math.floor(h * k))


def shift_regions(regions: Sequence[dict], dx: float, dy: float) -> list[dict]:
    """``regions`` moved by (dx, dy): their shapes as they lie on a crop."""
    def shift(shape: dict) -> dict:
        if shape["type"] in ("rect", "ellipse"):
            return {**shape, "x": shape["x"] + dx, "y": shape["y"] + dy}
        return {**shape, "points": [[x + dx, y + dy] for x, y in shape["points"]]}
    return [{**r, "shapes": [shift(s) for s in r["shapes"]]} for r in regions]


def feather_radius(size: tuple[int, int]) -> int:
    """Feather radius of the paste-back edge, scaled to the image (~9px at 1536)."""
    return max(2, round(max(size) * 0.006))


# ---------------------------------------------------------------------------
# Regions
# ---------------------------------------------------------------------------
def _draw_shape(draw: ImageDraw.ImageDraw, shape: dict, fill: int = 255) -> None:
    kind = shape["type"]
    if kind == "rect":
        x, y, w, h = shape["x"], shape["y"], shape["w"], shape["h"]
        draw.rectangle((x, y, x + w, y + h), fill=fill)
    elif kind == "ellipse":
        x, y, w, h = shape["x"], shape["y"], shape["w"], shape["h"]
        draw.ellipse((x, y, x + w, y + h), fill=fill)
    elif kind == "lasso":
        draw.polygon([tuple(p) for p in shape["points"]], fill=fill)
    elif kind == "brush":
        r = shape["radius"]
        points: list[tuple[float, float]] = []
        for i, p in enumerate(shape["points"]):
            # points closer than a quarter radius add nothing visible (as in the TS port)
            if points and math.dist(p, points[-1]) < r / 4 and i < len(shape["points"]) - 1:
                continue
            points.append(tuple(p))
        if len(points) > 1:
            # no joint="curve": the discs below round the joints, and Pillow's are slow when wide
            draw.line(points, fill=fill, width=round(2 * r))
        for x, y in points:  # round caps and joints
            draw.ellipse((x - r, y - r, x + r, y + r), fill=fill)
    else:
        raise ValueError(f"unknown region shape: {kind}")


def region_mask(size: tuple[int, int], shapes: Sequence[dict]) -> Image.Image:
    """Rasterize shapes into one L-mode mask: 255 is selected.

    Shapes apply in order, as selection tools combine them: ``op`` "add" (the
    default) adds the shape, "subtract" removes it, "intersect" keeps only what
    lies inside it.
    """
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    for shape in shapes:
        op = shape.get("op", "add")
        if op == "add":
            _draw_shape(draw, shape)
        elif op == "subtract":
            _draw_shape(draw, shape, fill=0)
        elif op == "intersect":
            keep = Image.new("L", size, 0)
            _draw_shape(ImageDraw.Draw(keep), shape)
            mask = ImageChops.darker(mask, keep)
            draw = ImageDraw.Draw(mask)
        else:
            raise ValueError(f"unknown shape operation: {op}")
    return mask


def union_mask(size: tuple[int, int], regions: Sequence[dict]) -> Image.Image:
    """Every region's mask together. Each region combines its own shapes; a shape that
    subtracts from one region leaves the others alone."""
    mask = Image.new("L", size, 0)
    for region in regions:
        mask = ImageChops.lighter(mask, region_mask(size, region["shapes"]))
    return mask


def annotation_stroke(size: tuple[int, int]) -> int:
    """Width of the outlines in the annotated image."""
    return max(3, round(max(size) / 400))


def annotation_badge(size: tuple[int, int]) -> int:
    """Radius of the numbered discs in the annotated image."""
    return max(12, round(max(size) / 70))


def annotate(image: Image.Image, regions: Sequence[dict],
             numbers: Sequence[int] | None = None) -> Image.Image:
    """Outline each region and number it: the second image sent to the model. ``numbers``
    gives each region's place among all of an edit's (from 0), when only some are shown: it
    keeps its number and color.

    The outline follows the region's own shape (a lasso around two eyes is two
    rings, a diagonal brush stroke a slanted band, the notch an eraser cut stays
    a notch), ``ANNOT_GAP`` line widths outside it: what is circled is what was
    selected, small regions included. A rectangle around a slanted or irregular
    region would take in corners that aren't part of it, and models fill those
    too: measured on real edits, outlines kept the change to the marked shape
    about twice as well as boxes. An outline never covers its own region (where two
    regions touch, it may cross the other, which keeps the border between them). A
    model that copies the lines into its output is caught by paste_back, which puts
    the original back along them. The number sits just outside the outline,
    touching it, near the top-left unless that would cover a region.
    """
    out = image.convert("RGB")
    w, h = out.size
    badge = annotation_badge(out.size)
    font = ImageFont.load_default(size=round(badge * 1.3))
    occupied = union_mask(out.size, regions)
    pixels = np.asarray(out).copy()
    badges = []
    for k, (ring, anchors) in enumerate(annotation_layout(out.size, regions)):
        if ring is None:
            continue
        i = numbers[k] if numbers is not None else k
        color = region_color(i)
        pixels[ring] = tuple(int(color[k:k + 2], 16) for k in (1, 3, 5))
        badges.append((_badge_center(occupied, anchors, badge), color, i))
    out = Image.fromarray(pixels)
    draw = ImageDraw.Draw(out)
    for (cx, cy), color, i in badges:
        draw.ellipse((cx - badge, cy - badge, cx + badge, cy + badge), fill=color)
        draw.text((cx, cy), str(i + 1), fill="white", font=font, anchor="mm")
    return out


def annotation_layout(size: tuple[int, int], regions: Sequence[dict]
                      ) -> list[tuple[np.ndarray | None, list[tuple[int, int]]]]:
    """Per region: its outline (bool, full size; None for an empty region) and the points
    its number may be centred on, best first: one badge radius outside the outline,
    nearest each corner of the outline's bounding box.

    The outline is worked out at full size, so it keeps the region's shape to the pixel,
    on the box around the region only; the number's place needs less care and is worked
    out at the paste-back's scale.
    """
    w, h = size
    stroke = annotation_stroke(size)
    badge = annotation_badge(size)
    reach = ANNOT_GAP * stroke + stroke
    scale = _scale_for(size)

    def grown_full(small: np.ndarray, by: int) -> np.ndarray:
        grown = _round_dilate(small, max(1, round(by / scale)))
        return np.asarray(_bool_image(grown).resize(size, Image.Resampling.BILINEAR)) >= 128

    layout = []
    for region in regions:
        mask = region_mask(size, region["shapes"])
        box = mask.getbbox()
        if box is None:
            layout.append((None, []))
            continue
        # The box with room for the outline and a pixel more: erosion treats its sides as the
        # image's edge, which they are, or else nothing set comes within a pixel of them
        x0, y0 = max(0, box[0] - reach - 1), max(0, box[1] - reach - 1)
        x1, y1 = min(w, box[2] + reach + 1), min(h, box[3] + reach + 1)
        selected = np.asarray(mask.crop((x0, y0, x1, y1))) > 0
        grown = _round_dilate(selected, reach)
        ring = np.zeros((h, w), dtype=bool)
        ring[y0:y1, x0:x1] = grown & ~_erode_closed(grown, stroke) & ~selected
        ys, xs = np.nonzero(ring)
        if not len(xs):
            layout.append((None, []))
            continue
        corners = ((xs.min(), ys.min()), (xs.max(), ys.min()),
                   (xs.min(), ys.max()), (xs.max(), ys.max()))
        small = np.asarray(_small(mask, scale)) > 0
        outer = grown_full(small, reach + badge)
        # its edge inside the image only: a badge on the image's edge would sit on a region
        # that runs to it. A region taking in nearly all of the image leaves none: then any
        oy, ox = np.nonzero(outer & ~_erode(outer, 1))
        if not len(ox):
            oy, ox = np.nonzero(outer & ~_erode_closed(outer, 1))
        anchors = []
        for cx, cy in corners:
            k = int(np.argmin((ox - cx) ** 2 + (oy - cy) ** 2))
            anchors.append((int(ox[k]), int(oy[k])))
        layout.append((ring, anchors))
    return layout


def _badge_center(occupied: Image.Image, points, radius: int) -> tuple[int, int]:
    """The first point whose badge covers no region; else the first point."""
    w, h = occupied.size
    placed = [(min(max(x, radius), w - radius), min(max(y, radius), h - radius))
              for x, y in points]
    for cx, cy in placed:
        box = (cx - radius, cy - radius, cx + radius + 1, cy + radius + 1)
        if occupied.crop(box).getbbox() is None:
            return cx, cy
    return placed[0]


# ---------------------------------------------------------------------------
# Paste-back
# ---------------------------------------------------------------------------
def same_aspect(a: tuple[int, int], b: tuple[int, int]) -> bool:
    return abs((a[0] / a[1]) / (b[0] / b[1]) - 1) <= ASPECT_TOLERANCE


def echoed_marks(original: Image.Image, annotated: Image.Image,
                 result: Image.Image) -> Image.Image | None:
    """Outlines and numbers the model copied from the annotated image (L, 255 = copied).

    Annotation pixels are where the annotated image clearly differs from the
    original; where the result matches the annotated image there, the model
    copied the marks. A copy reproduces a good share of them; a few matching
    pixels are chance (a red flower over the red box line) and don't count.
    Returns None when nothing was copied. All three images must have the same
    size.
    """
    def far(a: Image.Image, b: Image.Image, threshold: int) -> Image.Image:
        r, g, b_ = ImageChops.difference(a.convert("RGB"), b.convert("RGB")).split()
        return ImageChops.lighter(ImageChops.lighter(r, g), b_).point(
            lambda v: 255 if v > threshold else 0)

    marks = far(annotated, original, 48)
    echo = ImageChops.darker(marks, ImageOps.invert(far(result, annotated, 40)))
    copied = echo.histogram()[255]
    return echo if copied and copied >= ECHO_MIN_SHARE * marks.histogram()[255] else None


def _feather(area: Image.Image, radius: int, band: Image.Image | None) -> Image.Image:
    """The paste-back weights for ``area``: grown by about two feather radii, then blurred by
    one (keeping what stays above 2.3%); none over copied marks (``band``)."""
    spread = area.filter(ImageFilter.GaussianBlur(radius)).point(lambda v: 255 if v > 5 else 0)
    soft = ImageChops.lighter(spread, area).filter(ImageFilter.GaussianBlur(radius))
    return soft if band is None else ImageChops.darker(soft, ImageOps.invert(band))


def whole_pieces(original: Image.Image, result: Image.Image, area: Image.Image, radius: int,
                 band: Image.Image | None):
    """The area with the changed words that reach it taken whole, and a function that sets the
    feathered weights over the other changed words near it to all or nothing.

    The feathered edge blends the output into the original. Where the two only differ a little
    (text the model redrew, aligned by register), that shows nothing; where they differ a lot, it
    shows both at once: the old number through the new one, a word half rewritten. Models often
    rewrite a whole word or line when a region covers part of it. So pieces of strong change
    near the area (above PIECE_WEAK, with a core above PIECE_CORE) are merged along lines into
    runs (letters less than a feather radius apart), and each run comes from one side: runs
    reaching the area are added to it whole; the others take the side most of their weight is
    on. Runs that go on past PIECE_ZONE feather radii or off the image (a whole changed
    background) are left as they are, and so are copied marks (``band``). When the model copied
    the outlines, they are its edge, as in grow_area: pieces are looked at only up to them.
    """
    w, h = area.size
    a = np.asarray(area) > 0
    reach = PIECE_ZONE * radius
    if band is not None:
        reach = min(reach, (ANNOT_GAP + 1) * annotation_stroke(area.size))
    zone = _dilate(a, reach)
    ys, xs = np.nonzero(zone)
    if not len(xs):
        return area, None
    box = (max(0, int(xs.min()) - 4), max(0, int(ys.min()) - 4),
           min(w, int(xs.max()) + 5), min(h, int(ys.max()) + 5))
    x0, y0, x1, y1 = box
    blur = ImageFilter.GaussianBlur(PIECE_BLUR)
    o, r = (np.asarray(im.convert("RGB").crop(box).filter(blur), np.int16)
            for im in (original, result))
    diff = np.abs(o - r).max(axis=2)
    z = zone[y0:y1, x0:x1]
    weak = (diff >= PIECE_WEAK) & z
    if band is not None:
        weak &= ~(np.asarray(band)[y0:y1, x0:x1] > 0)
    labels = _label8(weak)
    cored = np.zeros(int(labels.max()) + 1, bool)
    cored[labels[(diff >= PIECE_CORE) & weak]] = True
    cored[0] = False
    pieces = cored[labels]
    if not pieces.any():
        return area, None
    # letters along a line: within a feather radius across, a pixel up or down
    runs = _label8(_dilate_axis(_dilate_axis(pieces, radius, 1), 1, 0)) * pieces
    edge = z & ~_erode_closed(z, 1)  # the image's edge too: the zone may cover all of a small one
    open_runs = np.unique(runs[edge])
    reach = np.unique(runs[_dilate(a[y0:y1, x0:x1], 2)])
    taken = np.isin(runs, reach) & ~np.isin(runs, open_runs) & pieces
    if taken.any():
        grown = a.copy()
        grown[y0:y1, x0:x1] |= _dilate(taken, 1)
        area = _bool_image(grown)
    rest = np.where(np.isin(runs, open_runs) | taken, 0, runs)

    def settle(soft: Image.Image) -> Image.Image:
        s = np.asarray(soft)[y0:y1, x0:x1].astype(np.int64)
        inside = rest[(s > 0) & (s < 255)]
        ids = np.unique(inside[inside > 0])
        if not len(ids):
            return soft
        counts = np.bincount(rest.ravel(), minlength=int(rest.max()) + 1)
        sums = np.bincount(rest.ravel(), weights=s.ravel(), minlength=int(rest.max()) + 1)
        whole = np.zeros(len(counts), bool)
        whole[ids] = True
        result_side = whole & (2 * sums >= 255 * counts)
        on = _dilate(result_side[rest], 1)
        off = _dilate((whole & ~result_side)[rest], 1) & ~on
        if not (on.any() or off.any()):
            return soft
        out = np.where(on, 255, np.where(off, 0, s)).astype(np.uint8)
        # the pieces' edges antialiased, as the rest of the weights are smooth
        smooth = np.asarray(Image.fromarray(out).filter(ImageFilter.GaussianBlur(1)))
        out = np.where(_dilate(on | off, 2), smooth, out)
        full = np.asarray(soft).copy()
        full[y0:y1, x0:x1] = out
        return Image.fromarray(full)

    return area, settle


def copied_band(echo: Image.Image, mask: Image.Image) -> Image.Image:
    """Where the original goes back over copied marks (L, 255 = all original): the copied
    pixels and a line's width around them (copies drawn a little off, or blurred), outside
    the regions; the band is whole, and only its edge is softened, by a pixel."""
    stroke = annotation_stroke(echo.size)
    band = _bool_image(_dilate(np.asarray(echo) > 0, stroke) & ~(np.asarray(mask) > 0))
    return ImageChops.lighter(band, band.filter(ImageFilter.GaussianBlur(1)))


# -- small-scale masks (boolean numpy arrays) ----------------------------------
def _scale_for(size: tuple[int, int]) -> int:
    """Shrink factor for the paste-back analysis; small images are barely shrunk."""
    return max(1, min(SPILL_SCALE, min(size) // 96))


def _rgb(im: Image.Image) -> Image.Image:
    """``im`` as RGB; the image itself when it already is (no copy)."""
    return im if im.mode == "RGB" else im.convert("RGB")


def _small(im: Image.Image, scale: int) -> Image.Image:
    return im.resize((max(1, im.width // scale), max(1, im.height // scale)),
                     Image.Resampling.BOX)


def _bool_image(mask: np.ndarray) -> Image.Image:
    return Image.fromarray(mask.astype(np.uint8) * 255, "L")


def _shift(mask: np.ndarray, by: int, axis: int) -> np.ndarray:
    """``mask`` moved by ``by`` pixels along ``axis``; what moves in is False."""
    out = np.zeros_like(mask)
    src, dst = [slice(None)] * 2, [slice(None)] * 2
    if by > 0:
        src[axis], dst[axis] = slice(None, -by), slice(by, None)
    else:
        src[axis], dst[axis] = slice(-by, None), slice(None, by)
    out[tuple(dst)] = mask[tuple(src)]
    return out


def _dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    """Binary dilation by a (2r+1) square: shifted copies, doubling the shift (log r steps)."""
    out = mask
    for axis in (0, 1):
        reach, step = 0, 1
        while reach < radius:
            by = min(step, radius - reach)
            out = out | _shift(out, by, axis) | _shift(out, -by, axis)
            reach += by
            step *= 2
    return out


def _dilate_axis(mask: np.ndarray, radius: int, axis: int) -> np.ndarray:
    """Binary dilation along one axis only, by ``radius`` pixels each way."""
    out = mask
    reach, step = 0, 1
    while reach < radius:
        by = min(step, radius - reach)
        out = out | _shift(out, by, axis) | _shift(out, -by, axis)
        reach += by
        step *= 2
    return out


def _label8(mask: np.ndarray) -> np.ndarray:
    """Connected components (8-connected) of ``mask``: an int array, 0 off ``mask`` and a number
    per component on it (the numbering is arbitrary; only the grouping matters).

    Works on runs of set pixels along rows, joined with the overlapping runs of the row above.
    """
    h, w = mask.shape
    padded = np.zeros((h, w + 2), np.int8)
    padded[:, 1:-1] = mask
    step = np.diff(padded, axis=1)
    starts = np.nonzero(step == 1)
    ends = np.nonzero(step == -1)
    rows, x0s, x1s = starts[0], starts[1], ends[1]  # run on row y from x0 to x1 - 1
    n = len(rows)
    parent = list(range(n + 1))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    first = np.searchsorted(rows, np.arange(h + 1))
    for y in range(1, h):
        above = range(first[y - 1], first[y])
        j = above.start
        for i in range(first[y], first[y + 1]):
            # runs above that touch this one, diagonals included
            while j < above.stop and x1s[j] < x0s[i]:
                j += 1
            k = j
            while k < above.stop and x0s[k] <= x1s[i]:
                ri, rk = find(i + 1), find(k + 1)
                if ri != rk:
                    parent[max(ri, rk)] = min(ri, rk)
                k += 1
    roots = np.array([find(i + 1) for i in range(n)], np.int32)
    labels = np.zeros((h, w), np.int32)
    for i in range(n):
        labels[rows[i], x0s[i]:x1s[i]] = roots[i]
    return labels


def _erode(mask: np.ndarray, radius: int) -> np.ndarray:
    return ~_dilate(~mask, radius)


def _round_dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    """Dilation by an octagon close to a disc: a square (0.414 r) then a diamond (the rest)."""
    square = round(radius * 0.4142)
    out = _dilate(mask, square)
    for _ in range(radius - square):
        out = (out | _shift(out, 1, 0) | _shift(out, -1, 0) | _shift(out, 1, 1)
               | _shift(out, -1, 1))
    return out


def _erode_closed(mask: np.ndarray, radius: int) -> np.ndarray:
    """Erosion where the outside of the image counts as unset (an edge erodes too)."""
    padded = np.pad(mask, radius, constant_values=False)
    return _erode(padded, radius)[radius:-radius, radius:-radius]


def _components_near(strong: np.ndarray, zone: np.ndarray) -> list[np.ndarray]:
    """Connected components (4-connected) of ``strong`` that have a pixel in ``zone``."""
    # 255 = strong, not yet visited. A copy: images made by fromarray are read-only, and
    # flood fill would silently write nothing
    work = _bool_image(strong).copy()
    found = []
    ys, xs = np.nonzero(zone & strong)
    for y, x in zip(ys.tolist(), xs.tolist(), strict=True):
        if work.getpixel((x, y)) != 255:
            continue  # part of a component already found
        ImageDraw.floodfill(work, (x, y), 128)
        comp = np.asarray(work) == 128
        work.paste(64, mask=_bool_image(comp))  # visited
        found.append(comp)
    return found


def _fill_holes(mask: np.ndarray) -> np.ndarray:
    """``mask`` plus every pixel it encloses."""
    ys, xs = np.nonzero(mask)
    if not len(ys):
        return mask
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    crop = mask[y0:y1, x0:x1]
    padded = Image.new("L", (crop.shape[1] + 2, crop.shape[0] + 2), 0)
    padded.paste(_bool_image(crop), (1, 1))
    ImageDraw.floodfill(padded, (0, 0), 128)  # everything reachable from outside
    out = mask.copy()
    out[y0:y1, x0:x1] = np.asarray(padded)[1:-1, 1:-1] != 128
    return out


# -- measuring change ------------------------------------------------------------
_RGB2XYZ = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722],
                     [0.0193, 0.1192, 0.9505]])
_WHITE = np.array([0.9505, 1.0, 1.089])


def _lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB (0-255) to CIE Lab, whose distances follow what the eye sees."""
    x = rgb / 255.0
    x = np.where(x > 0.04045, ((x + 0.055) / 1.055) ** 2.4, x / 12.92)
    xyz = x @ _RGB2XYZ.T / _WHITE
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], axis=-1)


def change_map(original: Image.Image, result: Image.Image, scale: int) -> np.ndarray:
    """How much ``result`` differs from ``original`` at each pixel, at 1/scale size.

    Lab distance of both images, averaged down and softened first: this
    measures structure (an object, a color), not the grain of a re-rendered
    texture.
    """
    soften = ImageFilter.GaussianBlur(1)

    def lab(im: Image.Image) -> np.ndarray:
        return _lab(np.asarray(_small(_rgb(im), scale).filter(soften), np.float64))

    return np.linalg.norm(lab(original) - lab(result), axis=-1)


def _grow_once(delta: np.ndarray, seed: np.ndarray, threshold: float,
               blocked: np.ndarray | None, reach: int, bridge: int,
               min_patch: float) -> tuple[np.ndarray, str]:
    """Extend the region with the new content that belongs to it (one threshold).

    Models often draw the new object larger than the region (flowers rising
    out of a vase), or a little beside it (a dog sitting next to the box that
    asked for it); pasting only the region would cut it off or leave half of
    it as a ghost. So the region grows through pixels that changed strongly
    (above ``threshold``) and are connected to it, and takes in large patches
    of strong change lying within ``bridge`` pixels. Small specks (a texture
    the model redrew) are never bridged to, so growth can't hop across them.
    Holes the result encloses are filled.

    Returns (area, note): NOTE_SPILL_TOO_LARGE when growth runs away, else
    NOTE_SPILL_GROWN when the area grew noticeably, else "". ``blocked``
    (copied annotation marks) and ``reach`` pixels around them are never
    included.
    """
    seed_area = int(seed.sum())
    if not seed_area:
        return seed, ""
    strong = delta > threshold
    if blocked is not None:
        strong &= ~_dilate(blocked, reach)
    allowed = strong | seed
    limit = seed_area + min(seed_area * SPILL_MAX_GROWTH, delta.size * SPILL_MAX_SHARE)
    min_patch = max(min_patch, seed_area * SPILL_PATCH_SHARE)

    grown = seed
    for _ in range(4):  # touching growth, then bridge to nearby patches; repeat
        for _ in range(max(delta.shape)):
            step = (_dilate(grown, 1) & allowed) | grown
            if np.array_equal(step, grown):
                break
            grown = step
            if grown.sum() > limit:
                return seed, NOTE_SPILL_TOO_LARGE
        zone = _dilate(grown, bridge) & ~grown
        patches = [c for c in _components_near(strong & ~grown, zone) if c.sum() >= min_patch]
        if not patches:
            break
        for patch in patches:
            grown = grown | patch
        grown = grown | _erode(_dilate(grown, bridge), bridge)  # the gaps crossed, too
        if grown.sum() > limit:
            return seed, NOTE_SPILL_TOO_LARGE

    grown = _fill_holes(_erode(_dilate(grown, 1), 1)) | seed
    if grown.sum() > limit:
        return seed, NOTE_SPILL_TOO_LARGE
    # Small growth is kept too (the rest of a recolored sleeve); only a big one is worth a note
    noted = int(grown.sum()) - seed_area > seed_area * SPILL_NOTE_GROWTH
    return grown, NOTE_SPILL_GROWN if noted else ""


def grow_area(delta: np.ndarray, seed: np.ndarray, threshold: float,
              blocked: np.ndarray | None, reach: int, bridge: int,
              min_patch: float) -> tuple[np.ndarray, str]:
    """Grow the region (see _grow_once), getting stricter if growth runs away.

    A low threshold catches the faint parts of new content, but when the model
    also changed other things around it (relit the buildings next to a new
    sky), growth leaks into them and hits the limit. Cutting the new content
    off at the region's edge would leave a seam through it, so try again with
    stricter thresholds: they keep what changed the most, which is the new
    content, and drop what changed a little. Only if even those run away is
    the region all there is.
    """
    for k in range(SPILL_ESCALATE):
        grown, note = _grow_once(delta, seed, threshold * 1.6 ** k, blocked, reach, bridge,
                                 min_patch)
        if note != NOTE_SPILL_TOO_LARGE:
            return grown, note
    return seed, NOTE_SPILL_TOO_LARGE


# -- the output against the original -------------------------------------------
def register(original: Image.Image, result: Image.Image, mask: Image.Image) -> Image.Image:
    """``result`` (the model's output, of the original's aspect) on the original's pixel grid.

    Models draw their output at a size of their own and don't keep the framing to the pixel:
    scaled back to the original's size, the output can sit a few pixels off, mostly as a slight
    stretch of one axis (measured: up to 1.5%, 8 px, on screenshots of unusual proportions). Pasted
    back like that, every line and letter along the feathered edge shows twice. So the offset is
    measured along each axis, as a scale and a shift (registration), on patches away from the
    regions, and the output is resampled onto the original's grid in one step from its own
    pixels. Some models also move parts of the image a pixel or two on their own; what matters
    is around the regions, so the patches near them settle what offset is left there. An output
    that is nowhere off by more than REGISTER_MIN_SHIFT, or whose patches don't agree on an
    offset, is only resized, as before.
    """
    size = original.size
    plain = result if result.size == size else result.resize(size, Image.Resampling.LANCZOS)
    box = registration_box(original, result, mask)
    if box is None:
        return plain
    pad, (x0, y0, x1, y1) = box
    mode = "RGBA" if result.has_transparency_data else "RGB"
    # The box may reach a little past the output's edge: repeat the edge pixels there
    arr = np.pad(np.asarray(result.convert(mode)), ((pad, pad), (pad, pad), (0, 0)), mode="edge")
    return Image.fromarray(arr, mode).resize(size, Image.Resampling.LANCZOS, box=(x0, y0, x1, y1))


def registration_box(original: Image.Image, result: Image.Image, mask: Image.Image
                     ) -> tuple[int, tuple[float, float, float, float]] | None:
    """Where on ``result``, padded by the returned number of pixels, the original's frame lies (a
    box for ``Image.resize``); None to leave the output as it is (see register)."""
    w, h = original.size
    fit = _register_fit(original, result, mask)
    if fit is None:
        return None
    (kx, tx), (ky, ty) = fit
    worst = max(abs(tx), abs(kx * w + tx), abs(ty), abs(ky * h + ty))
    if worst < REGISTER_MIN_SHIFT:
        return None
    # The original's pixel at c shows at (1 + k) c + t on the output resized to ``size``
    rw, rh = result.size
    x0, y0 = tx * rw / w, ty * rh / h
    x1, y1 = x0 + (1 + kx) * rw, y0 + (1 + ky) * rh
    pad = math.ceil(max(0.0, -x0, -y0, x1 - rw, y1 - rh)) + 4
    return pad, (x0 + pad, y0 + pad, x1 + pad, y1 + pad)


def _register_fit(original: Image.Image, result: Image.Image, mask: Image.Image
                  ) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """Per axis, (k, t) with the original's pixel at c showing at (1 + k) c + t on ``result``
    resized to the original's size: a fit over the whole image, moved by what is left near the
    regions; None if the patches don't agree on either.

    Integer sums of squared differences and plain arithmetic in a fixed order, so the web build,
    which ports this, finds the same numbers.
    """
    w, h = original.size
    q = max(1, _round(max(w, h) / REGISTER_COARSE))
    coarse_tile = REGISTER_TILE // 2
    a = original.convert("L")
    b = result.convert("L")
    if b.size != (w, h):
        b = b.resize((w, h), Image.Resampling.BILINEAR)
    keep = _bool_image(~_dilate(np.asarray(mask) > 0, max(coarse_tile * q, REGISTER_TILE)))

    # 1. On a copy 1/q the size, whole-pixel offsets up to REGISTER_REACH of the long side
    small = (max(1, w // q), max(1, h // q))
    ac, bc = (np.asarray(im.resize(small, Image.Resampling.BOX), np.int64) for im in (a, b))
    keep_c = np.asarray(keep.resize(small, Image.Resampling.BOX)) == 255
    tiles = _texture_tiles(ac, keep_c, coarse_tile)
    reach = max(2, math.ceil(REGISTER_REACH * max(w, h) / q))
    xs, ys = [], []
    center = coarse_tile * q / 2
    for (x, y), ssd in zip(tiles, _ssd_search(ac, bc, tiles, coarse_tile, None, reach),
                           strict=True):
        for axis, offset in _readings(ssd, reach, coarse_tile):
            (xs if axis == 0 else ys).append(((x * q + center, y * q + center),
                                              (x, y)[axis] * q + center, offset * q))
    # (whole steps of q pixels: they scatter by up to q around the fit)
    fx = _line_fit([(c, d) for _, c, d in xs], w, q)
    fy = _line_fit([(c, d) for _, c, d in ys], h, q)
    if fx is None or fy is None:
        return None

    # 2. At full size (lightly blurred: a one-pixel line then gives a smooth minimum), around
    # that, to a fraction of a pixel by a parabola through the minimum
    blur = ImageFilter.GaussianBlur(1)
    af, bf = (np.asarray(im.filter(blur), np.int64) for im in (a, b))
    tile = REGISTER_TILE
    tiles = _texture_tiles(af, np.asarray(keep) == 255, tile)
    reach = q + 1  # the first search measured in steps of q pixels
    half = tile / 2
    guesses = [(_round(fx[0] * (x + half) + fx[1]), _round(fy[0] * (y + half) + fy[1]))
               for x, y in tiles]
    xs, ys = [], []
    for (x, y), guess, ssd in zip(tiles, guesses, _ssd_search(af, bf, tiles, tile, guesses,
                                                              reach), strict=True):
        for axis, offset in _readings(ssd, reach, tile, subpixel=True):
            (xs if axis == 0 else ys).append(((x + half, y + half), (x, y)[axis] + half,
                                              guess[axis] + offset))
    whole = (_line_fit([(c, d) for _, c, d in xs], w, REGISTER_MAX_SPREAD),
             _line_fit([(c, d) for _, c, d in ys], h, REGISTER_MAX_SPREAD))
    # 3. What is left near the regions: a shift, from the patches there
    bx0, by0, bx1, by1 = mask.getbbox() or (0, 0, w, h)
    out = []
    for fit, points in zip(whole, (xs, ys), strict=True):
        k, t = fit or (0.0, 0.0)
        near = sorted(d - (k * c + t) for (px, py), c, d in points
                      if bx0 - REGISTER_NEAR <= px <= bx1 + REGISTER_NEAR
                      and by0 - REGISTER_NEAR <= py <= by1 + REGISTER_NEAR)
        if len(near) >= 6:
            shift = near[len(near) // 2]
            off = sorted(abs(d - shift) for d in near)
            if off[len(off) // 2] <= REGISTER_MAX_SPREAD:
                out.append((k, t + shift))
                continue
        if fit is None:
            return None
        out.append(fit)
    return out[0], out[1]


def _readings(ssd: np.ndarray | None, reach: int, tile: int, subpixel: bool = False
              ) -> list[tuple[int, float]]:
    """The offsets a tile's search tells, as (axis, offset): along an axis only where the best
    match stands clear of its neighbours that way (a horizontal line tells nothing about x) and
    isn't at the edge of the search. With ``subpixel``, refined by a parabola through it."""
    if ssd is None:
        return []
    span = 2 * reach + 1
    dy, dx = divmod(int(np.argmin(ssd)), span)
    s0 = int(ssd[dy, dx])
    out = []
    for axis, at in ((0, dx), (1, dy)):
        if not 0 < at < span - 1:
            continue  # the best match is at the edge of the search: no clear match
        minus = int(ssd[dy, dx - 1] if axis == 0 else ssd[dy - 1, dx])
        plus = int(ssd[dy, dx + 1] if axis == 0 else ssd[dy + 1, dx])
        curve = minus - 2 * s0 + plus
        if curve < 4 * tile * tile:
            continue  # flat along this axis (a line along it)
        out.append((axis, at - reach + (0.5 * (minus - plus) / curve if subpixel else 0)))
    return out


def _round(v: float) -> int:
    """Halves rounded up, as Math.round does (Python's round makes them even)."""
    return math.floor(v + 0.5)


def _texture_tiles(a: np.ndarray, keep: np.ndarray, tile: int) -> list[tuple[int, int]]:
    """Top-left corners of the tiles of ``a`` that lie where ``keep`` and have some structure
    (an average step of 2 levels between neighbours), at most REGISTER_MAX_TILES of them, spread
    evenly in reading order."""
    h, w = a.shape
    found = []
    for y in range(0, h - tile + 1, tile):
        for x in range(0, w - tile + 1, tile):
            if not keep[y:y + tile, x:x + tile].all():
                continue
            t = a[y:y + tile, x:x + tile]
            if int(np.abs(np.diff(t, axis=0)).sum() + np.abs(np.diff(t, axis=1)).sum()) \
                    >= 2 * tile * tile:
                found.append((x, y))
    n = len(found)
    if n > REGISTER_MAX_TILES:
        found = [found[i * n // REGISTER_MAX_TILES] for i in range(REGISTER_MAX_TILES)]
    return found


def _ssd_search(a: np.ndarray, b: np.ndarray, tiles: list[tuple[int, int]], tile: int,
                guesses: list[tuple[int, int]] | None, reach: int) -> list[np.ndarray | None]:
    """For each tile of ``a``: the sums of squared differences against ``b`` moved by the guess
    plus (dx, dy), both from -reach to reach, as an array [dy, dx]; None where that leaves ``b``."""
    h, w = b.shape
    span = 2 * reach + 1
    found: list[np.ndarray | None] = [None] * len(tiles)
    ok, own, windows = [], [], []
    for i, (x, y) in enumerate(tiles):
        gx, gy = guesses[i] if guesses else (0, 0)
        x0, y0 = x + gx - reach, y + gy - reach
        if x0 >= 0 and y0 >= 0 and x0 + tile + 2 * reach <= w and y0 + tile + 2 * reach <= h:
            ok.append(i)
            own.append(a[y:y + tile, x:x + tile])
            windows.append(b[y0:y0 + tile + 2 * reach, x0:x0 + tile + 2 * reach])
    if not ok:
        return found
    mine, theirs = np.stack(own), np.stack(windows)
    ssd = np.empty((len(ok), span, span), np.int64)
    for dy in range(span):
        for dx in range(span):
            d = mine - theirs[:, dy:dy + tile, dx:dx + tile]
            ssd[:, dy, dx] = (d * d).sum(axis=(1, 2))
    for k, i in enumerate(ok):
        found[i] = ssd[k]
    return found


def _line_fit(points: list[tuple[float, float]], size: int, tolerance: float
              ) -> tuple[float, float] | None:
    """(k, t) of d = k c + t through the (c, d) points by least squares, once more without those
    far off; None with fewer than 6 left or when they still disagree by more than ``tolerance``
    (the median distance). Points spread over too narrow a band to tell a scale give an offset
    only."""
    def fit(pts: list[tuple[float, float]]) -> tuple[float, float]:
        n = len(pts)
        sc = sd = scc = scd = 0.0
        for c, d in pts:
            sc += c
            sd += d
            scc += c * c
            scd += c * d
        cs = [c for c, _ in pts]
        if max(cs) - min(cs) < 0.3 * size:
            return 0.0, sd / n
        k = (n * scd - sc * sd) / (n * scc - sc * sc)
        return k, (sd - k * sc) / n

    def spread(pts: list[tuple[float, float]], k: float, t: float) -> float:
        off = sorted(abs(d - (k * c + t)) for c, d in pts)
        return off[len(off) // 2]

    if len(points) < 6:
        return None
    k, t = fit(points)
    limit = max(tolerance, 3 * spread(points, k, t))
    kept = [(c, d) for c, d in points if abs(d - (k * c + t)) <= limit]
    if len(kept) < 6:
        return None
    k, t = fit(kept)
    if spread(kept, k, t) > tolerance or abs(k) > 0.05:
        return None
    return k, t


def _far(original: Image.Image, seed: np.ndarray, scale: int) -> np.ndarray:
    """Where the output is compared with the original (at 1/scale): away from the regions
    (``seed``), and where the original shows. Under transparent pixels it stores colors no one
    sees, which a model returns as anything (often white)."""
    far = ~_dilate(seed, ALIGN_MARGIN // scale)
    if original.has_transparency_data:
        alpha = _small(original.convert("RGBA").getchannel("A"), scale)
        far &= _erode(np.asarray(alpha) == 255, 4)
    return far


def aligned(original: Image.Image, result: Image.Image, mask: Image.Image) -> bool:
    """Whether ``result`` keeps the original's framing (the sizes must match).

    Models usually keep the framing of the image they edit, but some now and
    then redraw the whole scene, zoomed or shifted; a patch of that output
    would be a piece of another picture. Fine structure away from the region
    tells: in an aligned output the edges sit where the original has them
    (correlation near 1, even when the colors drifted), in a reframed one they
    don't (near 0).
    """
    scale = _scale_for(original.size)

    def detail(im: Image.Image) -> np.ndarray:
        g = _small(im.convert("L"), scale)
        return (np.asarray(g, np.float64)
                - np.asarray(g.filter(ImageFilter.GaussianBlur(3)), np.float64))

    far = _far(original, np.asarray(_small(mask, scale)) > 0, scale)
    if far.sum() < 0.05 * far.size:
        return True  # the region is nearly everything: nothing to compare
    a, b = detail(original)[far], detail(result)[far]
    norm = float(np.sqrt((a * a).sum() * (b * b).sum()))
    return norm == 0 or float((a * b).sum()) / norm >= ALIGN_MIN_CORR


def match_tone(original: Image.Image, result: Image.Image, mask: Image.Image) -> Image.Image:
    """``result`` with the model's overall tone drift undone.

    Models shift brightness and color a little across the whole image when
    they edit, some by 20 levels or more. A patch of that output then sits
    visibly darker or tinted in the original. Away from the region nothing was
    meant to change, so a per-channel gain and offset fitted there map the
    output's tone back onto the original's; the mapping applies everywhere.
    The fit is robust: it starts from the median offset and is refitted on the
    best-fitting TONE_KEEP percent, so other things the model repainted don't
    pull it. It is trusted only over the levels it was measured on and fades
    out beyond them: a fit made on a pale background must not tint a black
    object.
    """
    scale = _scale_for(original.size)
    blur = ImageFilter.GaussianBlur(2)
    o = np.asarray(_small(_rgb(original), scale).filter(blur), np.float64)
    r = np.asarray(_small(_rgb(result), scale).filter(blur), np.float64)
    far = _far(original, np.asarray(_small(mask, scale)) > 0, scale)
    if far.sum() < 0.05 * far.size:
        return result
    # The levels that exist away from the region. Smoothed copies lose the extremes, so look
    # at the output itself, on a grid of about a million pixels (plenty for a range)
    step = max(1, int(math.sqrt(original.width * original.height / 1e6)))
    sample = (max(1, original.width // step), max(1, original.height // step))
    grid = np.asarray(_rgb(result).resize(sample, Image.Resampling.NEAREST))
    seen = grid[np.asarray(_bool_image(far).resize(sample, Image.Resampling.NEAREST)) > 0]
    lut: list[int] = []
    for c in range(3):
        x, y = r[..., c][far], o[..., c][far]
        lo, hi = (float(v) for v in np.percentile(seen[:, c], (0.5, 99.5)))
        # Start from the median offset, which holds up while under half the pixels were edited,
        # then keep the best-fitting share and refit: edits elsewhere don't pull the fit
        gain, offset = 1.0, float(np.median(y - x))
        for _ in range(3):
            err = np.abs(gain * x + offset - y)
            keep = err <= np.percentile(err, TONE_KEEP)
            xk, yk = x[keep], y[keep]
            spread = float(xk.var())
            if hi - lo >= TONE_MIN_SPAN and spread > 1.0:
                gain = float(((xk - xk.mean()) * (yk - yk.mean())).mean() / spread)
                offset = float(yk.mean() - gain * xk.mean())
            else:  # too narrow a range to tell a gain from an offset
                gain, offset = 1.0, float(np.median(yk - xk))
        clipped = float(np.clip(gain, 1 - TONE_MAX_GAIN, 1 + TONE_MAX_GAIN))
        if clipped != gain:  # a limited gain: the offset that goes best with it
            offset = float(np.median((y - clipped * x)[keep]))
        gain = clipped
        offset = float(np.clip(offset, -TONE_MAX_OFFSET, TONE_MAX_OFFSET))
        for v in range(256):
            trust = 1.0 if lo <= v <= hi else max(0.0, 1 - max(v - hi, lo - v) / TONE_FADE)
            lut.append(min(255, max(0, round(v + trust * (gain * v + offset - v)))))
    if all(lut[c * 256 + v] == v for c in range(3) for v in range(256)):
        return result
    fixed = _rgb(result).point(lut)
    if result.mode == "RGBA":
        fixed.putalpha(result.getchannel("A"))
    return fixed


def paste_back(original: Image.Image, result: Image.Image, mask: Image.Image,
               annotated: Image.Image | None = None,
               overall: bool = False) -> tuple[Image.Image | None, str]:
    """Put the edited region of ``result`` onto ``original``: (image, note).

    ``result`` must already have the original's size. The image is None, with
    the note NOTE_REFRAMED, when the model redrew the scene instead of
    editing it (see aligned); use its whole output then. With ``overall`` (the
    user also wrote an overall request) and the model changing much of the
    image far from the regions, the note is NOTE_OVERALL: the request asked
    for that change (a new sky, say), so the whole output should be adopted;
    the image returned is the pasted-back alternative. That is judged on the
    output as it is, before the tone drift is undone, since a change of light
    is mostly a shift of tones. Otherwise:

    - the model's overall tone drift is undone first (match_tone), so the
      patch doesn't show as a lighter or darker square;
    - the area pasted is the region plus the new content that belongs to it
      (grow_area): what the model drew past the region's edge isn't cut off,
      and new content next to it isn't left half-covered;
    - copied annotation marks (``annotated`` tells which) are never included:
      the outlines sit just outside the regions, within the feathered edge, so
      where the model copied them the original goes back along them;
    - the area's edge is feathered, and the transition lies outside the area:
      at the edge ~98% comes from the result, and beyond ~4.7 feather radii
      the original is untouched, pixel for pixel;
    - but nothing that changed is blended half and half: a changed word that
      reaches the area is taken whole, and one in the feathered edge comes
      wholly from one side (see whole_pieces).
    """
    toned, weights, note = paste_weights(original, result, mask, annotated, overall)
    if toned is None:
        return None, note
    return blend(original, toned, weights), note


def paste_weights(original: Image.Image, result: Image.Image, mask: Image.Image,
                  annotated: Image.Image | None = None, overall: bool = False
                  ) -> tuple[Image.Image | None, Image.Image | None, str]:
    """paste_back's work before the blend: (the result with the tone drift undone, the
    weights it is pasted with (L), the note); (None, None, NOTE_REFRAMED) when the model
    redrew the scene."""
    size = original.size
    if not aligned(original, result, mask):
        return None, None, NOTE_REFRAMED
    scale = _scale_for(size)
    seed = np.asarray(_small(mask, scale)) > 0
    changed_overall = False
    if overall:
        # before match_tone: a requested change of light or color (a winter day, dusk) is mostly
        # such a shift, which undoing the drift would take away
        far = _far(original, seed, scale)
        changed_overall = (far.sum() >= 0.05 * far.size and float(
            (change_map(original, result, scale)[far] > OVERALL_DELTA).mean()) > OVERALL_SHARE)
    result = match_tone(original, result, mask)
    delta = change_map(original, result, scale)
    outside = ~_dilate(seed, math.ceil(SPILL_NEAR / scale))
    drift = (float(np.median(delta[outside])) if outside.sum() > 0.02 * outside.size
             else float(np.percentile(delta, 20)))
    threshold = max(SPILL_MIN_DELTA, drift * SPILL_DRIFT_FACTOR)

    radius = feather_radius(size)
    reach = math.ceil(5 * radius / scale)
    blocked = None
    echo = echoed_marks(original, annotated, result) if annotated is not None else None
    if echo is not None:
        blocked = np.asarray(_small(echo, scale)) > 0
        # The model drew the outlines in, so they are its edge: nothing past them is the
        # region's new content (they lie a gap and a line's width out)
        outline = (ANNOT_GAP + 1) * annotation_stroke(size)
        delta = np.where(_dilate(seed, math.ceil(outline / scale)), delta, 0.0)
    area, note = grow_area(delta, seed, threshold, blocked, reach,
                           bridge=max(1, math.ceil(BRIDGE_RADII * radius / scale)),
                           min_patch=SPILL_MIN_PATCH / scale**2)
    if note == NOTE_SPILL_TOO_LARGE:
        area_img = mask  # everything changed: no clean outline exists, keep the region
    else:
        strong = delta > threshold
        if blocked is not None:
            strong &= ~_dilate(blocked, reach)
        # strong changes the feather would half cover anyway are taken whole
        area = area | (strong & _dilate(area, math.ceil(2 * radius / scale)))
        area_img = ImageChops.lighter(
            _bool_image(area).resize(size, Image.Resampling.BILINEAR).point(
                lambda v: 255 if v >= 128 else 0), mask)
    band = copied_band(echo, mask) if echo is not None else None
    pieces = None
    if note != NOTE_SPILL_TOO_LARGE:
        area_img, pieces = whole_pieces(original, result, area_img, radius, band)
    soft = _feather(area_img, radius, band)
    if pieces is not None:
        soft = pieces(soft)
    return result, soft, NOTE_OVERALL if changed_overall else note


def blend(base: Image.Image, top: Image.Image, weights: Image.Image) -> Image.Image:
    """``top`` over ``base`` by ``weights`` (L), in ``base``'s channels (RGB, or RGBA)."""
    mode = "RGBA" if base.has_transparency_data else "RGB"
    return Image.composite(top if top.mode == mode else top.convert(mode),
                           base if base.mode == mode else base.convert(mode), weights)


def merge_parts(full: Image.Image, pieces: Sequence[tuple], overall: bool = False) -> dict:
    """Put back the outputs of an edit sent in parts onto the original, ``full``.

    ``pieces`` are (the close-up, or None for the whole image; the output as it came; the mask
    of its regions and the annotated image, both as sent). Each output is pasted back as
    paste_back does, the close-ups last: they show their regions in more detail than the whole
    image's output.

    A close-up shows only part of the image. When the overall request changed all of one (a
    change of light, say) or one can't be pasted back, the whole image must be sent as well:
    without its output, this returns {"ask": "overall" or "unusable"}. Otherwise it returns
    {"merged": the pasted-back image, "raw": the whole output, "note"}, the whole output being
    the whole image's output with the close-ups pasted in, or else the original with each
    close-up's output put in its place. When the whole image's output can't be pasted back,
    "merged" is None: use that output as it came.
    """
    mode = "RGBA" if full.has_transparency_data else "RGB"
    full = full if full.mode == mode else full.convert(mode)
    whole = None
    ups = []
    ask = None
    for box, output, mask, annotated in sorted(pieces, key=lambda p: p[0] is not None):
        original = full if box is None else full.crop(box)
        if not same_aspect(original.size, output.size):
            if box is None:
                return {"merged": None, "raw": None, "note": NOTE_ASPECT_MISMATCH}
            ask = ask or "unusable"
            continue
        result = register(original, output, mask)
        toned, weights, note = paste_weights(original, result, mask, annotated, overall)
        if box is None:
            if toned is None:
                return {"merged": None, "raw": None, "note": note}
            whole = result, toned, weights, note
        elif toned is None:
            ask = ask or "unusable"
        else:
            if note == NOTE_OVERALL:
                ask = "overall"
            ups.append((box, result, mask, toned, weights, note))
    if whole is None and ask:
        return {"ask": ask}

    merged = full.copy() if whole is None else blend(full, whole[1], whole[2])
    raw = full.copy() if whole is None else whole[0].convert(mode)
    notes = []
    for box, result, mask, toned, weights, note in ups:
        merged.paste(blend(merged.crop(box), toned, weights), box[:2])
        if whole is None:
            raw.paste(result, box[:2])
        else:  # the close-up's regions, in the whole output's tones
            part = raw.crop(box)
            raw.paste(blend(part, match_tone(part, result, mask), weights), box[:2])
        notes.append(note)
    if whole and whole[3] == NOTE_OVERALL:
        note = NOTE_OVERALL
    else:
        # a close-up's own overall change is drift when the whole image's output has none
        notes += [whole[3]] if whole else []
        note = max((n for n in notes if n != NOTE_OVERALL), key=_PART_NOTES.index, default="")
    return {"merged": merged, "raw": raw, "note": note}


# The notes of a version made in parts, weakest first: it shows the strongest
_PART_NOTES = ("", NOTE_SPILL_GROWN, NOTE_SPILL_TOO_LARGE)


# ---------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------
def open_image(data: bytes) -> Image.Image:
    im = Image.open(io.BytesIO(data))
    im.load()
    if im.mode.startswith("I"):
        # 16-bit grayscale: Pillow's own conversion clips to 0..255, turning most of it white.
        # The result has no format, so normalize_upload stores it re-encoded at 8 bits
        level = (np.clip(np.asarray(im, np.int64), 0, 65535) >> 8).astype(np.uint8)
        gray = Image.fromarray(level, "L")
        key = im.info.get("transparency")
        if isinstance(key, int):
            gray.putalpha(Image.fromarray(np.where(np.asarray(im) == key, 0, 255).astype(np.uint8)))
        im = gray
    return im


def png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def _cmyk_to_srgb(im: Image.Image) -> Image.Image:
    """A CMYK picture (print JPEGs) in sRGB, through its own profile when it has one: Pillow's
    plain conversion ignores the profile, and left on RGB pixels the CMYK profile is invalid."""
    icc = im.info.get("icc_profile")
    out = None
    if icc:
        try:
            out = ImageCms.profileToProfile(im, ImageCms.ImageCmsProfile(io.BytesIO(icc)),
                                            ImageCms.createProfile("sRGB"), outputMode="RGB")
        except (ImageCms.PyCMSError, OSError):  # a broken or unsupported profile
            out = None
    out = out or im.convert("RGB")
    out.info.pop("icc_profile", None)
    return out


def normalize_upload(data: bytes) -> bytes:
    """Validate an upload and convert it where needed.

    Phone photos often store their orientation in EXIF: browsers rotate them
    for display, while the model and the paste-back use the raw pixels, so
    regions would land in the wrong place. Bake the rotation into the pixels.
    Everything else becomes RGB or RGBA (plain grayscale is kept as is);
    palette and color-key transparency becomes RGBA so later compositing
    keeps it.
    """
    if pb.detect_image_ext(data) is None:
        raise UserError("not_an_image",
                        "Only PNG, JPEG, WebP and GIF images are supported")
    try:
        im = open_image(data)
    except (OSError, SyntaxError, Image.DecompressionBombError) as exc:  # Syntax: a bad chunk
        raise UserError("bad_image", f"Couldn't read the image: {exc}",
                        detail=str(exc)) from None
    mode = "RGBA" if im.has_transparency_data else "RGB"
    orientation = im.getexif().get(0x0112, 1)
    keep_mode = im.mode == mode or (im.mode == "L" and mode == "RGB")
    if im.format in KEEP_UPLOAD_FORMATS and orientation == 1 and keep_mode:
        return data
    im = ImageOps.exif_transpose(im)
    if im.mode == "CMYK":
        im = _cmyk_to_srgb(im)
    if im.mode != mode:
        im = im.convert(mode)
    return png_bytes(im)


def for_api(data: bytes, max_pixels: int = pb.MAX_PIXELS) -> bytes:
    """Shrink an image that is too large to send.

    Returned unchanged when within both the pixel and byte limits; otherwise
    scaled down to at most ``max_pixels``, as PNG if it has transparency and
    high-quality JPEG if not, and a transparent one further when its PNG is
    still over the byte limit. Opaque inputs of the same size give outputs of
    the same size, so the original and its annotated copy stay aligned.
    """
    im = open_image(data)
    w, h = im.size
    if w * h <= max_pixels and len(data) <= API_MAX_BYTES:
        return data
    if w * h > max_pixels:
        k = math.sqrt(max_pixels / (w * h))
        im = im.resize((max(1, int(w * k)), max(1, int(h * k))),
                       Image.Resampling.LANCZOS)
    if im.has_transparency_data:
        im = im.convert("RGBA")
        buf = io.BytesIO()
        im.save(buf, "PNG")
        out = buf.getvalue()
        if len(out) > API_MAX_BYTES:
            # a noisy transparent image takes about 3 bytes a pixel even as PNG
            k = math.sqrt(API_MAX_BYTES / len(out)) * 0.97
            im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))),
                           Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, "PNG")
            out = buf.getvalue()
        return out
    buf = io.BytesIO()
    im.convert("RGB").save(buf, "JPEG", quality=94)
    return buf.getvalue()
