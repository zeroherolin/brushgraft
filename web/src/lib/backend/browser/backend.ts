// The browser build's backend: projects, versions and images live in this browser (IndexedDB),
// the image API is called from the page, and the image work runs in a Worker. Nothing is sent
// to brushgraft's own server, which only serves these static files.

import { ImageWorker, type ImageOps } from "../../imaging/client";
import { MIME } from "../../imaging/formats";
import type { Asset, Config, Job, LogLine, Project, ServerEvent, Settings, TreeNode } from "../../types";
// Project files and asset packs (and the zip code under them) load when first used
const zips = () => import("../archive");
import { ApiError, userError } from "../errors";
import { spec } from "../spec";
import type { Backend, JobRequest, SettingsUpdate, StorageInfo, Subscription } from "../types";
import { testConnection } from "./imageapi";
import { JobRunner } from "./jobs";
import { BrowserSettings } from "./settings";
import { BrowserStore, isQuotaError, newId } from "./store";
import { UrlCache } from "./urls";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const TAB_LOCK = "brushgraft-tab-";
const CHANNEL = "brushgraft-events";

/** Browser storage errors in the UI's terms. */
function storageFailure(e: unknown): unknown {
  return isQuotaError(e) ? userError("storage_full", "The browser's storage is full") : e;
}

async function guarded<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (e) {
    throw storageFailure(e);
  }
}

function save(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

const fileSafe = (name: string) => name.replace(/[^\p{L}\p{N}_.-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "project";

export class BrowserBackend implements Backend {
  readonly kind = "browser" as const;

  #tab = newId();
  #store!: BrowserStore;
  #images: ImageOps = new ImageWorker();
  #settings = new BrowserSettings();
  #runner!: JobRunner;
  #subscribers = new Set<Subscription>();
  #channel: BroadcastChannel | null = null;
  #full = new UrlCache(8);
  #thumbs = new UrlCache(600);
  #wake: WakeLockSentinel | null = null;

  async start(): Promise<Config> {
    try {
      this.#store = new BrowserStore();
      await this.#store.listProjects(); // opens the database: fails here if the browser blocks storage
    } catch (e) {
      throw new ApiError(
        "This browser won't let the page store data (private browsing, or site data is blocked)",
        500,
        "storage_unavailable",
      );
    }
    this.#runner = new JobRunner({
      store: this.#store,
      images: this.#images,
      owner: this.#tab,
      settings: () => ({ apiKey: this.#settings.apiKey, baseUrl: this.#settings.baseUrl }),
      publish: (ev) => this.#publish(ev),
      onActivity: (n) => this.#activity(n),
    });
    await this.#holdTabLock();
    // Jobs a closed page left unfinished are settled; another open tab's jobs are left alone
    const alive = await this.#liveTabs();
    await this.#store.recoverInterrupted((owner) => alive.has(owner));
    await this.#store.collectGarbage();
    this.#listen();
    window.addEventListener("beforeunload", (e) => {
      if (this.#runner.active > 0) {
        e.preventDefault(); // images in flight are billed but would never be saved
        e.returnValue = "";
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.#runner.active > 0) void this.#keepAwake(true);
    });
    return this.#config();
  }

  #config(): Config {
    return {
      version: spec.version,
      promptbrush_version: spec.promptbrush_version,
      models: spec.models,
      default_model: spec.default_model,
      lenient_model: spec.lenient_model,
      size_presets: spec.size_presets,
      default_size: spec.default_size,
      region_colors: spec.region_colors,
      max_regions: spec.max_regions,
      settings: this.#settingsView(),
      home: "",
    };
  }

  #settingsView(): Settings {
    return {
      api_key_set: !!this.#settings.apiKey,
      api_key_source: "",
      base_url: this.#settings.baseUrl,
      base_url_source: "",
      env_file: "",
      remember: this.#settings.remember,
    };
  }

  async saveSettings(body: SettingsUpdate): Promise<Settings> {
    this.#settings.save({ apiKey: body.api_key, baseUrl: body.base_url, remember: body.remember });
    return this.#settingsView();
  }

  async testConnection(): Promise<void> {
    if (!this.#settings.apiKey) throw userError("api_key_missing", "No API key is configured; add one in Settings");
    await testConnection(this.#settings.apiKey, this.#settings.baseUrl);
  }

  // -- tabs ----------------------------------------------------------------
  /** Hold a lock named for this tab for as long as it lives, so other tabs can tell it is open. */
  async #holdTabLock(): Promise<void> {
    if (!navigator.locks) return;
    await new Promise<void>((resolve) => {
      void navigator.locks.request(TAB_LOCK + this.#tab, () => {
        resolve();
        return new Promise<never>(() => {}); // never released; the browser frees it when the tab closes
      });
    });
  }

  async #liveTabs(): Promise<Set<string>> {
    if (!navigator.locks) return new Set([this.#tab]);
    const { held } = await navigator.locks.query();
    return new Set((held ?? []).map((l) => l.name ?? "").filter((n) => n.startsWith(TAB_LOCK)).map((n) => n.slice(TAB_LOCK.length)));
  }

  #listen(): void {
    if (typeof BroadcastChannel === "undefined") return;
    this.#channel = new BroadcastChannel(CHANNEL);
    // Other tabs' changes show up here too
    this.#channel.onmessage = (m: MessageEvent<{ from: string; ev: ServerEvent }>) => {
      if (m.data.from !== this.#tab) for (const s of this.#subscribers) s.event(m.data.ev);
    };
  }

  #publish(ev: ServerEvent): void {
    for (const s of this.#subscribers) s.event(ev);
    this.#channel?.postMessage({ from: this.#tab, ev });
  }

  subscribe(handlers: Subscription): () => void {
    this.#subscribers.add(handlers);
    queueMicrotask(() => handlers.open());
    return () => void this.#subscribers.delete(handlers);
  }

  // -- keeping the page alive while images are made ---------------------------
  #activity(active: number): void {
    void this.#keepAwake(active > 0);
  }

  async #keepAwake(on: boolean): Promise<void> {
    try {
      if (on && !this.#wake && navigator.wakeLock) {
        this.#wake = await navigator.wakeLock.request("screen");
        this.#wake.addEventListener("release", () => (this.#wake = null));
      } else if (!on && this.#wake) {
        await this.#wake.release();
        this.#wake = null;
      }
    } catch {
      // not allowed (a background tab, low battery): the jobs run on regardless
    }
  }

  // -- projects ------------------------------------------------------------
  projects = (): Promise<Project[]> => this.#store.listProjects();
  createProject = (name: string): Promise<Project> => guarded(this.#store.createProject(name));
  renameProject = (id: string, name: string): Promise<Project> => this.#store.renameProject(id, name);

  async deleteProject(id: string): Promise<void> {
    await this.#store.deleteProject(id);
    await this.#store.collectGarbage();
  }

  tree = (id: string): Promise<{ nodes: TreeNode[]; jobs: Job[] }> => this.#store.projectTree(id);

  async exportProject(id: string): Promise<void> {
    const { project, nodes, jobs } = await this.#store.everything(id);
    const images = new Map<string, Uint8Array>();
    const need = new Set<string>();
    for (const n of nodes) for (const s of [n.image, n.raw_image, n.merged_image]) if (s) need.add(s);
    for (const j of jobs) for (const s of [j.mask_image, j.annot_image, ...j.ref_images]) if (s) need.add(s);
    for (const sha of need) images.set(sha, new Uint8Array((await this.#store.getImage(sha)).data));
    const archiveNodes = nodes.map(({ project_id: _p, width: _w, height: _h, ...rest }) => (void [_p, _w, _h], rest));
    const archiveJobs = jobs.map(({ project_id: _p, ...rest }) => (void _p, rest));
    const { writeArchive } = await zips();
    save(writeArchive({ project, nodes: archiveNodes, jobs: archiveJobs, images }), `brushgraft-${fileSafe(project.name)}.zip`);
  }

  async importProject(file: File): Promise<Project> {
    return guarded(this.#import(new Uint8Array(await file.arrayBuffer())));
  }

  async #import(bytes: Uint8Array): Promise<Project> {
    const { readArchive, remapIds } = await zips();
    const content = await readArchive(bytes);
    const sizes = new Map<string, { width: number; height: number }>();
    for (const [sha, data] of content.images) {
      const stored = await this.#store.putImage(data); // the same bytes: the same hash
      sizes.set(sha, { width: stored.width, height: stored.height });
    }
    const { nodes, jobs } = remapIds(content, newId);
    const project: Project = { id: newId(), name: content.project.name, created_at: content.project.created_at, updated_at: content.project.updated_at };
    const full: TreeNode[] = nodes.map((n) => ({ ...n, project_id: project.id, ...sizes.get(n.image)! }));
    const settled: Job[] = jobs.map((j) => {
      const job = { ...j, project_id: project.id };
      // a job that was running when it was exported never finishes here
      if (job.status === "queued" || job.status === "running") {
        job.errors = [...job.errors, { code: "interrupted", detail: "", variant: "" }];
        job.status = job.done ? "done" : "failed";
      }
      return job;
    });
    await this.#store.insertProject(project, full, settled, this.#tab);
    return { ...project, node_count: full.length };
  }

  // -- versions ------------------------------------------------------------
  /** An uploaded file's bytes, checked and normalized as the server does (orientation baked in). */
  async #uploaded(file: File): Promise<Uint8Array> {
    if (file.size > MAX_UPLOAD_BYTES) {
      const max_mb = MAX_UPLOAD_BYTES / 1024 / 1024;
      throw userError("upload_too_large", `Images can't be larger than ${max_mb} MB`, { max_mb });
    }
    return this.#images.normalize(new Uint8Array(await file.arrayBuffer()));
  }

  async upload(projectId: string, file: File): Promise<TreeNode> {
    await this.#store.getProject(projectId);
    const data = await this.#uploaded(file);
    return guarded(
      (async () => {
        const image = await this.#store.putImage(data);
        const node = await this.#store.addNode({ projectId, image: image.sha, label: file.name.split(/[\\/]/).pop()!.slice(0, 200) });
        this.#publish({ type: "node", node });
        return node;
      })(),
    );
  }

  async patchNode(id: string, body: { starred?: boolean; label?: string; use_raw?: boolean }): Promise<TreeNode> {
    const node = await this.#store.updateNode(id, { starred: body.starred, label: body.label, useRaw: body.use_raw });
    this.#publish({ type: "node", node });
    return node;
  }

  async deleteNode(id: string): Promise<void> {
    const node = await this.#store.getNode(id);
    await this.#store.deleteNode(id);
    await this.#store.collectGarbage();
    this.#publish({ type: "tree", project_id: node.project_id });
  }

  async addFromAsset(projectId: string, assetId: string): Promise<TreeNode> {
    await this.#store.getProject(projectId);
    const asset = await this.#store.getAsset(assetId);
    const node = await guarded(this.#store.addNode({ projectId, image: asset.image, label: asset.name }));
    this.#publish({ type: "node", node });
    return node;
  }

  // -- the asset library ------------------------------------------------------
  assets = (): Promise<Asset[]> => this.#store.listAssets();

  async addAsset(file: File): Promise<Asset> {
    const data = await this.#uploaded(file);
    const name = file.name.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, "").trim().slice(0, 100) || "Untitled";
    const asset = await guarded(
      (async () => {
        const image = await this.#store.putImage(data);
        return this.#store.addAsset(image.sha, name);
      })(),
    );
    this.#publish({ type: "assets" });
    return asset;
  }

  async assetFromNode(nodeId: string, name: string): Promise<Asset> {
    const node = await this.#store.getNode(nodeId);
    const asset = await guarded(this.#store.addAsset(node.image, name.trim()));
    this.#publish({ type: "assets" });
    return asset;
  }

  async renameAsset(id: string, name: string): Promise<Asset> {
    const asset = await this.#store.renameAsset(id, name.trim());
    this.#publish({ type: "assets" });
    return asset;
  }

  async deleteAsset(id: string): Promise<void> {
    await this.#store.deleteAsset(id);
    await this.#store.collectGarbage();
    this.#publish({ type: "assets" });
  }

  async exportAssets(): Promise<void> {
    const assets = await this.#store.listAssets();
    const images = new Map<string, Uint8Array>();
    for (const a of assets) images.set(a.image, new Uint8Array((await this.#store.getImage(a.image)).data));
    const { writeAssetPack } = await zips();
    save(writeAssetPack(assets, images), "brushgraft-assets.zip");
  }

  async importAssets(file: File): Promise<{ added: number; skipped: number }> {
    const { readAssetPack } = await zips();
    const pack = await readAssetPack(new Uint8Array(await file.arrayBuffer()));
    const [added, skipped] = await guarded(
      (async () => {
        for (const data of pack.images.values()) await this.#store.putImage(data);
        return this.#store.importAssets(pack.assets);
      })(),
    );
    this.#publish({ type: "assets" });
    return { added, skipped };
  }

  // -- jobs ----------------------------------------------------------------
  createJob = (body: JobRequest): Promise<Job> => guarded(this.#runner.submit(body));

  async deleteJob(id: string): Promise<void> {
    const job = await this.#store.getJob(id);
    await this.#store.deleteJob(id);
    await this.#store.collectGarbage();
    this.#publish({ type: "tree", project_id: job.project_id });
  }

  async logs(jobId: string): Promise<LogLine[]> {
    await this.#store.getJob(jobId);
    return this.#runner.logs(jobId);
  }

  // -- images --------------------------------------------------------------
  imageSrc = (sha: string): Promise<string> =>
    this.#full.get(sha, async () => {
      const row = await this.#store.getImage(sha);
      return URL.createObjectURL(new Blob([row.data], { type: MIME[row.ext] }));
    });

  /** Thumbnails are made on first use and kept, so scrolling a long tree is cheap afterwards. */
  thumbSrc = (sha: string): Promise<string> =>
    this.#thumbs.get(sha, async () => {
      let thumb = await this.#store.getThumb(sha);
      if (!thumb) {
        const made = await this.#images.thumb(new Uint8Array((await this.#store.getImage(sha)).data));
        await this.#store.putThumb(sha, made.type, made.bytes).catch(() => {}); // a full disk shouldn't stop the picture
        return URL.createObjectURL(new Blob([made.bytes as BlobPart], { type: made.type }));
      }
      thumb = thumb!;
      return URL.createObjectURL(new Blob([thumb.data], { type: thumb.type }));
    });

  async download(sha: string, name: string): Promise<void> {
    const row = await this.#store.getImage(sha);
    save(new Blob([row.data], { type: MIME[row.ext] }), `${name}${row.ext}`);
  }

  // -- storage -------------------------------------------------------------
  async storage(): Promise<StorageInfo | null> {
    if (!navigator.storage?.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    return { used: usage ?? (await this.#store.imageBytes()), quota: quota ?? null, persistent: (await navigator.storage.persisted?.()) ?? false };
  }

  async persistStorage(): Promise<boolean> {
    return (await navigator.storage?.persist?.()) ?? false;
  }
}
