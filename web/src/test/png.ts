// Test helpers: PNG files as Rasters (Node only).
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import type { Channels, Raster } from "../lib/imaging/raster";

export function decodePng(buffer: Buffer, mode?: "L" | "RGB" | "RGBA"): Raster {
  const png = PNG.sync.read(buffer);
  const px = png.width * png.height;
  const channels: Channels = mode === "L" ? 1 : mode === "RGB" ? 3 : 4;
  const data = new Uint8Array(px * channels);
  for (let i = 0; i < px; i++) {
    for (let k = 0; k < channels; k++) data[i * channels + k] = png.data[i * 4 + (channels === 1 ? 0 : k)];
  }
  return { width: png.width, height: png.height, channels, data };
}

export const readPng = (path: string, mode?: "L" | "RGB" | "RGBA") => decodePng(readFileSync(path), mode);

/** how many samples differ by more than ``tolerance``, and the largest difference */
export function compare(a: Raster, b: Raster, tolerance = 0): { count: number; max: number; pixels: number } {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    throw new Error(`shape ${a.width}x${a.height}x${a.channels} vs ${b.width}x${b.height}x${b.channels}`);
  }
  let count = 0;
  let max = 0;
  const bad = new Set<number>();
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d > tolerance) {
      count++;
      bad.add(Math.floor(i / a.channels));
    }
    if (d > max) max = d;
  }
  return { count, max, pixels: bad.size };
}

export const PARITY = new URL("../../.parity/", import.meta.url).pathname;
