// Projects, versions, jobs, the asset library and images in IndexedDB: the browser's counterpart
// of brushgraft.store (same rows, same rules, same error codes). Images are stored by the SHA-256
// of their bytes, so identical content is kept once.

import { detectExt, sniff, type Ext } from "../../imaging/formats";
import type { Asset, Job, JobError, Project, Region, TreeNode } from "../../types";
import { notFound, userError } from "../errors";
import { spec } from "../spec";

const DB_NAME = "brushgraft";
// 2: the asset library, and jobs record each reference's image (ref_images)
const DB_VERSION = 2;

export interface ImageRow {
  sha: string;
  ext: Ext;
  width: number;
  height: number;
  bytes: number;
  data: ArrayBuffer;
}

interface ThumbRow {
  sha: string;
  type: string;
  data: ArrayBuffer;
}

/** a job as stored: the Job the UI sees, plus who is running it */
export interface JobRow extends Job {
  owner: string;
}

type NodeRow = Omit<TreeNode, "width" | "height"> & { width: number; height: number };
type AssetRow = Omit<Asset, "width" | "height">;

const ACTIVE = new Set(["queued", "running"]);
const now = (() => {
  let last = 0;
  // strictly increasing, so versions made in the same millisecond keep their order
  return () => (last = Math.max(Date.now() / 1000, last + 1e-6));
})();

export const newId = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
};

export async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
}

const done = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

/** The storage ran out of room (the browser's quota) */
export const isQuotaError = (e: unknown): boolean => e instanceof DOMException && e.name === "QuotaExceededError";

export class BrowserStore {
  #db: Promise<IDBDatabase>;

  constructor(factory: IDBFactory = indexedDB, name = DB_NAME) {
    this.#db = new Promise((resolve, reject) => {
      const open = factory.open(name, DB_VERSION);
      open.onupgradeneeded = (event) => {
        const db = open.result;
        if (event.oldVersion < 1) {
          db.createObjectStore("projects", { keyPath: "id" });
          const nodes = db.createObjectStore("nodes", { keyPath: "id" });
          nodes.createIndex("project_id", "project_id");
          nodes.createIndex("parent_id", "parent_id");
          const jobs = db.createObjectStore("jobs", { keyPath: "id" });
          jobs.createIndex("project_id", "project_id");
          db.createObjectStore("images", { keyPath: "sha" });
          db.createObjectStore("thumbs", { keyPath: "sha" });
        }
        if (event.oldVersion < 2) {
          // an image is in the library once
          db.createObjectStore("assets", { keyPath: "id" }).createIndex("image", "image", { unique: true });
          if (event.oldVersion >= 1) fillRefImages(open.transaction!);
        }
      };
      open.onsuccess = () => {
        const db = open.result;
        db.onversionchange = () => db.close(); // a newer version of the page is opening
        resolve(db);
      };
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error("The database is in use by an older version of this page; close its other tabs"));
    });
  }

  /** Run ``fn`` in one transaction; resolves once it has committed. */
  async #tx<T>(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.#db;
    const tx = db.transaction(stores, mode);
    const complete = finished(tx);
    let value: T;
    try {
      value = await fn(tx);
    } catch (e) {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      complete.catch(() => {});
      throw e;
    }
    await complete;
    return value;
  }

  close(): void {
    void this.#db.then((db) => db.close());
  }

  // -- images ---------------------------------------------------------------
  /** Store image bytes (reusing an identical copy); returns {sha, width, height}. */
  async putImage(data: Uint8Array): Promise<{ sha: string; width: number; height: number }> {
    const info = sniff(data);
    if (!detectExt(data)) throw userError("not_an_image", "Only PNG, JPEG, WebP and GIF images are supported");
    if (!info) throw userError("bad_image", "Couldn't read the image: the file is damaged", { detail: "bad header" });
    const sha = await sha256(data);
    await this.#tx(["images"], "readwrite", async (tx) => {
      const images = tx.objectStore("images");
      if ((await done(images.count(sha))) === 0) {
        const copy = data.buffer.byteLength === data.byteLength && data.byteOffset === 0 ? data.buffer.slice(0) : data.slice().buffer;
        const row: ImageRow = { sha, ext: info.ext, width: info.width, height: info.height, bytes: data.length, data: copy as ArrayBuffer };
        await done(images.put(row));
      }
    });
    return { sha, width: info.width, height: info.height };
  }

  async getImage(sha: string): Promise<ImageRow> {
    const row = await this.#tx(["images"], "readonly", (tx) => done<ImageRow | undefined>(tx.objectStore("images").get(sha)));
    if (!row) throw notFound("image", sha);
    return row;
  }

  async imageInfo(sha: string): Promise<{ ext: Ext; width: number; height: number; bytes: number }> {
    const { ext, width, height, bytes } = await this.getImage(sha);
    return { ext, width, height, bytes };
  }

  async getThumb(sha: string): Promise<ThumbRow | undefined> {
    return this.#tx(["thumbs"], "readonly", (tx) => done<ThumbRow | undefined>(tx.objectStore("thumbs").get(sha)));
  }

  async putThumb(sha: string, type: string, bytes: Uint8Array): Promise<void> {
    const data = bytes.slice().buffer as ArrayBuffer;
    await this.#tx(["thumbs"], "readwrite", (tx) => done(tx.objectStore("thumbs").put({ sha, type, data } satisfies ThumbRow)));
  }

  /** Delete images no node, job or asset refers to; returns how many. */
  async collectGarbage(): Promise<number> {
    return this.#tx(["images", "thumbs", "nodes", "jobs", "assets"], "readwrite", async (tx) => {
      const used = new Set<string>();
      for (const n of await done<NodeRow[]>(tx.objectStore("nodes").getAll())) {
        for (const sha of [n.image, n.raw_image, n.merged_image]) if (sha) used.add(sha);
      }
      for (const j of await done<JobRow[]>(tx.objectStore("jobs").getAll())) {
        for (const sha of [j.mask_image, j.annot_image, ...(j.ref_images ?? [])]) if (sha) used.add(sha);
      }
      for (const a of await done<AssetRow[]>(tx.objectStore("assets").getAll())) used.add(a.image);
      const images = tx.objectStore("images");
      let n = 0;
      for (const sha of (await done(images.getAllKeys())) as string[]) {
        if (used.has(sha)) continue;
        images.delete(sha);
        tx.objectStore("thumbs").delete(sha);
        n++;
      }
      return n;
    });
  }

  /** Bytes the images take (thumbnails excluded: they are cheap and can be made again). */
  async imageBytes(): Promise<number> {
    return this.#tx(["images"], "readonly", async (tx) => {
      let total = 0;
      const cursor = tx.objectStore("images").openCursor();
      await new Promise<void>((resolve, reject) => {
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return resolve();
          total += (c.value as ImageRow).bytes;
          c.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
      return total;
    });
  }

  // -- projects -------------------------------------------------------------
  async listProjects(): Promise<Project[]> {
    return this.#tx(["projects", "nodes"], "readonly", async (tx) => {
      const projects = await done<Project[]>(tx.objectStore("projects").getAll());
      const counts = new Map<string, number>();
      for (const n of await done<NodeRow[]>(tx.objectStore("nodes").getAll())) counts.set(n.project_id, (counts.get(n.project_id) ?? 0) + 1);
      return projects
        .map((p) => ({ ...p, node_count: counts.get(p.id) ?? 0 }))
        .sort((a, b) => b.updated_at - a.updated_at);
    });
  }

  async getProject(id: string): Promise<Project> {
    const p = await this.#tx(["projects"], "readonly", (tx) => done<Project | undefined>(tx.objectStore("projects").get(id)));
    if (!p) throw notFound("project", id);
    return p;
  }

  async createProject(name: string): Promise<Project> {
    const t = now();
    const project: Project = { id: newId(), name, created_at: t, updated_at: t };
    await this.#tx(["projects"], "readwrite", (tx) => done(tx.objectStore("projects").put(project)));
    return { ...project, node_count: 0 };
  }

  async renameProject(id: string, name: string): Promise<Project> {
    return this.#tx(["projects"], "readwrite", async (tx) => {
      const store = tx.objectStore("projects");
      const p = await done<Project | undefined>(store.get(id));
      if (!p) throw notFound("project", id);
      const updated = { ...p, name, updated_at: now() };
      await done(store.put(updated));
      return updated;
    });
  }

  async touchProject(id: string): Promise<void> {
    await this.#tx(["projects"], "readwrite", async (tx) => {
      const store = tx.objectStore("projects");
      const p = await done<Project | undefined>(store.get(id));
      if (p) await done(store.put({ ...p, updated_at: now() }));
    });
  }

  async deleteProject(id: string): Promise<void> {
    await this.#tx(["projects", "nodes", "jobs"], "readwrite", async (tx) => {
      if (!(await done(tx.objectStore("projects").count(id)))) throw notFound("project", id);
      const jobs = await done<JobRow[]>(tx.objectStore("jobs").index("project_id").getAll(id));
      if (jobs.some((j) => ACTIVE.has(j.status))) {
        throw userError("project_busy", "Jobs in this project are still generating; delete it once they finish");
      }
      for (const j of jobs) tx.objectStore("jobs").delete(j.id);
      const nodes = await done<NodeRow[]>(tx.objectStore("nodes").index("project_id").getAll(id));
      for (const n of nodes) tx.objectStore("nodes").delete(n.id);
      tx.objectStore("projects").delete(id);
    });
  }

  async projectTree(id: string): Promise<{ nodes: TreeNode[]; jobs: Job[] }> {
    return this.#tx(["projects", "nodes", "jobs"], "readonly", async (tx) => {
      if (!(await done(tx.objectStore("projects").count(id)))) throw notFound("project", id);
      const nodes = await done<NodeRow[]>(tx.objectStore("nodes").index("project_id").getAll(id));
      const jobs = await done<JobRow[]>(tx.objectStore("jobs").index("project_id").getAll(id));
      return {
        nodes: nodes.sort((a, b) => a.created_at - b.created_at),
        jobs: jobs.sort((a, b) => a.created_at - b.created_at).map(publicJob),
      };
    });
  }

  // -- assets ---------------------------------------------------------------
  async #withSize(tx: IDBTransaction, row: AssetRow): Promise<Asset> {
    const info = await done<ImageRow | undefined>(tx.objectStore("images").get(row.image));
    return { ...row, width: info?.width ?? 0, height: info?.height ?? 0 };
  }

  async listAssets(): Promise<Asset[]> {
    return this.#tx(["assets", "images"], "readonly", async (tx) => {
      const rows = await done<AssetRow[]>(tx.objectStore("assets").getAll());
      rows.sort((a, b) => b.created_at - a.created_at);
      const out: Asset[] = [];
      for (const r of rows) out.push(await this.#withSize(tx, r));
      return out;
    });
  }

  async getAsset(id: string): Promise<Asset> {
    return this.#tx(["assets", "images"], "readonly", async (tx) => {
      const row = await done<AssetRow | undefined>(tx.objectStore("assets").get(id));
      if (!row) throw notFound("asset", id);
      return this.#withSize(tx, row);
    });
  }

  /** Put a stored image in the library; an image already there is returned as it is. */
  async addAsset(image: string, name: string): Promise<Asset> {
    return this.#tx(["assets", "images"], "readwrite", async (tx) => {
      if (!(await done(tx.objectStore("images").count(image)))) throw notFound("image", image);
      const assets = tx.objectStore("assets");
      let row = await done<AssetRow | undefined>(assets.index("image").get(image));
      if (!row) {
        row = { id: newId(), name, image, created_at: now() };
        await done(assets.put(row));
      }
      return this.#withSize(tx, row);
    });
  }

  async renameAsset(id: string, name: string): Promise<Asset> {
    return this.#tx(["assets", "images"], "readwrite", async (tx) => {
      const assets = tx.objectStore("assets");
      const row = await done<AssetRow | undefined>(assets.get(id));
      if (!row) throw notFound("asset", id);
      row.name = name;
      await done(assets.put(row));
      return this.#withSize(tx, row);
    });
  }

  /** Take an asset out of the library; versions made with it keep its image (their jobs refer to it). */
  async deleteAsset(id: string): Promise<void> {
    await this.#tx(["assets"], "readwrite", async (tx) => {
      if (!(await done(tx.objectStore("assets").count(id)))) throw notFound("asset", id);
      await done(tx.objectStore("assets").delete(id));
    });
  }

  /** Add assets read from an asset pack (images stored first): [added, skipped as already there]. */
  async importAssets(entries: { name: string; image: string; created_at: number }[]): Promise<[number, number]> {
    return this.#tx(["assets"], "readwrite", async (tx) => {
      const assets = tx.objectStore("assets");
      let added = 0;
      for (const e of entries) {
        if (await done(assets.index("image").count(e.image))) continue;
        await done(assets.put({ id: newId(), name: e.name, image: e.image, created_at: e.created_at } satisfies AssetRow));
        added++;
      }
      return [added, entries.length - added];
    });
  }

  // -- nodes ----------------------------------------------------------------
  async getNode(id: string): Promise<TreeNode> {
    const n = await this.#tx(["nodes"], "readonly", (tx) => done<NodeRow | undefined>(tx.objectStore("nodes").get(id)));
    if (!n) throw notFound("version", id);
    return n;
  }

  /** Add a version. With ``rawImage``, ``image`` is the pasted-back result. */
  async addNode(p: {
    projectId: string;
    image: string;
    parentId?: string | null;
    jobId?: string | null;
    rawImage?: string | null;
    /** the pasted-back result when ``image`` isn't it (the whole output was adopted) */
    mergedImage?: string | null;
    note?: string;
    label?: string;
  }): Promise<TreeNode> {
    return this.#tx(["projects", "nodes", "images"], "readwrite", async (tx) => {
      const info = await done<ImageRow | undefined>(tx.objectStore("images").get(p.image));
      if (!info) throw notFound("image", p.image);
      const node: NodeRow = {
        id: newId(),
        project_id: p.projectId,
        parent_id: p.parentId ?? null,
        job_id: p.jobId ?? null,
        image: p.image,
        raw_image: p.rawImage ?? null,
        merged_image: p.rawImage ? (p.mergedImage ?? p.image) : null,
        note: p.note ?? "",
        label: p.label ?? "",
        starred: false,
        width: info.width,
        height: info.height,
        created_at: now(),
      };
      await done(tx.objectStore("nodes").put(node));
      const projects = tx.objectStore("projects");
      const project = await done<Project | undefined>(projects.get(p.projectId));
      if (project) await done(projects.put({ ...project, updated_at: now() }));
      return node;
    });
  }

  async updateNode(id: string, p: { starred?: boolean; label?: string; useRaw?: boolean }): Promise<TreeNode> {
    return this.#tx(["nodes", "jobs", "images"], "readwrite", async (tx) => {
      const nodes = tx.objectStore("nodes");
      const node = await done<NodeRow | undefined>(nodes.get(id));
      if (!node) throw notFound("version", id);
      if (p.starred !== undefined) node.starred = p.starred;
      if (p.label !== undefined) node.label = p.label;
      if (p.useRaw !== undefined) {
        if (!(node.raw_image && node.merged_image)) {
          throw userError("no_alternative", "This version wasn't pasted back, so there is nothing to switch to");
        }
        // Later versions (finished or still generating) were made from the adopted image;
        // swapping it would break that link.
        const children = await done(nodes.index("parent_id").count(id));
        const jobs = await done<JobRow[]>(tx.objectStore("jobs").index("project_id").getAll(node.project_id));
        const active = jobs.some((j) => j.parent_id === id && ACTIVE.has(j.status));
        if (children || active) {
          throw userError("has_successors", "This version already has later versions, so its adopted image can no longer change");
        }
        node.image = p.useRaw ? node.raw_image : node.merged_image;
        const info = await done<ImageRow | undefined>(tx.objectStore("images").get(node.image));
        if (info) [node.width, node.height] = [info.width, info.height];
      }
      await done(nodes.put(node));
      return node;
    });
  }

  /** ``ids`` and everything below them: versions made from them, and the jobs that made those. */
  async #subtree(tx: IDBTransaction, ids: string[]): Promise<{ nodes: Set<string>; jobs: Set<string> }> {
    const nodes = new Set<string>();
    const jobs = new Set<string>();
    const queue = [...ids];
    const index = tx.objectStore("nodes").index("parent_id");
    while (queue.length) {
      const id = queue.pop()!;
      if (nodes.has(id)) continue;
      nodes.add(id);
      for (const n of await done<NodeRow[]>(index.getAll(id))) queue.push(n.id);
    }
    // jobs whose parent is in the subtree go with it
    const all = await done<JobRow[]>(tx.objectStore("jobs").getAll());
    for (const j of all) if (j.parent_id && nodes.has(j.parent_id)) jobs.add(j.id);
    return { nodes, jobs };
  }

  async #activeUnder(tx: IDBTransaction, nodeIds: string[]): Promise<boolean> {
    const { nodes } = await this.#subtree(tx, nodeIds);
    const all = await done<JobRow[]>(tx.objectStore("jobs").getAll());
    return all.some((j) => j.parent_id && nodes.has(j.parent_id) && ACTIVE.has(j.status));
  }

  /** Delete a version and its whole subtree. Refused while a job in it is generating. */
  async deleteNode(id: string): Promise<void> {
    await this.#tx(["nodes", "jobs"], "readwrite", async (tx) => {
      if (!(await done(tx.objectStore("nodes").count(id)))) throw notFound("version", id);
      if (await this.#activeUnder(tx, [id])) {
        throw userError("branch_busy", "A version in this branch is still generating; delete it once that finishes");
      }
      const { nodes, jobs } = await this.#subtree(tx, [id]);
      for (const n of nodes) tx.objectStore("nodes").delete(n);
      for (const j of jobs) tx.objectStore("jobs").delete(j);
    });
  }

  // -- jobs -----------------------------------------------------------------
  async createJob(job: Omit<JobRow, "id" | "status" | "created_at" | "done" | "failed" | "errors" | "usage" | "finished_at">): Promise<Job> {
    const row: JobRow = {
      ...job,
      id: newId(),
      status: "queued",
      done: 0,
      failed: 0,
      errors: [],
      usage: null,
      created_at: now(),
      finished_at: null,
    };
    await this.#tx(["jobs", "projects"], "readwrite", async (tx) => {
      await done(tx.objectStore("jobs").put(row));
      const projects = tx.objectStore("projects");
      const project = await done<Project | undefined>(projects.get(row.project_id));
      if (project) await done(projects.put({ ...project, updated_at: now() }));
    });
    return publicJob(row);
  }

  async getJob(id: string): Promise<JobRow> {
    const j = await this.#tx(["jobs"], "readonly", (tx) => done<JobRow | undefined>(tx.objectStore("jobs").get(id)));
    if (!j) throw notFound("job", id);
    return j;
  }

  async setJobRunning(id: string): Promise<Job> {
    return this.#tx(["jobs"], "readwrite", async (tx) => {
      const store = tx.objectStore("jobs");
      const j = await done<JobRow | undefined>(store.get(id));
      if (!j) throw notFound("job", id);
      if (j.status === "queued") {
        j.status = "running";
        await done(store.put(j));
      }
      return publicJob(j);
    });
  }

  /** Record one request's outcome; once all n are in, mark the job done or failed. */
  async recordAttempt(id: string, p: { ok: boolean; error?: JobError | null; usage?: Record<string, number> | null }): Promise<Job> {
    return this.#tx(["jobs"], "readwrite", async (tx) => {
      const store = tx.objectStore("jobs");
      const j = await done<JobRow | undefined>(store.get(id));
      if (!j) throw notFound("job", id);
      if (p.error) j.errors = [...j.errors, p.error];
      j.usage = addUsage(j.usage, p.usage);
      j.done += p.ok ? 1 : 0;
      j.failed += p.ok ? 0 : 1;
      if (j.done + j.failed >= j.n) {
        j.status = j.done ? "done" : "failed";
        j.finished_at = now();
      }
      await done(store.put(j));
      return publicJob(j);
    });
  }

  async deleteJob(id: string): Promise<void> {
    await this.#tx(["nodes", "jobs"], "readwrite", async (tx) => {
      const jobs = tx.objectStore("jobs");
      const job = await done<JobRow | undefined>(jobs.get(id));
      if (!job) throw notFound("job", id);
      if (ACTIVE.has(job.status)) throw userError("job_active", "This job is still running");
      const outputs = (await done<NodeRow[]>(tx.objectStore("nodes").getAll())).filter((n) => n.job_id === id).map((n) => n.id);
      if (await this.#activeUnder(tx, outputs)) {
        throw userError("branch_busy", "A version in this branch is still generating; delete it once that finishes");
      }
      const { nodes, jobs: below } = await this.#subtree(tx, outputs);
      for (const n of nodes) tx.objectStore("nodes").delete(n);
      for (const j of below) jobs.delete(j);
      jobs.delete(id);
    });
  }

  async anyActiveJobs(): Promise<boolean> {
    return this.#tx(["jobs"], "readonly", async (tx) => (await done<JobRow[]>(tx.objectStore("jobs").getAll())).some((j) => ACTIVE.has(j.status)));
  }

  /**
   * Settle jobs left unfinished by a page that closed: done if any image came back. ``alive``
   * says which owners are still running (another tab), so their jobs are left alone.
   */
  async recoverInterrupted(alive: (owner: string, job: JobRow) => boolean): Promise<number> {
    return this.#tx(["jobs"], "readwrite", async (tx) => {
      const store = tx.objectStore("jobs");
      let n = 0;
      for (const j of await done<JobRow[]>(store.getAll())) {
        if (!ACTIVE.has(j.status) || alive(j.owner, j)) continue;
        j.errors = [...j.errors, { code: "interrupted", detail: "", variant: "" }];
        j.status = j.done ? "done" : "failed";
        j.finished_at = now();
        await done(store.put(j));
        n++;
      }
      return n;
    });
  }

  // -- bulk, for import and export -------------------------------------------
  async everything(projectId: string): Promise<{ project: Project; nodes: TreeNode[]; jobs: Job[] }> {
    const project = await this.getProject(projectId);
    return { project, ...(await this.projectTree(projectId)) };
  }

  /** Add a whole project (new ids already chosen by the caller). Images must be stored first. */
  async insertProject(project: Project, nodes: TreeNode[], jobs: Job[], owner: string): Promise<void> {
    await this.#tx(["projects", "nodes", "jobs"], "readwrite", async (tx) => {
      await done(tx.objectStore("projects").put(project));
      for (const j of jobs) await done(tx.objectStore("jobs").put({ ...j, owner } satisfies JobRow));
      for (const n of nodes) await done(tx.objectStore("nodes").put(n));
    });
  }
}

/**
 * Upgrading from version 1: each job's ref_images, from the references that still exist (as
 * brushgraft.store does). Runs inside the upgrade's own transaction.
 */
function fillRefImages(tx: IDBTransaction): void {
  const nodes = tx.objectStore("nodes");
  const cursor = tx.objectStore("jobs").openCursor();
  cursor.onsuccess = () => {
    const c = cursor.result;
    if (!c) return;
    const job = c.value as JobRow;
    const shas: (string | null)[] = [];
    const next = (i: number) => {
      if (i === job.refs.length) {
        c.update({ ...job, ref_images: shas });
        c.continue();
        return;
      }
      const get = nodes.get(job.refs[i]);
      get.onsuccess = () => {
        shas.push((get.result as NodeRow | undefined)?.image ?? null);
        next(i + 1);
      };
    };
    next(0);
  };
}

/** a job without the bookkeeping field the UI doesn't know */
function publicJob(row: JobRow): Job {
  const { owner: _owner, ...job } = row;
  void _owner;
  return job;
}

function addUsage(total: Record<string, number> | null, usage: Record<string, number> | null | undefined) {
  if (!usage) return total;
  const out = { ...(total ?? {}) };
  for (const [k, v] of Object.entries(usage)) if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
  return out;
}

export const MAX_REGIONS = spec.max_regions;
export type { Region };
