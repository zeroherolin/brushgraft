// Putting the model's output on the original's pixel grid before pasting it back: a port of
// brushgraft.imaging.register (see there for why). Integer sums and plain arithmetic in the same
// order as the Python, so both find the same offsets.

import { spec } from "../backend/spec";
import { dilate, fromGray, not, type Bits } from "./bits";
import { bitsToGray } from "./pasteback";
import { bbox, gaussianBlur, hasAlpha, padEdge, resize, toGray, toRgb, toRgba, type Raster } from "./raster";

const K = spec.imaging;

/** Halves rounded up (brushgraft.imaging._round). */
const round = (v: number): number => Math.floor(v + 0.5);

type Point = [number, number];
type Reading = { at: Point; coord: number; offset: number };

/** ``result`` (any size, the original's aspect) on the original's pixel grid: imaging.register. */
export function register(original: Raster, result: Raster, mask: Raster): Raster {
  const { width: w, height: h } = original;
  const plain = result.width === w && result.height === h ? result : resize(result, w, h, "lanczos");
  const found = registrationBox(original, result, mask);
  if (!found) return plain;
  const { pad, box } = found;
  const source = hasAlpha(result) ? toRgba(result) : toRgb(result);
  return resize(padEdge(source, pad), w, h, "lanczos", box);
}

/** Where on ``result`` padded by ``pad`` pixels the original's frame lies; null to leave it as it is. */
export function registrationBox(original: Raster, result: Raster, mask: Raster): { pad: number; box: [number, number, number, number] } | null {
  const { width: w, height: h } = original;
  const fit = registerFit(original, result, mask);
  if (!fit) return null;
  const [[kx, tx], [ky, ty]] = fit;
  const worst = Math.max(Math.abs(tx), Math.abs(kx * w + tx), Math.abs(ty), Math.abs(ky * h + ty));
  if (worst < K.register_min_shift) return null;
  const { width: rw, height: rh } = result;
  const x0 = (tx * rw) / w;
  const y0 = (ty * rh) / h;
  const x1 = x0 + (1 + kx) * rw;
  const y1 = y0 + (1 + ky) * rh;
  const pad = Math.ceil(Math.max(0, -x0, -y0, x1 - rw, y1 - rh)) + 4;
  return { pad, box: [x0 + pad, y0 + pad, x1 + pad, y1 + pad] };
}

/** Per axis (k, t): the original's pixel at c shows at (1 + k) c + t on the output resized to its size. */
export function registerFit(original: Raster, result: Raster, mask: Raster): [[number, number], [number, number]] | null {
  const { width: w, height: h } = original;
  const q = Math.max(1, round(Math.max(w, h) / K.register_coarse));
  const coarseTile = Math.floor(K.register_tile / 2);
  const a = toGray(original);
  let b = toGray(result);
  if (b.width !== w || b.height !== h) b = resize(b, w, h, "bilinear");
  const keepBits = not(dilate(fromGray(mask.data, w, h), Math.max(coarseTile * q, K.register_tile)));
  const keep = bitsToGray(keepBits);

  // 1. On a copy 1/q the size, whole-pixel offsets up to register_reach of the long side
  const sw = Math.max(1, Math.floor(w / q));
  const sh = Math.max(1, Math.floor(h / q));
  const ac = resize(a, sw, sh, "box");
  const bc = resize(b, sw, sh, "box");
  const keepC = resize(keep, sw, sh, "box");
  const keepSmall: Bits = { w: sw, h: sh, d: keepC.data.map((v) => (v === 255 ? 1 : 0)) };
  let tiles = textureTiles(ac, keepSmall, coarseTile);
  let reach = Math.max(2, Math.ceil((K.register_reach * Math.max(w, h)) / q));
  let xs: Reading[] = [];
  let ys: Reading[] = [];
  const center = (coarseTile * q) / 2;
  const coarse = ssdSearch(ac, bc, tiles, coarseTile, null, reach);
  tiles.forEach(([x, y], i) => {
    for (const [axis, offset] of readings(coarse[i], reach, coarseTile, false)) {
      const at: Point = [x * q + center, y * q + center];
      (axis === 0 ? xs : ys).push({ at, coord: (axis === 0 ? x : y) * q + center, offset: offset * q });
    }
  });
  // (whole steps of q pixels: they scatter by up to q around the fit)
  const fx = lineFit(xs, w, q);
  const fy = lineFit(ys, h, q);
  if (!fx || !fy) return null;

  // 2. At full size, lightly blurred, around that, to a fraction of a pixel
  const af = gaussianBlur(a, 1);
  const bf = gaussianBlur(b, 1);
  const tile = K.register_tile;
  tiles = textureTiles(af, keepBits, tile);
  reach = q + 1;
  const half = tile / 2;
  const guesses = tiles.map(([x, y]) => [round(fx[0] * (x + half) + fx[1]), round(fy[0] * (y + half) + fy[1])] as Point);
  const fine = ssdSearch(af, bf, tiles, tile, guesses, reach);
  xs = [];
  ys = [];
  tiles.forEach(([x, y], i) => {
    for (const [axis, offset] of readings(fine[i], reach, tile, true)) {
      (axis === 0 ? xs : ys).push({ at: [x + half, y + half], coord: (axis === 0 ? x : y) + half, offset: guesses[i][axis] + offset });
    }
  });
  const whole = [lineFit(xs, w, K.register_max_spread), lineFit(ys, h, K.register_max_spread)];

  // 3. What is left near the regions: a shift, from the patches there
  const [bx0, by0, bx1, by1] = bbox(mask) ?? [0, 0, w, h];
  const near = K.register_near;
  const out: [number, number][] = [];
  for (const [axis, points] of [[0, xs], [1, ys]] as const) {
    const fit = whole[axis];
    const [k, t] = fit ?? [0, 0];
    const left = points
      .filter(({ at: [px, py] }) => bx0 - near <= px && px <= bx1 + near && by0 - near <= py && py <= by1 + near)
      .map(({ coord, offset }) => offset - (k * coord + t))
      .sort((p, q2) => p - q2);
    if (left.length >= 6) {
      const shift = left[Math.floor(left.length / 2)];
      const off = left.map((d) => Math.abs(d - shift)).sort((p, q2) => p - q2);
      if (off[Math.floor(off.length / 2)] <= K.register_max_spread) {
        out.push([k, t + shift]);
        continue;
      }
    }
    if (!fit) return null;
    out.push(fit);
  }
  return [out[0], out[1]];
}

/** Top-left corners of the tiles that lie where ``keep`` and have some structure, at most register_max_tiles. */
function textureTiles(a: Raster, keep: Bits, tile: number): Point[] {
  const { width: w, height: h, data } = a;
  const found: Point[] = [];
  for (let y = 0; y + tile <= h; y += tile) {
    for (let x = 0; x + tile <= w; x += tile) {
      let inside = true;
      for (let yy = y; yy < y + tile && inside; yy++) {
        for (let xx = x; xx < x + tile; xx++) {
          if (!keep.d[yy * w + xx]) {
            inside = false;
            break;
          }
        }
      }
      if (!inside) continue;
      let texture = 0;
      for (let yy = y; yy < y + tile; yy++) {
        for (let xx = x; xx < x + tile; xx++) {
          const v = data[yy * w + xx];
          if (yy + 1 < y + tile) texture += Math.abs(data[(yy + 1) * w + xx] - v);
          if (xx + 1 < x + tile) texture += Math.abs(data[yy * w + xx + 1] - v);
        }
      }
      if (texture >= 2 * tile * tile) found.push([x, y]);
    }
  }
  const n = found.length;
  const max = K.register_max_tiles;
  return n > max ? Array.from({ length: max }, (_, i) => found[Math.floor((i * n) / max)]) : found;
}

/** Per tile: the sums of squared differences against ``b`` moved by the guess plus (dx, dy), [dy][dx] flat; null off ``b``. */
function ssdSearch(a: Raster, b: Raster, tiles: Point[], tile: number, guesses: Point[] | null, reach: number): (Float64Array | null)[] {
  const { width: w, height: h } = b;
  const span = 2 * reach + 1;
  return tiles.map(([x, y], i) => {
    const [gx, gy] = guesses ? guesses[i] : [0, 0];
    const x0 = x + gx - reach;
    const y0 = y + gy - reach;
    if (x0 < 0 || y0 < 0 || x0 + tile + 2 * reach > w || y0 + tile + 2 * reach > h) return null;
    const ssd = new Float64Array(span * span);
    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) {
        let s = 0;
        for (let yy = 0; yy < tile; yy++) {
          const ra = (y + yy) * a.width + x;
          const rb = (y0 + dy + yy) * w + x0 + dx;
          for (let xx = 0; xx < tile; xx++) {
            const d = a.data[ra + xx] - b.data[rb + xx];
            s += d * d;
          }
        }
        ssd[dy * span + dx] = s;
      }
    }
    return ssd;
  });
}

/** The offsets a tile's search tells, as [axis, offset] (imaging._readings). */
function readings(ssd: Float64Array | null, reach: number, tile: number, subpixel: boolean): [0 | 1, number][] {
  if (!ssd) return [];
  const span = 2 * reach + 1;
  let best = 0;
  for (let i = 1; i < ssd.length; i++) if (ssd[i] < ssd[best]) best = i;
  const dy = Math.floor(best / span);
  const dx = best - dy * span;
  const s0 = ssd[best];
  const out: [0 | 1, number][] = [];
  for (const [axis, at] of [[0, dx], [1, dy]] as const) {
    if (!(at > 0 && at < span - 1)) continue; // the best match is at the edge of the search
    const minus = axis === 0 ? ssd[dy * span + dx - 1] : ssd[(dy - 1) * span + dx];
    const plus = axis === 0 ? ssd[dy * span + dx + 1] : ssd[(dy + 1) * span + dx];
    const curve = minus - 2 * s0 + plus;
    if (curve < 4 * tile * tile) continue; // flat along this axis
    out.push([axis, at - reach + (subpixel ? (0.5 * (minus - plus)) / curve : 0)]);
  }
  return out;
}

/** (k, t) of d = k c + t by least squares, once more without those far off; null if they disagree (imaging._line_fit). */
function lineFit(points: Reading[], size: number, tolerance: number): [number, number] | null {
  const fit = (pts: Reading[]): [number, number] => {
    const n = pts.length;
    let sc = 0;
    let sd = 0;
    let scc = 0;
    let scd = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const { coord: c, offset: d } of pts) {
      sc += c;
      sd += d;
      scc += c * c;
      scd += c * d;
      lo = Math.min(lo, c);
      hi = Math.max(hi, c);
    }
    if (hi - lo < 0.3 * size) return [0, sd / n];
    const k = (n * scd - sc * sd) / (n * scc - sc * sc);
    return [k, (sd - k * sc) / n];
  };
  const spread = (pts: Reading[], k: number, t: number) => {
    const off = pts.map(({ coord, offset }) => Math.abs(offset - (k * coord + t))).sort((p, q) => p - q);
    return off[Math.floor(off.length / 2)];
  };
  if (points.length < 6) return null;
  let [k, t] = fit(points);
  const limit = Math.max(tolerance, 3 * spread(points, k, t));
  const kept = points.filter(({ coord, offset }) => Math.abs(offset - (k * coord + t)) <= limit);
  if (kept.length < 6) return null;
  [k, t] = fit(kept);
  if (spread(kept, k, t) > tolerance || Math.abs(k) > 0.05) return null;
  return [k, t];
}
