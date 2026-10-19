// The Worker that does the image work, off the page's thread: preparing what is
// sent to the model and pasting the result back take a second or two on large images.

import { browserCodec } from "./browser-codec";
import { forApi, merge, mergeParts, normalizeUpload, placeParts, prepare, thumbnail, type Piece } from "./ops";
import type { Region } from "../types";

export type WorkerRequest =
  | { id: number; op: "normalize"; data: Uint8Array }
  | { id: number; op: "prepare"; parent?: Uint8Array; regions: Region[]; refs: Uint8Array[]; zoom?: boolean }
  | { id: number; op: "merge"; parent: Uint8Array; result: Uint8Array; mask: Uint8Array; annot?: Uint8Array; overall?: boolean }
  | { id: number; op: "mergeParts"; parent: Uint8Array; pieces: Piece[]; overall: boolean }
  | { id: number; op: "placeParts"; parent: Uint8Array; pieces: Pick<Piece, "box" | "result">[] }
  | { id: number; op: "thumb"; data: Uint8Array }
  | { id: number; op: "forApi"; data: Uint8Array; maxPixels?: number };

export type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { message: string; code?: string; params?: Record<string, string | number>; status?: number } };

async function run(req: WorkerRequest): Promise<{ value: unknown; transfer: ArrayBuffer[] }> {
  switch (req.op) {
    case "normalize": {
      const bytes = await normalizeUpload(browserCodec, req.data);
      return { value: bytes, transfer: [bytes.buffer as ArrayBuffer] };
    }
    case "prepare": {
      const out = await prepare(browserCodec, { parent: req.parent, regions: req.regions, refs: req.refs, zoom: req.zoom });
      return { value: out, transfer: [] };
    }
    case "merge": {
      const out = await merge(browserCodec, req);
      return { value: out, transfer: out.image ? [out.image.buffer as ArrayBuffer] : [] };
    }
    case "mergeParts": {
      const out = await mergeParts(browserCodec, req);
      const transfer = [out.merged, out.raw].filter((b): b is Uint8Array => !!b).map((b) => b.buffer as ArrayBuffer);
      return { value: out, transfer };
    }
    case "placeParts": {
      const bytes = await placeParts(browserCodec, req);
      return { value: bytes, transfer: [bytes.buffer as ArrayBuffer] };
    }
    case "thumb": {
      const out = await thumbnail(browserCodec, req.data);
      return { value: out, transfer: [out.bytes.buffer as ArrayBuffer] };
    }
    case "forApi": {
      const bytes = await forApi(browserCodec, req.data, req.maxPixels);
      return { value: bytes, transfer: [] };
    }
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    const { value, transfer } = await run(req);
    (self as unknown as Worker).postMessage({ id: req.id, ok: true, value } satisfies WorkerReply, transfer);
  } catch (err) {
    const x = err as { message?: string; code?: string; params?: Record<string, string | number>; status?: number };
    (self as unknown as Worker).postMessage({
      id: req.id,
      ok: false,
      error: { message: x.message ?? String(err), code: x.code, params: x.params, status: x.status },
    } satisfies WorkerReply);
  }
};
