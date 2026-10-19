// The image work of an edit, as functions of bytes in and bytes out (they run in a
// Worker in the browser): normalising uploads, preparing the images sent to the API,
// and putting the model's output back onto the original. Python's counterparts are
// normalize_upload, for_api, merge_parts and JobRunner._save_result in brushgraft.

import { spec } from "../backend/spec";
import { userError } from "../backend/errors";
import type { Region } from "../types";
import { annotate } from "./annotate";
import type { Codec } from "./codec";
import { detectExt, jpegOrientation, sniff } from "./formats";
import { blendOnto, matchTone, pasteBack, pasteWeights, sameAspect, type PasteWeights } from "./pasteback";
import { register } from "./register";
import { bbox, copyRaster, crop, paste, resize, toRgb, toRgba, type Raster } from "./raster";
import { regionMask, unionMask } from "./shapes";
import { shiftRegions, zoomParts, type Box } from "./zoom";

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
  /** the annotated copy as sent */
  annot?: Uint8Array;
  /** an edit sent in parts instead (see zoomParts): the close-ups, after the whole image when it is needed */
  parts?: PreparedPart[];
}

export interface PreparedPart {
  /** the close-up; null for the whole image, with every region */
  box: Box | null;
  /** the regions it shows, by index */
  regions: number[];
  /** sent in order: what is edited, annotated copy, references */
  images: Uint8Array[];
  /** its regions' mask on what is edited */
  mask: Uint8Array;
  /** the annotated copy as sent */
  annot: Uint8Array;
}

/**
 * The images of an edit or generation: what to send, and the mask and annotated copy to keep.
 * With ``zoom``, a small edit of a large image goes in parts: close-ups (see zoom.ts), and the
 * whole image as well when some regions are too large for one.
 */
export async function prepare(
  codec: Codec,
  input: { parent?: Uint8Array; regions: Region[]; refs: Uint8Array[]; zoom?: boolean },
): Promise<Prepared> {
  const out: Prepared = { images: [] };
  const { parent, regions } = input;
  const refs: Uint8Array[] = [];
  for (const ref of input.refs) refs.push(await forApi(codec, ref, K.ref_max_pixels));
  if (parent && !regions.length) out.images.push(await forApi(codec, parent));
  if (parent && regions.length) {
    const original = await codec.decode(parent);
    const { width, height } = original;
    const mask = unionMask(width, height, regions);
    if (bbox(mask) === null) throw userError("empty_region", "The region is empty; draw it again");
    out.mask = await codec.encodePng(mask);
    const boxes = input.zoom ? regions.map((r) => bbox(regionMask(width, height, r.shapes))) : [];
    const plan = input.zoom ? zoomParts(width, height, boxes) : [];
    const whole = async () => {
      out.annot = await codec.encodePng(await annotate(codec, original, regions));
      return [await forApi(codec, parent), await forApi(codec, out.annot)];
    };
    if (!plan.length) {
      out.images.push(...(await whole()));
    } else {
      out.parts = [];
      const shown = new Set(plan.flatMap(([, numbers]) => numbers));
      if (boxes.some((b, i) => b && !shown.has(i))) {
        const images = await whole();
        out.parts.push({ box: null, regions: regions.map((_, i) => i), images: [...images, ...refs], mask: out.mask, annot: out.annot! });
      }
      for (const [box, numbers] of plan) {
        const view = crop(original, ...box);
        const some = shiftRegions(numbers.map((i) => regions[i]), -box[0], -box[1]);
        const annot = await codec.encodePng(await annotate(codec, view, some, numbers));
        out.parts.push({
          box,
          regions: numbers,
          images: [await forApi(codec, await codec.encodePng(view)), await forApi(codec, annot), ...refs],
          mask: await codec.encodePng(unionMask(view.width, view.height, some)),
          annot,
        });
      }
      return out;
    }
  }
  out.images.push(...refs);
  return out;
}

export interface Merged {
  /** the pasted-back image as PNG; null when the model redrew the scene (use its whole output) */
  image: Uint8Array | null;
  note: string;
}

/** Paste the edited region of the model's output onto the original. ``note`` explains what happened (see note.* in the locales). */
export async function merge(
  codec: Codec,
  input: { parent: Uint8Array; result: Uint8Array; mask: Uint8Array; annot?: Uint8Array; overall?: boolean },
): Promise<Merged> {
  const original = await codec.decode(input.parent);
  let result = await codec.decode(input.result);
  if (!sameAspect([original.width, original.height], [result.width, result.height])) {
    return { image: null, note: spec.notes.aspect_mismatch };
  }
  const gray = grayOf((await codec.decode(input.mask)) as Raster);
  // on the original's pixel grid: scaled back as it is, it can sit a few pixels off
  result = register(original, result, gray);
  const annotated = input.annot ? await codec.decode(input.annot) : null;
  const done = pasteBack(original, result, gray, annotated, input.overall ?? false);
  return { image: done.image ? await codec.encodePng(done.image) : null, note: done.note };
}

/** One request's output of an edit sent in parts, with what it was sent. */
export interface Piece {
  box: Box | null;
  result: Uint8Array;
  mask: Uint8Array;
  annot: Uint8Array;
}

export interface PartsMerged {
  /** send the whole image as well: a close-up changed all over (the overall request), or can't be pasted back */
  ask?: "overall" | "unusable";
  /** the pasted-back image; null: use the whole image's output as it came (redrawn, or of other proportions) */
  merged?: Uint8Array | null;
  /** the whole output */
  raw?: Uint8Array;
  note: string;
}

// The notes of a version made in parts, weakest first: it shows the strongest
const PART_NOTES = ["", spec.notes.spill_grown, spec.notes.spill_too_large];

/** Put back the outputs of an edit sent in parts onto the original: brushgraft.imaging.merge_parts. */
export async function mergeParts(codec: Codec, input: { parent: Uint8Array; pieces: Piece[]; overall: boolean }): Promise<PartsMerged> {
  const decoded = await codec.decode(input.parent);
  const full = decoded.channels === 4 ? toRgba(decoded) : toRgb(decoded);
  let whole: { result: Raster; w: PasteWeights } | null = null;
  const ups: { box: Box; result: Raster; mask: Raster; w: PasteWeights }[] = [];
  let ask: PartsMerged["ask"];
  // the whole image's output first (a stable sort)
  for (const p of [...input.pieces].sort((a, b) => Number(a.box !== null) - Number(b.box !== null))) {
    const original = p.box ? crop(full, ...p.box) : full;
    const output = await codec.decode(p.result);
    if (!sameAspect([original.width, original.height], [output.width, output.height])) {
      if (!p.box) return { merged: null, note: spec.notes.aspect_mismatch };
      ask ??= "unusable";
      continue;
    }
    const mask = grayOf(await codec.decode(p.mask));
    const result = register(original, output, mask);
    const w = pasteWeights(original, result, mask, await codec.decode(p.annot), input.overall);
    if (!p.box) {
      if (!w.toned) return { merged: null, note: w.note };
      whole = { result, w };
    } else if (!w.toned) {
      ask ??= "unusable";
    } else {
      if (w.note === spec.notes.overall_change) ask = "overall";
      ups.push({ box: p.box, result, mask, w });
    }
  }
  if (!whole && ask) return { ask, note: "" };

  const merged = copyRaster(full);
  if (whole) blendOnto(merged, whole.w.toned!, whole.w);
  const raw = whole ? inChannels(whole.result, full.channels) : copyRaster(full);
  const notes: string[] = [];
  for (const { box, result, mask, w } of ups) {
    const part = crop(merged, ...box);
    blendOnto(part, w.toned!, w);
    paste(merged, part, box[0], box[1]);
    if (!whole) {
      paste(raw, inChannels(result, full.channels), box[0], box[1]);
    } else {
      // the close-up's regions, in the whole output's tones
      const base = crop(raw, ...box);
      blendOnto(base, matchTone(base, result, mask), w);
      paste(raw, base, box[0], box[1]);
    }
    notes.push(w.note);
  }
  let note: string;
  if (whole?.w.note === spec.notes.overall_change) {
    note = spec.notes.overall_change;
  } else {
    // a close-up's own overall change is drift when the whole image's output has none
    if (whole) notes.push(whole.w.note);
    note = notes.filter((n) => n !== spec.notes.overall_change).reduce((a, b) => (PART_NOTES.indexOf(b) > PART_NOTES.indexOf(a) ? b : a), "");
  }
  return { merged: await codec.encodePng(merged), raw: await codec.encodePng(raw), note };
}

/** The outputs of an edit sent in parts put in place as they came, the whole image's first: when pasting back failed. */
export async function placeParts(codec: Codec, input: { parent: Uint8Array; pieces: Pick<Piece, "box" | "result">[] }): Promise<Uint8Array> {
  const decoded = await codec.decode(input.parent);
  const image = decoded.channels === 4 ? toRgba(decoded) : toRgb(decoded);
  for (const p of [...input.pieces].sort((a, b) => Number(a.box !== null) - Number(b.box !== null))) {
    const [x0, y0, x1, y1] = p.box ?? [0, 0, image.width, image.height];
    const output = resize(await codec.decode(p.result), x1 - x0, y1 - y0, "lanczos");
    paste(image, inChannels(output, image.channels), x0, y0);
  }
  return codec.encodePng(image);
}

/** ``im`` in RGB, or RGBA. */
const inChannels = (im: Raster, channels: number): Raster => (channels === 4 ? toRgba(im) : toRgb(im));

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
