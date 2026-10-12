// Validate and prepare requests, call the image API from the page, and write the results into
// the version tree: a port of brushgraft.jobs.JobRunner. Every step has the same order, error
// codes and log lines as the Python one, so the UI behaves the same in both modes.

import { sniff } from "../../imaging/formats";
import type { ImageOps } from "../../imaging/client";
import { sameAspect } from "../../imaging/pasteback";
import { ASSET_REF, type Job, type JobError, type LogLine, type Region, type ServerEvent, type TreeNode } from "../../types";
import { ApiError, userError } from "../errors";
import { charCount, compilePrompt } from "../prompts";
import { checkSize, fitSize, SIZE_PATTERN } from "../sizes";
import { spec } from "../spec";
import type { JobRequest } from "../types";
import { createImage, ImageAPIError, NetworkError, type LogFn } from "./imageapi";
import { isQuotaError, type BrowserStore } from "./store";

const LOG_LINES_PER_JOB = 200;
// Pasting back holds about 25 copies of the image's pixels in memory at once; above this a phone
// or a small laptop would run out, so the whole output is kept instead
const MAX_PASTE_PIXELS = 36_000_000;

// English log lines for job errors and paste-back notes (the UI shows the codes in the user's
// language elsewhere; the log is a raw trace)
const ERROR_LOG: Record<string, string> = {
  moderated: "Blocked by content moderation",
  prompt_too_long: "The API turned the prompt down as too long",
  api_error: "The API returned an error",
  network: "Network request failed",
  no_image: "The API returned no image",
  image_unreachable: "The image was made but this page can't download it",
  save_failed: "Couldn't save the result",
  storage_full: "The browser's storage is full",
  internal: "Internal error",
};
const NOTE_LOG: Record<string, string> = {
  [spec.notes.paste_failed]: "Pasting back failed; kept the model's whole output",
  [spec.notes.overall_change]: "The overall request changed the whole image; using the model's whole output (the pasted-back version is kept)",
  [spec.notes.reframed]: "The model redrew the scene (different framing); not pasted back",
  [spec.notes.spill_grown]: "New content went past the region; grew the paste-back area",
  [spec.notes.spill_too_large]: "New content spread too far; pasted back the region only",
};

interface Prepared {
  jobId: string;
  n: number;
  prompt: string;
  model: string;
  size: string;
  images: Uint8Array[];
  apiKey: string;
  baseUrl: string;
  /** the original, for pasting back */
  parent?: Uint8Array;
  mask?: Uint8Array;
  annot?: Uint8Array;
  /** the user wrote an overall request besides the regions */
  overall: boolean;
}

export interface RunnerDeps {
  store: BrowserStore;
  images: ImageOps;
  settings(): { apiKey: string; baseUrl: string };
  publish(ev: ServerEvent): void;
  /** who runs the jobs (this tab), so another tab can tell whether they are still alive */
  owner: string;
  /** called with the number of requests waiting or running whenever it changes */
  onActivity?(active: number): void;
  maxParallel?: number;
  fetch?: typeof fetch;
  sleep?: (seconds: number) => Promise<void>;
}

const error = (code: string, detail = "", variant = ""): JobError => ({ code, detail, variant });

// An API that turns a prompt down as too long answers 413, or (relays seen) 400/500 with text that
// says so: brushgraft.jobs._TOO_LONG
const TOO_LONG = /\binput_too_large\b|context_length|maximum context|too long|过长|超出.*长度/i;

function apiErrorCode(e: ImageAPIError): string {
  if (e.moderated) return "moderated";
  if (e.status === 413 || TOO_LONG.test(e.message)) return "prompt_too_long";
  return "api_error";
}

/** The few things the pydantic models check on the server, checked here the same way. */
function validate(b: JobRequest): void {
  const problems: string[] = [];
  // compilePrompt checks the length of what is sent; this only keeps an absurd body out
  if (charCount(b.prompt) > 4 * spec.max_prompt) problems.push("prompt: too long");
  if (b.regions.length > spec.max_regions) problems.push("regions: too many");
  if (b.refs.length > 8) problems.push("refs: too many");
  if (!(b.n >= 1 && b.n <= 4 && Number.isInteger(b.n))) problems.push("n: must be 1 to 4");
  if (b.model.length > 100) problems.push("model: too long");
  if ((b.size ?? "").length > 20) problems.push("size: too long");
  for (const r of b.regions) {
    if (!r.shapes.length || r.shapes.length > 200) problems.push("regions: a region needs 1 to 200 shapes");
    if (charCount(r.instruction) > 4 * spec.max_instruction) problems.push("regions: an instruction is too long");
  }
  if (problems.length) {
    const detail = problems.join("; ");
    throw new ApiError(detail, 422, "invalid_request", { detail });
  }
}

export class JobRunner {
  #logs = new Map<string, LogLine[]>();
  #pending = 0;
  #running = 0;
  #waiting: (() => void)[] = [];

  constructor(private deps: RunnerDeps) {}

  /** Requests queued or in flight. */
  get active(): number {
    return this.#pending;
  }

  logs(jobId: string): LogLine[] {
    return [...(this.#logs.get(jobId) ?? [])];
  }

  async submit(body: JobRequest): Promise<Job> {
    const { store } = this.deps;
    validate(body);
    await store.getProject(body.project_id);
    const { apiKey, baseUrl } = this.deps.settings();
    if (!apiKey) throw userError("api_key_missing", "No API key is configured; add one in Settings");
    const model = body.model.trim();
    if (!model) throw userError("model_required", "Choose a model");

    const parent = body.parent_id ? await store.getNode(body.parent_id) : null;
    if (parent && parent.project_id !== body.project_id) throw userError("cross_project", "Images must come from the same project");
    // A reference is an asset from the library (any project may use it), or a version of this project
    const refImages: string[] = [];
    for (const ref of body.refs) {
      if (ref.startsWith(ASSET_REF)) {
        refImages.push((await store.getAsset(ref.slice(ASSET_REF.length))).image);
        continue;
      }
      const node = await store.getNode(ref);
      if (node.project_id !== body.project_id) throw userError("cross_project", "Images must come from the same project");
      refImages.push(node.image);
    }
    const fullPrompt = compilePrompt(body.prompt, body.regions, { hasParent: !!parent, refCount: refImages.length, lang: body.lang });
    let size = body.size;
    if (parent) {
      // Edits keep the original's aspect ratio, so paste-back and comparison line up pixel for pixel
      size = size || fitSize(parent.width, parent.height);
    } else if (!size) {
      throw userError("size_required", "Choose a size");
    }
    if (!SIZE_PATTERN.test(size)) throw userError("size_format", `Size must look like 1536x1024 or auto, not '${size}'`, { size });
    checkSize(model, size);

    const regions: Region[] = parent ? body.regions : [];
    const parentBytes = parent ? new Uint8Array((await store.getImage(parent.image)).data) : undefined;
    const refBytes = await Promise.all(refImages.map(async (sha) => new Uint8Array((await store.getImage(sha)).data)));
    const prepared = await this.deps.images.prepare(parentBytes, regions, refBytes);
    const maskSha = prepared.mask ? (await store.putImage(prepared.mask)).sha : null;
    const annotSha = prepared.annot ? (await store.putImage(prepared.annot)).sha : null;

    const job = await store.createJob({
      project_id: body.project_id,
      parent_id: body.parent_id,
      kind: parent ? "edit" : "generate",
      prompt: body.prompt.trim(),
      full_prompt: fullPrompt,
      regions: body.regions,
      refs: [...body.refs],
      ref_images: refImages,
      model,
      size,
      n: body.n,
      composite: body.composite && body.regions.length > 0,
      mask_image: maskSha,
      annot_image: annotSha,
      owner: this.deps.owner,
    });
    const req: Prepared = {
      jobId: job.id, n: body.n, prompt: fullPrompt, model, size, images: prepared.images, apiKey, baseUrl,
      parent: parentBytes, mask: job.composite ? prepared.mask : undefined, annot: prepared.annot,
      overall: !!job.prompt,
    };
    this.#logs.set(job.id, []);
    this.deps.publish({ type: "job", job });
    this.#setPending(this.#pending + body.n);
    for (let k = 0; k < body.n; k++) void this.#schedule(() => this.#attempt(req, k));
    return job;
  }

  #setPending(n: number): void {
    this.#pending = n;
    this.deps.onActivity?.(n);
  }

  /** Run at most ``maxParallel`` requests at once, across all jobs (relays answer 429 when pushed). */
  #schedule(task: () => Promise<void>): Promise<void> {
    const max = this.deps.maxParallel ?? spec.http.max_parallel;
    return new Promise((resolve) => {
      const go = async () => {
        this.#running++;
        try {
          await task();
        } catch (e) {
          console.error(e); // an attempt records its own failures; this is a bug
        } finally {
          this.#running--;
          this.#setPending(this.#pending - 1);
          this.#waiting.shift()?.();
          resolve();
        }
      };
      if (this.#running < max) void go();
      else this.#waiting.push(() => void go());
    });
  }

  #log(jobId: string, level: string, msg: string): void {
    const line: LogLine = { t: Date.now() / 1000, level, msg };
    const list = this.#logs.get(jobId);
    if (list) {
      list.push(line);
      if (list.length > LOG_LINES_PER_JOB) list.splice(0, list.length - LOG_LINES_PER_JOB);
    }
    this.deps.publish({ type: "log", job_id: jobId, ...line });
  }

  async #attempt(req: Prepared, k: number): Promise<void> {
    const { store } = this.deps;
    try {
      this.deps.publish({ type: "job", job: await store.setJobRunning(req.jobId) });
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_found") return; // deleted while it waited
      throw e;
    }
    const variant = req.n > 1 ? `${k + 1}/${req.n}` : "";
    const tag = variant ? `[${variant}] ` : "";
    const log: LogFn = (level, msg) => this.#log(req.jobId, level, tag + msg);

    let gen: Awaited<ReturnType<typeof createImage>> | null = null;
    let err: JobError | null = null;
    const nodes: TreeNode[] = [];
    log("info", `Requesting ${req.model} at ${req.size}`);
    try {
      gen = await createImage(req.prompt, { images: req.images, model: req.model, size: req.size }, {
        apiKey: req.apiKey, baseUrl: req.baseUrl, log, fetch: this.deps.fetch, sleep: this.deps.sleep,
      });
    } catch (e) {
      if (e instanceof ImageAPIError) err = error(apiErrorCode(e), e.message, variant);
      else if (e instanceof NetworkError) err = error("network", networkDetail(e.message), variant);
      else if (e instanceof ApiError) err = error("api_error", e.message, variant);
      else err = error("internal", `${e instanceof Error ? e.name : "Error"}: ${e instanceof Error ? e.message : e}`, variant);
    }

    for (const data of gen?.images ?? []) {
      try {
        nodes.push(await this.#saveResult(req, data, log));
      } catch (e) {
        err = isQuotaError(e)
          ? error("storage_full", "", variant)
          : error("save_failed", `${e instanceof Error ? e.name : "Error"}: ${e instanceof Error ? e.message : e}`, variant);
      }
    }
    if (gen && !gen.images.length && !err) err = gen.lost.length ? error("image_unreachable", gen.lost[0], variant) : error("no_image", "", variant);
    if (err) log("error", `${ERROR_LOG[err.code]}${err.detail ? `: ${err.detail}` : ""}`);
    else log("ok", `Done in ${gen!.elapsed.toFixed(0)}s`);

    let job: Job;
    try {
      job = await store.recordAttempt(req.jobId, { ok: nodes.length > 0, error: err, usage: gen?.usage ?? null });
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_found") return; // the project was deleted meanwhile
      throw e;
    }
    for (const node of nodes) this.deps.publish({ type: "node", node });
    this.deps.publish({ type: "job", job });
  }

  async #saveResult(req: Prepared, data: Uint8Array, log: LogFn): Promise<TreeNode> {
    const { store, images } = this.deps;
    const job = await store.getJob(req.jobId);
    const common = { projectId: job.project_id, parentId: job.parent_id, jobId: job.id };
    const raw = (await store.putImage(data)).sha;
    if (!req.mask || !req.parent) return store.addNode({ image: raw, ...common });
    const original = sniff(req.parent)!;
    const result = sniff(data)!;
    if (!sameAspect([original.width, original.height], [result.width, result.height])) {
      log("warn", `Output is ${result.width}x${result.height}, a different aspect ratio from the original; not pasted back`);
      return store.addNode({ image: raw, note: spec.notes.aspect_mismatch, ...common });
    }
    let merged: Awaited<ReturnType<ImageOps["merge"]>>;
    try {
      if (original.width * original.height > MAX_PASTE_PIXELS) throw new Error("the image is too large for this browser");
      merged = await images.merge(req.parent, data, req.mask, req.annot, req.overall);
    } catch (e) {
      // the image is paid for: never lose it to a paste-back problem (memory, a damaged file)
      log("warn", `${NOTE_LOG[spec.notes.paste_failed]} (${e instanceof Error ? `${e.name}: ${e.message}` : e})`);
      return store.addNode({ image: raw, note: spec.notes.paste_failed, ...common });
    }
    if (merged.note) log(merged.image ? "info" : "warn", NOTE_LOG[merged.note]);
    if (!merged.image) return store.addNode({ image: raw, note: merged.note, ...common }); // the model redrew the scene
    const final = (await store.putImage(merged.image)).sha;
    if (merged.note === spec.notes.overall_change) {
      // adopt the whole output; the pasted-back one stays beside it
      return store.addNode({ image: raw, rawImage: raw, mergedImage: final, note: merged.note, ...common });
    }
    return store.addNode({ image: final, rawImage: raw, note: merged.note, ...common });
  }
}

/** A browser's "Failed to fetch" says nothing; point at the usual causes. */
function networkDetail(message: string): string {
  return /failed to fetch|load failed|networkerror/i.test(message)
    ? `${message}. Check the address in Settings, your connection, and that the service allows requests from web pages`
    : message;
}

export type { Region };
