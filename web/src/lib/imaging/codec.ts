// What imaging needs from the platform: decoding and encoding files, and
// drawing the numbers of the annotation. The browser's version uses an
// OffscreenCanvas (browser-codec.ts); the tests use pngjs.

import type { Raster } from "./raster";

export interface Codec {
  /**
   * Pixels of an image file, oriented as it is displayed (EXIF rotation applied):
   * RGB, or RGBA when the image has real transparency.
   */
  decode(bytes: Uint8Array): Promise<Raster>;
  encodePng(im: Raster): Promise<Uint8Array>;
  /** quality 0-1; images with transparency are saved as PNG instead */
  encodeJpeg(im: Raster, quality: number): Promise<Uint8Array>;
  /** the encoded image and its MIME type (a browser that can't write WebP says "image/png") */
  encodeThumb(im: Raster, quality: number): Promise<{ bytes: Uint8Array; type: string }>;
  /** coverage of ``text`` in white, centred in a mask of the returned size (grayscale, 255 = ink) */
  renderText(text: string, fontPx: number): Promise<Raster>;
}
