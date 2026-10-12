// Telling image formats and their sizes apart from the first bytes (no decoding),
// and reading a JPEG's orientation: what promptbrush.detect_image_ext and Pillow's
// header reading do on the Python side.

export type Ext = ".png" | ".jpg" | ".webp" | ".gif";

export const MIME: Record<Ext, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface Sniffed {
  ext: Ext;
  width: number;
  height: number;
}

const startsWith = (d: Uint8Array, bytes: number[], at = 0) => bytes.every((b, i) => d[at + i] === b);
const ascii = (d: Uint8Array, at: number, n: number) => String.fromCharCode(...d.subarray(at, at + n));

export function detectExt(d: Uint8Array): Ext | null {
  if (startsWith(d, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ".png";
  if (startsWith(d, [0xff, 0xd8, 0xff])) return ".jpg";
  if (ascii(d, 0, 4) === "RIFF" && ascii(d, 8, 4) === "WEBP") return ".webp";
  if (ascii(d, 0, 6) === "GIF87a" || ascii(d, 0, 6) === "GIF89a") return ".gif";
  return null;
}

/** Format and pixel size from the header; null when it isn't an image or the header is cut off. */
export function sniff(d: Uint8Array): Sniffed | null {
  const ext = detectExt(d);
  if (!ext) return null;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  try {
    if (ext === ".png") {
      if (d.length < 24) return null;
      return { ext, width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (ext === ".gif") return { ext, width: view.getUint16(6, true), height: view.getUint16(8, true) };
    if (ext === ".jpg") {
      let i = 2;
      while (i + 9 < d.length) {
        if (d[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = d[i + 1];
        if (marker === 0xff) {
          i++;
          continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const length = view.getUint16(i + 2);
        // start-of-frame markers carry the size (C4, C8 and CC are not frames)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { ext, height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
        }
        i += 2 + length;
      }
      return null;
    }
    // WebP: a lossy, lossless or extended header
    const kind = ascii(d, 12, 4);
    if (kind === "VP8 ") return { ext, width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (kind === "VP8L") {
      const bits = view.getUint32(21, true);
      return { ext, width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") {
      return {
        ext,
        width: (d[24] | (d[25] << 8) | (d[26] << 16)) + 1,
        height: (d[27] | (d[28] << 8) | (d[29] << 16)) + 1,
      };
    }
  } catch {
    // a cut-off header
  }
  return null;
}

/** The EXIF orientation (1-8) of a JPEG, 1 when there is none or it isn't a JPEG. */
export function jpegOrientation(d: Uint8Array): number {
  if (detectExt(d) !== ".jpg") return 1;
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let i = 2;
  while (i + 4 < d.length) {
    if (d[i] !== 0xff) return 1;
    const marker = d[i + 1];
    if (marker === 0xda || marker === 0xd9) return 1; // image data starts: no EXIF
    const length = view.getUint16(i + 2);
    if (marker === 0xe1 && ascii(d, i + 4, 6) === "Exif\0\0") {
      const tiff = i + 10;
      const little = ascii(d, tiff, 2) === "II";
      const u16 = (at: number) => view.getUint16(at, little);
      const u32 = (at: number) => view.getUint32(at, little);
      const dir = tiff + u32(tiff + 4);
      const entries = u16(dir);
      for (let k = 0; k < entries; k++) {
        const entry = dir + 2 + k * 12;
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    i += 2 + length;
  }
  return 1;
}
