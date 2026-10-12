import { describe, expect, it } from "vitest";
import { clampShape, dragBox, hitRegion, inRegion, regionBox, resizeBox, snap45, transformShapes } from "./geometry";
import type { Region, Shape } from "./types";

const rect = (x: number, y: number, w: number, h: number, op?: Shape["op"]): Shape => ({ type: "rect", x, y, w, h, ...(op ? { op } : {}) });
const region = (...shapes: Shape[]): Region => ({ shapes, instruction: "" });

describe("marquee dragging, as in Photoshop", () => {
  it("draws from corner to corner in any direction", () => {
    expect(dragBox([10, 10], [40, 30], false, false)).toEqual({ x0: 10, y0: 10, x1: 40, y1: 30 });
    expect(dragBox([40, 30], [10, 10], false, false)).toEqual({ x0: 10, y0: 10, x1: 40, y1: 30 });
  });
  it("Shift makes a square on the longer side, keeping the direction", () => {
    expect(dragBox([10, 10], [40, 20], true, false)).toEqual({ x0: 10, y0: 10, x1: 40, y1: 40 });
    expect(dragBox([10, 10], [-20, 0], true, false)).toEqual({ x0: -20, y0: -20, x1: 10, y1: 10 });
  });
  it("Alt draws from the centre; both together make a centred square", () => {
    expect(dragBox([50, 50], [60, 55], false, true)).toEqual({ x0: 40, y0: 45, x1: 60, y1: 55 });
    expect(dragBox([50, 50], [60, 55], true, true)).toEqual({ x0: 40, y0: 40, x1: 60, y1: 60 });
  });
});

describe("polygonal lasso", () => {
  it("Shift snaps a segment to the nearest 45°", () => {
    const [x, y] = snap45([0, 0], [10, 1]);
    expect([Math.round(x), Math.round(y)]).toEqual([10, 0]);
    const [a, b] = snap45([0, 0], [10, 9]);
    expect(Math.abs(a - b)).toBeLessThan(1e-9);
  });
});

describe("transforming a region", () => {
  const box = { x0: 0, y0: 0, x1: 100, y1: 50 };
  it("a corner moves, the opposite corner stays", () => {
    expect(resizeBox(box, "se", [150, 80], false, false)).toEqual({ x0: 0, y0: 0, x1: 150, y1: 80 });
    expect(resizeBox(box, "nw", [20, 10], false, false)).toEqual({ x0: 20, y0: 10, x1: 100, y1: 50 });
  });
  it("a side handle changes one dimension only", () => {
    expect(resizeBox(box, "e", [140, 999], false, false)).toEqual({ x0: 0, y0: 0, x1: 140, y1: 50 });
    expect(resizeBox(box, "n", [999, -10], false, false)).toEqual({ x0: 0, y0: -10, x1: 100, y1: 50 });
  });
  it("Shift on a corner keeps the proportions; Alt scales about the centre", () => {
    const kept = resizeBox(box, "se", [200, 60], true, false);
    expect((kept.x1 - kept.x0) / (kept.y1 - kept.y0)).toBeCloseTo(2);
    expect(resizeBox(box, "e", [120, 0], false, true)).toEqual({ x0: -20, y0: 0, x1: 120, y1: 50 });
  });
  it("can't be dragged inside out", () => {
    const b = resizeBox(box, "e", [-50, 0], false, false, 4);
    expect(b.x1 - b.x0).toBe(4);
  });
  it("maps every shape and scales brush widths", () => {
    const shapes: Shape[] = [rect(0, 0, 100, 50), { type: "brush", points: [[0, 0], [100, 50]], radius: 10 }, { type: "ellipse", x: 50, y: 0, w: 50, h: 50, op: "subtract" }];
    const out = transformShapes(shapes, box, { x0: 10, y0: 10, x1: 210, y1: 110 });
    expect(out[0]).toEqual(rect(10, 10, 200, 100));
    expect(out[1]).toMatchObject({ points: [[10, 10], [210, 110]], radius: 20 });
    expect(out[2]).toEqual({ type: "ellipse", x: 110, y: 10, w: 100, h: 100, op: "subtract" });
  });
});

describe("what a region selects", () => {
  const cut = region(rect(0, 0, 100, 100), { type: "ellipse", x: 25, y: 25, w: 50, h: 50, op: "subtract" });
  it("subtracted shapes are holes; intersecting keeps only the overlap; order matters", () => {
    expect(inRegion([10, 10], cut)).toBe(true);
    expect(inRegion([50, 50], cut)).toBe(false);
    const both = region(rect(0, 0, 100, 100), rect(50, 0, 100, 100, "intersect"));
    expect([inRegion([25, 50], both), inRegion([75, 50], both)]).toEqual([false, true]);
    expect(inRegion([50, 50], region(rect(40, 40, 20, 20, "subtract"), rect(0, 0, 100, 100)))).toBe(true);
  });
  it("clicking a hole selects nothing (or the region under it)", () => {
    expect(hitRegion([50, 50], [cut])).toBe(-1);
    expect(hitRegion([50, 50], [region(rect(0, 0, 200, 200)), cut])).toBe(0);
  });
  it("the region's box covers what it adds, cut down by intersections", () => {
    expect(regionBox(cut)).toEqual({ x0: 0, y0: 0, x1: 100, y1: 100 });
    expect(regionBox(region(rect(0, 0, 100, 100), rect(50, 0, 100, 100, "intersect")))).toEqual({ x0: 50, y0: 0, x1: 100, y1: 100 });
    expect(regionBox(region(rect(0, 0, 10, 10, "subtract")))).toBeNull();
  });
});

describe("clampShape", () => {
  it("keeps the operation and drops the default", () => {
    expect(clampShape(rect(-10, -10, 50, 50, "subtract"), 100, 100)).toEqual(rect(0, 0, 40, 40, "subtract"));
    expect(clampShape(rect(5, 5, 50, 50, "add"), 100, 100)).toEqual(rect(5, 5, 50, 50));
  });
  it("an ellipse keeps its own box, even past the edge; one wholly outside is dropped", () => {
    expect(clampShape({ type: "ellipse", x: -20, y: 10, w: 60, h: 40 }, 100, 100)).toEqual({ type: "ellipse", x: -20, y: 10, w: 60, h: 40 });
    expect(clampShape({ type: "ellipse", x: 120, y: 10, w: 60, h: 40 }, 100, 100)).toBeNull();
  });
  it("a lasso or a stroke past the edge keeps its shape (the mask cuts it), one that misses the image goes", () => {
    const corner: Shape = { type: "lasso", points: [[-100, 50], [50, -100], [50, 50]] };
    expect(clampShape(corner, 100, 100)).toEqual(corner);
    const stroke: Shape = { type: "brush", points: [[-20, 10], [-20, 90]], radius: 30 };
    expect(clampShape(stroke, 100, 100)).toEqual(stroke);
    expect(clampShape({ type: "brush", points: [[-50, 10], [-50, 90]], radius: 30 }, 100, 100)).toBeNull();
    expect(clampShape({ type: "lasso", points: [[110, 0], [150, 0], [150, 40]] }, 100, 100)).toBeNull();
  });
});
