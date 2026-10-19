import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageChops, ImageCms, ImageDraw, ImageFilter, ImageFont

import promptbrush as pb

from brushgraft import imaging
from brushgraft.errors import UserError
from brushgraft.store import NOTE_OVERALL, NOTE_REFRAMED, NOTE_SPILL_GROWN, NOTE_SPILL_TOO_LARGE

from .conftest import make_png, noise_png

CMYK_PROFILE = "/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc"

RECT = {"type": "rect", "x": 100, "y": 80, "w": 60, "h": 50}
LASSO = {"type": "lasso", "points": [[20, 20], [70, 30], [40, 70]]}
BRUSH = {"type": "brush", "points": [[250, 200], [290, 210]], "radius": 6}


def max_diff(a: Image.Image, b: Image.Image) -> int:
    diff = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    return max(hi for _, hi in diff.getextrema())


def scene(size=(480, 360), seed=1) -> Image.Image:
    """A textured picture, blobs a few pixels wide over most levels: a photo, to the paste-back."""
    rng = np.random.RandomState(seed)
    blobs = rng.randint(10, 246, (size[1] // 8, size[0] // 8, 3)).astype(np.uint8)
    return Image.fromarray(blobs).resize(size, Image.Resampling.BICUBIC)


def pixel_diff(a: Image.Image, b: Image.Image) -> np.ndarray:
    a_, b_ = (np.asarray(im.convert("RGB"), np.int16) for im in (a, b))
    return np.abs(a_ - b_).max(axis=2)


class TestRegionMask:
    def test_shapes(self):
        mask = imaging.region_mask((320, 240), [RECT, LASSO, BRUSH])
        assert mask.getpixel((130, 100)) == 255           # inside the rect
        assert mask.getpixel((45, 40)) == 255             # inside the lasso
        assert mask.getpixel((270, 205)) == 255           # on the stroke
        assert mask.getpixel((250, 194)) == 255           # round cap
        assert mask.getpixel((5, 5)) == 0
        assert mask.getpixel((300, 100)) == 0

    def test_shapes_combine_in_order_like_selection_modes(self):
        size = (200, 100)
        rect = {"type": "rect", "x": 10, "y": 10, "w": 120, "h": 60}

        def at(shapes, *points):
            mask = imaging.region_mask(size, shapes)
            return [mask.getpixel(p) for p in points]

        # subtract cuts a hole; the rest stays
        cut = [rect, {"type": "rect", "x": 50, "y": 20, "w": 20, "h": 20, "op": "subtract"}]
        assert at(cut, (30, 30), (60, 30)) == [255, 0]
        # intersect keeps only the overlap
        both = [rect, {"type": "ellipse", "x": 100, "y": 0, "w": 80, "h": 80, "op": "intersect"}]
        assert at(both, (120, 40), (30, 30), (170, 40)) == [255, 0, 0]
        # order matters: a later add fills the hole again
        refill = cut + [{"type": "rect", "x": 55, "y": 25, "w": 5, "h": 5}]
        assert at(refill, (57, 27), (65, 35)) == [255, 0]
        # a subtract that comes first has nothing to take away
        assert at([cut[1], rect], (60, 30)) == [255]

    def test_a_subtraction_stays_in_its_own_region(self):
        a = {"shapes": [{"type": "rect", "x": 0, "y": 0, "w": 100, "h": 100}]}
        b = {"shapes": [{"type": "rect", "x": 60, "y": 0, "w": 100, "h": 100},
                        {"type": "rect", "x": 40, "y": 40, "w": 40, "h": 20, "op": "subtract"}]}
        mask = imaging.union_mask((200, 120), [a, b])
        assert mask.getpixel((50, 50)) == 255   # region 1 keeps it
        assert mask.getpixel((70, 50)) == 255   # still region 1's
        assert imaging.region_mask((200, 120), b["shapes"]).getpixel((70, 50)) == 0

    def test_ellipse(self):
        mask = imaging.region_mask((100, 100), [{"type": "ellipse", "x": 10, "y": 30, "w": 80,
                                                 "h": 40}])
        assert mask.getpixel((50, 50)) == 255 and mask.getpixel((85, 50)) == 255
        assert mask.getpixel((12, 32)) == 0  # the corner of its box is outside

    def test_union_of_regions(self):
        regions = [{"shapes": [RECT]}, {"shapes": [LASSO, BRUSH]}]
        assert imaging.union_mask((320, 240), regions).getbbox() == (20, 20, 297, 217)

    def test_unknown_shape(self):
        with pytest.raises(ValueError):
            imaging.region_mask((10, 10), [{"type": "star"}])


class TestAnnotate:
    # three regions, apart from each other and from the edges
    REGIONS = [
        {"shapes": [RECT]},
        {"shapes": [{"type": "lasso", "points": [[400, 60], [470, 70], [440, 120]]}]},
        {"shapes": [{"type": "brush", "points": [[250, 350], [300, 360]], "radius": 6}]},
    ]

    def test_annotation_marks_outside_regions(self):
        original = Image.open(io.BytesIO(noise_png((640, 480))))
        annotated = imaging.annotate(original, self.REGIONS)
        assert annotated.size == original.size
        assert max_diff(annotated, original) > 0
        # nothing is drawn inside the regions
        inside = imaging.union_mask(original.size, self.REGIONS)
        diff = ImageChops.difference(annotated, original.convert("RGB")).convert("L")
        assert ImageChops.multiply(diff, inside).getbbox() is None

    def test_the_outline_follows_the_shape_not_its_bounding_box(self):
        # a diagonal brush stroke: its bounding box's far corners are nowhere near it
        size = (640, 480)
        stroke = {"type": "brush", "points": [[100, 100], [540, 380]], "radius": 8}
        original = Image.new("RGB", size, (128, 128, 128))
        annotated = imaging.annotate(original, [{"shapes": [stroke]}])
        drawn = pixel_diff(annotated, original) > 0
        assert drawn.any()
        assert not drawn[380:, :120].any() and not drawn[:100, 520:].any()  # empty corners
        # every outline pixel lies a gap from the stroke: past its edge, within a line's width
        ring, _ = imaging.annotation_layout(size, [{"shapes": [stroke]}])[0]
        ys, xs = np.nonzero(ring)
        a, b = np.array([100, 100]), np.array([540, 380])
        ab = b - a
        t = np.clip(((xs - a[0]) * ab[0] + (ys - a[1]) * ab[1]) / (ab ** 2).sum(), 0, 1)
        away = np.hypot(xs - (a[0] + t * (b - a)[0]), ys - (a[1] + t * (b - a)[1])) - 8
        line = imaging.annotation_stroke(size)
        assert away.min() >= imaging.ANNOT_GAP * line - 1.5
        assert away.max() <= (imaging.ANNOT_GAP + 1) * line + 1.5

    def test_the_outline_hugs_a_small_region_and_keeps_an_erasers_notch(self):
        # a small region on a big image: what is circled is what was selected, not a
        # neighbourhood around it; a bite taken out with the eraser shows in the outline
        size = (1600, 1000)
        shapes = [{"type": "rect", "x": 700, "y": 400, "w": 120, "h": 120},
                  {"type": "ellipse", "x": 780, "y": 430, "w": 80, "h": 60, "op": "subtract"}]
        ring, _ = imaging.annotation_layout(size, [{"shapes": shapes}])[0]
        ys, xs = np.nonzero(ring)
        reach = (imaging.ANNOT_GAP + 1) * imaging.annotation_stroke(size)
        assert (xs.min(), ys.min()) == (700 - reach, 400 - reach)
        assert (xs.max(), ys.max()) == (820 + reach, 520 + reach)
        assert ring[460, 782:792].any()  # the outline runs into the bite, 780 and on
        selected = np.asarray(imaging.region_mask(size, shapes)) > 0
        assert not (ring & selected).any()

    def test_an_empty_region_draws_nothing(self):
        original = Image.new("RGB", (200, 150), (90, 90, 90))
        far_away = {"shapes": [{"type": "rect", "x": 900, "y": 900, "w": 5, "h": 5}]}
        assert max_diff(imaging.annotate(original, [far_away]), original) == 0

    def test_badge_avoids_region_at_image_corner(self):
        original = Image.open(io.BytesIO(noise_png((640, 480))))
        for shape in ({"type": "rect", "x": 10, "y": 10, "w": 40, "h": 40},
                      # regions that run to the image's edge: a sky, a thin strip, a side
                      {"type": "rect", "x": 0, "y": 0, "w": 640, "h": 190},
                      {"type": "rect", "x": 120, "y": 2, "w": 250, "h": 5},
                      {"type": "rect", "x": 420, "y": 0, "w": 220, "h": 480}):
            regions = [{"shapes": [shape]}]
            annotated = imaging.annotate(original, regions)
            inside = imaging.union_mask(original.size, regions)
            diff = ImageChops.difference(annotated, original.convert("RGB")).convert("L")
            assert ImageChops.multiply(diff, inside).getbbox() is None, shape

    def test_same_aspect(self):
        assert imaging.same_aspect((1536, 1024), (3072, 2048))
        assert imaging.same_aspect((1179, 2556), (1168, 2528))
        assert not imaging.same_aspect((1536, 1024), (1024, 1024))


class TestPasteBack:
    SIZE = (480, 360)
    REGION = {"type": "rect", "x": 200, "y": 150, "w": 100, "h": 60}

    def setup_method(self):
        self.original = scene(self.SIZE)
        self.mask = imaging.region_mask(self.SIZE, [self.REGION])

    def edited(self, *draws, drift: float = 1.0) -> Image.Image:
        """The model's output: the original, a little darker or brighter, plus new objects."""
        out = self.original.point(lambda v: round(min(255, v * drift)))
        d = ImageDraw.Draw(out)
        for box, color in draws:
            d.rectangle(box, fill=color)
        return out

    def test_replaces_inside_keeps_outside_pixel_for_pixel(self):
        result = self.edited(((210, 160, 290, 200), (250, 250, 250)))
        merged, note = imaging.paste_back(self.original, result, self.mask)
        assert note == ""
        assert merged.getpixel((250, 180)) == (250, 250, 250)
        far = 5 * imaging.feather_radius(self.SIZE)
        outside = np.asarray(imaging.region_mask(
            self.SIZE, [{**self.REGION, "x": 200 - far, "y": 150 - far, "w": 100 + 2 * far,
                         "h": 60 + 2 * far}])) == 0
        assert pixel_diff(merged, self.original)[outside].max() == 0

    def test_output_of_another_size_is_resized_by_the_caller_only(self):
        # paste_back wants the original's size; the job resizes first
        result = self.edited(((210, 160, 290, 200), (250, 250, 250)))
        merged, _ = imaging.paste_back(self.original, result, self.mask)
        assert merged.size == self.original.size

    def test_keeps_alpha(self):
        original = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
        merged, _ = imaging.paste_back(
            original, Image.new("RGB", (100, 100), "red"),
            imaging.region_mask((100, 100), [RECT | {"x": 10, "y": 10}]))
        assert merged.mode == "RGBA"
        assert merged.getpixel((99, 99)) == (0, 0, 0, 0)

    def test_leaked_annotation_is_removed(self):
        # worst case: the model copied the annotations; paste-back must restore the original
        original = scene((640, 480))
        regions = [{"shapes": [{"type": "rect", "x": 200, "y": 150, "w": 120, "h": 100}]}]
        annotated = imaging.annotate(original, regions)
        mask = imaging.union_mask(original.size, regions)
        merged, _ = imaging.paste_back(original, annotated, mask, annotated)
        assert max_diff(merged, original) <= 1

    def test_tone_drift_is_undone_so_the_patch_does_not_show(self):
        # the model darkened everything by 15%; the patch must not sit darker in the original
        result = self.edited(((240, 170, 260, 190), (250, 250, 250)), drift=0.85)
        naive = Image.composite(result, self.original,
                                self.mask.filter(ImageFilter.GaussianBlur(3)))
        merged, _ = imaging.paste_back(self.original, result, self.mask)
        # in the region, away from the new object, the original's tones come back
        probe = (205, 155, 235, 165)
        dark = pixel_diff(naive, self.original)[probe[1]:probe[3], probe[0]:probe[2]].mean()
        fixed = pixel_diff(merged, self.original)[probe[1]:probe[3], probe[0]:probe[2]].mean()
        assert dark > 12 and fixed < 3
        assert min(merged.getpixel((250, 180))) >= 245   # the new object keeps its color

    def test_tone_fit_does_not_tint_objects_darker_than_it_saw(self):
        # fitted on mid-tone background, then a black object appears: it stays black
        result = self.edited(((220, 160, 280, 200), (0, 0, 0)), drift=0.9)
        merged, _ = imaging.paste_back(self.original, result, self.mask)
        assert max(merged.getpixel((250, 180))) <= 6

    def test_large_edits_elsewhere_do_not_skew_the_tone(self):
        # the model also repainted half the picture: that is no drift to undo
        result = self.edited(((0, 0, 479, 120), (20, 160, 20)),
                             ((220, 160, 280, 200), (250, 40, 40)))
        fixed = imaging.match_tone(self.original, result, self.mask)
        assert pixel_diff(fixed, result).max() <= 2

    def test_an_overall_change_of_light_is_seen_although_it_is_only_a_tone_shift(self):
        # "make it a cold winter day": everything bluer and darker, within what match_tone undoes
        arr = np.asarray(self.original, np.float64)
        cold = Image.fromarray(np.clip(arr * [0.88, 0.9, 1.0] + [-28, -18, 26], 0, 255)
                               .astype(np.uint8))
        ImageDraw.Draw(cold).rectangle((220, 160, 280, 200), fill=(20, 20, 20))
        merged, note = imaging.paste_back(self.original, cold, self.mask, overall=True)
        assert note == NOTE_OVERALL and merged is not None
        # without the overall request it is the model's drift: undone and pasted back
        assert imaging.paste_back(self.original, cold, self.mask)[1] != NOTE_OVERALL

    def test_reframed_output_is_refused(self):
        # same aspect, but a different picture: nothing to paste back
        other = scene(self.SIZE, seed=7)
        merged, note = imaging.paste_back(self.original, other, self.mask)
        assert merged is None and note == NOTE_REFRAMED
        shifted = ImageChops.offset(self.original, 37, 21)
        assert imaging.paste_back(self.original, shifted, self.mask)[1] == NOTE_REFRAMED

    def test_blank_paper_away_from_the_region_is_not_taken_for_a_reframe(self):
        # a scanned page: only grain away from the date, which the model drew afresh (and the
        # page 3 px to the right): nothing to judge the framing by
        def page(text, dx, seed):
            grain = np.random.default_rng(seed).normal(236, 1.2, (360, 480))
            im = Image.fromarray(np.clip(grain, 0, 255).astype(np.uint8)).convert("RGB")
            ImageDraw.Draw(im).text((210 + dx, 165), text, fill=(30, 30, 30),
                                    font=ImageFont.load_default(size=28))
            return im
        merged, note = imaging.paste_back(page("2025", 0, 1), page("2026", 3, 2), self.mask)
        assert merged is not None and note != NOTE_REFRAMED

    def test_an_output_a_few_pixels_askew_in_places_still_pastes_back(self):
        # drawn up to 6 px off in a wavy pattern no scale and shift undo: the fine detail no
        # longer lines up, the coarser does. Zoomed by 8%, it is another framing
        original = scene((900, 600), seed=3)
        mask = imaging.region_mask(original.size, [{"type": "rect", "x": 400, "y": 250,
                                                    "w": 100, "h": 80}])
        yy, xx = np.mgrid[0:600, 0:900]
        sx = np.clip(np.rint(xx + 6 * np.sin(yy / 30)), 0, 899).astype(int)
        sy = np.clip(np.rint(yy + 6 * np.cos(xx / 35)), 0, 599).astype(int)
        askew = Image.fromarray(np.asarray(original)[sy, sx])
        assert imaging.aligned(original, askew, mask)
        zoomed = original.crop((36, 24, 864, 576)).resize(original.size, Image.Resampling.LANCZOS)
        assert not imaging.aligned(original, zoomed, mask)

    def test_flat_images_are_never_refused(self):
        flat = Image.new("RGB", self.SIZE, (128, 128, 128))
        result = Image.new("RGB", self.SIZE, (128, 128, 128))
        ImageDraw.Draw(result).rectangle((210, 160, 290, 200), fill=(250, 40, 40))
        merged, note = imaging.paste_back(flat, result, self.mask)
        assert merged is not None and note == ""
        assert merged.getpixel((250, 180)) == (250, 40, 40)


class TestTransparency:
    """A transparent original: models paint a backdrop there (mostly white), which must not
    come back as an opaque patch."""
    SIZE = (480, 360)
    REGION = {"type": "rect", "x": 300, "y": 120, "w": 120, "h": 120}

    def setup_method(self):
        art = scene(self.SIZE).convert("RGBA")
        shows = Image.new("L", self.SIZE, 0)
        ImageDraw.Draw(shows).ellipse((60, 40, 360, 320), fill=255)  # a sticker
        art.putalpha(shows)
        self.original = art
        self.mask = imaging.region_mask(self.SIZE, [self.REGION])
        # what the model returns: white where the original is transparent
        out = Image.new("RGB", self.SIZE, (255, 255, 255))
        out.paste(art.convert("RGB"), mask=shows)
        self.result = out

    def test_the_backdrop_the_model_painted_is_transparent_again(self):
        ImageDraw.Draw(self.result).rectangle((320, 150, 350, 200), fill=(200, 30, 30))
        merged, note = imaging.paste_back(self.original, self.result, self.mask)
        assert merged.mode == "RGBA"
        px = np.asarray(merged)
        assert px[130, 410, 3] == 0                     # region, over transparency: still clear
        assert tuple(px[170, 335]) == (200, 30, 30, 255)  # new content inside: as drawn
        assert px[200, 200, 3] == 255                   # the sticker itself untouched
        # pixel for pixel the original beyond the area
        assert (px[:, :250] == np.asarray(self.original)[:, :250]).all()

    def test_what_the_model_drew_over_the_backdrop_keeps_its_own_opacity(self):
        # a soft dark shadow and a light object reaching past the sticker's edge
        shadow = Image.new("L", self.SIZE, 0)
        ImageDraw.Draw(shadow).rectangle((380, 200, 415, 235), fill=128)
        self.result.paste((0, 0, 0), mask=shadow)
        merged, _ = imaging.paste_back(self.original, self.result, self.mask)
        r, g, b, a = merged.getpixel((400, 220))
        assert 110 <= a <= 145 and max(r, g, b) <= 6  # half see-through black, not gray

    def test_noise_on_a_backdrop_just_short_of_white_stays_clear(self):
        # measured: a backdrop of (254, 255, 255) with specks of 255 in it
        px = np.asarray(self.result).copy()
        clear = np.asarray(self.original.getchannel("A")) == 0
        px[clear] = (254, 255, 255)
        px[clear & (np.indices(clear.shape).sum(axis=0) % 3 == 0)] = (255, 255, 255)
        merged, _ = imaging.paste_back(self.original, Image.fromarray(px), self.mask)
        assert np.asarray(merged)[..., 3][clear].max() == 0

    def test_a_light_part_of_the_object_stays_opaque(self):
        light = self.original.copy()
        ImageDraw.Draw(light).rectangle((300, 150, 340, 200), fill=(245, 245, 245, 255))
        result = self.result.copy()
        ImageDraw.Draw(result).rectangle((300, 150, 340, 200), fill=(245, 245, 245))
        merged, _ = imaging.paste_back(light, result, self.mask)
        assert merged.getpixel((320, 170))[3] == 255

    def test_a_scene_the_model_drew_behind_is_no_backdrop(self):
        behind = scene(self.SIZE, seed=9)
        behind.paste(self.original.convert("RGB"), mask=self.original.getchannel("A"))
        toned = imaging.match_tone(self.original, behind, self.mask)
        seed = np.asarray(imaging._small(self.mask, 2)) > 0
        assert imaging.backdrop_of(self.original, toned, seed, 2) is None
        assert imaging.backdrop_of(self.original, self.result, seed, 2) == (255, 255, 255)

    def test_the_annotated_copy_shows_it_over_white(self):
        clear = Image.new("RGBA", (200, 150), (0, 0, 0, 0))
        out = imaging.annotate(clear, [{"shapes": [{"type": "rect", "x": 80, "y": 60, "w": 30,
                                                    "h": 30}]}])
        assert out.mode == "RGB" and out.getpixel((5, 140)) == (255, 255, 255)


class TestMergeParts:
    """An edit sent in parts put together: close-ups, and the whole image's output."""
    SIZE = (2400, 1600)

    def setup_method(self):
        self.full = scene(self.SIZE, seed=4)
        self.regions = [{"shapes": [{"type": "rect", "x": 300, "y": 260, "w": 90, "h": 70}]}]
        self.box = imaging.zoom_parts(self.SIZE, [(300, 260, 391, 331)])[0][0]

    def close_up(self, glow: bool) -> tuple:
        view = self.full.crop(self.box)
        shown = imaging.shift_regions(self.regions, -self.box[0], -self.box[1])
        mask = imaging.union_mask(view.size, shown)
        out = view.copy()
        ImageDraw.Draw(out).rectangle(mask.getbbox(), fill=(30, 90, 200))
        if glow:  # its own change of light, in the corner towards the rest of the image
            w, h = view.size
            ImageDraw.Draw(out).rectangle((w * 2 // 3, h * 2 // 3, w, h), fill=(255, 200, 120))
        return self.box, out, mask, imaging.annotate(view, shown)

    def test_a_close_up_fades_out_at_its_edges_inside_the_image(self):
        box, out, mask, annotated = self.close_up(glow=True)
        done = imaging.merge_parts(self.full, [(box, out, mask, annotated)])
        merged = np.asarray(done["merged"])
        x1, y1 = box[2] - 1, box[3] - 1  # its last column and row lie inside the image
        assert (merged[box[1]:y1 + 1, x1] == np.asarray(self.full)[box[1]:y1 + 1, x1]).all()
        assert (merged[y1, box[0]:x1 + 1] == np.asarray(self.full)[y1, box[0]:x1 + 1]).all()
        assert tuple(merged[290, 340]) == (30, 90, 200)

    def test_put_into_the_whole_output_a_close_up_adds_only_what_is_near_its_regions(self):
        whole = self.full.point(lambda v: min(255, v + 6))  # the whole image's, a little lighter
        ImageDraw.Draw(whole).rectangle((300, 260, 390, 330), fill=(40, 100, 190))
        box, out, mask, annotated = self.close_up(glow=True)
        done = imaging.merge_parts(self.full, [
            (None, whole, imaging.union_mask(self.SIZE, self.regions),
             imaging.annotate(self.full, self.regions)), (box, out, mask, annotated)])
        raw = np.asarray(done["raw"])
        # the glow lies far from the region: the whole output is kept there
        corner = (slice(box[3] - 60, box[3] - 20), slice(box[2] - 60, box[2] - 20))
        assert pixel_diff(Image.fromarray(raw[corner]),
                          Image.fromarray(np.asarray(whole)[corner])).max() <= 2
        # the region: the close-up's, in the whole output's (lighter) tones
        assert np.abs(raw[290, 340].astype(int) - (36, 96, 206)).max() <= 2
        # the whole image's own output is kept as it came, for its request's view
        assert done["parts"][0]["raw"][1].getpixel((340, 290)) == (40, 100, 190)


class TestGrowth:
    """When the model draws new content past the region, the pasted area follows it."""

    SIZE = (480, 360)
    REGION = {"type": "rect", "x": 200, "y": 150, "w": 100, "h": 60}

    def setup_method(self):
        self.original = scene(self.SIZE)
        self.mask = imaging.region_mask(self.SIZE, [self.REGION])

    def result(self, *draws):
        out = self.original.copy()
        d = ImageDraw.Draw(out)
        for box, color in draws:
            d.rectangle(box, fill=color)
        return out

    RED, YELLOW, GREEN = (200, 30, 30), (240, 220, 40), (20, 160, 20)

    def test_content_rising_out_of_the_region_is_kept_whole(self):
        result = self.result(((210, 160, 290, 200), self.RED),
                             ((240, 60, 260, 160), self.YELLOW),     # rises out of it
                             ((10, 10, 60, 50), (40, 40, 200)))      # an unconnected change
        merged, note = imaging.paste_back(self.original, result, self.mask)
        assert note == NOTE_SPILL_GROWN
        assert merged.getpixel((250, 100)) == self.YELLOW
        assert merged.getpixel((250, 180)) == self.RED
        # the far change stays out
        assert pixel_diff(merged, self.original)[10:50, 10:60].max() == 0

    def test_content_next_to_the_region_is_taken_whole_not_half_covered(self):
        # the model drew the object a little left of the box: a feather alone would
        # lay half of it, see-through, over the original
        result = self.result(((176, 160, 214, 200), self.RED))
        merged, _ = imaging.paste_back(self.original, result, self.mask)
        for x in (180, 195, 210):
            assert merged.getpixel((x, 180)) == self.RED

    def test_small_specks_are_not_bridged_to(self):
        result = self.result(((176, 160, 182, 164), self.RED))     # a speck beside the box
        merged, note = imaging.paste_back(self.original, result, self.mask)
        assert note == ""
        assert pixel_diff(merged, self.original)[160:164, 176:182].max() == 0

    def test_no_new_content_outside_keeps_the_region(self):
        result = self.result(((210, 160, 290, 200), self.RED))
        _, note = imaging.paste_back(self.original, result, self.mask)
        assert note == ""

    def test_runaway_growth_falls_back_to_the_region(self):
        # the model redrew the whole top, and the new object touches it; no threshold
        # tells the new object from the rest (flat picture, uniform change)
        flat = Image.new("RGB", self.SIZE, (128, 128, 128))
        result = flat.copy()
        d = ImageDraw.Draw(result)
        d.rectangle((0, 0, 479, 160), fill=self.GREEN)
        d.rectangle((210, 160, 290, 200), fill=self.RED)
        merged, note = imaging.paste_back(flat, result, self.mask)
        assert note == NOTE_SPILL_TOO_LARGE
        assert pixel_diff(merged, flat)[0:100, :].max() == 0

    def test_a_big_region_still_lets_new_content_continue_past_its_edge(self):
        # the sky was marked down to y=160, but it goes on to y=250 behind the buildings, and
        # the model repainted all of it (and relit the buildings a little)
        original = Image.new("RGB", self.SIZE, (255, 140, 60))
        buildings = scene(self.SIZE, seed=3).crop((0, 0, 480, 110))
        original.paste(buildings, (0, 250))
        result = Image.new("RGB", self.SIZE, (20, 30, 80))
        result.paste(buildings.point(lambda v: round(v * 0.8)), (0, 250))
        sky = {"type": "rect", "x": 0, "y": 0, "w": 480, "h": 160}
        merged, note = imaging.paste_back(original, result, imaging.region_mask(self.SIZE, [sky]))
        assert note == NOTE_SPILL_GROWN
        # the sky went on to the skyline (give or take the tone matching)
        assert all(abs(a - b) <= 30 for a, b in zip(merged.getpixel((240, 200)), (20, 30, 80),
                                                    strict=True))
        assert pixel_diff(merged, original)[275:, :].max() == 0   # the buildings, past the feather

    def test_content_may_be_tinted_with_the_rest_of_the_picture(self):
        # the model tinted everything pink and drew an object: the tint is undone, the object kept
        tinted = Image.blend(self.original, Image.new("RGB", self.SIZE, (200, 120, 120)), 0.25)
        d = ImageDraw.Draw(tinted)
        d.rectangle((210, 160, 290, 200), fill=self.RED)
        d.rectangle((240, 80, 260, 160), fill=self.YELLOW)
        merged, note = imaging.paste_back(self.original, tinted, self.mask)
        assert note == NOTE_SPILL_GROWN
        assert all(abs(a - b) <= 25 for a, b in zip(merged.getpixel((250, 100)), self.YELLOW,
                                                    strict=True))

    def test_echoed_annotation_box_is_not_pasted(self):
        # worst case: the model copied the box and the new object grows across it
        original = Image.new("RGB", (640, 480), (128, 128, 128))
        regions = [{"shapes": [{"type": "rect", "x": 250, "y": 200, "w": 120, "h": 100}]}]
        annotated = imaging.annotate(original, regions)
        result = annotated.copy()
        draw = ImageDraw.Draw(result)
        draw.rectangle((260, 210, 360, 290), fill=(250, 250, 250))
        draw.rectangle((300, 60, 320, 210), fill=(250, 250, 0))  # crosses the top edge of the box
        mask = imaging.union_mask(original.size, regions)
        echo = imaging.echoed_marks(original, annotated, result)
        assert echo is not None
        merged, _ = imaging.paste_back(original, result, mask, annotated)
        # where the box was copied, the original is back; the new object stops at the box
        leaked = ImageChops.multiply(ImageChops.difference(merged, original).convert("L"), echo)
        assert leaked.getbbox() is None
        assert pixel_diff(merged, original)[60:170, 300:321].max() == 0

    def test_a_copied_outline_drawn_a_little_off_is_not_pasted(self):
        # the outline sits within the feathered edge: copied, even a pixel or two off, the
        # original goes back along it; inside the region the edit stays
        original = scene((640, 480))
        shapes = [{"type": "lasso", "points": [[260, 180], [400, 200], [380, 320], [250, 300]]}]
        regions = [{"shapes": shapes}]
        annotated = imaging.annotate(original, regions)
        marks = ImageChops.difference(annotated, original).convert("L").point(
            lambda v: 255 if v > 48 else 0)
        result = original.copy()
        ImageDraw.Draw(result).rectangle((280, 210, 370, 290), fill=(240, 240, 240))
        for dx, dy in ((0, 0), (2, 1)):
            result.paste(annotated.transform(annotated.size, Image.Transform.AFFINE,
                                             (1, 0, -dx, 0, 1, -dy)),
                         mask=ImageChops.offset(marks, dx, dy))
        mask = imaging.union_mask(original.size, regions)
        assert imaging.echoed_marks(original, annotated, result) is not None
        merged, _ = imaging.paste_back(original, result, mask, annotated)
        outside = np.asarray(mask) == 0
        assert pixel_diff(merged, original)[outside].max() <= 4
        assert merged.getpixel((325, 250)) == (240, 240, 240)

    def test_annotation_not_echoed(self):
        original = Image.new("RGB", (640, 480), (128, 128, 128))
        regions = [{"shapes": [{"type": "rect", "x": 250, "y": 200, "w": 120, "h": 100}]}]
        annotated = imaging.annotate(original, regions)
        assert imaging.echoed_marks(original, annotated, original) is None


def text_page(size=(900, 520), word="41.1us", seed=3) -> Image.Image:
    """A screenshot-like page: rows of text in a table, dark on light; ``word`` at (480, 260)."""
    rng = np.random.default_rng(seed)
    im = Image.new("RGB", size, (250, 250, 248))
    d = ImageDraw.Draw(im)
    font = ImageFont.load_default(size=26)
    for y in range(30, size[1] - 30, 46):
        d.line((20, y - 8, size[0] - 20, y - 8), fill=(190, 190, 195), width=1)
        for x in range(30, size[0] - 120, 150):
            if not (y == 260 and x == 480):
                d.text((x, y), "".join(rng.choice(list("abcdefgh0123456789"), 5)), font=font,
                       fill=(30, 30, 40))
    d.text((480, 260), word, font=font, fill=(30, 30, 40))
    return im


def drawn_at(page: Image.Image, size: tuple[int, int], kx: float, tx: float, ky: float,
             ty: float) -> Image.Image:
    """``page`` as a model returns it: drawn at ``size``, with the original's pixel at c landing
    at (1 + k) c + t (in the original's pixels) once resized back."""
    w, h = page.size
    pad = 60
    padded = Image.fromarray(np.pad(np.asarray(page), ((pad, pad), (pad, pad), (0, 0)),
                                    mode="edge"))
    box = (pad - tx / (1 + kx), pad - ty / (1 + ky), pad + (w - tx) / (1 + kx),
           pad + (h - ty) / (1 + ky))
    return padded.resize(size, Image.Resampling.LANCZOS, box=box)


class TestRegister:
    """The output is put on the original's pixel grid before pasting back."""

    REGION = [{"shapes": [{"type": "rect", "x": 470, "y": 250, "w": 70, "h": 40}]}]

    @pytest.mark.parametrize("out_size, kx, tx, ky, ty", [
        ((924, 534), 0.002, -1.4, -0.011, 0.8),   # a model's own size, a little off
        ((1312, 758), -0.004, 2.2, 0.003, -1.9),  # drawn larger
        ((900, 520), 0.0, 1.5, 0.0, -2.5),        # the same size, shifted
    ])
    def test_finds_the_scale_and_shift_of_each_axis(self, out_size, kx, tx, ky, ty):
        page = text_page()
        mask = imaging.union_mask(page.size, self.REGION)
        fit = imaging._register_fit(page, drawn_at(page, out_size, kx, tx, ky, ty), mask)
        assert fit is not None
        (fkx, ftx), (fky, fty) = fit
        w, h = page.size
        # off by at most a fifth of a pixel anywhere on the image
        assert max(abs((fkx - kx) * c + ftx - tx) for c in (0, w)) < 0.2
        assert max(abs((fky - ky) * c + fty - ty) for c in (0, h)) < 0.2

    def test_a_registered_output_lines_up_and_pastes_back_without_doubled_lines(self):
        page = text_page()
        mask = imaging.union_mask(page.size, self.REGION)
        out = drawn_at(page, (924, 534), 0.002, -1.4, -0.011, 0.8)
        plain = out.resize(page.size, Image.Resampling.LANCZOS)
        aligned = imaging.register(page, out, mask)
        far = ~imaging._dilate(np.asarray(mask) > 0, 60)
        assert pixel_diff(aligned, page)[far].mean() < 0.3 * pixel_diff(plain, page)[far].mean()
        merged, _ = imaging.paste_back(page, aligned, mask)
        assert pixel_diff(merged, page)[far].max() <= 8

    def test_an_output_already_in_place_is_left_as_it_is(self):
        page = text_page()
        mask = imaging.union_mask(page.size, self.REGION)
        assert imaging.registration_box(page, page.copy(), mask) is None
        assert imaging.register(page, page.copy(), mask).tobytes() == page.tobytes()

    def test_a_repeated_pattern_is_not_matched_a_period_off(self):
        # identical cells 18 px apart (a diagram, a table): a copy one cell off matches as well
        # as the right place, and on the coarse search's steps often better. Measured before:
        # an output not off at all was put 18 px up and left
        size, period = (1200, 800), 18
        base = Image.new("RGB", size, (245, 245, 240))
        d = ImageDraw.Draw(base)
        for y in range(0, size[1], period):
            for x in range(0, size[0], period):
                d.rounded_rectangle((x + 3, y + 3, x + period - 3, y + period - 3), 4,
                                    fill=(160, 210, 150), outline=(60, 120, 60), width=2)
        mask = imaging.region_mask(size, [{"type": "rect", "x": 600, "y": 400, "w": 18, "h": 18}])
        for dx, dy in ((3, -2), (0, 0), (-2, 1)):
            out = Image.fromarray(np.roll(np.roll(np.asarray(base), dy, 0), dx, 1))
            (kx, tx), (ky, ty) = imaging._register_fit(base, out, mask)
            assert abs(kx) < 1e-4 and abs(ky) < 1e-4
            assert (round(tx, 1), round(ty, 1)) == (dx, dy)

    def test_an_unrelated_output_is_only_resized(self):
        page = text_page()
        mask = imaging.union_mask(page.size, self.REGION)
        other = Image.open(io.BytesIO(noise_png((924, 534))))
        assert imaging.registration_box(page, other, mask) is None


class TestWholePieces:
    """Changed words are never blended half and half with the original."""

    def test_a_word_rewritten_past_the_region_is_taken_whole(self):
        # the region covers the first two characters; the model rewrote all of them
        page = text_page(word="41.1us")
        result = text_page(word="12.3us")
        mask = imaging.region_mask(page.size, [{"type": "rect", "x": 474, "y": 256, "w": 30,
                                                 "h": 30}])
        merged, _ = imaging.paste_back(page, result, mask)
        word = (470, 256, 560, 288)
        assert pixel_diff(merged.crop(word), result.crop(word)).max() <= 4

    def test_a_changed_word_in_the_feathered_edge_comes_from_one_side(self):
        # the region stops just short of the word: the feathered edge reaches into it
        page = text_page(word="41.1us")
        result = text_page(word="12.3us")
        mask = imaging.region_mask(page.size, [{"type": "rect", "x": 400, "y": 300, "w": 60,
                                                 "h": 40}])
        merged, _ = imaging.paste_back(page, result, mask)
        word = (480, 258, 560, 290)
        off_page = pixel_diff(merged.crop(word), page.crop(word))
        off_result = pixel_diff(merged.crop(word), result.crop(word))
        # every pixel of the word is the original's or the output's, not a mix of the two
        assert min(off_page.max(), off_result.max()) <= 2

    def test_a_rewritten_line_running_far_past_the_region_is_taken_whole(self):
        # a date on a poster: the region covers its first half, the model rewrote all of it
        def poster(line):
            im = Image.new("RGB", (1536, 1024), (250, 248, 240))
            d = ImageDraw.Draw(im)
            font = ImageFont.load_default(size=44)
            for y in (100, 230, 640, 770):
                d.text((90, y), "lorem ipsum dolor sit amet", font=font, fill=(90, 40, 20))
            d.text((90, 420), line, font=font, fill=(90, 40, 20))
            return im

        page, result = poster("2026-10-25  Sat  14:00"), poster("2026-11-08  Sun  15:00")
        mask = imaging.region_mask(page.size, [{"type": "rect", "x": 80, "y": 410, "w": 330,
                                                 "h": 75}])
        merged, _ = imaging.paste_back(page, result, mask)
        line = (80, 410, 700, 485)
        assert pixel_diff(merged.crop(line), result.crop(line)).max() <= 4

    def test_the_rest_of_a_line_moved_by_a_shorter_word_is_not_doubled(self):
        # "1234" became "99": the words after it moved left, past the region's edge
        def line(text):
            im = Image.new("RGB", (1536, 1024), (245, 245, 240))
            d = ImageDraw.Draw(im)
            for x in range(0, 1536, 64):
                d.line((x, 0, x, 1024), fill=(200, 200, 200))
            d.text((200, 300), text, fill=(20, 20, 20), font=ImageFont.load_default(size=48))
            return im

        page, result = line("Total: 1234 USD per month"), line("Total: 99 USD per month")
        mask = imaging.region_mask(page.size, [{"type": "rect", "x": 345, "y": 300, "w": 125,
                                                 "h": 60}])
        merged, _ = imaging.paste_back(page, result, mask)
        text = (180, 290, 900, 370)
        # at most a faint trace where the old line's end was, not a second set of letters
        assert pixel_diff(merged.crop(text), result.crop(text)).max() <= 12

    @staticmethod
    def paragraph(edited="flat", push=0, dx=0, dy=0, soft=0.0):
        """A paragraph with ``edited`` in its fifth line; the rest of that line ``push`` pixels
        along, everything ``dx``, ``dy`` off and blurred by ``soft``, as a model redraws it."""
        im = Image.new("RGB", (1536, 1024), (255, 255, 255))
        d = ImageDraw.Draw(im)
        font = ImageFont.load_default(size=30)
        words = "the quarterly report shows steady growth across all regions while costs".split()
        for k in range(9):
            line = " ".join(words[(k + j) % len(words)] for j in range(11))
            y = 120 + k * 48 + dy
            if k == 4:
                d.text((60 + dx, y), "costs remained", font=font, fill=(40, 40, 40))
                d.text((300 + dx, y), edited, font=font, fill=(40, 40, 40))
                d.text((390 + push + dx, y), line, font=font, fill=(40, 40, 40))
            else:
                d.text((60 + dx, y), line, font=font, fill=(40, 40, 40))
        return im.filter(ImageFilter.GaussianBlur(soft)) if soft else im

    PARAGRAPH_REGION = [{"type": "rect", "x": 290, "y": 310, "w": 100, "h": 44}]

    def blended(self, merged, page, result, box):
        """Pixels within ``box`` that are neither the original's nor the output's, where the two
        clearly differ: a word drawn twice."""
        m, o, r = (np.asarray(im.crop(box), np.int16) for im in (merged, page, result))
        apart = np.abs(o - r).max(axis=2) >= 48
        mixed = np.minimum(np.abs(m - o).max(axis=2), np.abs(m - r).max(axis=2)) >= 16
        return int((apart & mixed).sum())

    def test_lines_the_model_only_redrew_a_pixel_off_are_not_drawn_twice(self):
        # around the edited word the model redrew the paragraph a pixel off and softer: the lines
        # above and below run through the feathered edge
        page = self.paragraph()
        mask = imaging.region_mask(page.size, self.PARAGRAPH_REGION)
        result = imaging.register(page, self.paragraph("yearly", dx=2, dy=1, soft=0.8), mask)
        merged, _ = imaging.paste_back(page, result, mask)
        assert self.blended(merged, page, result, (200, 240, 600, 420)) == 0
        # and the original stays beyond the words next to the region (taken whole)
        far = ~imaging._dilate(np.asarray(mask) > 0, 150)
        assert pixel_diff(merged, page)[far].max() == 0

    def test_a_line_pushed_along_by_a_longer_word_is_cut_at_a_word_space(self):
        # "flat" became "yearly", and the rest of the line moved along by more than a word space,
        # far past the zone: the line comes from the output up to a word space, then the original
        page = self.paragraph()
        result = self.paragraph("yearly", push=11)
        mask = imaging.region_mask(page.size, self.PARAGRAPH_REGION)
        merged, _ = imaging.paste_back(page, result, mask)
        line = (40, 308, 1536, 356)
        assert self.blended(merged, page, result, line) == 0
        # each column of the line is all one image's: no letter is cut across
        m, o, r = (np.asarray(im.crop(line).convert("L"), np.int16)
                   for im in (merged, page, result))
        from_page = (np.abs(m - o) <= 2).all(axis=0)
        from_result = (np.abs(m - r) <= 2).all(axis=0)
        assert (from_page | from_result).all()

    def test_tolerant_diff_ignores_a_shift_of_a_pixel(self):
        page = np.asarray(text_page())
        shifted = np.roll(page, 1, axis=1)
        assert imaging.tolerant_diff(page, shifted)[:, 2:-2].max() == 0
        other = np.asarray(text_page(seed=4))
        assert imaging.tolerant_diff(page, other).max() > 100

    def test_a_line_is_split_at_spaces_both_images_have(self):
        # two words; in the output the second moved along a little, less than the space
        def words(second_at):
            im = Image.new("RGB", (400, 60), (255, 255, 255))
            d = ImageDraw.Draw(im)
            font = ImageFont.load_default(size=30)
            d.text((10, 10), "steady", font=font, fill=(0, 0, 0))
            d.text((second_at, 10), "growth", font=font, fill=(0, 0, 0))
            return np.asarray(im)

        o, r = words(140), words(144)
        changed = imaging.tolerant_diff(o, r) >= imaging.PIECE_WEAK
        lines = imaging._lines(changed, 9)
        assert len(np.unique(lines[lines > 0])) == 1  # one line...
        split = imaging._split_at_spaces(lines, o, r)
        left, right = split[:, :120], split[:, 140:]
        assert set(np.unique(left[left > 0])).isdisjoint(np.unique(right[right > 0]))  # two words

    def test_label8_groups_like_a_flood_fill(self):
        rng = np.random.default_rng(1)
        for _ in range(50):
            m = rng.random((int(rng.integers(1, 25)), int(rng.integers(1, 25)))) < 0.45
            labels = imaging._label8(m)
            assert (labels[~m] == 0).all()
            work = imaging._bool_image(m).copy()
            for y, x in zip(*np.nonzero(m), strict=True):
                if work.getpixel((int(x), int(y))) != 255:
                    continue
                # Pillow's flood fill is 4-connected: grow it by the diagonals by hand
                comp = np.zeros_like(m)
                comp[y, x] = True
                while True:
                    grown = imaging._dilate(comp, 1) & m
                    if (grown == comp).all():
                        break
                    comp = grown
                assert len(set(labels[comp].tolist())) == 1
                assert not (labels[m & ~comp] == labels[y, x]).any()
                work.paste(0, mask=imaging._bool_image(comp))


class TestMaskOps:
    """The small-scale mask helpers match PIL's rank filters and flood fill."""

    @pytest.mark.parametrize("radius", [1, 2, 3, 5, 9, 30])
    def test_dilate_and_erode_match_pil(self, radius):
        mask = np.random.RandomState(radius).rand(60, 80) > 0.985

        def pil(m, rank_filter):
            im = Image.fromarray(m.astype(np.uint8) * 255).filter(rank_filter(2 * radius + 1))
            return np.asarray(im) > 0

        assert np.array_equal(imaging._dilate(mask, radius), pil(mask, ImageFilter.MaxFilter))
        assert np.array_equal(imaging._erode(~mask, radius), pil(~mask, ImageFilter.MinFilter))

    def test_fill_holes_keeps_open_shapes_open(self):
        ring = np.zeros((20, 20), bool)
        ring[4:16, 4:16] = True
        ring[8:12, 8:12] = False
        assert imaging._fill_holes(ring)[10, 10]
        ring[8:12, 4] = False  # open it on one side: nothing is enclosed any more
        ring[10, 4:9] = False
        assert not imaging._fill_holes(ring)[10, 10]

    def test_components_near_returns_only_touching_components(self):
        strong = np.zeros((40, 40), bool)
        strong[5:10, 5:10] = True
        strong[20:30, 20:22] = True
        strong[0, 39] = True
        zone = np.zeros_like(strong)
        zone[5:25, 5:25] = True
        assert sorted(int(c.sum()) for c in imaging._components_near(strong, zone)) == [20, 25]


class TestZoom:
    def test_a_small_region_of_a_large_image_gets_a_close_up_around_it(self):
        box = imaging.zoom_box((3840, 2160), (3005, 899, 3422, 1007))
        x0, y0, x1, y1 = box
        w, h = x1 - x0, y1 - y0
        assert w * h >= imaging.ZOOM_MIN_PIXELS and imaging.same_aspect((w, h), (3840, 2160))
        assert x0 <= 3005 and y0 <= 899 and x1 >= 3422 and y1 >= 1007  # the region, within
        assert imaging.zoom_box((3840, 2160), (3760, 900, 3830, 1000))[2] == 3840  # kept inside
        # asked for larger than it is, in its proportions, at a size every model takes
        out_w, out_h = map(int, imaging.zoom_size(box).split("x"))
        assert out_w * out_h > w * h and imaging.same_aspect((out_w, out_h), (w, h))
        assert pb.fit_size(out_w, out_h) == f"{out_w}x{out_h}"

    def test_the_close_up_keeps_twice_the_regions_extent(self):
        x0, y0, x1, y1 = imaging.zoom_box((6000, 4000), (1000, 1000, 1700, 1100))
        assert x1 - x0 >= 1400 and x0 <= 1000 - 300 and x1 >= 1700 + 300

    @pytest.mark.parametrize("size, box", [
        ((1536, 1024), (100, 100, 200, 200)),  # the image is about the model's size already
        ((3840, 2160), (0, 0, 2400, 1400)),    # a large region
    ])
    def test_otherwise_the_whole_image_goes(self, size, box):
        assert imaging.zoom_box(size, box) is None

    def test_regions_close_together_share_a_close_up(self):
        size = (6000, 4000)
        boxes = [(1000, 1000, 1100, 1080), (1300, 1100, 1400, 1180),  # near each other
                 (5000, 3500, 5100, 3580),                             # far from them
                 None,                                                 # empty
                 (0, 0, 4000, 3000)]                                   # too large for any
        parts = imaging.zoom_parts(size, boxes)
        assert [numbers for _, numbers in parts] == [[0, 1], [2]]
        z = parts[0][0]
        assert z == imaging.zoom_box(size, (1000, 1000, 1400, 1180))
        assert imaging.zoom_parts(size, [(1000, 1000, 1100, 1080)]) == [
            (imaging.zoom_box(size, (1000, 1000, 1100, 1080)), [0])]

    def test_past_the_most_close_ups_the_largest_go_whole(self):
        size = (8000, 8000)
        # far apart, each its own close-up; the larger, the later
        boxes = [(x, y, x + 100 + 300 * k, y + 100)
                 for k, (x, y) in enumerate([(100, 100), (5000, 100), (100, 5000), (5000, 5000),
                                             (2500, 2500)])]
        parts = imaging.zoom_parts(size, boxes)
        assert [numbers for _, numbers in parts] == [[0], [1], [2], [3]]
        assert len(parts) == imaging.ZOOM_MAX_PARTS
        boxes.reverse()  # the order of the regions is kept
        assert [numbers for _, numbers in imaging.zoom_parts(size, boxes)] == [[1], [2], [3], [4]]

    def test_a_close_up_shows_its_regions_with_their_own_numbers_and_colors(self):
        region = {"shapes": [{"type": "rect", "x": 40, "y": 40, "w": 60, "h": 40}]}
        image = Image.new("RGB", (200, 150), (128, 128, 128))
        colors = {c for _, c in imaging.annotate(image, [region], numbers=[2]).getcolors(10000)}
        assert (52, 199, 89) in colors and (255, 59, 48) not in colors  # green, region 3's

    def test_regions_move_with_the_crop(self):
        regions = [{"instruction": "a", "shapes": [
            {"type": "rect", "x": 10, "y": 20, "w": 5, "h": 5, "op": "subtract"},
            {"type": "lasso", "points": [[10, 10], [20, 10], [15, 30]]},
            {"type": "brush", "points": [[50, 50]], "radius": 4}]}]
        moved = imaging.shift_regions(regions, -10, -5)
        assert moved[0]["shapes"] == [
            {"type": "rect", "x": 0, "y": 15, "w": 5, "h": 5, "op": "subtract"},
            {"type": "lasso", "points": [[0, 5], [10, 5], [5, 25]]},
            {"type": "brush", "points": [[40, 45]], "radius": 4}]
        assert regions[0]["shapes"][0]["x"] == 10  # the original is left as it was


class TestNormalizeUpload:
    def test_an_image_too_large_to_use_is_refused_before_it_is_decoded(self):
        # 13000 x 13000 flat PNG: a few hundred KB, 676 MB once decoded
        buf = io.BytesIO()
        Image.new("L", (13000, 13000)).save(buf, "PNG")
        assert len(buf.getvalue()) < 1_000_000
        with pytest.raises(UserError) as exc:
            imaging.normalize_upload(buf.getvalue())
        assert exc.value.code == "image_too_large" and exc.value.params["max_mp"] == 100

    def test_png_kept_byte_for_byte(self):
        data = make_png()
        assert imaging.normalize_upload(data) is data

    def test_exif_rotation_baked_into_pixels(self):
        im = Image.new("RGB", (60, 40), "blue")
        exif = im.getexif()
        exif[0x0112] = 6  # displayed rotated 90° clockwise
        buf = io.BytesIO()
        im.save(buf, "JPEG", exif=exif)
        out = imaging.normalize_upload(buf.getvalue())
        result = Image.open(io.BytesIO(out))
        assert result.format == "PNG"
        assert result.size == (40, 60)

    def test_gif_and_cmyk_converted_to_png(self):
        for fmt, mode in (("GIF", "P"), ("JPEG", "CMYK")):
            buf = io.BytesIO()
            Image.new(mode, (20, 10)).save(buf, fmt)
            result = Image.open(io.BytesIO(imaging.normalize_upload(buf.getvalue())))
            assert (result.format, result.mode, result.size) == ("PNG", "RGB", (20, 10))

    def test_a_cmyk_profile_is_not_left_on_rgb_pixels(self):
        # Pillow keeps it in info, and the PNG would carry it: an RGB image tagged as CMYK
        buf = io.BytesIO()
        Image.new("CMYK", (20, 10), (0, 200, 200, 0)).save(buf, "JPEG", icc_profile=b"junk" * 40)
        result = Image.open(io.BytesIO(imaging.normalize_upload(buf.getvalue())))
        assert result.mode == "RGB" and "icc_profile" not in result.info

    @pytest.mark.skipif(not Path(CMYK_PROFILE).exists(), reason="needs a CMYK profile (macOS)")
    def test_cmyk_colours_go_through_their_profile(self):
        icc = Path(CMYK_PROFILE).read_bytes()
        cmyk = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        red = ImageCms.profileToProfile(Image.new("RGB", (20, 10), (200, 40, 40)),
                                        ImageCms.createProfile("sRGB"), cmyk, outputMode="CMYK")
        buf = io.BytesIO()
        red.save(buf, "JPEG", icc_profile=icc, quality=95)
        out = Image.open(io.BytesIO(imaging.normalize_upload(buf.getvalue()))).getpixel((10, 5))
        # the plain conversion is 30 off
        assert max(abs(a - b) for a, b in zip(out, (200, 40, 40), strict=True)) < 20

    def test_palette_transparency_kept(self):
        im = Image.new("P", (20, 10), 0)
        im.putpalette([0, 0, 0, 255, 0, 0])
        im.info["transparency"] = 0
        buf = io.BytesIO()
        im.save(buf, "PNG", transparency=0)
        out = Image.open(io.BytesIO(imaging.normalize_upload(buf.getvalue())))
        assert out.mode == "RGBA" and out.getpixel((0, 0))[3] == 0
        # transparent pixels outside the region stay transparent
        merged, _ = imaging.paste_back(out, Image.new("RGB", (20, 10), "white"),
                                       imaging.region_mask((20, 10), [
                                           {"type": "rect", "x": 0, "y": 0, "w": 3, "h": 3}]))
        assert merged.mode == "RGBA" and merged.getpixel((19, 9))[3] == 0

    def test_rejects_non_images(self):
        for data, code in ((b"<html>", "not_an_image"),
                           (b"\x89PNG\r\n\x1a\n" + b"\x00" * 10, "bad_image")):
            with pytest.raises(UserError) as exc:
                imaging.normalize_upload(data)
            assert exc.value.code == code

    def test_grayscale_kept_and_grayscale_with_key_color_becomes_rgba(self):
        data = make_png(mode="L", color=128)
        assert imaging.normalize_upload(data) is data
        buf = io.BytesIO()
        Image.new("L", (8, 8), 0).save(buf, "PNG", transparency=0)
        out = Image.open(io.BytesIO(imaging.normalize_upload(buf.getvalue())))
        assert out.mode == "RGBA" and out.getpixel((0, 0))[3] == 0

    def test_16_bit_grayscale_keeps_its_tones(self):
        ramp = np.tile(np.linspace(2000, 56000, 64).astype(np.uint16), (8, 1))
        for key in (None, 2000):
            buf = io.BytesIO()
            Image.fromarray(ramp).save(buf, "PNG", **({} if key is None else {"transparency": key}))
            out = Image.open(io.BytesIO(imaging.normalize_upload(buf.getvalue())))
            gray = np.asarray(out.convert("L"), int)[0]
            assert out.mode == ("RGB" if key is None else "RGBA")
            assert abs(gray[0] - 2000 // 256) <= 1 and abs(gray[-1] - 56000 // 256) <= 1
            assert (np.diff(gray) >= 0).all() and len(set(gray)) > 50
        assert out.getpixel((0, 0))[3] == 0 and out.getpixel((1, 0))[3] == 255


class TestForApi:
    def test_small_image_sent_unchanged(self):
        data = make_png((640, 480))
        assert imaging.for_api(data) is data

    def test_large_image_scaled_and_pairs_stay_aligned(self):
        photo = noise_png((400, 300))
        annotated = imaging.png_bytes(imaging.annotate(
            Image.open(io.BytesIO(photo)), [{"shapes": [RECT]}]))
        a = Image.open(io.BytesIO(imaging.for_api(photo, max_pixels=30_000)))
        b = Image.open(io.BytesIO(imaging.for_api(annotated, max_pixels=30_000)))
        assert a.size == b.size and a.size[0] * a.size[1] <= 30_000
        assert a.format == "JPEG"
        assert abs(a.size[0] / a.size[1] - 4 / 3) < 0.02

    def test_a_transparent_image_goes_over_white_as_png(self):
        # models read transparency inconsistently (the black stored under it, say): sent as it
        # is usually shown, and as the annotated copy shows it
        rgba = np.zeros((300, 400, 4), np.uint8)
        rgba[100:200, 100:300] = (200, 30, 30, 255)
        out = Image.open(io.BytesIO(imaging.for_api(imaging.png_bytes(Image.fromarray(rgba)))))
        assert (out.format, out.mode, out.size) == ("PNG", "RGB", (400, 300))
        assert out.getpixel((10, 10)) == (255, 255, 255)
        assert out.getpixel((150, 150)) == (200, 30, 30)

    def test_a_transparent_image_too_large_even_as_png_goes_as_jpeg_of_its_size(self, monkeypatch):
        monkeypatch.setattr(imaging, "API_MAX_BYTES", 200_000)
        rgba = np.random.default_rng(1).integers(0, 256, (300, 400, 4), np.uint8)
        rgba[..., 3] = np.where(np.arange(400) < 100, 0, 255)
        data = imaging.png_bytes(Image.fromarray(rgba, "RGBA"))
        assert len(data) > 200_000
        out = imaging.for_api(data)
        im = Image.open(io.BytesIO(out))
        # the same size as the annotated copy, which is opaque and goes as it is
        assert len(out) <= 200_000 and (im.format, im.size) == ("JPEG", (400, 300))
