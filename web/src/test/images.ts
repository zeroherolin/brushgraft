// Test images: real PNG files made in code.
import { PNG } from "pngjs";

/** A PNG of ``w`` x ``h`` whose pixels come from ``fn(x, y) -> [r, g, b]``. */
export function makePng(w: number, h: number, fn: (x: number, y: number) => [number, number, number]): Uint8Array {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

/** Smooth, textured and varied enough for the paste-back to have something to compare. */
export const scenePng = (w = 240, h = 160, seed = 1): Uint8Array =>
  makePng(w, h, (x, y) => {
    const n = Math.sin(x * 0.21 + seed) * Math.cos(y * 0.17 - seed) * 40 + ((x * 7 + y * 13 + seed * 31) % 11) * 2;
    return [
      Math.max(0, Math.min(255, 110 + x * 0.3 + n)),
      Math.max(0, Math.min(255, 130 + y * 0.4 - n)),
      Math.max(0, Math.min(255, 90 + (x + y) * 0.15 + n * 0.5)),
    ];
  });

export const b64 = (d: Uint8Array): string => Buffer.from(d).toString("base64");

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
