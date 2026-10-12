// Boolean masks (1 = set) and the morphology the paste-back uses on them: the
// same operations as the numpy versions in brushgraft.imaging.

import { roundHalfEven } from "./stats";

export interface Bits {
  w: number;
  h: number;
  d: Uint8Array;
}

export const newBits = (w: number, h: number): Bits => ({ w, h, d: new Uint8Array(w * h) });
export const cloneBits = (b: Bits): Bits => ({ ...b, d: b.d.slice() });

export function count(b: Bits): number {
  let n = 0;
  for (let i = 0; i < b.d.length; i++) n += b.d[i];
  return n;
}

export function or(a: Bits, b: Bits): Bits {
  const out = newBits(a.w, a.h);
  for (let i = 0; i < out.d.length; i++) out.d[i] = a.d[i] | b.d[i];
  return out;
}

export function and(a: Bits, b: Bits): Bits {
  const out = newBits(a.w, a.h);
  for (let i = 0; i < out.d.length; i++) out.d[i] = a.d[i] & b.d[i];
  return out;
}

/** ``a & ~b`` */
export function without(a: Bits, b: Bits): Bits {
  const out = newBits(a.w, a.h);
  for (let i = 0; i < out.d.length; i++) out.d[i] = a.d[i] & (b.d[i] ^ 1);
  return out;
}

export function not(a: Bits): Bits {
  const out = newBits(a.w, a.h);
  for (let i = 0; i < out.d.length; i++) out.d[i] = a.d[i] ^ 1;
  return out;
}

/** Binary dilation by a (2r+1) square; what lies outside the image counts as unset. */
export function dilate(b: Bits, radius: number): Bits {
  if (radius <= 0) return b;
  const { w, h } = b;
  const rows = newBits(w, h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let last = -Infinity;
    for (let x = 0; x < w; x++) {
      if (b.d[o + x]) last = x;
      if (x - last <= radius) rows.d[o + x] = 1;
    }
    let next = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (b.d[o + x]) next = x;
      if (next - x <= radius) rows.d[o + x] = 1;
    }
  }
  const out = newBits(w, h);
  const last = new Float64Array(w).fill(-Infinity);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rows.d[y * w + x]) last[x] = y;
      if (y - last[x] <= radius) out.d[y * w + x] = 1;
    }
  }
  const next = new Float64Array(w).fill(Infinity);
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      if (rows.d[y * w + x]) next[x] = y;
      if (next[x] - y <= radius) out.d[y * w + x] = 1;
    }
  }
  return out;
}

/** Dilation by an octagon close to a disc: a square (0.414 r) then 4-neighbour steps for the rest. */
export function roundDilate(b: Bits, radius: number): Bits {
  const square = roundHalfEven(radius * 0.4142);
  let out = dilate(b, square);
  const { w, h } = b;
  for (let step = square; step < radius; step++) {
    const next = cloneBits(out);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (out.d[i]) continue;
        if ((x > 0 && out.d[i - 1]) || (x < w - 1 && out.d[i + 1]) || (y > 0 && out.d[i - w]) || (y < h - 1 && out.d[i + w])) next.d[i] = 1;
      }
    }
    out = next;
  }
  return out;
}

/** Erosion where the outside of the image counts as unset, so an edge erodes too. */
export function erodeClosed(b: Bits, radius: number): Bits {
  const { w, h } = b;
  const pw = w + 2 * radius;
  const padded = newBits(pw, h + 2 * radius);
  for (let y = 0; y < h; y++) padded.d.set(b.d.subarray(y * w, (y + 1) * w), (y + radius) * pw + radius);
  const eroded = erode(padded, radius);
  const out = newBits(w, h);
  for (let y = 0; y < h; y++) out.d.set(eroded.d.subarray((y + radius) * pw + radius, (y + radius) * pw + radius + w), y * w);
  return out;
}

/** Binary dilation along one axis only ("x": along rows, "y": along columns), ``radius`` pixels each way. */
export function dilateAxis(b: Bits, radius: number, axis: "x" | "y"): Bits {
  if (radius <= 0) return b;
  const { w, h } = b;
  const out = newBits(w, h);
  const [n, len, step, stride] = axis === "x" ? [h, w, 1, w] : [w, h, w, 1];
  for (let line = 0; line < n; line++) {
    const o = line * stride;
    let last = -Infinity;
    for (let i = 0; i < len; i++) {
      if (b.d[o + i * step]) last = i;
      if (i - last <= radius) out.d[o + i * step] = 1;
    }
    let next = Infinity;
    for (let i = len - 1; i >= 0; i--) {
      if (b.d[o + i * step]) next = i;
      if (next - i <= radius) out.d[o + i * step] = 1;
    }
  }
  return out;
}

/** Connected components (8-connected): 0 off ``b``, a number per component on it (only the grouping matters). */
export function label8(b: Bits): Int32Array {
  const { w, h } = b;
  const labels = new Int32Array(w * h);
  const stack: number[] = [];
  let n = 0;
  for (let s = 0; s < labels.length; s++) {
    if (!b.d[s] || labels[s]) continue;
    labels[s] = ++n;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          const j = yy * w + xx;
          if (b.d[j] && !labels[j]) {
            labels[j] = n;
            stack.push(j);
          }
        }
      }
    }
  }
  return labels;
}

/** Erosion as numpy's ``~dilate(~mask)``: the image's border doesn't erode anything. */
export const erode = (b: Bits, radius: number): Bits => (radius <= 0 ? b : not(dilate(not(b), radius)));

/**
 * Set ``grown`` to everything reachable from it through ``allowed`` pixels
 * (8-connected). Returns null as soon as more than ``limit`` pixels are set.
 */
export function floodGrow(grown: Bits, allowed: Bits, limit: number): Bits | null {
  const { w, h } = grown;
  const out = cloneBits(grown);
  const stack: number[] = [];
  let n = 0;
  for (let i = 0; i < out.d.length; i++) {
    if (out.d[i]) {
      n++;
      stack.push(i);
    }
  }
  if (n > limit) return null;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (!out.d[j] && allowed.d[j]) {
          out.d[j] = 1;
          if (++n > limit) return null;
          stack.push(j);
        }
      }
    }
  }
  return out;
}

/** Connected components (4-connected) of ``strong`` that touch ``zone`` and have at least ``minArea`` pixels. */
export function componentsNear(strong: Bits, zone: Bits, minArea: number): Int32Array[] {
  const { w, h } = strong;
  const seen = new Uint8Array(strong.d.length);
  const found: Int32Array[] = [];
  for (let s = 0; s < strong.d.length; s++) {
    if (!strong.d[s] || !zone.d[s] || seen[s]) continue;
    const members: number[] = [s];
    seen[s] = 1;
    for (let k = 0; k < members.length; k++) {
      const i = members[k];
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0 && strong.d[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), members.push(i - 1);
      if (x < w - 1 && strong.d[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), members.push(i + 1);
      if (y > 0 && strong.d[i - w] && !seen[i - w]) (seen[i - w] = 1), members.push(i - w);
      if (y < h - 1 && strong.d[i + w] && !seen[i + w]) (seen[i + w] = 1), members.push(i + w);
    }
    if (members.length >= minArea) found.push(Int32Array.from(members));
  }
  return found;
}

/** ``b`` plus every pixel it encloses. */
export function fillHoles(b: Bits): Bits {
  const { w, h } = b;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (b.d[y * w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return b;
  // the bounding box plus a one-pixel frame; the frame is background and everything reachable from it is outside
  const pw = x1 - x0 + 3;
  const ph = y1 - y0 + 3;
  const outside = new Uint8Array(pw * ph);
  const inside = (px: number, py: number) => {
    const x = px - 1 + x0;
    const y = py - 1 + y0;
    return px > 0 && py > 0 && px < pw - 1 && py < ph - 1 && b.d[y * w + x] === 1;
  };
  const stack = [0];
  outside[0] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const px = i % pw;
    const py = (i - px) / pw;
    for (const [qx, qy] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
      if (qx < 0 || qy < 0 || qx >= pw || qy >= ph) continue;
      const j = qy * pw + qx;
      if (!outside[j] && !inside(qx, qy)) {
        outside[j] = 1;
        stack.push(j);
      }
    }
  }
  const out = cloneBits(b);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!outside[(y - y0 + 1) * pw + (x - x0 + 1)]) out.d[y * w + x] = 1;
    }
  }
  return out;
}

/** Bits of a grayscale raster (non-zero = set). */
export function fromGray(data: Uint8Array, w: number, h: number): Bits {
  const out = newBits(w, h);
  for (let i = 0; i < out.d.length; i++) out.d[i] = data[i] ? 1 : 0;
  return out;
}
