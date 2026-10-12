// Put the edited region of the model's output onto the original, and nothing more:
// a port of brushgraft.imaging (see there for the reasoning behind each step). The
// constants come from generated/spec.json, shared with the Python side.

import { spec } from "../backend/spec";
import {
  and, count, dilate, dilateAxis, erode, erodeClosed, fillHoles, floodGrow, fromGray, label8, newBits, not, or, without, componentsNear,
  cloneBits, type Bits,
} from "./bits";
import {
  bbox, composite, crop, darker, gaussianBlur, blurReach, lighter, newRaster, paste, point, resize, resizeNearest,
  toGray, toRgb, toRgba, copyRaster, type Raster,
} from "./raster";
import { clamp, mean, median, percentile, percentilesOfBytes, roundHalfEven } from "./stats";

const K = spec.imaging;
const NOTE = spec.notes;

export const sameAspect = (a: [number, number], b: [number, number]): boolean =>
  Math.abs(a[0] / a[1] / (b[0] / b[1]) - 1) <= K.aspect_tolerance;

/** Feather radius of the paste-back edge, scaled to the image (~9px at 1536). */
export const featherRadius = (width: number, height: number): number =>
  Math.max(2, roundHalfEven(Math.max(width, height) * 0.006));

/** Width of the outlines in the annotated image. */
export const annotationStroke = (width: number, height: number): number => Math.max(3, roundHalfEven(Math.max(width, height) / 400));

/** Radius of the numbered discs in the annotated image. */
export const annotationBadge = (width: number, height: number): number => Math.max(12, roundHalfEven(Math.max(width, height) / 70));

/** Shrink factor for the analysis; small images are barely shrunk. */
export const scaleFor = (width: number, height: number): number =>
  Math.max(1, Math.min(K.spill_scale, Math.floor(Math.min(width, height) / 96)));

const small = (im: Raster, scale: number): Raster =>
  resize(im, Math.max(1, Math.floor(im.width / scale)), Math.max(1, Math.floor(im.height / scale)), "box");

/** A grayscale mask as bits at 1/scale size. */
export const smallBits = (mask: Raster, scale: number): Bits => {
  const s = small(mask, scale);
  return fromGray(s.data, s.width, s.height);
};

/**
 * Where the output is compared with the original (at 1/scale): away from the regions (``seed``),
 * and where the original shows. Under transparent pixels it stores colors no one sees, which a
 * model returns as anything (often white).
 */
function farFrom(original: Raster, seed: Bits, scale: number): Bits {
  const far = not(dilate(seed, Math.floor(K.align_margin / scale)));
  if (original.channels !== 4) return far;
  const alpha = newRaster(original.width, original.height, 1);
  for (let i = 0; i < alpha.data.length; i++) alpha.data[i] = original.data[i * 4 + 3];
  const a = small(alpha, scale);
  const opaque = erode(fromGray(a.data.map((v) => (v === 255 ? 1 : 0)), a.width, a.height), 4);
  return and(far, opaque);
}

export const bitsToGray = (b: Bits): Raster => {
  const out = newRaster(b.w, b.h, 1);
  for (let i = 0; i < b.d.length; i++) out.data[i] = b.d[i] ? 255 : 0;
  return out;
};

// ---------------------------------------------------------------------------
// Measuring change
// ---------------------------------------------------------------------------
const LINEAR = Float64Array.from({ length: 256 }, (_, v) => {
  const x = v / 255;
  return x > 0.04045 ? ((x + 0.055) / 1.055) ** 2.4 : x / 12.92;
});

const lab = (f: number) => (f > 0.008856 ? Math.cbrt(f) : 7.787 * f + 16 / 116);

/** sRGB to CIE Lab, whose distances follow what the eye sees: three planes. */
function labOf(im: Raster): [Float64Array, Float64Array, Float64Array] {
  const n = im.width * im.height;
  const L = new Float64Array(n);
  const A = new Float64Array(n);
  const B = new Float64Array(n);
  const c = im.channels;
  for (let i = 0; i < n; i++) {
    const r = LINEAR[im.data[i * c]];
    const g = LINEAR[im.data[i * c + 1]];
    const b = LINEAR[im.data[i * c + 2]];
    const fx = lab((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505);
    const fy = lab(0.2126 * r + 0.7152 * g + 0.0722 * b);
    const fz = lab((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089);
    L[i] = 116 * fy - 16;
    A[i] = 500 * (fx - fy);
    B[i] = 200 * (fy - fz);
  }
  return [L, A, B];
}

/** How much ``result`` differs from ``original`` at each pixel, at 1/scale size. */
function changeMap(original: Raster, result: Raster, scale: number): Float64Array {
  const prep = (im: Raster) => labOf(gaussianBlur(small(toRgb(im), scale), 1));
  const [l1, a1, b1] = prep(original);
  const [l2, a2, b2] = prep(result);
  const out = new Float64Array(l1.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(l1[i] - l2[i], a1[i] - a2[i], b1[i] - b2[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Copied annotation marks
// ---------------------------------------------------------------------------
/** Boxes and numbers the model copied from the annotated image (grayscale, 255 = copied), or null. */
export function echoedMarks(original: Raster, annotated: Raster, result: Raster): Raster | null {
  const n = original.width * original.height;
  const echo = newRaster(original.width, original.height, 1);
  const co = original.channels;
  const ca = annotated.channels;
  const cr = result.channels;
  let marks = 0;
  let copied = 0;
  for (let i = 0; i < n; i++) {
    const m = Math.max(
      Math.abs(annotated.data[i * ca] - original.data[i * co]),
      Math.abs(annotated.data[i * ca + 1] - original.data[i * co + 1]),
      Math.abs(annotated.data[i * ca + 2] - original.data[i * co + 2]),
    );
    if (m <= 48) continue;
    marks++;
    const d = Math.max(
      Math.abs(result.data[i * cr] - annotated.data[i * ca]),
      Math.abs(result.data[i * cr + 1] - annotated.data[i * ca + 1]),
      Math.abs(result.data[i * cr + 2] - annotated.data[i * ca + 2]),
    );
    if (d <= 40) {
      echo.data[i] = 255;
      copied++;
    }
  }
  return copied && copied >= K.echo_min_share * marks ? echo : null;
}

/**
 * Where the original goes back over copied marks (255 = all original): the copied pixels and a
 * line's width around them, outside the regions; whole, with only its edge softened by a pixel.
 */
export function copiedBand(echo: Raster, mask: Raster): Raster {
  const { width: w, height: h } = echo;
  const band = bitsToGray(without(dilate(fromGray(echo.data, w, h), annotationStroke(w, h)), fromGray(mask.data, w, h)));
  return lighter(band, gaussianBlur(band, 1));
}

// ---------------------------------------------------------------------------
// Whole pieces in the feathered edge
// ---------------------------------------------------------------------------
type Settle = (soft: Raster, ox: number, oy: number) => Raster;

/**
 * The area with the changed words that reach it taken whole, and a function that sets the
 * feathered weights over the other changed words near it to all or nothing: imaging.whole_pieces.
 * ``settle`` takes the weights cropped at (ox, oy), covering the pieces' box.
 */
export function wholePieces(original: Raster, toned: Raster, area: Raster, radius: number, band: Raster | null): { area: Raster; settle: Settle | null } {
  const { width: w, height: h } = area;
  const a = fromGray(area.data, w, h);
  // when the model copied the outlines, they are its edge (as in growArea): pieces only up to them
  const reach = band ? Math.min(K.piece_zone * radius, (K.annot_gap + 1) * annotationStroke(w, h)) : K.piece_zone * radius;
  const zone = dilate(a, reach);
  const zb = bbox(bitsToGray(zone));
  if (!zb) return { area, settle: null };
  const x0 = Math.max(0, zb[0] - 4);
  const y0 = Math.max(0, zb[1] - 4);
  const x1 = Math.min(w, zb[2] - 1 + 5);
  const y1 = Math.min(h, zb[3] - 1 + 5);
  const cw = x1 - x0;
  const ch = y1 - y0;
  const o = gaussianBlur(crop(toRgb(original), x0, y0, x1, y1), K.piece_blur);
  const r = gaussianBlur(crop(toRgb(toned), x0, y0, x1, y1), K.piece_blur);
  const n = cw * ch;
  const diff = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    diff[i] = Math.max(Math.abs(o.data[i * 3] - r.data[i * 3]), Math.abs(o.data[i * 3 + 1] - r.data[i * 3 + 1]), Math.abs(o.data[i * 3 + 2] - r.data[i * 3 + 2]));
  }
  const z = newBits(cw, ch);
  const aCrop = newBits(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      z.d[y * cw + x] = zone.d[(y + y0) * w + x + x0];
      aCrop.d[y * cw + x] = a.d[(y + y0) * w + x + x0];
    }
  }
  const weak = newBits(cw, ch);
  for (let i = 0; i < n; i++) {
    const x = i % cw;
    const y = (i - x) / cw;
    weak.d[i] = diff[i] >= K.piece_weak && z.d[i] && !(band && band.data[(y + y0) * w + x + x0] > 0) ? 1 : 0;
  }
  const labels = label8(weak);
  let max = 0;
  for (let i = 0; i < n; i++) if (labels[i] > max) max = labels[i];
  const cored = new Uint8Array(max + 1);
  for (let i = 0; i < n; i++) if (weak.d[i] && diff[i] >= K.piece_core) cored[labels[i]] = 1;
  cored[0] = 0;
  const pieces = newBits(cw, ch);
  let anyPiece = false;
  for (let i = 0; i < n; i++) if (cored[labels[i]]) (pieces.d[i] = 1), (anyPiece = true);
  if (!anyPiece) return { area, settle: null };
  // letters along a line: within a feather radius across, a pixel up or down
  const runLabels = label8(dilateAxis(dilateAxis(pieces, radius, "x"), 1, "y"));
  const runs = new Int32Array(n);
  let maxRun = 0;
  for (let i = 0; i < n; i++) {
    runs[i] = pieces.d[i] ? runLabels[i] : 0;
    if (runs[i] > maxRun) maxRun = runs[i];
  }
  const openRun = new Uint8Array(maxRun + 1);
  // open runs touch the zone's edge, the image's included (the zone may cover all of a small one)
  const inner = erodeClosed(z, 1);
  for (let i = 0; i < n; i++) if (z.d[i] && !inner.d[i]) openRun[runs[i]] = 1;
  const reaches = new Uint8Array(maxRun + 1);
  const near = dilate(aCrop, 2);
  for (let i = 0; i < n; i++) if (near.d[i]) reaches[runs[i]] = 1;
  const taken = newBits(cw, ch);
  let anyTaken = false;
  for (let i = 0; i < n; i++) if (pieces.d[i] && reaches[runs[i]] && !openRun[runs[i]]) (taken.d[i] = 1), (anyTaken = true);
  if (anyTaken) {
    const add = dilate(taken, 1);
    const grown = copyRaster(area);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (add.d[y * cw + x]) grown.data[(y + y0) * w + x + x0] = 255;
    area = grown;
  }
  const rest = new Int32Array(n);
  for (let i = 0; i < n; i++) rest[i] = openRun[runs[i]] || taken.d[i] ? 0 : runs[i];

  const settle: Settle = (soft, ox, oy) => {
    const s = new Int32Array(n);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) s[y * cw + x] = soft.data[(y + y0 - oy) * soft.width + x + x0 - ox];
    const counts = new Float64Array(maxRun + 1);
    const sums = new Float64Array(maxRun + 1);
    const whole = new Uint8Array(maxRun + 1);
    let anyWhole = false;
    for (let i = 0; i < n; i++) {
      counts[rest[i]]++;
      sums[rest[i]] += s[i];
      if (rest[i] && s[i] > 0 && s[i] < 255) (whole[rest[i]] = 1), (anyWhole = true);
    }
    if (!anyWhole) return soft;
    const onSeed = newBits(cw, ch);
    const offSeed = newBits(cw, ch);
    for (let i = 0; i < n; i++) {
      const k = rest[i];
      if (!whole[k]) continue;
      if (2 * sums[k] >= 255 * counts[k]) onSeed.d[i] = 1;
      else offSeed.d[i] = 1;
    }
    const on = dilate(onSeed, 1);
    const off = without(dilate(offSeed, 1), on);
    let changed = false;
    const out = newRaster(cw, ch, 1);
    for (let i = 0; i < n; i++) {
      out.data[i] = on.d[i] ? 255 : off.d[i] ? 0 : s[i];
      if (on.d[i] || off.d[i]) changed = true;
    }
    if (!changed) return soft;
    // the pieces' edges antialiased, as the rest of the weights are smooth
    const smooth = gaussianBlur(out, 1);
    const edge = dilate(or(on, off), 2);
    const result = copyRaster(soft);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = y * cw + x;
        result.data[(y + y0 - oy) * soft.width + x + x0 - ox] = edge.d[i] ? smooth.data[i] : out.data[i];
      }
    }
    return result;
  };
  return { area, settle };
}

// ---------------------------------------------------------------------------
// Growing the paste-back area
// ---------------------------------------------------------------------------
function growOnce(
  delta: Float64Array, w: number, h: number, seed: Bits, threshold: number, blocked: Bits | null,
  reach: number, bridge: number, minPatchIn: number,
): { area: Bits; note: string } {
  const seedArea = count(seed);
  if (!seedArea) return { area: seed, note: "" };
  let strong = newBits(w, h);
  for (let i = 0; i < delta.length; i++) strong.d[i] = delta[i] > threshold ? 1 : 0;
  if (blocked) strong = without(strong, dilate(blocked, reach));
  const allowed = or(strong, seed);
  const limit = seedArea + Math.min(seedArea * K.spill_max_growth, delta.length * K.spill_max_share);
  const minPatch = Math.max(minPatchIn, seedArea * K.spill_patch_share);
  const tooLarge = { area: seed, note: NOTE.spill_too_large };

  let grown = seed;
  for (let round = 0; round < 4; round++) {
    // touching growth, then bridge to nearby patches; repeat
    const flooded = floodGrow(grown, allowed, limit);
    if (!flooded) return tooLarge;
    grown = flooded;
    const zone = without(dilate(grown, bridge), grown);
    const patches = componentsNear(without(strong, grown), zone, minPatch);
    if (!patches.length) break;
    grown = cloneBits(grown);
    for (const patch of patches) for (const i of patch) grown.d[i] = 1;
    grown = or(grown, erode(dilate(grown, bridge), bridge)); // the gaps crossed, too
    if (count(grown) > limit) return tooLarge;
  }
  grown = or(fillHoles(erode(dilate(grown, 1), 1)), seed);
  const total = count(grown);
  if (total > limit) return tooLarge;
  // Small growth is kept too (the rest of a recolored sleeve); only a big one is worth a note
  return { area: grown, note: total - seedArea > seedArea * K.spill_note_growth ? NOTE.spill_grown : "" };
}

/** Grow the region, getting stricter if growth runs away (see _grow_once and grow_area in Python). */
function growArea(
  delta: Float64Array, w: number, h: number, seed: Bits, threshold: number, blocked: Bits | null,
  reach: number, bridge: number, minPatch: number,
): { area: Bits; note: string } {
  for (let k = 0; k < K.spill_escalate; k++) {
    const grown = growOnce(delta, w, h, seed, threshold * 1.6 ** k, blocked, reach, bridge, minPatch);
    if (grown.note !== NOTE.spill_too_large) return grown;
  }
  return { area: seed, note: NOTE.spill_too_large };
}

// ---------------------------------------------------------------------------
// The output against the original
// ---------------------------------------------------------------------------
/** Whether ``result`` keeps the original's framing: fine detail away from the region still lines up. */
export function aligned(original: Raster, result: Raster, mask: Raster): boolean {
  const scale = scaleFor(original.width, original.height);
  const detail = (im: Raster) => {
    const g = small(toGray(im), scale);
    const blurred = gaussianBlur(g, 3);
    return Float64Array.from(g.data, (v, i) => v - blurred.data[i]);
  };
  const far = farFrom(original, smallBits(mask, scale), scale);
  if (count(far) < 0.05 * far.d.length) return true;
  const da = detail(original);
  const db = detail(result);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < far.d.length; i++) {
    if (!far.d[i]) continue;
    ab += da[i] * db[i];
    aa += da[i] * da[i];
    bb += db[i] * db[i];
  }
  const norm = Math.sqrt(aa * bb);
  return norm === 0 || ab / norm >= K.align_min_corr;
}

/** ``result`` with the model's overall tone drift undone (robust per-channel gain and offset). */
export function matchTone(original: Raster, result: Raster, mask: Raster): Raster {
  const scale = scaleFor(original.width, original.height);
  const prep = (im: Raster) => gaussianBlur(small(toRgb(im), scale), 2);
  const o = prep(original);
  const r = prep(result);
  const far = farFrom(original, smallBits(mask, scale), scale);
  const nFar = count(far);
  if (nFar < 0.05 * far.d.length) return result;

  // The levels that exist away from the region: look at the output itself on a grid of ~1 MP
  const step = Math.max(1, Math.trunc(Math.sqrt((original.width * original.height) / 1e6)));
  const sw = Math.max(1, Math.floor(original.width / step));
  const sh = Math.max(1, Math.floor(original.height / step));
  const grid = resizeNearest(toRgb(result), sw, sh);
  const farGray = bitsToGray(far);
  const farGrid = resizeNearest(farGray, sw, sh);
  const seen: Uint8Array[] = [0, 1, 2].map(() => new Uint8Array(sw * sh));
  let ns = 0;
  for (let i = 0; i < sw * sh; i++) {
    if (!farGrid.data[i]) continue;
    for (let c = 0; c < 3; c++) seen[c][ns] = grid.data[i * 3 + c];
    ns++;
  }

  const lut = new Uint8Array(768);
  for (let c = 0; c < 3; c++) {
    const x = new Float64Array(nFar);
    const y = new Float64Array(nFar);
    for (let i = 0, k = 0; i < far.d.length; i++) {
      if (far.d[i]) {
        x[k] = r.data[i * 3 + c];
        y[k] = o.data[i * 3 + c];
        k++;
      }
    }
    const [lo, hi] = percentilesOfBytes(seen[c].subarray(0, ns), [0.5, 99.5]);
    // Start from the median offset, then keep the best-fitting share and refit
    let gain = 1;
    let offset = median(y.map((v, i) => v - x[i]));
    let keep: Uint8Array = new Uint8Array(nFar);
    for (let pass = 0; pass < 3; pass++) {
      const err = x.map((v, i) => Math.abs(gain * v + offset - y[i]));
      const limit = percentile(err, K.tone_keep);
      keep = Uint8Array.from(err, (e) => (e <= limit ? 1 : 0));
      const xk = x.filter((_, i) => keep[i]);
      const yk = y.filter((_, i) => keep[i]);
      const mx = mean(xk);
      const my = mean(yk);
      const spread = mean(xk.map((v) => (v - mx) * (v - mx)));
      if (hi - lo >= K.tone_min_span && spread > 1) {
        gain = mean(xk.map((v, i) => (v - mx) * (yk[i] - my))) / spread;
        offset = my - gain * mx;
      } else {
        gain = 1;
        offset = median(yk.map((v, i) => v - xk[i]));
      }
    }
    const clipped = clamp(gain, 1 - K.tone_max_gain, 1 + K.tone_max_gain);
    if (clipped !== gain) offset = median(y.map((v, i) => v - clipped * x[i]).filter((_, i) => keep[i]));
    gain = clipped;
    offset = clamp(offset, -K.tone_max_offset, K.tone_max_offset);
    for (let v = 0; v < 256; v++) {
      const trust = v >= lo && v <= hi ? 1 : Math.max(0, 1 - Math.max(v - hi, lo - v) / K.tone_fade);
      lut[c * 256 + v] = Math.min(255, Math.max(0, roundHalfEven(v + trust * (gain * v + offset - v))));
    }
  }
  let identity = true;
  for (let c = 0; c < 3 && identity; c++) for (let v = 0; v < 256; v++) if (lut[c * 256 + v] !== v) identity = false;
  if (identity) return result;
  const fixed = copyRaster(result);
  const ch = fixed.channels;
  for (let i = 0; i < fixed.data.length; i += ch) {
    for (let c = 0; c < 3; c++) fixed.data[i + c] = lut[c * 256 + fixed.data[i + c]];
  }
  return fixed;
}

// ---------------------------------------------------------------------------
// Paste-back
// ---------------------------------------------------------------------------
export interface PasteResult {
  /**
   * null when the model redrew the scene: use its whole output. With the note
   * overall_change it is the pasted-back alternative, and the whole output is to be adopted.
   */
  image: Raster | null;
  note: string;
  /** the model's output after undoing its tone drift: what was pasted from */
  toned?: Raster;
}

/**
 * Put the edited region of ``result`` (the original's size) onto ``original``. See
 * brushgraft.imaging.paste_back: tone drift undone, the area grown over the new content,
 * copied marks excluded, a feathered edge that leaves everything past ~4.7 radii untouched.
 * ``overall``: the user also wrote an overall request, which may ask for changes everywhere.
 */
export function pasteBack(original: Raster, result: Raster, mask: Raster, annotated: Raster | null, overall = false): PasteResult {
  const { width, height } = original;
  if (!aligned(original, result, mask)) return { image: null, note: NOTE.reframed };
  const scale = scaleFor(width, height);
  const seed = smallBits(mask, scale);
  const { w, h } = seed;
  // An overall request that changed much of the image far from the regions (a new sky): the
  // whole output is what was asked for. Judged before the tone drift is undone: a change of
  // light or color (a winter day, dusk) is mostly such a shift
  let changedOverall = false;
  if (overall) {
    const far = farFrom(original, seed, scale);
    const nFar = count(far);
    if (nFar >= 0.05 * far.d.length) {
      const asIs = changeMap(original, result, scale);
      let changed = 0;
      for (let i = 0; i < asIs.length; i++) if (far.d[i] && asIs[i] > K.overall_delta) changed++;
      changedOverall = changed / nFar > K.overall_share;
    }
  }
  const toned = matchTone(original, result, mask);
  const delta = changeMap(original, toned, scale);
  const outside = not(dilate(seed, Math.ceil(K.spill_near / scale)));
  const nOutside = count(outside);
  let drift: number;
  if (nOutside > 0.02 * outside.d.length) {
    const vals = new Float64Array(nOutside);
    for (let i = 0, k = 0; i < delta.length; i++) if (outside.d[i]) vals[k++] = delta[i];
    drift = median(vals);
  } else {
    drift = percentile(delta, 20);
  }
  const threshold = Math.max(K.spill_min_delta, drift * K.spill_drift_factor);

  const radius = featherRadius(width, height);
  const reach = Math.ceil((5 * radius) / scale);
  let blocked: Bits | null = null;
  const echo = annotated ? echoedMarks(original, annotated, toned) : null;
  if (echo) {
    blocked = smallBits(echo, scale);
    // The model drew the outlines in, so they are its edge: nothing past them is the region's
    // new content (they lie a gap and a line's width out)
    const outline = (K.annot_gap + 1) * annotationStroke(width, height);
    const within = dilate(seed, Math.ceil(outline / scale));
    for (let i = 0; i < delta.length; i++) if (!within.d[i]) delta[i] = 0;
  }
  const grown = growArea(delta, w, h, seed, threshold, blocked, Math.max(0, reach),
    Math.max(1, Math.ceil((K.bridge_radii * radius) / scale)), K.spill_min_patch / scale ** 2);

  let areaImg: Raster;
  if (grown.note === NOTE.spill_too_large) {
    areaImg = mask; // everything changed: no clean outline exists, keep the region
  } else {
    let strong = newBits(w, h);
    for (let i = 0; i < delta.length; i++) strong.d[i] = delta[i] > threshold ? 1 : 0;
    if (blocked) strong = without(strong, dilate(blocked, reach));
    // strong changes the feather would half cover anyway are taken whole
    const area = or(grown.area, and(strong, dilate(grown.area, Math.ceil((2 * radius) / scale))));
    const up = resize(bitsToGray(area), width, height, "bilinear");
    areaImg = lighter(point(up, (v) => (v >= 128 ? 255 : 0)), mask);
  }

  const band = echo ? copiedBand(echo, mask) : null;
  let settle: Settle | null = null;
  if (grown.note !== NOTE.spill_too_large) {
    const pieces = wholePieces(original, toned, areaImg, radius, band);
    areaImg = pieces.area;
    settle = pieces.settle;
  }

  const asRgba = original.channels === 4;
  const orig = asRgba ? toRgba(original) : toRgb(original);
  const res = asRgba ? toRgba(toned) : toRgb(toned);
  const box = bbox(areaImg);
  const note = changedOverall ? NOTE.overall_change : grown.note;
  if (!box) return { image: copyRaster(orig), note, toned };
  // Blurs reach a bounded distance, so work on the box around the area plus that much (and the
  // whole pieces' box): the result is the same as blurring the whole image, at a fraction of the cost
  const margin = Math.max(2 * blurReach(radius) + 2, K.piece_zone * radius + 6);
  const x0 = Math.max(0, box[0] - margin);
  const y0 = Math.max(0, box[1] - margin);
  const x1 = Math.min(width, box[2] + margin);
  const y1 = Math.min(height, box[3] + margin);
  const area = crop(areaImg, x0, y0, x1, y1);
  // Grow by about two feather radii, then blur by one (keep what stays above 2.3%)
  const spread = point(gaussianBlur(area, radius), (v) => (v > 5 ? 255 : 0));
  let soft = gaussianBlur(lighter(spread, area), radius);
  // the outlines lie within the feathered edge: where the model copied them, the original goes back
  if (band) soft = darker(soft, point(crop(band, x0, y0, x1, y1), (v) => 255 - v));
  if (settle) soft = settle(soft, x0, y0);
  const image = copyRaster(orig);
  paste(image, composite(crop(res, x0, y0, x1, y1), crop(orig, x0, y0, x1, y1), soft), x0, y0);
  return { image, note, toned };
}
