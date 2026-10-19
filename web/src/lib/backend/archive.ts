// A project as one .zip: project.json (versions and how each was made) plus images/<sha256>.<ext>;
// and the asset library as one: assets.json plus the same images/.
// The local server (brushgraft/archive.py) and the browser build read and write the same file, so a
// project moves between them. A file from outside is untrusted: it is checked field by field, every
// image must hash to its name, and the sizes are bounded before anything is unpacked.

import { Zip, ZipPassThrough, unzipSync } from "fflate";
import { detectExt, sniff } from "../imaging/formats";
import type { Job, JobError, Project, Region, SentRequest, ShapeOp, TreeNode } from "../types";
import { ApiError, userError } from "./errors";
import { charCount } from "./prompts";
import { spec } from "./spec";

const A = spec.archive;
const MAX_COORD = spec.imaging.max_coord;

export interface ArchiveContent {
  project: Pick<Project, "name" | "created_at" | "updated_at">;
  nodes: Omit<TreeNode, "project_id" | "width" | "height">[];
  jobs: Omit<Job, "project_id">[];
  /** sha → bytes, for every image the nodes and jobs refer to */
  images: Map<string, Uint8Array>;
}

const SHA = /^[0-9a-f]{64}$/;
const ID = /^[\w-]{1,64}$/;
const REF = /^(asset:)?[\w-]{1,64}$/;

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------
/** A zip of ``name`` (the manifest) and images/ as a Blob, built in pieces so a large one isn't held twice in memory. */
function writeZip(name: string, manifest: unknown, images: Map<string, Uint8Array>, time: number): Blob {
  const parts: BlobPart[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) failure = err;
    else parts.push(chunk as BlobPart);
  });
  const add = (file: string, data: Uint8Array, mtime: number) => {
    const entry = new ZipPassThrough(file);
    entry.mtime = mtime;
    zip.add(entry);
    entry.push(data, true);
  };
  // zip dates run from 1980 to 2099; the real times are in the manifest
  const when = Math.min(Math.max(Math.round(time * 1000), Date.UTC(1980, 0, 2)), Date.UTC(2099, 0, 1));
  add(name, new TextEncoder().encode(JSON.stringify(manifest, null, 1)), when);
  for (const [sha, data] of images) add(`images/${sha}${detectExt(data) ?? ""}`, data, when);
  zip.end();
  if (failure) throw failure;
  return new Blob(parts, { type: "application/zip" });
}

/** The project file as a Blob. */
export function writeArchive(content: ArchiveContent, appVersion = spec.version): Blob {
  const manifest = {
    format: A.format,
    version: A.version,
    exported_by: `brushgraft ${appVersion}`,
    project: content.project,
    nodes: content.nodes,
    jobs: content.jobs,
  };
  return writeZip("project.json", manifest, content.images, content.project.updated_at);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
const bad = (detail: string) => userError("bad_archive", `This isn't a brushgraft project file: ${detail}`, { detail });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, what: string, max: number, optional = false): string => {
  if (optional && (v === undefined || v === null)) return "";
  if (typeof v !== "string" || charCount(v) > max) throw bad(`${what} is not text`);
  return v;
};
// not Math.abs(v) <= limit fails NaN too
const num = (v: unknown, what: string, limit = 1e15): number => {
  if (typeof v !== "number" || !(Math.abs(v) <= limit)) throw bad(`${what} is not a number`);
  return v;
};
const sha = (v: unknown, what: string, optional = false): string | null => {
  if (optional && (v === undefined || v === null)) return null;
  if (typeof v !== "string" || !SHA.test(v)) throw bad(`${what} is not an image hash`);
  return v;
};
const id = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !ID.test(v)) throw bad(`${what} is not an id`);
  return v;
};
const optId = (v: unknown, what: string): string | null => (v === undefined || v === null ? null : id(v, what));

function region(v: unknown): Region {
  if (!isObject(v) || !Array.isArray(v.shapes) || v.shapes.length < 1 || v.shapes.length > spec.max_shapes) throw bad("a region is malformed");
  const pts = (p: unknown, min: number): [number, number][] => {
    if (!Array.isArray(p) || p.length < min || p.length > 20000) throw bad("a shape has the wrong number of points");
    return p.map((q) => {
      if (!Array.isArray(q) || q.length !== 2) throw bad("a point is malformed");
      return [num(q[0], "x", MAX_COORD), num(q[1], "y", MAX_COORD)];
    });
  };
  const shapes = v.shapes.map((s): Region["shapes"][number] => {
    if (!isObject(s)) throw bad("a shape is malformed");
    // kept only when given, so a file reads back exactly as it was written
    const op = "op" in s ? { op: s.op as ShapeOp } : {};
    if ("op" in s && s.op !== "add" && s.op !== "subtract" && s.op !== "intersect") throw bad("a shape has an unknown operation");
    if (s.type === "rect" || s.type === "ellipse") {
      const [w, h] = [num(s.w, "w", 2 * MAX_COORD), num(s.h, "h", 2 * MAX_COORD)];
      if (w <= 0 || h <= 0) throw bad("a rectangle is empty");
      return { type: s.type, x: num(s.x, "x", MAX_COORD), y: num(s.y, "y", MAX_COORD), w, h, ...op };
    }
    if (s.type === "lasso") return { type: "lasso", points: pts(s.points, 3), ...op };
    if (s.type === "brush") {
      const radius = num(s.radius, "radius");
      if (radius <= 0 || radius > 4000) throw bad("a brush radius is out of range");
      return { type: "brush", points: pts(s.points, 1), radius, ...op };
    }
    throw bad("a shape has an unknown type");
  });
  return { shapes, instruction: str(v.instruction, "an instruction", spec.max_instruction, true) };
}

function jobError(v: unknown): JobError | string {
  if (typeof v === "string") return v.slice(0, 2000);
  if (!isObject(v)) throw bad("an error entry is malformed");
  return { code: str(v.code, "an error code", 64), detail: str(v.detail, "an error detail", 5000, true), variant: str(v.variant, "a variant", 20, true) };
}

/** Check a project.json and return it in the shape the stores take. Throws bad_archive. */
function sentRequest(r: unknown): SentRequest {
  const box = isObject(r) ? r.box : 0;
  if (!isObject(r) || (box !== null && (!Array.isArray(box) || box.length !== 4))) throw bad("a request is malformed");
  return {
    prompt: str(r.prompt, "a prompt sent", spec.max_full_prompt),
    box: box === null ? null : (box.map((v) => Math.trunc(num(v, "a close-up", spec.imaging.max_coord))) as SentRequest["box"]),
    size: str(r.size, "a size", 20, true),
    annot_image: sha(r.annot_image, "an annotated image", true),
  };
}

export function parseManifest(raw: unknown): Omit<ArchiveContent, "images"> {
  if (!isObject(raw) || raw.format !== A.format) throw bad("project.json is missing or has another format");
  if (typeof raw.version !== "number" || raw.version > A.version) {
    throw userError("archive_newer", "This project file was made by a newer brushgraft; upgrade to open it");
  }
  if (!isObject(raw.project) || !Array.isArray(raw.nodes) || !Array.isArray(raw.jobs)) throw bad("project.json is incomplete");
  if (raw.nodes.length > A.max_nodes || raw.jobs.length > A.max_nodes) throw bad("it has too many versions");

  const p = raw.project;
  const project = { name: str(p.name, "the project name", 100).trim() || "Untitled", created_at: num(p.created_at, "created_at"), updated_at: num(p.updated_at, "updated_at") };

  const nodes = raw.nodes.map((n): ArchiveContent["nodes"][number] => {
    if (!isObject(n)) throw bad("a version is malformed");
    return {
      id: id(n.id, "a version id"),
      parent_id: optId(n.parent_id, "a parent id"),
      job_id: optId(n.job_id, "a job id"),
      image: sha(n.image, "a version's image")!,
      raw_image: sha(n.raw_image, "a raw image", true),
      merged_image: sha(n.merged_image, "a merged image", true),
      note: str(n.note, "a note", 64, true),
      label: str(n.label, "a label", 200, true),
      starred: n.starred === true,
      created_at: num(n.created_at, "a version's time"),
    };
  });
  const jobs = raw.jobs.map((j): ArchiveContent["jobs"][number] => {
    if (!isObject(j)) throw bad("a job is malformed");
    if (j.kind !== "generate" && j.kind !== "edit") throw bad("a job has an unknown kind");
    if (!Array.isArray(j.regions) || j.regions.length > spec.max_regions) throw bad("a job has too many regions");
    if (!Array.isArray(j.refs) || j.refs.length > 8) throw bad("a job has too many references");
    const refImages = j.ref_images;
    if (refImages !== undefined && refImages !== null && (!Array.isArray(refImages) || refImages.length !== j.refs.length)) {
      throw bad("a job's reference images don't match its references");
    }
    const requests = j.requests ?? []; // not in files from before edits were sent in parts
    if (!Array.isArray(requests) || requests.length > spec.max_regions + 1) throw bad("a job has too many requests");
    const n = num(j.n, "a job's count");
    if (!Number.isInteger(n) || n < 1 || n > 4) throw bad("a job's count is out of range");
    const errors = Array.isArray(j.errors) ? j.errors.slice(0, 50).map(jobError) : [];
    let usage: Record<string, number> | null = null;
    if (isObject(j.usage)) {
      const kept = Object.entries(j.usage).filter(([, v]) => typeof v === "number" && Math.abs(v) <= 2 ** 53);
      usage = Object.fromEntries(kept) as Record<string, number>;
    }
    const status = ["queued", "running", "done", "failed"].includes(j.status as string) ? (j.status as Job["status"]) : "failed";
    return {
      id: id(j.id, "a job id"),
      parent_id: optId(j.parent_id, "a job's parent"),
      kind: j.kind,
      prompt: str(j.prompt, "a prompt", spec.max_prompt, true),
      full_prompt: str(j.full_prompt, "a full prompt", spec.max_full_prompt, true),
      regions: j.regions.map(region),
      refs: j.refs.map((r) => {
        if (typeof r !== "string" || !REF.test(r)) throw bad("a reference is not an id");
        return r;
      }),
      // null in a version 1 file: filled in below from the versions
      ref_images: Array.isArray(refImages) ? refImages.map((s) => sha(s, "a reference's image", true)) : (null as unknown as (string | null)[]),
      model: str(j.model, "a model", 100),
      size: str(j.size, "a size", 20, true),
      n,
      composite: j.composite === true,
      mask_image: sha(j.mask_image, "a mask", true),
      annot_image: sha(j.annot_image, "an annotated image", true),
      requests: requests.map(sentRequest),
      status,
      done: Math.min(n, Math.max(0, Math.trunc(num(j.done ?? 0, "done")))),
      failed: Math.min(n, Math.max(0, Math.trunc(num(j.failed ?? 0, "failed")))),
      errors,
      usage,
      created_at: num(j.created_at, "a job's time"),
      finished_at: j.finished_at === null || j.finished_at === undefined ? null : num(j.finished_at, "a finish time"),
    };
  });

  const images = new Map(nodes.map((n) => [n.id, n.image]));
  for (const j of jobs) if (!j.ref_images) j.ref_images = j.refs.map((r) => images.get(r) ?? null);

  // References must resolve, and parents must not form a loop
  const nodeIds = new Set(nodes.map((n) => n.id));
  const jobIds = new Set(jobs.map((j) => j.id));
  if (nodeIds.size !== nodes.length || jobIds.size !== jobs.length) throw bad("an id appears twice");
  for (const n of nodes) {
    if (n.parent_id && !nodeIds.has(n.parent_id)) throw bad("a version's parent is missing");
    if (n.job_id && !jobIds.has(n.job_id)) throw bad("a version's job is missing");
  }
  for (const j of jobs) if (j.parent_id && !nodeIds.has(j.parent_id)) throw bad("a job's parent is missing");
  const parent = new Map(nodes.map((n) => [n.id, n.parent_id]));
  for (const n of nodes) {
    let at: string | null = n.id;
    for (let hops = 0; at; hops++) {
      if (hops > nodes.length) throw bad("versions refer to each other in a loop");
      at = parent.get(at) ?? null;
    }
  }
  return { project, nodes, jobs };
}

/** The images every node and job refers to. */
export function referencedImages(m: Omit<ArchiveContent, "images">): Set<string> {
  const out = new Set<string>();
  for (const n of m.nodes) for (const s of [n.image, n.raw_image, n.merged_image]) if (s) out.add(s);
  for (const j of m.jobs) {
    for (const s of [j.mask_image, j.annot_image, ...j.ref_images, ...j.requests.map((r) => r.annot_image)]) if (s) out.add(s);
  }
  return out;
}

/**
 * Open a zip of ``name`` (checked by ``parse``) and images/: checks the sizes before unpacking, each
 * image against its name, and that every image ``referenced`` names is there.
 */
async function readZip<M>(
  file: Uint8Array,
  name: string,
  parse: (raw: unknown) => M,
  referenced: (m: M) => Set<string>,
  fail: (detail: string) => Error,
): Promise<{ manifest: M; images: Map<string, Uint8Array> }> {
  let total = 0;
  let count = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(file, {
      filter: (info) => {
        if (++count > A.max_nodes * 4) throw fail("it has too many files");
        if (info.originalSize > A.max_file_bytes) throw fail(`${info.name} is too large`);
        total += info.originalSize;
        if (total > A.max_total_bytes) throw fail("it is too large");
        return info.name === name || /^images\/[0-9a-f]{64}\.(png|jpg|webp|gif)$/.test(info.name);
      },
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw fail("it can't be opened as a zip file");
  }
  const manifestBytes = files[name];
  if (!manifestBytes) throw fail(`${name} is missing`);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch {
    throw fail(`${name} is not valid JSON`);
  }
  const manifest = parse(raw);
  const images = new Map<string, Uint8Array>();
  for (const [entry, data] of Object.entries(files)) {
    const m = /^images\/([0-9a-f]{64})\.\w+$/.exec(entry);
    if (!m) continue;
    if ((await sha256Hex(data)) !== m[1]) throw fail(`${entry} doesn't match its name`);
    if (!sniff(data)) throw fail(`${entry} is not an image`);
    images.set(m[1], data);
  }
  for (const s of referenced(manifest)) if (!images.has(s)) throw fail(`the image ${s.slice(0, 8)}… is missing`);
  return { manifest, images };
}

/** Open a project file: checks the zip's sizes before unpacking, each image against its name, and the manifest. */
export async function readArchive(file: Uint8Array): Promise<ArchiveContent> {
  const { manifest, images } = await readZip(file, "project.json", parseManifest, referencedImages, bad);
  return { ...manifest, images };
}

/** Fresh ids for a project's versions and jobs, so an import never collides with what is already there. */
export function remapIds(content: ArchiveContent, newId: () => string): { nodes: ArchiveContent["nodes"]; jobs: ArchiveContent["jobs"] } {
  const nodeMap = new Map(content.nodes.map((n) => [n.id, newId()]));
  const jobMap = new Map(content.jobs.map((j) => [j.id, newId()]));
  return {
    nodes: content.nodes.map((n) => ({ ...n, id: nodeMap.get(n.id)!, parent_id: n.parent_id && nodeMap.get(n.parent_id)!, job_id: n.job_id && jobMap.get(n.job_id)! }) as ArchiveContent["nodes"][number]),
    jobs: content.jobs.map((j) => ({
      ...j,
      id: jobMap.get(j.id)!,
      parent_id: j.parent_id && nodeMap.get(j.parent_id)!,
      // A reference to a version that isn't in the file, or to an asset, stays as it is: it finds
      // nothing here (the library is another one), and its image is in ref_images
      refs: j.refs.map((r) => nodeMap.get(r) ?? r),
    })) as ArchiveContent["jobs"],
  };
}

// ---------------------------------------------------------------------------
// Asset packs: the asset library as a .zip
// ---------------------------------------------------------------------------
export interface AssetPackEntry {
  name: string;
  image: string;
  created_at: number;
}

const badPack = (detail: string) => userError("bad_asset_pack", `This isn't a brushgraft asset pack: ${detail}`, { detail });

/** The asset library as a Blob. */
export function writeAssetPack(assets: AssetPackEntry[], images: Map<string, Uint8Array>, appVersion = spec.version): Blob {
  const manifest = {
    format: A.assets_format,
    version: A.assets_version,
    exported_by: `brushgraft ${appVersion}`,
    assets: assets.map(({ name, image, created_at }) => ({ name, image, created_at })),
  };
  return writeZip("assets.json", manifest, images, Math.max(0, ...assets.map((a) => a.created_at)));
}

/** Check an assets.json (brushgraft.archive.parse_asset_manifest). */
export function parseAssetManifest(raw: unknown): { assets: AssetPackEntry[] } {
  if (!isObject(raw) || raw.format !== A.assets_format) throw badPack("assets.json is missing or has another format");
  if (typeof raw.version !== "number" || raw.version > A.assets_version) {
    throw userError("archive_newer", "This file was made by a newer brushgraft; upgrade to open it");
  }
  if (!Array.isArray(raw.assets) || raw.assets.length > A.max_assets) throw badPack("it has no list of assets, or too many");
  return {
    assets: raw.assets.map((a): AssetPackEntry => {
      if (!isObject(a)) throw badPack("an asset is malformed");
      if (typeof a.name !== "string" || charCount(a.name) > 100) throw badPack("an asset's name is not text");
      if (typeof a.image !== "string" || !SHA.test(a.image)) throw badPack("an asset's image is not an image hash");
      if (typeof a.created_at !== "number" || !(Math.abs(a.created_at) <= 1e15)) throw badPack("an asset's time is not a number");
      return { name: a.name.trim() || "Untitled", image: a.image, created_at: a.created_at };
    }),
  };
}

/** Open an asset pack: (entries, images), checked as a project file is. */
export async function readAssetPack(file: Uint8Array): Promise<{ assets: AssetPackEntry[]; images: Map<string, Uint8Array> }> {
  const { manifest, images } = await readZip(file, "assets.json", parseAssetManifest, (m) => new Set(m.assets.map((a) => a.image)), badPack);
  return { assets: manifest.assets, images };
}
