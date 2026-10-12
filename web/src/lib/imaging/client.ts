// The page's handle on the image Worker: the same operations as ops.ts, run off-thread.

import { ApiError } from "../backend/errors";
import type { Region } from "../types";
import type { Merged, Prepared } from "./ops";
import type { WorkerReply, WorkerRequest } from "./worker";

type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;

/** What the backend needs done to images; ImageWorker does it off-thread, tests do it in place. */
export interface ImageOps {
  normalize(data: Uint8Array): Promise<Uint8Array>;
  prepare(parent: Uint8Array | undefined, regions: Region[], refs: Uint8Array[]): Promise<Prepared>;
  merge(parent: Uint8Array, result: Uint8Array, mask: Uint8Array, annot?: Uint8Array, overall?: boolean): Promise<Merged>;
  thumb(data: Uint8Array): Promise<{ bytes: Uint8Array; type: string }>;
}

export class ImageWorker implements ImageOps {
  #worker: Worker | null = null;
  #next = 1;
  #pending = new Map<number, { resolve: (v: never) => void; reject: (e: unknown) => void }>();

  #send<T>(req: Distribute<WorkerRequest>): Promise<T> {
    if (!this.#worker) {
      this.#worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
      this.#worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        const p = this.#pending.get(e.data.id);
        if (!p) return;
        this.#pending.delete(e.data.id);
        if (e.data.ok) p.resolve(e.data.value as never);
        else p.reject(new ApiError(e.data.error.message, e.data.error.status ?? 400, e.data.error.code ?? "", e.data.error.params ?? {}));
      };
      this.#worker.onerror = (e) => {
        for (const p of this.#pending.values()) p.reject(new Error(e.message || "The image worker stopped"));
        this.#pending.clear();
        this.#worker = null;
      };
    }
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.#worker!.postMessage({ ...req, id });
    });
  }

  normalize = (data: Uint8Array) => this.#send<Uint8Array>({ op: "normalize", data });
  prepare = (parent: Uint8Array | undefined, regions: Region[], refs: Uint8Array[]) =>
    this.#send<Prepared>({ op: "prepare", parent, regions, refs });
  merge = (parent: Uint8Array, result: Uint8Array, mask: Uint8Array, annot?: Uint8Array, overall?: boolean) =>
    this.#send<Merged>({ op: "merge", parent, result, mask, annot, overall });
  thumb = (data: Uint8Array) => this.#send<{ bytes: Uint8Array; type: string }>({ op: "thumb", data });
}
