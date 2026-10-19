// Images onto the system clipboard, to paste into another app without saving a file first.

import type { Shape } from "./types";
import { shapesBox } from "./geometry";
import { regionMask } from "./imaging/shapes";
import { bbox } from "./imaging/raster";

/**
 * Whether this page may put an image on the clipboard: the async Clipboard API, which browsers
 * offer only to secure pages (HTTPS, or this computer: not the local server opened from another
 * device by its network address over plain HTTP).
 */
export const canCopyImage = (): boolean =>
  window.isSecureContext && typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";

/**
 * Put the image ``make`` gives on the clipboard, as PNG (the one image type every browser's
 * clipboard takes; it keeps transparency). The write starts at once, in the click or key press:
 * Safari allows it only within the user's gesture, and the image is made meanwhile.
 */
export async function copyImage(make: () => Promise<Blob>): Promise<void> {
  const png = make().then(asPng);
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  } catch (e) {
    // a browser that takes no promise in a ClipboardItem: the image itself
    if (!(e instanceof TypeError)) throw e;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": await png })]);
  }
}

async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = canvasOf(bitmap.width, bitmap.height);
    context(canvas).drawImage(bitmap, 0, 0);
    return await pngOf(canvas);
  } finally {
    bitmap.close();
  }
}

/**
 * The pixels of ``image`` inside a region (its ``shapes``, in image pixels), cropped to them and
 * transparent around: the object marked, to paste elsewhere. Null when the region covers none of
 * the image.
 */
export async function cutOut(image: Blob, shapes: Shape[]): Promise<Blob | null> {
  const bitmap = await createImageBitmap(image);
  try {
    // only the area the shapes can reach is rasterized, not the whole image
    const reach = shapesBox(shapes);
    if (!reach) return null;
    const x0 = Math.max(0, Math.floor(reach.x0));
    const y0 = Math.max(0, Math.floor(reach.y0));
    const x1 = Math.min(bitmap.width, Math.ceil(reach.x1) + 1);
    const y1 = Math.min(bitmap.height, Math.ceil(reach.y1) + 1);
    if (x1 <= x0 || y1 <= y0) return null;
    const mask = regionMask(x1 - x0, y1 - y0, shapes.map((s) => moved(s, -x0, -y0)));
    const tight = bbox(mask);
    if (!tight) return null;
    const [bx0, by0, bx1, by1] = tight;
    const [w, h] = [bx1 - bx0, by1 - by0];
    const canvas = canvasOf(w, h);
    const ctx = context(canvas);
    ctx.drawImage(bitmap, -(x0 + bx0), -(y0 + by0));
    const px = ctx.getImageData(0, 0, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = mask.data[(by0 + y) * mask.width + bx0 + x];
        const i = (y * w + x) * 4 + 3;
        px.data[i] = Math.round((px.data[i] * a) / 255);
      }
    }
    ctx.putImageData(px, 0, 0);
    return await pngOf(canvas);
  } finally {
    bitmap.close();
  }
}

/** A shape moved by (dx, dy). */
function moved(s: Shape, dx: number, dy: number): Shape {
  if (s.type === "rect" || s.type === "ellipse") return { ...s, x: s.x + dx, y: s.y + dy };
  return { ...s, points: s.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Context2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

const context = (canvas: AnyCanvas) => canvas.getContext("2d") as Context2D;

function canvasOf(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function pngOf(canvas: AnyCanvas): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image is too large to copy"))), "image/png"),
  );
}
