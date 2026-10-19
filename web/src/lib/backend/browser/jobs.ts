// Validate and prepare requests, call the image API from the page, and write the results into
// the version tree: a port of brushgraft.jobs.JobRunner. Every step has the same order, error
// codes and log lines as the Python one, so the UI behaves the same in both modes.

import { sniff } from "../../imaging/formats";
import type { ImageOps } from "../../imaging/client";
import { sameAspect } from "../../imaging/pasteback";
import type { Merged, PartsMerged, PreparedPart } from "../../imaging/ops";
import { zoomSize } from "../../imaging/zoom";
import {
  ASSET_REF, type Job, type JobError, type LogLine, type NodePart, type Region, type SentRequest, type ServerEvent, type Shape, type TreeNode,
} from "../../types";
import { ApiError, userError } from "../errors";
import { charCount, compilePrompt, overallAppliesToWhole } from "../prompts";
import { checkSize, fitSize, SIZE_PATTERN } from "../sizes";
import { spec } from "../spec";
import type { JobRequest } from "../types";
import { createImage, ImageAPIError, NetworkError, type LogFn } from "./imageapi";
import { addUsage, isQuotaError, type BrowserStore } from "./store";

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
  [spec.notes.overall_change]: "Using the model's whole output, for the overall request (the pasted-back version is kept)",
  [spec.notes.reframed]: "The model redrew the scene (different framing); not pasted back",
  [spec.notes.spill_grown]: "New content went past the region; grew the paste-back area",
  [spec.notes.spill_too_large]: "New content spread too far; pasted back the region only",
  [spec.notes.part_failed]: "Some requests failed; their regions are left as they were",
  [spec.notes.too_large]: "Too large to paste back in this browser; kept the model's whole output",
};
const ASK_LOG: Record<string, string> = {
  unusable: "A close-up couldn't be pasted back; sending the whole image as well",
};

type Generation = Awaited<ReturnType<typeof createImage>>;

/** One request of an edit sent in parts: a close-up of some regions, or the whole image with all of them. */
interface Part extends PreparedPart {
  prompt: string;
  size: string;
  /** the annotated copy as stored */
  annotSha: string;
}

/** As job.requests lists it. */
const record = (p: Part): SentRequest => ({ prompt: p.prompt, box: p.box, regions: p.regions, size: p.size, annot_image: p.annotSha });

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
  /** the annotated copy as sent */
  annot?: Uint8Array;
  /** an overall request about the whole image (see overallAppliesToWhole) */
  overall: boolean;
  /**
   * A small edit of a large image goes in parts instead (each variant sends them all): the regions
   * in close-ups, and the whole image with every region when some are too large for one. ``whole``
   * makes that part; a close-up may call for it too (see mergeParts)
   */
  parts?: Part[];
  whole?: () => Promise<Part>;
  /**
   * With an overall request about the whole image, it goes first, alone, on the whole image, and
   * ``then`` the regions with instructions, in parts of its output (see #runFirst); with what they need
   */
  first?: { prompt: string; images: Uint8Array[] };
  then?: number[];
  regions: Region[];
  refs: Uint8Array[];
  lang: "en" | "zh";
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

/** The error a request ended with. */
function failure(e: unknown, variant: string): JobError {
  if (e instanceof ImageAPIError) return error(apiErrorCode(e), e.message, variant);
  if (e instanceof NetworkError) return error("network", e.message, variant);
  if (e instanceof ApiError) return error("api_error", e.message, variant);
  return error("internal", `${e instanceof Error ? e.name : "Error"}: ${e instanceof Error ? e.message : e}`, variant);
}

/** Usages summed (numbers only). */
const sumUsage = (usages: (Record<string, number> | null | undefined)[]): Record<string, number> | null =>
  usages.reduce<Record<string, number> | null>((total, u) => addUsage(total, u ?? null), null);

/** At most ``max`` tasks at once; the others wait their turn. */
class Slots {
  #running = 0;
  #waiting: (() => void)[] = [];

  constructor(private max: () => number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#running < this.max()) this.#running++;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve)); // its slot is handed over
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running--;
    }
  }
}

// An API that turns a prompt down as too long answers 413, or (relays seen) 400/500 with text that
// says so: brushgraft.jobs._TOO_LONG
const TOO_LONG = /\binput_too_large\b|context_length|maximum context|too long|过长|超出.*长度/i;

function apiErrorCode(e: ImageAPIError): string {
  if (e.moderated) return "moderated";
  if (e.code === spec.http.no_image) return "no_image";
  if (e.status === 413 || TOO_LONG.test(e.message)) return "prompt_too_long";
  return "api_error";
}

// Coordinates within spec.imaging.max_coord (false for NaN too); extents above zero
const coord = (v: number) => Math.abs(v) <= spec.imaging.max_coord;
const extent = (v: number, max = 2 * spec.imaging.max_coord) => v > 0 && v <= max;

function shapeOk(s: Shape): boolean {
  if (s.type === "rect" || s.type === "ellipse") return coord(s.x) && coord(s.y) && extent(s.w) && extent(s.h);
  const fewest = s.type === "lasso" ? 3 : 1;
  const pointsOk = s.points.length >= fewest && s.points.length <= 20000 && s.points.every(([x, y]) => coord(x) && coord(y));
  return pointsOk && (s.type === "lasso" || extent(s.radius, 4000));
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
    if (!r.shapes.length || r.shapes.length > spec.max_shapes) problems.push(`regions: a region needs 1 to ${spec.max_shapes} shapes`);
    if (charCount(r.instruction) > 4 * spec.max_instruction) problems.push("regions: an instruction is too long");
    if (!r.shapes.every(shapeOk)) problems.push("regions: a shape is out of range");
  }
  if (problems.length) {
    const detail = problems.join("; ");
    throw new ApiError(detail, 422, "invalid_request", { detail });
  }
}

export class JobRunner {
  #logs = new Map<string, LogLine[]>();
  #pending = 0;
  // Relay services answer 429 when pushed too hard: at most this many requests at once. A job's
  // variants take the first slots, the requests they send the second (an edit sent in parts sends
  // several at once)
  #variants = new Slots(() => this.deps.maxParallel ?? spec.http.max_parallel);
  #calls = new Slots(() => this.deps.maxParallel ?? spec.http.max_parallel);

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
    // the image edited and its annotated copy count too (a close-up's are as many): promptbrush.check_images
    const own = (parent ? 1 : 0) + (parent && body.regions.length ? 1 : 0);
    const limit = spec.models.find((m) => m.name === model)?.images;
    if (limit !== undefined && own + refImages.length > limit) {
      const most = Math.max(0, limit - own);
      throw userError("too_many_refs", `${model} takes at most ${most} reference images in this edit`, { model, max: most });
    }

    const regions: Region[] = parent ? body.regions : [];
    const parentBytes = parent ? new Uint8Array((await store.getImage(parent.image)).data) : undefined;
    const refBytes = await Promise.all(refImages.map(async (sha) => new Uint8Array((await store.getImage(sha)).data)));
    // A small edit of a large image goes in close-ups, to be pasted back within them: not for a
    // model that redraws the scene (nothing of its output is pasted back), nor when the whole
    // output is wanted, nor for an image too large to paste back in this browser
    const aligned = spec.models.find((m) => m.name === model)?.aligned ?? true;
    const zoom = body.composite && regions.length > 0 && aligned && !!parent && parent.width * parent.height <= MAX_PASTE_PIXELS;
    const overall = overallAppliesToWhole(body.prompt, regions);
    const prepared = await this.deps.images.prepare(parentBytes, regions, refBytes, { zoom, first: overall });
    const maskSha = prepared.mask ? (await store.putImage(prepared.mask)).sha : null;
    let annotSha = prepared.annot ? (await store.putImage(prepared.annot)).sha : null;
    const parts: Part[] = [];
    for (const p of prepared.parts ?? []) {
      const some = p.regions.map((i) => regions[i]);
      parts.push({
        ...p,
        prompt: p.box
          ? compilePrompt(body.prompt, some, { hasParent: true, refCount: refImages.length, lang: body.lang, numbers: p.regions })
          : fullPrompt,
        size: p.box ? zoomSize(p.box) : size,
        annotSha: (await store.putImage(p.annot)).sha,
      });
    }
    if (parts.length) annotSha = parts[0].annotSha;
    // the overall request first, alone (no annotated copy), then the regions with instructions
    const first = prepared.first ? { prompt: compilePrompt(body.prompt, [], { hasParent: true, refCount: refImages.length, lang: body.lang }), images: prepared.images } : undefined;

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
      requests: first ? [{ prompt: first.prompt, box: null, regions: [], size, annot_image: null }] : parts.map(record),
      owner: this.deps.owner,
    }, parent?.image);
    let whole: Promise<Part> | null = parts[0]?.box === null ? Promise.resolve(parts[0]) : null;
    const req: Prepared = {
      jobId: job.id, n: body.n, prompt: fullPrompt, model, size, images: prepared.images, apiKey, baseUrl,
      parent: parentBytes, mask: job.composite ? prepared.mask : undefined, annot: prepared.annot,
      overall,
      parts: parts.length ? parts : undefined,
      // the whole image, with every region, as an edit not sent in parts; made once
      whole: () => (whole ??= this.#wholePart(parentBytes!, regions, refBytes, fullPrompt, size)),
      first,
      then: first ? regions.flatMap((r, i) => (r.instruction?.trim() ? [i] : [])) : undefined,
      regions,
      refs: refBytes,
      lang: body.lang,
    };
    this.#logs.set(job.id, []);
    this.deps.publish({ type: "job", job });
    this.#setPending(this.#pending + body.n);
    for (let k = 0; k < body.n; k++) void this.#schedule(() => this.#attempt(req, k));
    return job;
  }

  async #wholePart(parent: Uint8Array, regions: Region[], refs: Uint8Array[], prompt: string, size: string): Promise<Part> {
    const p = await this.deps.images.prepare(parent, regions, refs);
    const annotSha = (await this.deps.store.putImage(p.annot!)).sha;
    return { box: null, regions: regions.map((_, i) => i), images: p.images, mask: p.mask!, annot: p.annot!, prompt, size, annotSha };
  }

  /** The requests for the regions ``req.then`` on ``base`` (the overall request's output): close-ups, or with ``wholeOnly`` the whole of it. */
  async #regionParts(req: Prepared, base: Uint8Array, wholeOnly = false): Promise<Part[]> {
    const p = await this.deps.images.prepare(base, req.regions, req.refs, { zoom: !wholeOnly, only: req.then });
    const parts: Part[] = [];
    for (const part of p.parts ?? []) {
      parts.push({
        ...part,
        prompt: compilePrompt("", part.regions.map((i) => req.regions[i]), { hasParent: true, refCount: req.refs.length, lang: req.lang, numbers: part.regions }),
        size: part.box ? zoomSize(part.box) : req.size,
        annotSha: (await this.deps.store.putImage(part.annot)).sha,
      });
    }
    return parts;
  }

  #setPending(n: number): void {
    this.#pending = n;
    this.deps.onActivity?.(n);
  }

  /** Run a job's variant when a slot is free. */
  async #schedule(task: () => Promise<void>): Promise<void> {
    try {
      await this.#variants.run(task);
    } catch (e) {
      console.error(e); // an attempt records its own failures; this is a bug
    } finally {
      this.#setPending(this.#pending - 1);
    }
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

    const started = Date.now();
    const { nodes, err, usage } = req.first
      ? await this.#runFirst(req, variant, log)
      : req.parts
        ? await this.#runParts(req, req.parts, variant, log)
        : await this.#runWhole(req, variant, log);
    if (err) log("error", `${ERROR_LOG[err.code]}${err.detail ? `: ${err.detail}` : ""}`);
    else log("ok", `Done in ${((Date.now() - started) / 1000).toFixed(0)}s`);

    let job: Job;
    try {
      job = await store.recordAttempt(req.jobId, { ok: nodes.length > 0, error: err, usage });
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_found") return; // the project was deleted meanwhile
      throw e;
    }
    for (const node of nodes) this.deps.publish({ type: "node", node });
    this.deps.publish({ type: "job", job });
  }

  /** Send one request when a slot is free (the cap holds across jobs). */
  #request(req: Prepared, prompt: string, images: Uint8Array[], size: string, log: LogFn, what = ""): Promise<Generation> {
    return this.#calls.run(() => {
      log("info", `Requesting ${req.model} at ${size}${what}`);
      return createImage(prompt, { images, model: req.model, size }, {
        apiKey: req.apiKey, baseUrl: req.baseUrl, log, fetch: this.deps.fetch, sleep: this.deps.sleep,
      });
    });
  }

  /** One request; its image (if it is an edit of regions) pasted back. */
  async #runWhole(req: Prepared, variant: string, log: LogFn): Promise<{ nodes: TreeNode[]; err: JobError | null; usage: Record<string, number> | null }> {
    let gen: Generation | null = null;
    let err: JobError | null = null;
    const nodes: TreeNode[] = [];
    try {
      gen = await this.#request(req, req.prompt, req.images, req.size, log);
    } catch (e) {
      err = failure(e, variant);
    }
    for (const data of gen?.images ?? []) {
      try {
        nodes.push(await this.#saveResult(req, data, log));
      } catch (e) {
        err = this.#saveError(e, variant);
      }
    }
    if (gen && !gen.images.length && !err) err = gen.lost.length ? error("image_unreachable", gen.lost[0], variant) : error("no_image", "", variant);
    return { nodes, err, usage: gen?.usage ?? null };
  }

  #saveError(e: unknown, variant: string): JobError {
    return isQuotaError(e)
      ? error("storage_full", "", variant)
      : error("save_failed", `${e instanceof Error ? e.name : "Error"}: ${e instanceof Error ? e.message : e}`, variant);
  }

  async #saveResult(req: Prepared, data: Uint8Array, log: LogFn): Promise<TreeNode> {
    const { store, images } = this.deps;
    const job = await store.getJob(req.jobId);
    const common = { projectId: job.project_id, parentId: job.parent_id, jobId: job.id };
    const raw = (await store.putImage(data)).sha;
    if (!req.mask || !req.parent) return store.addNode({ image: raw, ...common });
    const original = sniff(req.parent);
    const result = sniff(data);
    if (!original || !result) {
      // the image is paid for: kept as it came
      log("warn", NOTE_LOG[spec.notes.paste_failed]);
      return store.addNode({ image: raw, note: spec.notes.paste_failed, ...common });
    }
    if (!sameAspect([original.width, original.height], [result.width, result.height])) {
      log("warn", `Output is ${result.width}x${result.height}, a different aspect ratio from the original; not pasted back`);
      return store.addNode({ image: raw, note: spec.notes.aspect_mismatch, ...common });
    }
    if (original.width * original.height > MAX_PASTE_PIXELS) {
      log("warn", NOTE_LOG[spec.notes.too_large]);
      return store.addNode({ image: raw, note: spec.notes.too_large, ...common });
    }
    let merged: Awaited<ReturnType<ImageOps["merge"]>>;
    try {
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

  /**
   * The overall request alone on the whole image, then the regions with instructions in close-ups of
   * its output, pasted back onto it: one version (jobs._run_first). Its output takes the regions only
   * if it keeps the original's framing; if not, or if none of the regions come back, it is the
   * version as it is.
   */
  async #runFirst(req: Prepared, variant: string, log: LogFn): Promise<{ nodes: TreeNode[]; err: JobError | null; usage: Record<string, number> | null }> {
    const { store, images } = this.deps;
    const sent = await this.#sendParts(req, [{ box: null, regions: [], images: req.first!.images, mask: req.mask!, annot: new Uint8Array(), prompt: req.first!.prompt, size: req.size, annotSha: "" }], variant, log);
    const data = sent.outputs[0];
    const usage0 = sumUsage(sent.usages);
    if (!data) return { nodes: [], err: sent.err, usage: usage0 };
    let based: Merged;
    try {
      based = await images.firstBase(req.parent!, data, req.mask!);
    } catch (e) {
      // the image is paid for: kept as it came
      log("warn", `${NOTE_LOG[spec.notes.paste_failed]} (${e instanceof Error ? `${e.name}: ${e.message}` : e})`);
      based = { image: null, note: spec.notes.paste_failed };
    }
    if (!based.image) {
      const why = NOTE_LOG[based.note] ?? "The output has a different aspect ratio from the original";
      log("warn", `${why}; the regions can't be put on it, so it is used as it is`);
      try {
        return { nodes: [await this.#addNode(req, { image: (await store.putImage(data)).sha, note: based.note })], err: null, usage: usage0 };
      } catch (e) {
        return { nodes: [], err: this.#saveError(e, variant), usage: usage0 };
      }
    }
    const base = based.image;
    let baseSha: string;
    let parts: Part[];
    const numbers: number[] = [];
    try {
      baseSha = (await store.putImage(base)).sha;
      log("info", "Sending the regions with instructions, on the overall request's output");
      parts = await this.#regionParts(req, base);
      // gone: the project was deleted meanwhile
      for (const part of parts) numbers.push(await store.addJobRequest(req.jobId, record(part)).catch(() => numbers.length + 1));
    } catch (e) {
      return { nodes: [], err: this.#saveError(e, variant), usage: usage0 };
    }
    const firstMade: NodePart = { request: 0, note: "", usage: usage0, raw_image: baseSha, raw_at: [0, 0], merged_image: baseSha, merged_at: [0, 0] };
    let whole: Promise<Part> | null = null;
    const then: Prepared = { ...req, parent: base, overall: false, parts, first: undefined, whole: () => (whole ??= this.#regionParts(req, base, true).then((p) => p[0])) };
    const done = await this.#runParts(then, parts, variant, log, numbers, firstMade);
    const usage = addUsage(usage0, done.usage);
    if (done.nodes.length) return { ...done, usage };
    // none of the regions came back: the overall request's output as it is
    log("warn", NOTE_LOG[spec.notes.part_failed]);
    try {
      return { nodes: [await this.#addNode(req, { image: baseSha, note: spec.notes.part_failed })], err: done.err, usage };
    } catch (e) {
      return { nodes: [], err: this.#saveError(e, variant), usage };
    }
  }

  /**
   * The parts of an edit, all at once (and the whole image after them if a close-up calls for it), put back together into one version.
   * ``numbers``: each part's place in the job's requests (by default, from 0); ``first``: what the overall request made, before them.
   */
  async #runParts(
    req: Prepared,
    planned: Part[],
    variant: string,
    log: LogFn,
    placed?: number[],
    first?: NodePart,
  ): Promise<{ nodes: TreeNode[]; err: JobError | null; usage: Record<string, number> | null }> {
    const { store, images } = this.deps;
    let parts = planned;
    // each part's place in the job's requests
    let numbers = placed ?? planned.map((_, i) => i);
    const sent = await this.#sendParts(req, parts, variant, log);
    let { outputs, usages, err } = sent;
    let usage = sumUsage(usages);
    // when some fail, the others (paid for) still make the version, with their regions only
    if (!outputs.some(Boolean)) return { nodes: [], err, usage };
    const back = () => parts.flatMap((p, i) => (outputs[i] ? [i] : []));
    const pieces = () => back().map((i) => ({ box: parts[i].box, result: outputs[i]!, mask: parts[i].mask, annot: parts[i].annot }));
    let done: PartsMerged;
    try {
      done = await images.mergeParts(req.parent!, pieces(), req.overall, !err);
      if (done.ask) {
        log("info", ASK_LOG[done.ask]);
        const part = await req.whole!();
        // gone: the project was deleted meanwhile
        const k = await store.addJobRequest(req.jobId, record(part)).catch(() => parts.length);
        const more = await this.#sendParts(req, [part], variant, log);
        usage = addUsage(usage, sumUsage(more.usages));
        err = more.err;
        parts = [...parts, part];
        numbers = [...numbers, k];
        outputs = [...outputs, ...more.outputs];
        usages = [...usages, ...more.usages];
        done = await images.mergeParts(req.parent!, pieces(), req.overall, false);
      }
    } catch (e) {
      // the images are paid for: never lose them to a paste-back problem (memory, a damaged file)
      log("warn", `${NOTE_LOG[spec.notes.paste_failed]} (${e instanceof Error ? `${e.name}: ${e.message}` : e})`);
      try {
        const image = (await store.putImage(await images.placeParts(req.parent!, pieces()))).sha;
        return { nodes: [await this.#addNode(req, { image, note: spec.notes.paste_failed })], err, usage };
      } catch (e2) {
        return { nodes: [], err: this.#saveError(e2, variant), usage };
      }
    }
    if (err) done.note = spec.notes.part_failed;
    try {
      const kept = back();
      const made = await this.#partRecords(done, kept.map((i) => numbers[i]), kept.map((i) => usages[i]), first);
      return { nodes: [await this.#saveParts(req, done, kept.map((i) => parts[i]), kept.map((i) => outputs[i]!), made, log)], err, usage };
    } catch (e) {
      return { nodes: [], err: this.#saveError(e, variant), usage };
    }
  }

  /** Send ``parts`` at once: each one's image (null where it failed), each one's usage, the first error. */
  async #sendParts(
    req: Prepared,
    parts: Part[],
    variant: string,
    log: LogFn,
  ): Promise<{ outputs: (Uint8Array | null)[]; usages: (Record<string, number> | null)[]; err: JobError | null }> {
    const results = await Promise.allSettled(
      parts.map((part, i) => {
        const label = parts.length > 1 ? `Request ${i + 1}/${parts.length}: ` : "";
        let what = " (the whole image)";
        if (part.box) {
          const [x0, y0, x1, y1] = part.box;
          what = ` (regions ${part.regions.map((k) => k + 1).join(", ")}, a close-up of ${x1 - x0}x${y1 - y0} at (${x0}, ${y0}))`;
        }
        return this.#request(req, part.prompt, part.images, part.size, (level, msg) => log(level, label + msg), what);
      }),
    );
    const outputs: (Uint8Array | null)[] = [];
    const usages: (Record<string, number> | null)[] = [];
    let err: JobError | null = null;
    for (const r of results) {
      if (r.status === "rejected") {
        err ??= failure(r.reason, variant);
        outputs.push(null);
        usages.push(null);
        continue;
      }
      usages.push(r.value.usage ?? null);
      outputs.push(r.value.images[0] ?? null);
      if (!r.value.images.length) err ??= r.value.lost.length ? error("image_unreachable", r.value.lost[0], variant) : error("no_image", "", variant);
    }
    return { outputs, usages, err };
  }

  /** What each request made on its own, as a version records it (none for a single request); ``first`` before them. */
  async #partRecords(done: PartsMerged, numbers: number[], usages: (Record<string, number> | null)[], first?: NodePart): Promise<NodePart[]> {
    const made = done.parts ?? [];
    if (made.length + (first ? 1 : 0) < 2) return [];
    const { store } = this.deps;
    const out: NodePart[] = first ? [first] : [];
    for (const [i, p] of made.entries()) {
      out.push({
        request: numbers[i],
        note: p.note,
        usage: sumUsage([usages[i]]),
        raw_image: (await store.putImage(p.raw)).sha,
        raw_at: p.rawAt,
        merged_image: p.merged ? (await store.putImage(p.merged)).sha : null,
        merged_at: p.merged ? p.mergedAt : null,
      });
    }
    return out;
  }

  async #saveParts(req: Prepared, done: PartsMerged, parts: Part[], outputs: Uint8Array[], made: NodePart[], log: LogFn): Promise<TreeNode> {
    const { store } = this.deps;
    const note = done.note;
    if (!done.merged) {
      // the whole image's output can't be pasted back: use it
      const data = outputs[parts.findIndex((p) => p.box === null)];
      log("warn", note === spec.notes.aspect_mismatch ? "The whole image's output has a different aspect ratio from the original; not pasted back" : NOTE_LOG[note]);
      return this.#addNode(req, { image: (await store.putImage(data)).sha, note, parts: made });
    }
    if (note) log("info", NOTE_LOG[note]);
    const raw = (await store.putImage(done.raw!)).sha;
    const final = (await store.putImage(done.merged)).sha;
    if (note === spec.notes.overall_change) {
      // adopt the whole output; the pasted-back one stays beside it
      return this.#addNode(req, { image: raw, rawImage: raw, mergedImage: final, note, parts: made });
    }
    return this.#addNode(req, { image: final, rawImage: raw, note, parts: made });
  }

  async #addNode(req: Prepared, fields: { image: string; rawImage?: string; mergedImage?: string; note?: string; parts?: NodePart[] }): Promise<TreeNode> {
    const job = await this.deps.store.getJob(req.jobId);
    return this.deps.store.addNode({ projectId: job.project_id, parentId: job.parent_id, jobId: job.id, ...fields });
  }
}

export type { Region };
