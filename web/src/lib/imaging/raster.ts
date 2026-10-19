// Pixel buffers and the few image operations the paste-back needs. They follow
// Pillow's algorithms step for step (box-filter coefficients in fixed point, the
// three-pass box blur that approximates a Gaussian, 8-bit blending), so the
// browser build edits an image the way the Python build does; the parity tests
// compare the two on the same inputs.

export type Channels = 1 | 3 | 4;

export interface Raster {
  width: number;
  height: number;
  /** 1 = grayscale (L), 3 = RGB, 4 = RGBA; samples interleaved, row by row */
  channels: Channels;
  data: Uint8Array;
}

export function newRaster(width: number, height: number, channels: Channels, fill = 0): Raster {
  const data = new Uint8Array(width * height * channels);
  if (fill) data.fill(fill);
  return { width, height, channels, data };
}

export const copyRaster = (r: Raster): Raster => ({ ...r, data: r.data.slice() });

const f32 = Math.fround;

// ---------------------------------------------------------------------------
// Resampling (Pillow's Resample.c, 8-bit)
// ---------------------------------------------------------------------------
export type Filter = "box" | "bilinear" | "lanczos";

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(x * Math.PI) / (x * Math.PI));

const FILTERS: Record<Filter, { fn: (x: number) => number; support: number }> = {
  box: { fn: (x) => (x > -0.5 && x <= 0.5 ? 1 : 0), support: 0.5 },
  bilinear: { fn: (x) => (Math.abs(x) < 1 ? 1 - Math.abs(x) : 0), support: 1 },
  lanczos: { fn: (x) => (x >= -3 && x < 3 ? sinc(x) * sinc(x / 3) : 0), support: 3 },
};

const PRECISION_BITS = 32 - 8 - 2;

interface Coeffs {
  ksize: number;
  bounds: Int32Array; // per output pixel: first input index, count
  kk: Int32Array; // per output pixel: ksize fixed-point weights
}

/** Pillow's precompute_coeffs: the source span [in0, in1) (floats, as Pillow takes the box) onto ``outSize`` pixels. */
function coeffs(inSize: number, outSize: number, filter: Filter, in0 = 0, in1 = inSize): Coeffs {
  const { fn, support: base } = FILTERS[filter];
  const start = f32(in0);
  const scale = f32(f32(in1) - start) / outSize;
  const filterScale = Math.max(scale, 1);
  const support = base * filterScale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Int32Array(outSize * ksize);
  const pre = new Float64Array(ksize);
  const inv = 1 / filterScale;
  for (let xx = 0; xx < outSize; xx++) {
    const center = start + (xx + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let sum = 0;
    for (let x = 0; x < xmax; x++) {
      const w = fn((x + xmin - center + 0.5) * inv);
      pre[x] = w;
      sum += w;
    }
    for (let x = 0; x < ksize; x++) {
      const w = x < xmax ? (sum !== 0 ? pre[x] / sum : pre[x]) : 0;
      kk[xx * ksize + x] = Math.trunc(w < 0 ? -0.5 + w * (1 << PRECISION_BITS) : 0.5 + w * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, bounds, kk };
}

const clip8 = (v: number) => {
  const q = v >> PRECISION_BITS;
  return q < 0 ? 0 : q > 255 ? 255 : q;
};

function passHorizontal(src: Uint8Array, w: number, rows: number, row0: number, c: number, outW: number, co: Coeffs): Uint8Array {
  const out = new Uint8Array(outW * rows * c);
  const { ksize, bounds, kk } = co;
  const half = 1 << (PRECISION_BITS - 1);
  for (let y = 0; y < rows; y++) {
    const inRow = (y + row0) * w * c;
    const outRow = y * outW * c;
    for (let xx = 0; xx < outW; xx++) {
      const xmin = bounds[xx * 2];
      const n = bounds[xx * 2 + 1];
      const k0 = xx * ksize;
      for (let ch = 0; ch < c; ch++) {
        let ss = half;
        for (let x = 0; x < n; x++) ss += src[inRow + (x + xmin) * c + ch] * kk[k0 + x];
        out[outRow + xx * c + ch] = clip8(ss);
      }
    }
  }
  return out;
}

function passVertical(src: Uint8Array, w: number, c: number, outH: number, co: Coeffs): Uint8Array {
  const out = new Uint8Array(w * outH * c);
  const { ksize, bounds, kk } = co;
  const half = 1 << (PRECISION_BITS - 1);
  const stride = w * c;
  for (let yy = 0; yy < outH; yy++) {
    const ymin = bounds[yy * 2];
    const n = bounds[yy * 2 + 1];
    const k0 = yy * ksize;
    for (let i = 0; i < stride; i++) {
      let ss = half;
      for (let y = 0; y < n; y++) ss += src[(y + ymin) * stride + i] * kk[k0 + y];
      out[yy * stride + i] = clip8(ss);
    }
  }
  return out;
}

/**
 * Pillow's ``Image.resize`` for 8-bit images with box, bilinear or lanczos. ``box`` is the part of
 * the source to resample (x0, y0, x1, y1), as Pillow's argument of that name: fractions allowed,
 * within the image.
 */
export function resize(im: Raster, width: number, height: number, filter: Filter, box?: [number, number, number, number]): Raster {
  const [bx0, by0, bx1, by1] = box ?? [0, 0, im.width, im.height];
  if (width === im.width && height === im.height && bx0 === 0 && by0 === 0 && bx1 === im.width && by1 === im.height) return copyRaster(im);
  const c = im.channels;
  // Pillow filters RGBA premultiplied by alpha
  const premultiplied = c === 4 && hasAlpha(im);
  let src = premultiplied ? premultiply(im.data) : im.data;
  let w = im.width;
  let rows = im.height;
  let row0 = 0;
  // as Pillow: a pass is needed when the size changes or the box doesn't span the image that way
  const needH = width !== im.width || f32(bx0) !== 0 || f32(bx1) !== width;
  const needV = height !== im.height || f32(by0) !== 0 || f32(by1) !== height;
  // as Pillow 13: when the height shrinks more than twice as much as the width, the vertical
  // pass goes first, over the whole width (each pass rounds and clips, so the order shows)
  if (im.height - height > 0 && im.height - height > (im.width - width) * 2) {
    let data = passVertical(src, im.width, c, height, coeffs(im.height, height, filter, by0, by1));
    if (needH) data = passHorizontal(data, im.width, height, 0, c, width, coeffs(im.width, width, filter, bx0, bx1));
    if (premultiplied) data = unpremultiply(data);
    return { width, height, channels: c, data };
  }
  const vert = needV ? coeffs(im.height, height, filter, by0, by1) : null;
  if (vert) {
    row0 = vert.bounds[0];
    rows = vert.bounds[(height - 1) * 2] + vert.bounds[(height - 1) * 2 + 1] - row0;
  }
  if (needH) {
    src = passHorizontal(src, im.width, rows, row0, c, width, coeffs(im.width, width, filter, bx0, bx1));
    w = width;
  } else if (row0 !== 0 || rows !== im.height) {
    src = src.subarray(row0 * w * c, (row0 + rows) * w * c);
  }
  let data = src;
  if (vert) {
    const shifted = Int32Array.from(vert.bounds);
    for (let i = 0; i < height; i++) shifted[i * 2] -= row0;
    data = passVertical(src, w, c, height, { ...vert, bounds: shifted });
  }
  if (data === im.data) data = data.slice();
  if (premultiplied) data = unpremultiply(data);
  return { width, height, channels: c, data };
}

/** ``im`` with ``pad`` pixels around it, each a copy of the nearest edge pixel (numpy's pad, mode "edge"). */
export function padEdge(im: Raster, pad: number): Raster {
  const c = im.channels;
  const w = im.width + 2 * pad;
  const h = im.height + 2 * pad;
  const out = newRaster(w, h, c);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(im.height - 1, Math.max(0, y - pad));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(im.width - 1, Math.max(0, x - pad));
      const i = (y * w + x) * c;
      const j = (sy * im.width + sx) * c;
      for (let k = 0; k < c; k++) out.data[i + k] = im.data[j + k];
    }
  }
  return out;
}

/** Nearest neighbour, the way Pillow picks the source pixel: ``floor`` of a position stepped by the scale. */
export function resizeNearest(im: Raster, width: number, height: number): Raster {
  const c = im.channels;
  const out = newRaster(width, height, c);
  // Pillow adds the scale up one step at a time, so a position that is exactly whole in
  // theory (30.5 * 90 / 183) can land just below it; stepping the same way gives its pixel
  const axis = (from: number, to: number) => {
    const step = from / to;
    const idx = new Int32Array(to);
    let pos = step * 0.5;
    for (let i = 0; i < to; i++, pos += step) idx[i] = Math.min(from - 1, Math.floor(pos));
    return idx;
  };
  const xs = axis(im.width, width);
  const ys = axis(im.height, height);
  for (let y = 0; y < height; y++) {
    const srcRow = ys[y] * im.width * c;
    const dstRow = y * width * c;
    for (let x = 0; x < width; x++) {
      for (let ch = 0; ch < c; ch++) out.data[dstRow + x * c + ch] = im.data[srcRow + xs[x] * c + ch];
    }
  }
  return out;
}

export function hasAlpha(im: Raster): boolean {
  if (im.channels !== 4) return false;
  const d = im.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

function premultiply(d: Uint8Array): Uint8Array {
  const out = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    for (let k = 0; k < 3; k++) {
      const t = d[i + k] * a + 128;
      out[i + k] = ((t >> 8) + t) >> 8;
    }
    out[i + 3] = a;
  }
  return out;
}

function unpremultiply(d: Uint8Array): Uint8Array {
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 255 || a === 0) continue;
    for (let k = 0; k < 3; k++) d[i + k] = Math.min(255, Math.floor((d[i + k] * 255) / a));
  }
  return d;
}

// ---------------------------------------------------------------------------
// Gaussian blur (Pillow's BoxBlur.c: three box passes per direction)
// ---------------------------------------------------------------------------
/** Pillow's box radius for ``passes`` passes approximating a Gaussian of ``radius`` (float32 arithmetic, as in C). */
function gaussianBoxRadius(radius: number, passes: number): number {
  const r = f32(radius);
  const sigma2 = f32(f32(r * r) / passes);
  const L = f32(Math.sqrt(12 * sigma2 + 1));
  const l = f32(Math.floor((L - 1) / 2));
  const num = f32(f32(f32(2 * l) + 1) * f32(f32(l * f32(l + 1)) - f32(3 * sigma2)));
  const den = f32(6 * f32(sigma2 - f32(f32(l + 1) * f32(l + 1))));
  return f32(l + f32(num / den));
}

function boxLine(src: Int32Array, out: Uint8Array, n: number, floatRadius: number): void {
  const radius = Math.trunc(floatRadius);
  const ww = Math.trunc(f32(16777216 / f32(f32(floatRadius * 2) + 1)));
  const fw = Math.floor((16777216 - (radius * 2 + 1) * ww) / 2);
  const lastx = n - 1;
  const edgeA = Math.min(radius + 1, n);
  const edgeB = Math.max(n - radius - 1, 0);
  const save = (x: number, acc: number, left: number, right: number) => {
    out[x] = (acc * ww + (src[left] + src[right]) * fw + 8388608) >>> 24;
  };
  let acc = src[0] * (radius + 1);
  for (let x = 0; x < edgeA - 1; x++) acc += src[x];
  acc += src[lastx] * (radius - edgeA + 1);
  if (edgeA <= edgeB) {
    for (let x = 0; x < edgeA; x++) {
      acc += src[x + radius] - src[0];
      save(x, acc, 0, x + radius + 1);
    }
    for (let x = edgeA; x < edgeB; x++) {
      acc += src[x + radius] - src[x - radius - 1];
      save(x, acc, x - radius - 1, x + radius + 1);
    }
    for (let x = edgeB; x <= lastx; x++) {
      acc += src[lastx] - src[x - radius - 1];
      save(x, acc, x - radius - 1, lastx);
    }
  } else {
    for (let x = 0; x < edgeB; x++) {
      acc += src[x + radius] - src[0];
      save(x, acc, 0, x + radius + 1);
    }
    for (let x = edgeB; x < edgeA; x++) {
      acc += src[lastx] - src[0];
      save(x, acc, 0, lastx);
    }
    for (let x = edgeA; x <= lastx; x++) {
      acc += src[lastx] - src[x - radius - 1];
      save(x, acc, x - radius - 1, lastx);
    }
  }
}

function blurAxis(data: Uint8Array, w: number, h: number, c: number, floatRadius: number, vertical: boolean): void {
  const n = vertical ? h : w;
  const lines = vertical ? w : h;
  const line = new Int32Array(n);
  const out = new Uint8Array(n);
  for (let ch = 0; ch < c; ch++) {
    for (let l = 0; l < lines; l++) {
      const base = vertical ? l * c + ch : l * w * c + ch;
      const step = vertical ? w * c : c;
      for (let i = 0; i < n; i++) line[i] = data[base + i * step];
      for (let pass = 0; pass < 3; pass++) {
        boxLine(line, out, n, floatRadius);
        if (pass < 2) line.set(out);
      }
      for (let i = 0; i < n; i++) data[base + i * step] = out[i];
    }
  }
}

/** Pillow's ``ImageFilter.GaussianBlur(radius)``. */
export function gaussianBlur(im: Raster, radius: number): Raster {
  const out = copyRaster(im);
  const box = gaussianBoxRadius(radius, 3);
  if (box === 0 || im.width === 0 || im.height === 0) return out;
  blurAxis(out.data, im.width, im.height, im.channels, box, false);
  blurAxis(out.data, im.width, im.height, im.channels, box, true);
  return out;
}

/** How far a blur of this radius spreads a pixel (a bound; beyond it the result is exactly 0). */
export function blurReach(radius: number): number {
  return 3 * (Math.trunc(gaussianBoxRadius(radius, 3)) + 1);
}

// ---------------------------------------------------------------------------
// Conversions and per-pixel operations
// ---------------------------------------------------------------------------
/** RGB(A) to grayscale with Pillow's integer weights. */
export function toGray(im: Raster): Raster {
  if (im.channels === 1) return im;
  const c = im.channels;
  const out = newRaster(im.width, im.height, 1);
  for (let i = 0, j = 0; j < out.data.length; i += c, j++) {
    out.data[j] = (im.data[i] * 19595 + im.data[i + 1] * 38470 + im.data[i + 2] * 7471 + 0x8000) >> 16;
  }
  return out;
}

/** The colour channels only (alpha dropped, as ``convert("RGB")`` does). */
export function toRgb(im: Raster): Raster {
  if (im.channels === 3) return im;
  const out = newRaster(im.width, im.height, 3);
  if (im.channels === 1) {
    for (let i = 0; i < im.data.length; i++) out.data.fill(im.data[i], i * 3, i * 3 + 3);
    return out;
  }
  for (let i = 0, j = 0; i < im.data.length; i += 4, j += 3) {
    out.data[j] = im.data[i];
    out.data[j + 1] = im.data[i + 1];
    out.data[j + 2] = im.data[i + 2];
  }
  return out;
}

export function toRgba(im: Raster): Raster {
  if (im.channels === 4) return im;
  const rgb = toRgb(im);
  const out = newRaster(im.width, im.height, 4, 255);
  for (let i = 0, j = 0; i < rgb.data.length; i += 3, j += 4) {
    out.data[j] = rgb.data[i];
    out.data[j + 1] = rgb.data[i + 1];
    out.data[j + 2] = rgb.data[i + 2];
  }
  return out;
}

/** ``im`` as RGB, over ``backdrop`` where it is transparent (as is when opaque): imaging.on_backdrop. */
export function onBackdrop(im: Raster, backdrop: readonly [number, number, number]): Raster {
  if (im.channels !== 4) return toRgb(im);
  const out = newRaster(im.width, im.height, 3);
  for (let i = 0, j = 0; j < out.data.length; i += 4, j += 3) {
    const a = im.data[i + 3];
    for (let c = 0; c < 3; c++) out.data[j + c] = Math.floor((im.data[i + c] * a + backdrop[c] * (255 - a) + 127) / 255);
  }
  return out;
}

export const WHITE = [255, 255, 255] as const;

/** ``Image.composite(top, bottom, mask)``: Pillow's 8-bit blend, per sample. */
export function composite(top: Raster, bottom: Raster, mask: Raster): Raster {
  const out = copyRaster(bottom);
  const c = out.channels;
  const m = mask.data;
  for (let p = 0; p < m.length; p++) {
    const a = m[p];
    if (a === 0) continue;
    for (let k = 0; k < c; k++) {
      const i = p * c + k;
      if (a === 255) out.data[i] = top.data[i];
      else {
        const t = bottom.data[i] * (255 - a) + top.data[i] * a + 128;
        out.data[i] = ((t >> 8) + t) >> 8;
      }
    }
  }
  return out;
}

export const lighter = (a: Raster, b: Raster): Raster => zip(a, b, Math.max);
export const darker = (a: Raster, b: Raster): Raster => zip(a, b, Math.min);

function zip(a: Raster, b: Raster, fn: (x: number, y: number) => number): Raster {
  const out = copyRaster(a);
  for (let i = 0; i < out.data.length; i++) out.data[i] = fn(a.data[i], b.data[i]);
  return out;
}

/** A grayscale image from ``fn`` applied to every sample (a lookup table, like ``Image.point``). */
export function point(im: Raster, fn: (v: number) => number): Raster {
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = fn(v);
  const out = copyRaster(im);
  for (let i = 0; i < out.data.length; i++) out.data[i] = lut[out.data[i]];
  return out;
}

/** The rectangle ``box`` = [x0, y0, x1, y1) of an image. */
export function crop(im: Raster, x0: number, y0: number, x1: number, y1: number): Raster {
  const c = im.channels;
  const out = newRaster(x1 - x0, y1 - y0, im.channels);
  for (let y = y0; y < y1; y++) {
    out.data.set(im.data.subarray((y * im.width + x0) * c, (y * im.width + x1) * c), (y - y0) * out.width * c);
  }
  return out;
}

/** Put ``src`` into ``dst`` at (x0, y0). */
export function paste(dst: Raster, src: Raster, x0: number, y0: number): void {
  const c = dst.channels;
  for (let y = 0; y < src.height; y++) {
    dst.data.set(src.data.subarray(y * src.width * c, (y + 1) * src.width * c), ((y + y0) * dst.width + x0) * c);
  }
}

/** [x0, y0, x1, y1) around the non-zero samples of a grayscale image, or null if there are none. */
export function bbox(im: Raster): [number, number, number, number] | null {
  let x0 = im.width;
  let y0 = im.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < im.height; y++) {
    const row = y * im.width;
    for (let x = 0; x < im.width; x++) {
      if (im.data[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}
