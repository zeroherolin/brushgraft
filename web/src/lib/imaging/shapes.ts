// Region shapes as a mask: the same shapes and the same rules as brushgraft.imaging
// (pixel (x, y) has its centre at (x, y), as in Pillow's drawing; a rectangle takes in both
// of its end pixels). Edge pixels may differ from Pillow's by one; the parity tests allow it.

import type { Shape } from "../types";
import { newRaster, type Raster } from "./raster";
import { roundHalfEven } from "./stats";

function span(mask: Raster, y: number, x0: number, x1: number, value: number): void {
  if (y < 0 || y >= mask.height) return;
  const a = Math.max(0, Math.ceil(x0));
  const b = Math.min(mask.width - 1, Math.floor(x1));
  if (a <= b) mask.data.fill(value, y * mask.width + a, y * mask.width + b + 1);
}

function fillPolygon(mask: Raster, floats: [number, number][], value: number): void {
  // Pillow cuts the coordinates to whole pixels first
  const pts = floats.map(([x, y]) => [Math.trunc(x), Math.trunc(y)] as [number, number]);
  const n = pts.length;
  let top = Infinity;
  let bottom = -Infinity;
  for (const [, y] of pts) {
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  const y0 = Math.max(0, Math.ceil(top));
  const y1 = Math.min(mask.height - 1, Math.floor(bottom));
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % n];
      if (ay === by) continue;
      // each edge owns its upper end but not its lower end, so a vertex is counted once
      if ((ay <= y && y < by) || (by <= y && y < ay)) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) span(mask, y, xs[i], xs[i + 1], value);
  }
  // Pillow also takes in the pixels on the outline; the scanline leaves out the bottom edge and slivers
  for (let i = 0; i < n; i++) line(mask, pts[i], pts[(i + 1) % n], value);
}

/** Bresenham, the way Pillow draws a one-pixel line between whole-pixel points. */
function line(mask: Raster, [x0, y0]: [number, number], [x1, y1]: [number, number], value: number): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (x0 >= 0 && y0 >= 0 && x0 < mask.width && y0 < mask.height) mask.data[y0 * mask.width + x0] = value;
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** Pillow fills the ellipse inscribed in the box with whole-pixel corners; this is its outline to within a pixel. */
function ellipse(mask: Raster, bx0: number, by0: number, bx1: number, by1: number, value: number): void {
  const x0 = Math.trunc(bx0);
  const x1 = Math.trunc(bx1);
  const y0 = Math.trunc(by0);
  const y1 = Math.trunc(by1);
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2 + 0.45;
  const ry = (y1 - y0) / 2 + 0.45;
  for (let y = Math.max(0, y0 - 1); y <= Math.min(mask.height - 1, y1 + 1); y++) {
    const t = (y - my) / ry;
    if (Math.abs(t) > 1) continue;
    const half = rx * Math.sqrt(1 - t * t);
    span(mask, y, mx - half, mx + half, value);
  }
}

const disc = (mask: Raster, cx: number, cy: number, r: number, value: number) => ellipse(mask, cx - r, cy - r, cx + r, cy + r, value);

function stroke(mask: Raster, pts: [number, number][], r: number, value: number): void {
  // the band is drawn as a line of width round(2r), the round ends as discs of radius r
  const half = Math.max(1, roundHalfEven(2 * r)) / 2;
  let last: [number, number] | null = null;
  for (const p of pts) {
    // points closer than a quarter radius add nothing visible
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < r / 4 && p !== pts[pts.length - 1]) continue;
    if (last) {
      // the band between two round ends: a rectangle of width 2r along the segment
      const dx = p[0] - last[0];
      const dy = p[1] - last[1];
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const nx = (-dy / len) * half;
        const ny = (dx / len) * half;
        fillPolygon(
          mask,
          [
            [last[0] + nx, last[1] + ny],
            [p[0] + nx, p[1] + ny],
            [p[0] - nx, p[1] - ny],
            [last[0] - nx, last[1] - ny],
          ],
          value,
        );
      }
    }
    disc(mask, p[0], p[1], r, value);
    last = p;
  }
}

export function drawShape(mask: Raster, shape: Shape, value = 255): void {
  if (shape.type === "rect") {
    // Pillow cuts coordinates to whole pixels and fills both ends
    const x0 = Math.max(0, Math.trunc(shape.x));
    const y0 = Math.max(0, Math.trunc(shape.y));
    const x1 = Math.min(mask.width - 1, Math.trunc(shape.x + shape.w));
    const y1 = Math.min(mask.height - 1, Math.trunc(shape.y + shape.h));
    for (let y = y0; y <= y1; y++) span(mask, y, x0, x1, value);
  } else if (shape.type === "ellipse") {
    ellipse(mask, shape.x, shape.y, shape.x + shape.w, shape.y + shape.h, value);
  } else if (shape.type === "lasso") {
    fillPolygon(mask, shape.points, value);
  } else if (shape.type === "brush") {
    stroke(mask, shape.points, shape.radius, value);
  } else {
    throw new Error(`unknown region shape: ${(shape as { type: string }).type}`);
  }
}

/**
 * All shapes in one grayscale mask (255 = selected), applied in order the way selection tools
 * combine them: ``op`` add (the default), subtract, or intersect (keep only what lies inside).
 */
export function regionMask(width: number, height: number, shapes: Shape[]): Raster {
  const mask = newRaster(width, height, 1);
  for (const shape of shapes) {
    const op = shape.op ?? "add";
    if (op === "add") drawShape(mask, shape, 255);
    else if (op === "subtract") drawShape(mask, shape, 0);
    else {
      const keep = newRaster(width, height, 1);
      drawShape(keep, shape, 255);
      for (let i = 0; i < mask.data.length; i++) if (!keep.data[i]) mask.data[i] = 0;
    }
  }
  return mask;
}

export const unionMask = (width: number, height: number, regions: { shapes: Shape[] }[]): Raster => {
  // regions combine by union; each region's own shapes combine by their operations
  const out = newRaster(width, height, 1);
  for (const r of regions) {
    const m = regionMask(width, height, r.shapes);
    for (let i = 0; i < m.data.length; i++) if (m.data[i]) out.data[i] = 255;
  }
  return out;
};
