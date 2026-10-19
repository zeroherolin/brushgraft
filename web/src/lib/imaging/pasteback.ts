// Put the edited region of the model's output onto the original, and nothing more:
// a port of brushgraft.imaging (see there for the reasoning behind each step). The
// constants come from generated/spec.json, shared with the Python side.

import { spec } from "../backend/spec";
import {
  and, count, dilate, dilateAxis, erode, erodeClosed, fillHoles, floodGrow, fromGray, label8, newBits, not, or, without, componentsNear,
  cloneBits, type Bits,
} from "./bits";
import {
  bbox, composite, crop, darker, gaussianBlur, blurReach, lighter, newRaster, onBackdrop, paste, point, resize, resizeNearest,
  toGray, toRgb, toRgba, copyRaster, WHITE, type Raster,
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
/** The weights at (ox, oy) settled; past them too, for a line taken whole beyond the zone. */
type Settle = (soft: Raster, ox: number, oy: number) => { soft: Raster; x0: number; y0: number };

/**
 * The area with the changed words that reach it taken whole, and a function that sets the
 * feathered weights over everything else that changed near it to all or nothing:
 * imaging.whole_pieces (the reasons are there). ``settle`` takes the weights cropped at (ox, oy),
 * covering the pieces' box.
 */
export function wholePieces(
  original: Raster, toned: Raster, area: Raster, radius: number, band: Raster | null, core: Raster | null = null,
): { area: Raster; settle: Settle | null } {
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
  const oRgb = crop(toRgb(original), x0, y0, x1, y1);
  const rRgb = crop(toRgb(toned), x0, y0, x1, y1);
  const o = gaussianBlur(oRgb, K.piece_blur);
  const r = gaussianBlur(rRgb, K.piece_blur);
  const n = cw * ch;
  const diff = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    diff[i] = Math.max(Math.abs(o.data[i * 3] - r.data[i * 3]), Math.abs(o.data[i * 3 + 1] - r.data[i * 3 + 1]), Math.abs(o.data[i * 3 + 2] - r.data[i * 3 + 2]));
  }
  const beyondShift = changedBeyondShift(oRgb, rRgb, K.piece_weak);
  const z = newBits(cw, ch);
  const aCrop = newBits(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      z.d[y * cw + x] = zone.d[(y + y0) * w + x + x0];
      aCrop.d[y * cw + x] = a.d[(y + y0) * w + x + x0];
    }
  }
  const weak = newBits(cw, ch);
  const sharp = newBits(cw, ch);
  const either = newBits(cw, ch);
  for (let i = 0; i < n; i++) {
    const x = i % cw;
    const y = (i - x) / cw;
    if (!z.d[i] || (band && band.data[(y + y0) * w + x + x0] > 0)) continue;
    weak.d[i] = diff[i] >= K.piece_weak ? 1 : 0;
    sharp.d[i] = beyondShift.d[i];
    either.d[i] = weak.d[i] | sharp.d[i];
  }
  const labels = label8(either);
  let max = 0;
  for (let i = 0; i < n; i++) if (labels[i] > max) max = labels[i];
  const cored = new Uint8Array(max + 1);
  for (let i = 0; i < n; i++) if (weak.d[i] && diff[i] >= K.piece_core) cored[labels[i]] = 1;
  cored[0] = 0;
  const pieces = newBits(cw, ch);
  for (let i = 0; i < n; i++) if (cored[labels[i]]) pieces.d[i] = 1;
  // open: touching the zone's edge, the image's included (the zone may cover all of a small one)
  const inner = erodeClosed(z, 1);
  const edge = newBits(cw, ch);
  for (let i = 0; i < n; i++) edge.d[i] = z.d[i] && !inner.d[i] ? 1 : 0;
  // rewritten words, merged along lines
  const runs = linesOf(pieces, radius);
  const maxRun = maxOf(runs);
  const openRun = flagged(runs, edge, maxRun);
  const reachesRun = flagged(runs, dilate(aCrop, 2), maxRun);
  const taken = newBits(cw, ch);
  let anyTaken = false;
  for (let i = 0; i < n; i++) if (pieces.d[i] && reachesRun[runs[i]] && !openRun[runs[i]]) (taken.d[i] = 1), (anyTaken = true);
  const grown = cloneBits(aCrop);
  if (anyTaken) {
    const add = dilate(taken, 1);
    const out = copyRaster(area);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (!add.d[y * cw + x]) continue;
        out.data[(y + y0) * w + x + x0] = 255;
        grown.d[y * cw + x] = 1;
      }
    }
    area = out;
  }
  const rest = new Int32Array(n);
  for (let i = 0; i < n; i++) rest[i] = (pieces.d[i] && openRun[runs[i]]) || taken.d[i] ? 0 : runs[i];
  // everything else that changed, line by line; a line running past the zone cut at its spaces
  const other = newBits(cw, ch);
  for (let i = 0; i < n; i++) other.d[i] = sharp.d[i] && !(pieces.d[i] && !openRun[runs[i]]) ? 1 : 0;
  const lines = linesOf(other, radius);
  const longLine = flagged(lines, edge, maxOf(lines));
  const longOnly = new Int32Array(n);
  for (let i = 0; i < n; i++) longOnly[i] = other.d[i] && longLine[lines[i]] ? lines[i] : 0;
  const split = splitAtSpaces(longOnly, cw, oRgb, rRgb);
  const splitMax = maxOf(split);
  const seg = new Int32Array(n);
  for (let i = 0; i < n; i++) seg[i] = longOnly[i] ? split[i] : lines[i] > 0 ? lines[i] + splitMax : 0;
  // reaching the area: in its core, where the core's edge cuts it (one only near it needn't be), or
  // in the words taken whole
  const inside = newBits(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x;
      const inCore = core ? core.data[(y + y0) * w + x + x0] > 0 : grown.d[i] === 1;
      inside.d[i] = inCore || (anyTaken && grown.d[i] && !aCrop.d[i]) ? 1 : 0;
    }
  }
  const maxSeg = maxOf(seg);
  const reachesSeg = flagged(seg, inside, maxSeg);
  const openSeg = flagged(seg, edge, maxSeg);
  // what reaches the area and still runs past the zone can't come from the output whole
  const cut = new Int32Array(n);
  let anyCut = false;
  for (let i = 0; i < n; i++) {
    if (seg[i] > 0 && reachesSeg[seg[i]] && openSeg[seg[i]]) {
      cut[i] = seg[i];
      seg[i] = 0;
      anyCut = true;
    }
  }
  const n0 = maxOf(rest);
  const groups = new Int32Array(n);
  for (let i = 0; i < n; i++) groups[i] = rest[i] > 0 ? rest[i] : seg[i] > 0 ? seg[i] + n0 : 0;
  const nGroups = maxOf(groups) + 1;
  // these come from the output: they reach the area
  const forced = new Uint8Array(nGroups);
  for (let i = 0; i < n; i++) if (inside.d[i] && groups[i] > n0) forced[groups[i]] = 1;
  forced[0] = 0;
  if (nGroups === 1 && !anyCut) return { area, settle: null };
  const cutIds = anyCut ? [...new Set(cut.filter((k) => k > 0))] : [];
  // the two images whole, for a line cut past the zone
  const wholeO = anyCut ? toRgb(original) : null;
  const wholeR = anyCut ? toRgb(toned) : null;

  const settle: Settle = (soft, ox, oy) => {
    const s = new Int32Array(n);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) s[y * cw + x] = soft.data[(y + y0 - oy) * soft.width + x + x0 - ox];
    const counts = new Float64Array(nGroups);
    const sums = new Float64Array(nGroups);
    const whole = new Uint8Array(nGroups);
    let feathered = false;
    for (let i = 0; i < n; i++) {
      counts[groups[i]]++;
      sums[groups[i]] += s[i];
      if (s[i] > 0 && s[i] < 255) {
        feathered = true;
        if (groups[i]) whole[groups[i]] = 1;
      }
    }
    const onSeed = newBits(cw, ch);
    const offSeed = newBits(cw, ch);
    for (let i = 0; i < n; i++) {
      const k = groups[i];
      if (!whole[k]) continue;
      if (forced[k] || 2 * sums[k] >= 255 * counts[k]) onSeed.d[i] = 1;
      else offSeed.d[i] = 1;
    }
    const beyond: [number, number, number, number][] = [];
    if (feathered) {
      for (const k of cutIds) {
        const line = newBits(cw, ch);
        let inBand = false;
        for (let i = 0; i < n; i++) {
          if (cut[i] !== k) continue;
          line.d[i] = 1;
          if (s[i] > 0 && s[i] < 255) inBand = true;
        }
        if (inBand) beyond.push(...cutLine(line, s, wholeO!, wholeR!, x0, y0, edge, radius, onSeed, offSeed));
      }
    }
    const on = dilate(onSeed, 1);
    const off = without(without(dilate(offSeed, 1), on), inside); // the area itself is the output's
    let changed = false;
    const out = newRaster(cw, ch, 1);
    for (let i = 0; i < n; i++) {
      out.data[i] = on.d[i] ? 255 : off.d[i] ? 0 : s[i];
      if (on.d[i] || off.d[i]) changed = true;
    }
    if (!changed) return { soft, x0: ox, y0: oy };
    // the pieces' edges antialiased, as the rest of the weights are smooth
    const smooth = gaussianBlur(out, 1);
    const near2 = dilate(or(on, off), 2);
    // the weights grown to take in the lines taken whole past the zone
    let [rx0, ry0, rx1, ry1] = [ox, oy, ox + soft.width, oy + soft.height];
    for (const [top, bottom, left, right] of beyond) {
      [rx0, ry0, rx1, ry1] = [Math.min(rx0, left), Math.min(ry0, top), Math.max(rx1, right), Math.max(ry1, bottom)];
    }
    const result = newRaster(rx1 - rx0, ry1 - ry0, 1);
    paste(result, soft, ox - rx0, oy - ry0);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = y * cw + x;
        result.data[(y + y0 - ry0) * result.width + x + x0 - rx0] = near2.d[i] ? smooth.data[i] : out.data[i];
      }
    }
    for (const [top, bottom, left, right] of beyond) {
      for (let y = top; y < bottom; y++) result.data.fill(255, (y - ry0) * result.width + left - rx0, (y - ry0) * result.width + right - rx0);
    }
    return { soft: result, x0: rx0, y0: ry0 };
  };
  return { area, settle };
}

const maxOf = (a: Int32Array): number => {
  let m = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return m;
};

/** Per label (0 to ``max``): whether any of its pixels is set in ``where``. */
function flagged(labels: Int32Array, where: Bits, max: number): Uint8Array {
  const out = new Uint8Array(max + 1);
  for (let i = 0; i < labels.length; i++) if (where.d[i]) out[labels[i]] = 1;
  return out;
}

/** ``pieces`` merged along lines (within ``gap`` across, a pixel up or down), labelled; 0 off them: imaging._lines. */
function linesOf(pieces: Bits, gap: number): Int32Array {
  const labels = label8(dilateAxis(dilateAxis(pieces, gap, "x"), 1, "y"));
  for (let i = 0; i < labels.length; i++) if (!pieces.d[i]) labels[i] = 0;
  return labels;
}

/**
 * Where two RGB rasters of the same size differ by ``threshold`` or more beyond a pixel's shift: each
 * pixel is that far from all of the other's 3x3 neighbours, one way or the other (the largest channel;
 * the edge repeated). imaging.tolerant_diff(a, b) >= threshold, stopping at the first close neighbour.
 */
function changedBeyondShift(a: Raster, b: Raster, threshold: number): Bits {
  const { width: w, height: h } = a;
  const out = newBits(w, h);
  const ad = a.data;
  const bd = b.data;
  // whether p's pixel i is at least threshold from q's pixel j, in any channel
  const apart = (p: Uint8Array, i: number, q: Uint8Array, j: number): boolean => {
    let d = p[i] - q[j];
    if (d >= threshold || -d >= threshold) return true;
    d = p[i + 1] - q[j + 1];
    if (d >= threshold || -d >= threshold) return true;
    d = p[i + 2] - q[j + 2];
    return d >= threshold || -d >= threshold;
  };
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w;
    const mid = y * w;
    const down = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const i = (mid + x) * 3;
      // the same pixel close enough: no neighbour need be looked at
      if (!apart(ad, i, bd, i)) continue;
      const l = x > 0 ? x - 1 : 0;
      const r = x < w - 1 ? x + 1 : x;
      // that far from all nine neighbours, one way or the other
      let far = true;
      for (let pass = 0; pass < 2; pass++) {
        const p = pass ? bd : ad;
        const q = pass ? ad : bd;
        far = true;
        for (const row of [up, mid, down]) {
          if (!apart(p, i, q, (row + l) * 3) || !apart(p, i, q, (row + x) * 3) || !apart(p, i, q, (row + r) * 3)) {
            far = false;
            break;
          }
        }
        if (far) break;
      }
      if (far) out.d[mid + x] = 1;
    }
  }
  return out;
}

/** Of ``flat`` (one entry per column), the entries in runs of at least ``need`` set entries: imaging._wide_runs. */
function wideRuns(flat: Uint8Array, need: number): Uint8Array {
  const out = new Uint8Array(flat.length);
  let start = -1;
  for (let i = 0; i <= flat.length; i++) {
    if (i < flat.length && flat[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= need) out.fill(1, start, i);
      start = -1;
    }
  }
  return out;
}

/** The median of ``v`` (sorted in place), as numpy takes it: the mean of the middle two of an even count. */
function medianOf(v: Float64Array): number {
  v.sort();
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Per column of an RGB raster's rows ``top`` to ``bottom`` (inclusive), ``left`` to ``right``: its pixels at
 * least piece_flat from the column's median, in any channel: imaging._column_ink.
 */
function columnInk(im: Raster, top: number, bottom: number, left: number, right: number): Int32Array {
  const { width: w, data: d } = im;
  const rows = bottom - top + 1;
  const out = new Int32Array(right - left + 1);
  const vals = new Float64Array(rows);
  const mid = [0, 0, 0];
  for (let x = left; x <= right; x++) {
    for (let c = 0; c < 3; c++) {
      for (let y = top; y <= bottom; y++) vals[y - top] = d[(y * w + x) * 3 + c];
      mid[c] = medianOf(vals);
    }
    let n = 0;
    for (let y = top; y <= bottom; y++) {
      const i = (y * w + x) * 3;
      if (Math.max(Math.abs(d[i] - mid[0]), Math.abs(d[i + 1] - mid[1]), Math.abs(d[i + 2] - mid[2])) >= K.piece_flat) n++;
    }
    out[x - left] = n;
  }
  return out;
}

/** The pixels of each label, and its bounds. */
function byLabel(labels: Int32Array, w: number): Map<number, { px: number[]; top: number; bottom: number; left: number; right: number }> {
  const out = new Map<number, { px: number[]; top: number; bottom: number; left: number; right: number }>();
  for (let i = 0; i < labels.length; i++) {
    const k = labels[i];
    if (!k) continue;
    const x = i % w;
    const y = (i - x) / w;
    let g = out.get(k);
    if (!g) out.set(k, (g = { px: [], top: y, bottom: y, left: x, right: x }));
    g.px.push(i);
    if (y > g.bottom) g.bottom = y;
    if (x < g.left) g.left = x;
    if (x > g.right) g.right = x;
  }
  return out;
}

/** Each line cut at the word spaces both images have: imaging._split_at_spaces. */
function splitAtSpaces(lines: Int32Array, w: number, oRgb: Raster, rRgb: Raster): Int32Array {
  const out = new Int32Array(lines.length);
  let count = 0;
  const groups = byLabel(lines, w);
  for (const k of [...groups.keys()].sort((p, q) => p - q)) {
    const { px, top, bottom, left, right } = groups.get(k)!;
    const need = Math.max(2, roundHalfEven(K.piece_space * (bottom - top + 1)));
    const len = right - left + 1;
    const busy = new Uint8Array(len);
    for (const i of px) busy[(i % w) - left] = 1;
    const blank = (im: Raster) => Uint8Array.from(columnInk(im, top, bottom, left, right), (v) => (v === 0 ? 1 : 0));
    const spaceO = wideRuns(blank(oRgb), need);
    const spaceR = wideRuns(blank(rRgb), need);
    // a stretch starts at a busy column after a gap (or at the line's start)
    const number = new Int32Array(len);
    let seenGap = true;
    let current = count;
    for (let c = 0; c < len; c++) {
      if (!busy[c] && spaceO[c] && spaceR[c]) {
        seenGap = true;
      } else if (busy[c]) {
        if (seenGap) {
          current++;
          seenGap = false;
        }
        number[c] = current;
      }
    }
    for (const i of px) out[i] = number[(i % w) - left];
    count = current;
  }
  return out;
}

/**
 * Set ``on`` (from the output) and ``off`` (from the original) over a line of text that reaches the area
 * and runs past the zone, cut on each side of the area at a word space of both images: imaging._cut_line.
 * ``line``, ``s``, ``edge`` and the seeds are the zone's box, at (bx, by) in the whole images ``wholeO``
 * and ``wholeR``. Returns the boxes past the zone to set to 255 (top, bottom, left, right; ends exclusive).
 */
function cutLine(
  line: Bits, s: Int32Array, wholeO: Raster, wholeR: Raster, bx: number, by: number, edge: Bits, radius: number, on: Bits, off: Bits,
): [number, number, number, number][] {
  const bw = line.w;
  const bh = line.h;
  let top = Infinity;
  let bottom = -1;
  let left = Infinity;
  let right = -1;
  for (let i = 0; i < line.d.length; i++) {
    if (!line.d[i]) continue;
    const x = i % bw;
    const y = (i - x) / bw;
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    left = Math.min(left, x);
    right = Math.max(right, x);
  }
  const height = bottom - top + 1;
  if (height > K.piece_line * radius || right - left + 1 < 2 * height) return [];
  const width = wholeO.width; // columns are counted on the images from here on
  const need = Math.max(2, roundHalfEven(K.piece_space * height));
  const inkO = columnInk(wholeO, by + top, by + bottom, 0, width - 1);
  const inkR = columnInk(wholeR, by + top, by + bottom, 0, width - 1);
  const flatO = wideRuns(Uint8Array.from(inkO, (v) => (v === 0 ? 1 : 0)), need);
  const flatR = wideRuns(Uint8Array.from(inkR, (v) => (v === 0 ? 1 : 0)), need);
  const spaces = Uint8Array.from(flatO, (v, j) => v & flatR[j]);
  const lo = bx + left;
  const hi = bx + right;
  // where row y is its background (its median) in both images
  const clearAt = (y: number): Uint8Array => {
    const out = new Uint8Array(width);
    if (y < 0 || y >= wholeO.height) return out;
    out.fill(1);
    const vals = new Float64Array(width);
    for (const im of [wholeO, wholeR]) {
      const mid = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        for (let x = 0; x < width; x++) vals[x] = im.data[(y * width + x) * 3 + c];
        mid[c] = medianOf(vals);
      }
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        if (Math.max(Math.abs(im.data[i] - mid[0]), Math.abs(im.data[i + 1] - mid[1]), Math.abs(im.data[i + 2] - mid[2])) >= K.piece_flat) out[x] = 0;
      }
    }
    return out;
  };
  // the band: as narrow as leaves the line's letters inside it where the zone has it
  let band: [number, number] | null = null;
  let clear = new Uint8Array(width);
  for (let m = 2; m <= Math.max(2, Math.floor(height / 3)); m++) {
    const above = clearAt(by + top - m);
    const below = clearAt(by + bottom + m);
    const edges = Uint8Array.from(above, (v, j) => v & below[j]);
    let all = true;
    for (let j = lo; j <= hi && all; j++) if (!edges[j]) all = false;
    if (all) {
      band = [by + top - m + 1, by + bottom + m];
      clear = edges;
      break;
    }
  }
  const colMax = (x: number) => {
    let m = 0;
    for (let y = top; y <= bottom; y++) m = Math.max(m, s[y * bw + x]);
    return m;
  };
  let a0 = -1;
  let a1 = -1;
  for (let x = left; x <= right; x++) {
    if (colMax(x) !== 255) continue;
    if (a0 < 0) a0 = bx + x;
    a1 = bx + x;
  }
  if (a0 < 0) a0 = a1 = colMax(left) >= colMax(right) ? lo - 1 : hi + 1; // it reaches the area at that end
  // the last column before x with ink, and the first after it
  const lastBefore = (ink: Int32Array, j: number) => {
    for (let x = Math.min(j, width) - 1; x >= 0; x--) if (ink[x]) return x;
    return -1;
  };
  const firstAfter = (ink: Int32Array, j: number) => {
    for (let x = Math.max(j + 1, 0); x < width; x++) if (ink[x]) return x;
    return width;
  };
  const beyond: [number, number, number, number][] = [];
  for (const side of [1, -1]) {
    const start = side === 1 ? a1 : a0;
    const inPart = (x: number) => (side === 1 ? bx + x > start : bx + x < start);
    let any = false;
    let atZone = false;
    for (let i = 0; i < line.d.length; i++) {
      if (!line.d[i] || !inPart(i % bw)) continue;
      any = true;
      if (edge.d[i]) atZone = true;
    }
    if (!any) continue;
    const cand: number[] = [];
    if (side === 1) {
      for (let j = start + 1; j <= hi; j++) if (spaces[j]) cand.push(j);
    } else {
      for (let j = start - 1; j >= lo; j--) if (spaces[j]) cand.push(j);
    }
    const far = new Set<number>();
    if (!atZone) {
      cand.push(side === 1 ? hi + 1 : lo - 1); // past the line's end
    } else if (band) {
      for (let j = side === 1 ? hi + 1 : lo - 1; j >= 0 && j < width; j += side) {
        if (!clear[j]) break;
        if (spaces[j]) far.add(j), cand.push(j);
      }
    }
    if (!cand.length) continue; // no word space both images have: left as it is
    // the space between the two images' words on either side of the cut: the output's towards the
    // area, the original's beyond; then the nearest
    const score = (j: number): number[] => {
      const before = lastBefore(side === 1 ? inkR : inkO, j);
      const after = firstAfter(side === 1 ? inkO : inkR, j);
      return [Math.max(0, need - (after - before - 1)), Math.abs(j - start), j];
    };
    let best = cand[0];
    let bestScore = score(best);
    for (const j of cand.slice(1)) {
      const sc = score(j);
      for (let k = 0; k < 3; k++) {
        if (sc[k] === bestScore[k]) continue;
        if (sc[k] < bestScore[k]) (best = j), (bestScore = sc);
        break;
      }
    }
    if (!band) {
      // the line's changed pixels only
      for (let i = 0; i < line.d.length; i++) {
        if (!line.d[i]) continue;
        const x = bx + (i % bw);
        if (!inPart(i % bw)) continue;
        if (side === 1 ? x < best : x > best) on.d[i] = 1;
        else off.d[i] = 1;
      }
    } else {
      // all of the band: no trace of the other image's letters is left beside them
      for (let y = Math.max(0, band[0] - by); y < Math.min(bh, Math.max(0, band[1] - by)); y++) {
        for (let x = 0; x < bw; x++) {
          const c = bx + x;
          if (side === 1 ? c > start && c < best : c < start && c > best) on.d[y * bw + x] = 1;
          else if (side === 1 ? c >= best : c <= best) off.d[y * bw + x] = 1;
        }
      }
    }
    if (far.has(best)) beyond.push(side === 1 ? [band![0], band![1], hi + 1, best] : [band![0], band![1], best + 1, lo]);
  }
  return beyond;
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
/**
 * Whether ``result`` keeps the original's framing: detail away from the region still lines up,
 * fine or a few times coarser (a model's few pixels askew in places pass, a reframed output
 * doesn't), either sign (light turned dark). Only grain away from the region: nothing to judge
 * by, aligned. imaging.aligned.
 */
export function aligned(original: Raster, result: Raster, mask: Raster): boolean {
  const scale = scaleFor(original.width, original.height);
  const far = farFrom(original, smallBits(mask, scale), scale);
  const n = count(far);
  if (n < 0.05 * far.d.length) return true;
  const g = [small(toGray(original), scale), small(toGray(result), scale)];
  /** what lies between two blurs (0: none), away from the region */
  const detail = (im: Raster, fine: number, coarse: number): Float64Array => {
    const sharp = fine === 0 ? im : gaussianBlur(im, fine);
    const blurred = gaussianBlur(im, coarse);
    const out = new Float64Array(n);
    for (let i = 0, k = 0; i < far.d.length; i++) if (far.d[i]) out[k++] = sharp.data[i] - blurred.data[i];
    return out;
  };
  const corr = (a: Float64Array, b: Float64Array): number => {
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let i = 0; i < a.length; i++) {
      ab += a[i] * b[i];
      aa += a[i] * a[i];
      bb += b[i] * b[i];
    }
    const norm = Math.sqrt(aa * bb);
    return norm === 0 ? 1 : Math.abs(ab) / norm; // light turned dark (a dark theme): edges in place, sign turned
  };
  const a = detail(g[0], 0, 3);
  let energy = 0;
  for (const v of a) energy += v * v;
  if (Math.sqrt(energy / n) < K.align_min_detail) return true;
  return corr(a, detail(g[1], 0, 3)) >= K.align_min_corr || corr(detail(g[0], 1.5, 6), detail(g[1], 1.5, 6)) >= K.align_coarse_corr;
}

/**
 * The color the model painted where the original is transparent, away from the regions (``seed``,
 * at 1/scale): the same nearly everywhere there; null without such an area, or when the model drew
 * something there. imaging.backdrop_of.
 */
export function backdropOf(original: Raster, result: Raster, seed: Bits, scale: number): [number, number, number] | null {
  if (original.channels !== 4) return null;
  const alpha = newRaster(original.width, original.height, 1);
  for (let i = 0; i < alpha.data.length; i++) alpha.data[i] = original.data[i * 4 + 3];
  const a = small(alpha, scale);
  const clear = and(erode(fromGray(a.data.map((v) => (v === 0 ? 1 : 0)), a.width, a.height), 4), not(dilate(seed, Math.floor(K.align_margin / scale))));
  const n = count(clear);
  if (n < K.backdrop_min_pixels) return null;
  const rs = small(toRgb(result), scale);
  const seen = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  for (let i = 0, k = 0; i < clear.d.length; i++) {
    if (!clear.d[i]) continue;
    for (let c = 0; c < 3; c++) seen[c][k] = rs.data[i * 3 + c];
    k++;
  }
  const color = seen.map((v) => v.slice().sort()[n >> 1]) as [number, number, number];
  let near = 0;
  for (let k = 0; k < n; k++) {
    const off = Math.max(Math.abs(seen[0][k] - color[0]), Math.abs(seen[1][k] - color[1]), Math.abs(seen[2][k] - color[2]));
    if (off <= K.backdrop_tolerance) near++;
  }
  return near >= K.backdrop_share * n ? color : null;
}

/**
 * ``result`` (RGBA) with the model's ``backdrop`` taken out where the original isn't opaque: each
 * pixel as opaque as the original's or as far as its color went from the backdrop, whichever is
 * more, and the color that over the backdrop gives the output's. imaging.keyed.
 */
export function keyed(original: Raster, result: Raster, backdrop: readonly [number, number, number]): Raster {
  const o = toRgba(original);
  const r = toRgb(result);
  const out = newRaster(o.width, o.height, 4);
  const d = [0, 0, 0];
  for (let p = 0; p < o.width * o.height; p++) {
    let share = 0;
    for (let c = 0; c < 3; c++) {
      d[c] = r.data[p * 3 + c] - backdrop[c];
      const span = Math.max(d[c] > 0 ? 255 - backdrop[c] : backdrop[c], K.key_min_span);
      share = Math.max(share, Math.floor((510 * Math.abs(d[c]) + span) / (2 * span)));
    }
    if (share <= K.key_noise) share = 0;
    const alpha = Math.max(o.data[p * 4 + 3], share);
    for (let c = 0; c < 3; c++) {
      out.data[p * 4 + c] = alpha > 0 ? clamp(backdrop[c] + Math.floor((510 * d[c] + alpha) / (2 * alpha)), 0, 255) : o.data[p * 4 + c];
    }
    out.data[p * 4 + 3] = alpha;
  }
  return out;
}

/** The paste-back weights for ``area``: grown by about two feather radii, then blurred by one (keeping what stays above 2.3%). */
export function feather(area: Raster, radius: number): Raster {
  const spread = point(gaussianBlur(area, radius), (v) => (v > 5 ? 255 : 0));
  return gaussianBlur(lighter(spread, area), radius);
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
      // a tie goes up: the two builds' fits can differ in the last bits (imaging.match_tone)
      lut[c * 256 + v] = Math.min(255, Math.max(0, roundHalfEven(v + trust * (gain * v + offset - v) + K.tone_tie)));
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
}

/** pasteBack's work before the blend (see pasteWeights). */
export interface PasteWeights {
  /** the model's output with its tone drift undone, in the original's channels; null when it redrew the scene */
  toned: Raster | null;
  /** the weights it is pasted with, from (x0, y0) on (none elsewhere); null: none at all */
  soft: Raster | null;
  x0: number;
  y0: number;
  note: string;
}

/**
 * Put the edited region of ``result`` (the original's size) onto ``original``. See
 * brushgraft.imaging.paste_back: tone drift undone, the area grown over the new content,
 * copied marks excluded, a feathered edge that leaves everything past ~4.7 radii untouched.
 * ``overall``: the user also wrote an overall request, which may ask for changes everywhere.
 */
export function pasteBack(original: Raster, result: Raster, mask: Raster, annotated: Raster | null, overall = false): PasteResult {
  const w = pasteWeights(original, result, mask, annotated, overall);
  if (!w.toned) return { image: null, note: w.note };
  const image = copyRaster(original.channels === 4 ? toRgba(original) : toRgb(original));
  blendOnto(image, w.toned, w);
  return { image, note: w.note };
}

/** ``top`` over ``base`` (changed in place) by the weights of pasteWeights, in ``base``'s channels. */
export function blendOnto(base: Raster, top: Raster, w: Pick<PasteWeights, "soft" | "x0" | "y0">): void {
  if (!w.soft) return;
  const x1 = w.x0 + w.soft.width;
  const y1 = w.y0 + w.soft.height;
  const res = top.channels === base.channels ? top : base.channels === 4 ? toRgba(top) : toRgb(top);
  paste(base, composite(crop(res, w.x0, w.y0, x1, y1), crop(base, w.x0, w.y0, x1, y1), w.soft), w.x0, w.y0);
}

/** pasteBack's work before the blend: brushgraft.imaging.paste_weights. */
export function pasteWeights(original: Raster, result: Raster, mask: Raster, annotated: Raster | null, overall = false): PasteWeights {
  const { width, height } = original;
  if (!aligned(original, result, mask)) return { toned: null, soft: null, x0: 0, y0: 0, note: NOTE.reframed };
  const scale = scaleFor(width, height);
  const seed = smallBits(mask, scale);
  const { w, h } = seed;
  const toned = matchTone(original, result, mask);
  // Where the original is transparent the model painted a backdrop: compared over it, only what it
  // drew there counts as change
  const backdrop = backdropOf(original, toned, seed, scale);
  const seen = backdrop ? onBackdrop(original, backdrop) : original;
  const delta = changeMap(seen, toned, scale);
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
  // (the annotated copy shows a transparent original over white)
  const echo = annotated ? echoedMarks(onBackdrop(original, WHITE), annotated, toned) : null;
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
  let core: Raster | null = null;
  if (grown.note === NOTE.spill_too_large) {
    areaImg = mask; // everything changed: no clean outline exists, keep the region
  } else {
    let strong = newBits(w, h);
    for (let i = 0; i < delta.length; i++) strong.d[i] = delta[i] > threshold ? 1 : 0;
    if (blocked) strong = without(strong, dilate(blocked, reach));
    const fullSize = (b: Bits) => lighter(point(resize(bitsToGray(b), width, height, "bilinear"), (v) => (v >= 128 ? 255 : 0)), mask);
    // the region and the new content that belongs to it
    core = fullSize(grown.area);
    // strong changes the feather would half cover anyway are taken whole
    areaImg = fullSize(or(grown.area, and(strong, dilate(grown.area, Math.ceil((2 * radius) / scale)))));
  }

  const band = echo ? copiedBand(echo, mask) : null;
  let settle: Settle | null = null;
  if (grown.note !== NOTE.spill_too_large) {
    const pieces = wholePieces(seen, toned, areaImg, radius, band, core);
    areaImg = pieces.area;
    settle = pieces.settle;
  }

  const res = backdrop ? keyed(original, toned, backdrop) : original.channels === 4 ? toRgba(toned) : toRgb(toned);
  const box = bbox(areaImg);
  // an overall request about the whole image: its whole output is what was asked for (imaging.paste_back)
  const note = overall ? NOTE.overall_change : grown.note;
  if (!box) return { toned: res, soft: null, x0: 0, y0: 0, note };
  // Blurs reach a bounded distance, so work on the box around the area plus that much (and the
  // whole pieces' box): the result is the same as blurring the whole image, at a fraction of the cost
  const margin = Math.max(2 * blurReach(radius) + 2, K.piece_zone * radius + 6);
  let x0 = Math.max(0, box[0] - margin);
  let y0 = Math.max(0, box[1] - margin);
  const x1 = Math.min(width, box[2] + margin);
  const y1 = Math.min(height, box[3] + margin);
  let soft = feather(crop(areaImg, x0, y0, x1, y1), radius);
  // the outlines lie within the feathered edge: where the model copied them, the original goes back
  if (band) soft = darker(soft, point(crop(band, x0, y0, x1, y1), (v) => 255 - v));
  if (settle) ({ soft, x0, y0 } = settle(soft, x0, y0));
  return { toned: res, soft, x0, y0, note };
}
