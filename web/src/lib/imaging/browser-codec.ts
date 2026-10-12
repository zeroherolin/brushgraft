// The browser's Codec: decoding through createImageBitmap, encoding and text through
// OffscreenCanvas. Runs in a Worker (OffscreenCanvas needs no DOM).

import type { Codec } from "./codec";
import { hasAlpha, newRaster, toRgb, type Raster } from "./raster";

const canvas = (w: number, h: number) => new OffscreenCanvas(w, h);

function toRaster(data: ImageData): Raster {
  const raster: Raster = { width: data.width, height: data.height, channels: 4, data: new Uint8Array(data.data.buffer.slice(0)) };
  return hasAlpha(raster) ? raster : toRgb(raster);
}

function toImageData(im: Raster): ImageData {
  const px = im.width * im.height;
  const rgba = new Uint8ClampedArray(px * 4);
  const c = im.channels;
  for (let i = 0; i < px; i++) {
    rgba[i * 4] = im.data[i * c];
    rgba[i * 4 + 1] = im.data[i * c + (c === 1 ? 0 : 1)];
    rgba[i * 4 + 2] = im.data[i * c + (c === 1 ? 0 : 2)];
    rgba[i * 4 + 3] = c === 4 ? im.data[i * 4 + 3] : 255;
  }
  return new ImageData(rgba, im.width, im.height);
}

async function encode(im: Raster, type: string, quality?: number): Promise<{ bytes: Uint8Array; type: string }> {
  const c = canvas(im.width, im.height);
  c.getContext("2d")!.putImageData(toImageData(im), 0, 0);
  const blob = await c.convertToBlob({ type, quality });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type };
}

export const browserCodec: Codec = {
  async decode(bytes) {
    // Colour management off: the model and the paste-back work on the file's own numbers.
    // The bitmap is oriented as displayed (EXIF applied), as the server's upload step makes it.
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), {
      colorSpaceConversion: "none",
      imageOrientation: "from-image",
      premultiplyAlpha: "none",
    });
    try {
      const c = canvas(bitmap.width, bitmap.height);
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      return toRaster(ctx.getImageData(0, 0, bitmap.width, bitmap.height));
    } finally {
      bitmap.close();
    }
  },

  async encodePng(im) {
    return (await encode(im, "image/png")).bytes;
  },

  async encodeJpeg(im, quality) {
    // JPEG has no transparency: keep PNG for such images, as the server does
    return im.channels === 4 ? (await encode(im, "image/png")).bytes : (await encode(im, "image/jpeg", quality)).bytes;
  },

  async encodeThumb(im, quality) {
    const webp = await encode(im, "image/webp", quality);
    return webp.type === "image/webp" ? webp : encode(im, "image/png");
  },

  async renderText(text, fontPx) {
    const c = canvas(Math.ceil(fontPx * text.length * 0.9) + 4, Math.ceil(fontPx * 1.4) + 4);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, c.width / 2, c.height / 2);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const ink = newRaster(c.width, c.height, 1);
    for (let i = 0; i < ink.data.length; i++) ink.data[i] = data[i * 4 + 3];
    return ink;
  },
};
