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
    /** the body's error.code, when it has one */
    readonly code = "",
  ) {
    super(message);
    this.name = "ImageAPIError";
  }

  /** content moderation blocked the image: HTTP 451 (relays), or an error code saying so (OpenAI: 400 moderation_blocked) */
  get moderated(): boolean {
    return this.status === 451 || H.moderation_codes.includes(this.code);
  }
}

/** The ``error.code`` of an OpenAI-style error body, or "". */
function errorCode(body: unknown): string {
  const error = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : null;
  return typeof code === "string" ? code : "";
}

/** The request never got an answer: the connection failed, was refused (CORS included) or timed out. */
export class NetworkError extends Error {
  override name = "NetworkError";
}

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

/** The Retry-After header, in seconds or as an HTTP date, capped at max_retry_after; 0 if missing or unparsable. */
export function retryAfter(resp: Response, now = Date.now()): number {
  const value = (resp.headers.get("Retry-After") ?? "").trim();
  if (!value) return 0;
  const seconds = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0), H.max_retry_after) : 0;
}

/**
 * Back off and retry on a connection error, a timeout or a retryable status, as promptbrush's
 * request_with_retry: a POST (paid for) is sent again freely only when it was refused before any
 * work began (safe_retry_status), else at most uncertain_retries times (a page can't tell a
 * connection never made from one dropped after the request went out, so a network error counts as
 * uncertain); an exhausted quota isn't retried. The last response or error is returned/thrown.
 */
async function requestWithRetry(url: string, init: RequestInit, readTimeout: number, o: CallOptions): Promise<Response> {
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  const log = o.log ?? (() => {});
  const paid = (init.method ?? "GET").toUpperCase() === "POST";
  let uncertain = 0;
  const jitter = () => (o.sleep ? 0 : Math.random()); // none in tests, which check the waits
  for (let attempt = 1; attempt <= H.max_retries; attempt++) {
    let retry = attempt < H.max_retries;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), (H.connect_timeout + readTimeout) * 1000);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout.signal]) : timeout.signal;
    try {
      const resp = await doFetch(url, { ...init, signal });
      // The body can stall too: read it inside the timeout, then hand over a finished response
      const body = await resp.arrayBuffer();
      const done = new Response(body, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
      if (!H.retry_status.includes(resp.status) || !retry) return done;
      if (resp.status === 429 && H.quota_codes.includes(errorCode(jsonOf(body)))) return done;
      if (paid && !H.safe_retry_status.includes(resp.status) && ++uncertain > H.uncertain_retries) return done;
      const wait = Math.max(H.retry_backoff ** attempt, retryAfter(resp)) + jitter();
      log("retry", `HTTP ${resp.status}, retrying in ${wait.toFixed(0)}s (${attempt}/${H.max_retries - 1})`);
      await sleep(wait);
    } catch (e) {
      if (o.signal?.aborted) throw e;
      const last = timeout.signal.aborted ? new Error(`Timed out after ${H.connect_timeout + readTimeout}s`) : e;
      if (paid) retry = retry && ++uncertain <= H.uncertain_retries;
      if (!retry) {
        log("error", `Request failed: ${last instanceof Error ? last.message : String(last)}`);
        throw new NetworkError(last instanceof Error ? last.message : String(last));
      }
      const wait = H.retry_backoff ** attempt + jitter();
      const kind = timeout.signal.aborted ? "Timeout" : "Connection error";
      log("retry", `${kind}, retrying in ${wait.toFixed(0)}s (${attempt}/${H.max_retries - 1})`);
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("unreachable");
}

/** The JSON in a response body, or null. */
function jsonOf(body: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
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
        if (!/^https?:\/\//i.test(it.url)) throw new Error("not an http(s) link");
        // the link without its query: a signed link's signature stays out of the log
        log("info", `Downloading image: ${it.url.split("?")[0]}`);
        try {
          const resp = await requestWithRetry(it.url, { method: "GET" }, H.timeout_download, o);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          data = new Uint8Array(await resp.arrayBuffer());
          if (data.length > H.max_download_bytes) throw new Error(`too large (${data.length.toLocaleString("en")} bytes)`);
        } catch (e) {
          lost.push(it.url);
          throw e;
        }
      }
      // what an expired link or a relay's error page answers with, rather than an image
      if (data && !detectExt(data)) throw new Error(`not an image (${data.length.toLocaleString("en")} bytes)`);
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
  let result: unknown = null;
  let parsed = true;
  try {
    result = JSON.parse(text);
  } catch {
    parsed = false;
  }
  if (resp.status !== 200) throw new ImageAPIError(`HTTP ${resp.status}: ${brief(text)}`, resp.status, errorCode(result));
  if (!parsed) throw new ImageAPIError(`Response is not valid JSON: ${brief(text)}`, resp.status);
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new ImageAPIError(`Unexpected response format: ${brief(text)}`, resp.status);
  }
  const r = result as Record<string, unknown>;
  if (r.error) {
    throw new ImageAPIError(`API returned an error: ${brief(typeof r.error === "string" ? r.error : JSON.stringify(r.error))}`, resp.status, errorCode(r));
  }
  // often a relay's own error, in a shape of its own ({"code": 1001, "msg": ...})
  if (!Array.isArray(r.data) || !r.data.length) throw new ImageAPIError(`No image in the response: ${brief(text)}`, resp.status, H.no_image);

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
  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new ImageAPIError(`HTTP ${resp.status}: ${brief(text)}`, resp.status);
  try {
    JSON.parse(text);
  } catch {
    throw new ImageAPIError(`Response is not valid JSON: ${brief(text)}`, resp.status);
  }
}
