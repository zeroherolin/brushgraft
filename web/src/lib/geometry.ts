import type { Point, Region, Shape, ShapeOp } from "./types";

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const opOf = (shape: Shape): ShapeOp => shape.op ?? "add";

export function shapeBox(shape: Shape): Box {
  if (shape.type === "rect" || shape.type === "ellipse") {
    return { x0: shape.x, y0: shape.y, x1: shape.x + shape.w, y1: shape.y + shape.h };
  }
  const pad = shape.type === "brush" ? shape.radius : 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of shape.points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

const union = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const meet = (a: Box, b: Box): Box | null => {
  const box = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return box.x1 > box.x0 && box.y1 > box.y0 ? box : null;
};

/** The box around what a region selects: added shapes, cut down by intersections (subtractions only make it smaller). */
export function regionBox(region: Region): Box | null {
  let box: Box | null = null;
  for (const s of region.shapes) {
    const op = opOf(s);
    if (op === "add") box = box ? union(box, shapeBox(s)) : shapeBox(s);
    else if (op === "intersect" && box) box = meet(box, shapeBox(s));
  }
  return box;
}

/** The box around every shape of a region, whatever it does: what a transform moves. */
export function shapesBox(shapes: Shape[]): Box | null {
  return shapes.length ? shapes.map(shapeBox).reduce(union) : null;
}

function inPolygon([x, y]: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function hitShape(p: Point, shape: Shape): boolean {
  if (shape.type === "rect") {
    return p[0] >= shape.x && p[0] <= shape.x + shape.w && p[1] >= shape.y && p[1] <= shape.y + shape.h;
  }
  if (shape.type === "ellipse") {
    const rx = shape.w / 2;
    const ry = shape.h / 2;
    if (rx <= 0 || ry <= 0) return false;
    return ((p[0] - shape.x - rx) / rx) ** 2 + ((p[1] - shape.y - ry) / ry) ** 2 <= 1;
  }
  if (shape.type === "lasso") return inPolygon(p, shape.points);
  const pts = shape.points;
  if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) <= shape.radius;
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(p, pts[i - 1], pts[i]) <= shape.radius) return true;
  }
  return false;
}

/** Whether the point is selected by the region: its shapes applied in order, as the mask is made. */
export function inRegion(p: Point, region: Region): boolean {
  let inside = false;
  for (const s of region.shapes) {
    const op = opOf(s);
    if (op === "add") inside ||= hitShape(p, s);
    else if (op === "subtract") inside &&= !hitShape(p, s);
    else inside &&= hitShape(p, s);
  }
  return inside;
}

/** Index of the region under the point (later regions first), or -1. */
export function hitRegion(p: Point, regions: Region[]): number {
  for (let i = regions.length - 1; i >= 0; i--) {
    if (inRegion(p, regions[i])) return i;
  }
  return -1;
}

const round = (v: number) => Math.round(v * 10) / 10;

/** Clamp a shape to the image; null if it's too small (an accidental tap) or misses the image. */
export function clampShape(shape: Shape, w: number, h: number): Shape | null {
  const cx = (x: number) => Math.max(0, Math.min(w, x));
  const cy = (y: number) => Math.max(0, Math.min(h, y));
  const op = shape.op && shape.op !== "add" ? { op: shape.op } : {};
  if (shape.type === "rect" || shape.type === "ellipse") {
    // an ellipse keeps its own box (it may reach past the edge; the mask cuts it there)
    const x0 = Math.min(shape.x, shape.x + shape.w);
    const y0 = Math.min(shape.y, shape.y + shape.h);
    const x1 = Math.max(shape.x, shape.x + shape.w);
    const y1 = Math.max(shape.y, shape.y + shape.h);
    const [a, b, c, d] = shape.type === "rect" ? [cx(x0), cy(y0), cx(x1), cy(y1)] : [x0, y0, x1, y1];
    if (c - a < 3 || d - b < 3 || c <= 0 || d <= 0 || a >= w || b >= h) return null;
    return { type: shape.type, x: round(a), y: round(b), w: round(c - a), h: round(d - b), ...op };
  }
  // A lasso or a stroke keeps its points where they were drawn: moving each one inside would change
  // its shape (a loop round a corner would shrink). The mask is cut at the image's edge anyway.
  const points = shape.points.map(([x, y]) => [round(x), round(y)] as Point);
  const b = shapeBox(shape.type === "brush" ? { type: "brush", points, radius: shape.radius } : { type: "lasso", points });
  if (b.x1 <= 0 || b.y1 <= 0 || b.x0 >= w || b.y0 >= h) return null;
  if (shape.type === "lasso") {
    if (points.length < 3 || b.x1 - b.x0 < 3 || b.y1 - b.y0 < 3) return null;
    return { type: "lasso", points, ...op };
  }
  return { type: "brush", points, radius: round(shape.radius), ...op };
}

/** Drop points that are too close together, to keep requests small. */
export function simplify(points: Point[], minDist: number): Point[] {
  if (points.length < 3) return points;
  const out: Point[] = [points[0]];
  for (const p of points.slice(1, -1)) {
    const last = out[out.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= minDist) out.push(p);
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * The box dragged from ``start`` to ``end``, as marquee tools make it: ``square`` keeps the
 * sides equal (Shift in Photoshop), ``centered`` grows it from the start point (Alt).
 */
export function dragBox(start: Point, end: Point, square: boolean, centered: boolean): Box {
  let dx = end[0] - start[0];
  let dy = end[1] - start[1];
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * side;
    dy = Math.sign(dy || 1) * side;
  }
  if (centered) {
    return { x0: start[0] - Math.abs(dx), y0: start[1] - Math.abs(dy), x1: start[0] + Math.abs(dx), y1: start[1] + Math.abs(dy) };
  }
  return { x0: Math.min(start[0], start[0] + dx), y0: Math.min(start[1], start[1] + dy), x1: Math.max(start[0], start[0] + dx), y1: Math.max(start[1], start[1] + dy) };
}

/** The end of a segment from ``from``, snapped to the nearest multiple of 45° (Shift with the polygonal lasso). */
export function snap45(from: Point, to: Point): Point {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [from[0] + Math.cos(angle) * len, from[1] + Math.sin(angle) * len];
}

/** Map every shape from box ``from`` onto box ``to`` (a selection transform); brush widths scale with the area. */
export function transformShapes(shapes: Shape[], from: Box, to: Box): Shape[] {
  const sx = (to.x1 - to.x0) / Math.max(1e-6, from.x1 - from.x0);
  const sy = (to.y1 - to.y0) / Math.max(1e-6, from.y1 - from.y0);
  const mx = (x: number) => round(to.x0 + (x - from.x0) * sx);
  const my = (y: number) => round(to.y0 + (y - from.y0) * sy);
  return shapes.map((s): Shape => {
    if (s.type === "rect" || s.type === "ellipse") {
      return { ...s, x: mx(s.x), y: my(s.y), w: round(Math.max(1, s.w * sx)), h: round(Math.max(1, s.h * sy)) };
    }
    const points = s.points.map(([x, y]) => [mx(x), my(y)] as Point);
    if (s.type === "lasso") return { ...s, points };
    return { ...s, points, radius: round(Math.max(1, s.radius * Math.sqrt(sx * sy))) };
  });
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Where a handle sits on a box. */
export function handlePoint(box: Box, handle: Handle): Point {
  const x = handle.includes("w") ? box.x0 : handle.includes("e") ? box.x1 : (box.x0 + box.x1) / 2;
  const y = handle.includes("n") ? box.y0 : handle.includes("s") ? box.y1 : (box.y0 + box.y1) / 2;
  return [x, y];
}

/**
 * The box after dragging ``handle`` to ``p``. The opposite side stays put, or with ``centered``
 * the centre (Alt); ``keepAspect`` (Shift on a corner) keeps the proportions. Never smaller than ``min``.
 */
export function resizeBox(box: Box, handle: Handle, p: Point, keepAspect: boolean, centered: boolean, min = 2): Box {
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  let { x0, y0, x1, y1 } = box;
  const horizontal = handle.includes("w") || handle.includes("e");
  const vertical = handle.includes("n") || handle.includes("s");
  if (handle.includes("w")) x0 = Math.min(p[0], (centered ? cx : x1) - min);
  if (handle.includes("e")) x1 = Math.max(p[0], (centered ? cx : x0) + min);
  if (handle.includes("n")) y0 = Math.min(p[1], (centered ? cy : y1) - min);
  if (handle.includes("s")) y1 = Math.max(p[1], (centered ? cy : y0) + min);
  if (centered) {
    if (horizontal) [x0, x1] = handle.includes("w") ? [x0, 2 * cx - x0] : [2 * cx - x1, x1];
    if (vertical) [y0, y1] = handle.includes("n") ? [y0, 2 * cy - y0] : [2 * cy - y1, y1];
  }
  if (keepAspect && horizontal && vertical) {
    const w0 = box.x1 - box.x0;
    const h0 = box.y1 - box.y0;
    const k = Math.max((x1 - x0) / w0, (y1 - y0) / h0);
    const w = w0 * k;
    const h = h0 * k;
    if (centered) [x0, x1, y0, y1] = [cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2];
    else {
      if (handle.includes("w")) x0 = x1 - w;
      else x1 = x0 + w;
      if (handle.includes("n")) y0 = y1 - h;
      else y1 = y0 + h;
    }
  }
  return { x0, y0, x1, y1 };
}
