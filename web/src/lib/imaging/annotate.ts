// The annotated copy of the image sent to the model: each region outlined along its own shape and
// numbered (see brushgraft.imaging.annotate for why the outline sits where it does).

import { spec } from "../backend/spec";
import type { Region } from "../types";
import { erode, erodeClosed, fromGray, newBits, roundDilate, type Bits } from "./bits";
import type { Codec } from "./codec";
import { annotationBadge, annotationStroke, bitsToGray, scaleFor, smallBits } from "./pasteback";
import { bbox, copyRaster, crop, onBackdrop, resize, toRgb, WHITE, type Raster } from "./raster";
import { regionMask, unionMask } from "./shapes";
import { roundHalfEven } from "./stats";

export const regionColor = (index: number): string => spec.region_colors[index % spec.region_colors.length];

const hex = (color: string): [number, number, number] => [
  parseInt(color.slice(1, 3), 16),
  parseInt(color.slice(3, 5), 16),
  parseInt(color.slice(5, 7), 16),
];

function fillDisc(im: Raster, cx: number, cy: number, r: number, rgb: [number, number, number]): void {
  for (let y = cy - r; y <= cy + r; y++) {
    if (y < 0 || y >= im.height) continue;
    const half = Math.sqrt(Math.max(0, (r + 0.45) ** 2 - (y - cy) ** 2));
    const x0 = Math.max(0, Math.ceil(cx - half));
    const x1 = Math.min(im.width - 1, Math.floor(cx + half));
    for (let x = x0; x <= x1; x++) {
      const i = (y * im.width + x) * 3;
      im.data[i] = rgb[0];
      im.data[i + 1] = rgb[1];
      im.data[i + 2] = rgb[2];
    }
  }
}

/** The first point whose badge covers no region; else the first point. */
export function badgeCenter(occupied: Raster, points: [number, number][], radius: number): [number, number] {
  const { width: w, height: h } = occupied;
  const placed = points.map(([x, y]) => [Math.min(Math.max(x, radius), w - radius), Math.min(Math.max(y, radius), h - radius)] as [number, number]);
  for (const [cx, cy] of placed) {
    const box = crop(occupied, Math.max(0, cx - radius), Math.max(0, cy - radius), Math.min(w, cx + radius + 1), Math.min(h, cy + radius + 1));
    if (bbox(box) === null) return [cx, cy];
  }
  return placed[0];
}

/** The pixels of ``b`` nearest each of ``corners``, first in reading order on ties (numpy's argmin). */
function nearest(b: Bits, corners: [number, number][]): [number, number][] {
  return corners.map(([cx, cy]) => {
    let best = Infinity;
    let at: [number, number] = [0, 0];
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        if (!b.d[y * b.w + x]) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < best) {
          best = d;
          at = [x, y];
        }
      }
    }
    return at;
  });
}

export interface Layout {
  /** the outline, full size; null for an empty region */
  ring: Bits | null;
  /** where its number may be centred, best first */
  anchors: [number, number][];
}

/**
 * Each region's outline and number positions: brushgraft.imaging.annotation_layout. The outline
 * is worked out at full size on the box around the region, the number's place at 1/scale.
 */
export function annotationLayout(width: number, height: number, regions: Region[]): Layout[] {
  const stroke = annotationStroke(width, height);
  const badge = annotationBadge(width, height);
  const reach = spec.imaging.annot_gap * stroke + stroke;
  const scale = scaleFor(width, height);
  const grownFull = (small: Bits, by: number): Bits => {
    const grown = roundDilate(small, Math.max(1, roundHalfEven(by / scale)));
    const up = resize(bitsToGray(grown), width, height, "bilinear");
    return fromGray(up.data.map((v) => (v >= 128 ? 1 : 0)), width, height);
  };
  return regions.map((region) => {
    const mask = regionMask(width, height, region.shapes);
    const box = bbox(mask);
    if (!box) return { ring: null, anchors: [] };
    // The box with room for the outline and a pixel more: erosion treats its sides as the
    // image's edge, which they are, or else nothing set comes within a pixel of them
    const bx0 = Math.max(0, box[0] - reach - 1);
    const by0 = Math.max(0, box[1] - reach - 1);
    const bx1 = Math.min(width, box[2] + reach + 1);
    const by1 = Math.min(height, box[3] + reach + 1);
    const bw = bx1 - bx0;
    const selected = fromGray(crop(mask, bx0, by0, bx1, by1).data, bw, by1 - by0);
    const grown = roundDilate(selected, reach);
    const inner = erodeClosed(grown, stroke);
    const ring = newBits(width, height);
    let [x0, y0, x1, y1] = [width, height, -1, -1];
    for (let y = 0; y < grown.h; y++) {
      for (let x = 0; x < bw; x++) {
        const i = y * bw + x;
        if (!grown.d[i] || inner.d[i] || selected.d[i]) continue;
        const [gx, gy] = [bx0 + x, by0 + y];
        ring.d[gy * width + gx] = 1;
        if (gx < x0) x0 = gx;
        if (gx > x1) x1 = gx;
        if (gy < y0) y0 = gy;
        y1 = gy;
      }
    }
    if (x1 < 0) return { ring: null, anchors: [] };
    const small = smallBits(mask, scale);
    const outer = grownFull(small, reach + badge);
    // its edge inside the image only: a badge on the image's edge would sit on a region that runs
    // to it. A region taking in nearly all of the image leaves none: then any
    const edgeOf = (inner: Bits): Bits => ({ w: width, h: height, d: outer.d.map((v, i) => v & (inner.d[i] ^ 1)) });
    let edge = edgeOf(erode(outer, 1));
    if (!edge.d.includes(1)) edge = edgeOf(erodeClosed(outer, 1));
    return { ring, anchors: nearest(edge, [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) };
  });
}

/**
 * Outline each region along its shape and number it: the second image sent to the model.
 * ``numbers`` gives each region's place among all of an edit's (from 0), when only some are
 * shown: it keeps its number and color.
 */
export async function annotate(codec: Codec, image: Raster, regions: Region[], numbers?: number[]): Promise<Raster> {
  // a transparent image over white, as it is usually shown
  const out = image.channels === 4 ? onBackdrop(image, WHITE) : copyRaster(toRgb(image));
  const { width: w, height: h } = out;
  const badge = annotationBadge(w, h);
  const occupied = unionMask(w, h, regions);
  const badges: { cx: number; cy: number; rgb: [number, number, number]; text: string }[] = [];
  annotationLayout(w, h, regions).forEach(({ ring, anchors }, k) => {
    if (!ring) return;
    const i = numbers ? numbers[k] : k;
    const rgb = hex(regionColor(i));
    for (let p = 0; p < ring.d.length; p++) {
      if (!ring.d[p]) continue;
      out.data[p * 3] = rgb[0];
      out.data[p * 3 + 1] = rgb[1];
      out.data[p * 3 + 2] = rgb[2];
    }
    const [cx, cy] = badgeCenter(occupied, anchors, badge);
    badges.push({ cx, cy, rgb, text: String(i + 1) });
  });
  // the badges go on top of every outline, then the white numbers (the platform draws them)
  for (const { cx, cy, rgb } of badges) fillDisc(out, cx, cy, badge, rgb);
  for (const { cx, cy, text } of badges) {
    const ink = await codec.renderText(text, Math.round(badge * 1.3));
    const ox = cx - Math.floor(ink.width / 2);
    const oy = cy - Math.floor(ink.height / 2);
    for (let y = 0; y < ink.height; y++) {
      const yy = oy + y;
      if (yy < 0 || yy >= h) continue;
      for (let x = 0; x < ink.width; x++) {
        const a = ink.data[y * ink.width + x];
        const xx = ox + x;
        if (!a || xx < 0 || xx >= w) continue;
        const i = (yy * w + xx) * 3;
        for (let k = 0; k < 3; k++) out.data[i + k] = Math.round((out.data[i + k] * (255 - a) + 255 * a) / 255);
      }
    }
  }
  return out;
}
