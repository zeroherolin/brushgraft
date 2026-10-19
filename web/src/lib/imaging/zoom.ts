// A small edit of a large image is sent in close-ups: the area around the regions, in the
// image's proportions, so the model sees them in detail. Python's counterparts are zoom_box,
// zoom_parts, zoom_size and shift_regions in brushgraft.imaging (the constants and the reasons
// are there).

import { fitSize } from "../backend/sizes";
import { spec } from "../backend/spec";
import type { Region, Shape } from "../types";

const K = spec.imaging;

export type Box = [number, number, number, number];

/** The close-up for regions within ``box`` (their bounding box, ends exclusive), or null to send the whole image. */
export function zoomBox(width: number, height: number, box: Box): Box | null {
  const [x0, y0, x1, y1] = box;
  const aspect = width / height;
  let w = Math.max((x1 - x0) * K.zoom_context, (y1 - y0) * K.zoom_context * aspect);
  if (w * (w / aspect) < K.zoom_min_pixels) w = Math.sqrt(K.zoom_min_pixels * aspect);
  w = Math.ceil(w);
  const h = Math.ceil(w / aspect);
  if (w > width || h > height || w * h > K.zoom_max_share * width * height) return null;
  const left = Math.floor(Math.min(Math.max((x0 + x1) / 2 - w / 2, 0), width - w));
  const top = Math.floor(Math.min(Math.max((y0 + y1) / 2 - h / 2, 0), height - h));
  return [left, top, left + w, top + h];
}

/**
 * The close-ups to send regions in, given each one's bounding box (null for an empty region):
 * [close-up, the regions' indices], in the regions' order. Regions close together share one;
 * regions too large for any are left out, and so are the largest close-ups past zoom_max_parts
 * (those regions go with the whole image).
 */
export function zoomParts(width: number, height: number, boxes: (Box | null)[]): [Box, number[]][] {
  const union = (group: number[]): Box => {
    const bs = group.map((i) => boxes[i]!);
    return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];
  };
  const area = (z: Box) => (z[2] - z[0]) * (z[3] - z[1]);
  let groups = boxes.flatMap((b, i) => (b && zoomBox(width, height, b) ? [[i]] : []));
  for (;;) {
    let best: [number, number, number] | null = null;
    for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        const z = zoomBox(width, height, union([...groups[a], ...groups[b]]));
        if (z && (best === null || area(z) < best[0])) best = [area(z), a, b];
      }
    }
    if (best === null) break;
    const [, a, b] = best;
    groups[a] = [...groups[a], ...groups[b]].sort((x, y) => x - y);
    groups = groups.filter((_, i) => i !== b);
  }
  let parts = groups.map((g): [Box, number[]] => [zoomBox(width, height, union(g))!, g]);
  if (parts.length > K.zoom_max_parts) {
    const kept = new Set([...parts].sort((p, q) => area(p[0]) - area(q[0])).slice(0, K.zoom_max_parts));
    parts = parts.filter((p) => kept.has(p));
  }
  return parts;
}

/** The size to ask for a close-up in: its proportions, at least zoom_output_pixels. */
export function zoomSize(box: Box): string {
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  const k = Math.max(1, Math.sqrt(K.zoom_output_pixels / (w * h)));
  return fitSize(Math.floor(w * k), Math.floor(h * k));
}

/** ``regions`` moved by (dx, dy): their shapes as they lie on a crop. */
export function shiftRegions(regions: Region[], dx: number, dy: number): Region[] {
  const shift = (s: Shape): Shape =>
    s.type === "rect" || s.type === "ellipse"
      ? { ...s, x: s.x + dx, y: s.y + dy }
      : { ...s, points: s.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
  return regions.map((r) => ({ ...r, shapes: r.shapes.map(shift) }));
}
