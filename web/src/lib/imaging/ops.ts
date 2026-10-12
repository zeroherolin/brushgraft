// The image work of an edit, as functions of bytes in and bytes out (they run in a
// Worker in the browser): normalising uploads, preparing the images sent to the API,
// and putting the model's output back onto the original. Python's counterparts are
// normalize_upload, for_api and JobRunner._save_result in brushgraft.

import { spec } from "../backend/spec";
import { userError } from "../backend/errors";
import type { Region } from "../types";
import { annotate } from "./annotate";
import type { Codec } from "./codec";
import { detectExt, jpegOrientation, sniff } from "./formats";
import { pasteBack, sameAspect } from "./pasteback";
import { register } from "./register";
import { bbox, resize, type Raster } from "./raster";
import { unionMask } from "./shapes";

const K = spec.imaging;
const KEEP_UPLOAD_FORMATS = new Set([".png", ".jpg", ".webp"]);
export const THUMB_EDGE = 384;

/** Rotate or flip pixels as an EXIF orientation says (1 = as is). */
export function orient(im: Raster, orientation: number): Raster {
  if (orientation === 1) return im;
  const swap = orientation >= 5;
  const w = swap ? im.height : im.width;
  const h = swap ? im.width : im.height;
  const c = im.channels;
  const out = { width: w, height: h, channels: im.channels, data: new Uint8Array(w * h * c) };
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      let nx: number;
      let ny: number;
      switch (orientation) {
        case 2: [nx, ny] = [im.width - 1 - x, y]; break;
        case 3: [nx, ny] = [im.width - 1 - x, im.height - 1 - y]; break;
        case 4: [nx, ny] = [x, im.height - 1 - y]; break;
        case 5: [nx, ny] = [y, x]; break;
        case 6: [nx, ny] = [im.height - 1 - y, x]; break;
        case 7: [nx, ny] = [im.height - 1 - y, im.width - 1 - x]; break;
        default: [nx, ny] = [y, im.width - 1 - x]; break;
      }
      const from = (y * im.width + x) * c;
      out.data.set(im.data.subarray(from, from + c), (ny * w + nx) * c);
    }
  }
  return out;
}

/**
 * Validate an upload and convert it where needed. Phone photos often store their
 * orientation in EXIF: browsers rotate them for display, while the model and the paste-back
 * use the raw pixels, so the rotation is baked in. Formats the model can't read (GIF)
 * become PNG.
 */
export async function normalizeUpload(codec: Codec, data: Uint8Array): Promise<Uint8Array> {
  if (!detectExt(data)) throw userError("not_an_image", "Only PNG, JPEG, WebP and GIF images are supported");
  const info = sniff(data);
  if (!info) throw userError("bad_image", "Couldn't read the image: the file is damaged", { detail: "bad header" });
  if (KEEP_UPLOAD_FORMATS.has(info.ext) && jpegOrientation(data) === 1) {
    // Decoding proves it can be read; the original bytes are kept
    await decodeChecked(codec, data);
    return data;
  }
  // decode() applies the orientation, as browsers do for display
  return codec.encodePng(await decodeChecked(codec, data));
}

async function decodeChecked(codec: Codec, data: Uint8Array): Promise<Raster> {
  try {
    return await codec.decode(data);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw userError("bad_image", `Couldn't read the image: ${detail}`, { detail });
  }
}

/**
 * Shrink an image that is too large to send: returned unchanged within both the pixel and
 * byte limits; otherwise scaled down to at most ``maxPixels``, as PNG with transparency and
 * high-quality JPEG without, and a transparent one further when its PNG is still over the byte
 * limit. Opaque inputs of the same size give outputs of the same size.
 */
export async function forApi(codec: Codec, data: Uint8Array, maxPixels = spec.sizes.max_pixels): Promise<Uint8Array> {
  const info = sniff(data);
  if (info && info.width * info.height <= maxPixels && data.length <= K.api_max_bytes) return data;
  let im = await codec.decode(data);
  const { width: w, height: h } = im;
  if (w * h > maxPixels) {
    const k = Math.sqrt(maxPixels / (w * h));
    im = resize(im, Math.max(1, Math.trunc(w * k)), Math.max(1, Math.trunc(h * k)), "lanczos");
  }
  if (im.channels !== 4) return codec.encodeJpeg(im, 0.94);
  const png = await codec.encodePng(im);
  if (png.length <= K.api_max_bytes) return png;
  // a noisy transparent image takes about 3 bytes a pixel even as PNG
  const k = Math.sqrt(K.api_max_bytes / png.length) * 0.97;
  return codec.encodePng(resize(im, Math.max(1, Math.trunc(im.width * k)), Math.max(1, Math.trunc(im.height * k)), "lanczos"));
}

export interface Prepared {
  /** sent in order: original, annotated copy, references */
  images: Uint8Array[];
  mask?: Uint8Array;
  annot?: Uint8Array;
}

/** The images of an edit or generation: what to send, and the mask and annotated copy to keep. */
export async function prepare(
  codec: Codec,
  input: { parent?: Uint8Array; regions: Region[]; refs: Uint8Array[] },
): Promise<Prepared> {
  const out: Prepared = { images: [] };
  const { parent, regions } = input;
  if (parent) {
    out.images.push(await forApi(codec, parent));
    if (regions.length) {
      const original = await codec.decode(parent);
      const mask = unionMask(original.width, original.height, regions);
      if (bbox(mask) === null) throw userError("empty_region", "The region is empty; draw it again");
      out.mask = await codec.encodePng(mask);
      out.annot = await codec.encodePng(await annotate(codec, original, regions));
      out.images.push(await forApi(codec, out.annot));
    }
  }
  for (const ref of input.refs) out.images.push(await forApi(codec, ref, K.ref_max_pixels));
  return out;
}

export interface Merged {
  /** the pasted-back image as PNG; null when the model redrew the scene (use its whole output) */
  image: Uint8Array | null;
  note: string;
}

/**
 * Paste the edited region of the model's output onto the original. ``note`` explains
 * what happened (see note.* in the locales); the caller has already checked the aspect.
 */
export async function merge(
  codec: Codec,
  input: { parent: Uint8Array; result: Uint8Array; mask: Uint8Array; annot?: Uint8Array; overall?: boolean },
): Promise<Merged> {
  const original = await codec.decode(input.parent);
  let result = await codec.decode(input.result);
  if (!sameAspect([original.width, original.height], [result.width, result.height])) {
    return { image: null, note: spec.notes.aspect_mismatch };
  }
  const mask = (await codec.decode(input.mask)) as Raster;
  const gray = grayOf(mask);
  // on the original's pixel grid: scaled back as it is, it can sit a few pixels off
  result = register(original, result, gray);
  const annotated = input.annot ? await codec.decode(input.annot) : null;
  const done = pasteBack(original, result, gray, annotated, input.overall ?? false);
  return { image: done.image ? await codec.encodePng(done.image) : null, note: done.note };
}

/** A mask PNG decoded as RGB is gray: take one channel. */
function grayOf(mask: Raster): Raster {
  if (mask.channels === 1) return mask;
  const out = { width: mask.width, height: mask.height, channels: 1 as const, data: new Uint8Array(mask.width * mask.height) };
  for (let i = 0; i < out.data.length; i++) out.data[i] = mask.data[i * mask.channels];
  return out;
}

/** A thumbnail: long edge ``THUMB_EDGE``, never enlarged. */
export async function thumbnail(codec: Codec, data: Uint8Array): Promise<{ bytes: Uint8Array; type: string }> {
  let im = await codec.decode(data);
  const k = Math.min(1, THUMB_EDGE / Math.max(im.width, im.height));
  if (k < 1) im = resize(im, Math.max(1, Math.round(im.width * k)), Math.max(1, Math.round(im.height * k)), "lanczos");
  return codec.encodeThumb(im, 0.82);
}
