// A Codec for tests: PNG only, through pngjs. Text is drawn as a plain block (the browser
// draws real digits), which is enough to see where the numbers go.
import { PNG } from "pngjs";
import type { Codec } from "../lib/imaging/codec";
import { hasAlpha, newRaster, type Raster } from "../lib/imaging/raster";
import { decodePng } from "./png";

function toPng(im: Raster): Uint8Array {
  const png = new PNG({ width: im.width, height: im.height });
  const c = im.channels;
  for (let i = 0; i < im.width * im.height; i++) {
    png.data[i * 4] = im.data[i * c];
    png.data[i * 4 + 1] = im.data[i * c + (c === 1 ? 0 : 1)];
    png.data[i * 4 + 2] = im.data[i * c + (c === 1 ? 0 : 2)];
    png.data[i * 4 + 3] = c === 4 ? im.data[i * 4 + 3] : 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

export const testCodec: Codec = {
  async decode(bytes) {
    const rgba = decodePng(Buffer.from(bytes), "RGBA");
    if (hasAlpha(rgba)) return rgba;
    return decodePng(Buffer.from(bytes), "RGB");
  },
  async encodePng(im) {
    return toPng(im);
  },
  async encodeJpeg(im) {
    return toPng(im);
  },
  async encodeThumb(im) {
    return { bytes: toPng(im), type: "image/png" };
  },
  async renderText(_text, fontPx) {
    return newRaster(Math.round(fontPx * 0.6), Math.round(fontPx * 0.8), 1, 255);
  },
};
