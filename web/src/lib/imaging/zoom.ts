// A small edit of a large image is sent as a close-up: the area around the regions, in the
// image's proportions, so the model sees them in detail. Python's counterparts are zoom_box,
// zoom_size and shift_regions in brushgraft.imaging (the constants and the reasons are there).

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
