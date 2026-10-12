// Calls to the OpenAI-compatible image API from the page: a port of promptbrush's
// create_image (retries with back-off, Retry-After, timeouts, b64 and url results).
// The values (retry policy, timeouts) come from generated/spec.json.

import { MIME, detectExt } from "../../imaging/formats";
import { spec } from "../spec";
import { checkSize } from "../sizes";

const H = spec.http;

/** The API reported a failure: a non-200 status, a body that isn't a JSON object, or an ``error`` field. */
export class ImageAPIError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }

  /** content moderation blocked the image (HTTP 451) */
  get moderated(): boolean {
    return this.status === 451;
  }
}

/** The request never got an answer: the connection failed, was refused (CORS included) or timed out. */
export class NetworkError extends Error {}

export interface Generation {
  images: Uint8Array[];
  usage: Record<string, number> | null;
  /** seconds, including retries */
  elapsed: number;
  /** images the API made but that couldn't be fetched (a url the page may not read), for the error to name */
  lost: string[];
}

export type LogFn = (level: string, msg: string) => void;

export interface CallOptions {
  apiKey: string;
  baseUrl: string;
  log?: LogFn;
  /** for tests: replaces fetch and sleep */
  fetch?: typeof fetch;
  sleep?: (seconds: number) => Promise<void>;
  signal?: AbortSignal;
}

const brief = (text: string, limit = 300) => {
  const t = text.trim().replace(/\n/g, " ");
  return t.length <= limit ? t : `${t.slice(0, limit)}…`;
};

const defaultSleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

function retryAfter(resp: Response): number {
  const v = Number(resp.headers.get("Retry-After") ?? 0);
  return Number.isFinite(v) ? Math.min(v, H.max_retry_after) : 0;
}

/** Back off and retry on a connection error, a timeout or a retryable status; the last response or error is returned/thrown. */
async function requestWithRetry(url: string, init: RequestInit, readTimeout: number, o: CallOptions): Promise<Response> {
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  const log = o.log ?? (() => {});
  let last: unknown;
  for (let attempt = 1; attempt <= H.max_retries; attempt++) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), (H.connect_timeout + readTimeout) * 1000);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout.signal]) : timeout.signal;
    try {
      const resp = await doFetch(url, { ...init, signal });
      if (H.retry_status.includes(resp.status) && attempt < H.max_retries) {
        const wait = Math.max(H.retry_backoff ** attempt, retryAfter(resp));
        log("retry", `HTTP ${resp.status}, retrying in ${wait.toFixed(0)}s (${attempt}/${H.max_retries - 1})`);
        await sleep(wait);
        continue;
      }
      // The body can stall too: read it inside the timeout, then hand over a finished response
      const body = await resp.arrayBuffer();
      return new Response(body, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      last = e;
      if (attempt < H.max_retries) {
        const wait = H.retry_backoff ** attempt;
        const kind = timeout.signal.aborted ? "Timeout" : "Connection error";
        log("retry", `${kind}, retrying in ${wait.toFixed(0)}s (${attempt}/${H.max_retries - 1})`);
        await sleep(wait);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  log("error", `Still failing after ${H.max_retries - 1} retries`);
  throw new NetworkError(last instanceof Error ? last.message : String(last));
}

type Part = { name: string; value: string | { data: Uint8Array; type: string; filename: string } };

const quote = (s: string) => s.replace(/[\r\n"]/g, (c) => ({ "\r": "%0D", "\n": "%0A", '"': "%22" })[c]!);

/**
 * A multipart/form-data body written by hand. FormData would turn every newline in a text field
 * into CRLF, so the model would be sent other bytes than the Python build sends; this keeps the
 * prompt exactly as compiled. Images stay Blobs, not copied into one buffer.
 */
export function multipart(parts: Part[]): { body: Blob; contentType: string } {
  const boundary = `----brushgraft${Array.from(crypto.getRandomValues(new Uint8Array(12)), (v) => v.toString(16).padStart(2, "0")).join("")}`;
  const text = new TextEncoder();
  const chunks: BlobPart[] = [];
  for (const { name, value } of parts) {
    if (typeof value === "string") {
      chunks.push(text.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n`), text.encode(value), "\r\n");
    } else {
      chunks.push(
        text.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"; filename="${quote(value.filename)}"\r\nContent-Type: ${value.type}\r\n\r\n`),
        value.data as BlobPart,
        "\r\n",
      );
    }
  }
  chunks.push(`--${boundary}--\r\n`);
  return { body: new Blob(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Every image of a response; one that can't be decoded or fetched is skipped on its own. */
async function decodeImages(result: Record<string, unknown>, o: CallOptions, lost: string[]): Promise<Uint8Array[]> {
  const log = o.log ?? (() => {});
  const items = result.data;
  if (!Array.isArray(items) || !items.length) {
    log("warn", "No image data received");
    return [];
  }
  const images: Uint8Array[] = [];
  for (const [k, item] of items.entries()) {
    const i = k + 1;
    let data: Uint8Array | null = null;
    try {
      const it = (item ?? {}) as { b64_json?: string; url?: string };
      if (typeof it.b64_json === "string" && it.b64_json) {
        data = b64(it.b64_json);
      } else if (typeof it.url === "string" && it.url) {
        log("info", `Downloading image: ${it.url}`);
        try {
          const resp = await requestWithRetry(it.url, { method: "GET" }, H.timeout_download, o);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          data = new Uint8Array(await resp.arrayBuffer());
        } catch (e) {
          lost.push(it.url);
          throw e;
        }
      }
    } catch (e) {
      log("error", `Failed to fetch image ${i}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (!data || !data.length) {
      log("warn", `Image ${i} has no usable data, skipping`);
      continue;
    }
    images.push(data);
  }
  return images;
}

/**
 * One single-image request. Without ``images`` it generates; with them it edits (the first is
 * the image being edited). Throws ImageAPIError when the API reports a failure and NetworkError
 * when the retries run out; a bad size or image throws before anything is sent.
 */
export async function createImage(
  prompt: string,
  p: { images?: Uint8Array[]; model: string; size: string },
  o: CallOptions,
): Promise<Generation> {
  const log = o.log ?? (() => {});
  if (!prompt.trim()) throw new Error("prompt must not be empty");
  const warning = checkSize(p.model, p.size);
  if (warning) log("warn", warning);

  const base = o.baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${o.apiKey}` };
  const images = p.images ?? [];
  let url: string;
  let init: RequestInit;
  let timeout: number;
  if (!images.length) {
    url = `${base}/images/generations`;
    init = {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model: p.model, prompt, n: 1, size: p.size }),
    };
    timeout = H.timeout_generate;
  } else {
    url = `${base}/images/edits`;
    const parts: { name: string; value: string | { data: Uint8Array; type: string; filename: string } }[] = [];
    images.forEach((data, k) => {
      const ext = detectExt(data);
      if (!ext) throw new Error(`Reference image ${k + 1} is not a PNG/JPEG/WebP/GIF image`);
      parts.push({ name: "image[]", value: { data, type: MIME[ext], filename: `image_${k + 1}${ext}` } });
    });
    parts.push({ name: "model", value: p.model }, { name: "prompt", value: prompt }, { name: "n", value: "1" }, { name: "size", value: p.size });
    const { body, contentType } = multipart(parts);
    init = { method: "POST", headers: { ...headers, "Content-Type": contentType }, body };
    timeout = H.timeout_edit;
  }

  const start = performance.now();
  const resp = await requestWithRetry(url, init, timeout, o);
  const elapsed = (performance.now() - start) / 1000;
  log("info", `Request finished in ${elapsed.toFixed(0)}s`);
  const text = await resp.text();
  if (resp.status !== 200) throw new ImageAPIError(`HTTP ${resp.status}: ${brief(text)}`, resp.status);
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    throw new ImageAPIError(`Response is not valid JSON: ${brief(text)}`, resp.status);
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new ImageAPIError(`Unexpected response format: ${brief(text)}`, resp.status);
  }
  const r = result as Record<string, unknown>;
  if (r.error) throw new ImageAPIError(`API returned an error: ${brief(typeof r.error === "string" ? r.error : JSON.stringify(r.error))}`, resp.status);

  let usage: Record<string, number> | null = null;
  if (typeof r.usage === "object" && r.usage !== null && !Array.isArray(r.usage)) {
    usage = r.usage as Record<string, number>;
    log("info", `Usage: total=${usage.total_tokens ?? "N/A"} input=${usage.input_tokens ?? "N/A"} output=${usage.output_tokens ?? "N/A"}`);
  }
  const lost: string[] = [];
  return { images: await decodeImages(r, o, lost), usage, elapsed, lost };
}

/** Ask the API whether the key and address work, without making an image: GET {base}/models. */
export async function testConnection(apiKey: string, baseUrl: string, o: Partial<CallOptions> = {}): Promise<void> {
  const doFetch = o.fetch ?? fetch;
  const signal = AbortSignal.timeout(15_000);
  let resp: Response;
  try {
    resp = await doFetch(`${baseUrl.replace(/\/+$/, "")}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  }
  if (!resp.ok) throw new ImageAPIError(`HTTP ${resp.status}: ${brief(await resp.text().catch(() => ""))}`, resp.status);
}
