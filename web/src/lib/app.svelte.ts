// Global state: the current project's nodes and jobs, the selection, a draft per
// node, and UI preferences.
//
// A draft is the next edit being prepared on a version. Once submitted, its
// regions and instructions belong to the job and show up on every version it
// produced ("made with"); the draft itself starts empty again, so each child of
// a version is prepared from scratch, the way a sent message clears the input.

import { ApiError, backend, type JobRequest } from "./backend";
import { charCount } from "./backend/prompts";
import { spec } from "./backend/spec";
import { dialogs } from "./dialogs.svelte";
import { fig } from "./format";
import { regionBox, shapeBox, transformShapes, type Box } from "./geometry";
import { regionMask } from "./imaging/shapes";
import { i18n, t, type Key } from "./i18n.svelte";
import { undoKey } from "./platform";
import { applyTheme, loadPref, savePref, type Theme } from "./prefs";
import { ASSET_REF, type Asset, type Config, type Job, type JobError, type LogLine, type ModelInfo, type Project, type Region, type ServerEvent, type Shape, type ShapeOp, type TreeNode } from "./types";

export type Tool = "select" | "rect" | "ellipse" | "lasso" | "polygon" | "brush" | "eraser";
/** What a new shape does, as in Photoshop's options bar: a new region, or add to / subtract from / intersect with one */
export type SelectMode = "new" | "add" | "subtract" | "intersect";
export type Mode = "edit" | "generate";
export type Layout = "wide" | "medium" | "narrow";

export interface Draft {
  regions: Region[];
  prompt: string;
  refs: string[];
}

const NEW_DRAFT = "__new__";
const LOG_LIMIT = 80;
const MAX_REFS = 8;
const UNDO_LIMIT = 100;
const TOOLS: Tool[] = ["select", "rect", "ellipse", "lasso", "polygon", "brush", "eraser"];

const emptyDraft = (): Draft => ({ regions: [], prompt: "", refs: [] });
const isEmpty = (d: Draft | undefined) => !d || (!d.regions.length && !d.prompt.trim() && !d.refs.length);
const newUid = () => Math.random().toString(36).slice(2, 10);
const withUids = (regions: Region[]): Region[] => regions.map((r) => (r.uid ? r : { ...r, uid: newUid() }));

/** a job's regions, prompt and references as a fresh draft (a deep copy) */
function draftOf(job: Job, keepRef: (id: string) => boolean): Draft {
  const regions = withUids(JSON.parse(JSON.stringify(job.regions)) as Region[]);
  return { regions, prompt: job.prompt, refs: job.refs.filter(keepRef) };
}

/** ``box`` rasterized at up to 400 px across, which is enough to tell empty from not: a mapping onto that grid. */
function grid(box: Box): { w: number; h: number; to: Box } {
  const k = Math.min(1, 400 / Math.max(box.x1 - box.x0, box.y1 - box.y0));
  const w = Math.ceil((box.x1 - box.x0) * k) + 2;
  const h = Math.ceil((box.y1 - box.y0) * k) + 2;
  return { w, h, to: { x0: 1, y0: 1, x1: w - 1, y1: h - 1 } };
}

/** Whether a region selects nothing (everything it added was subtracted, or intersected away). */
function selectsNothing(region: Region): boolean {
  const box = regionBox(region);
  if (!box || box.x1 - box.x0 < 0.5 || box.y1 - box.y0 < 0.5) return true;
  const g = grid(box);
  return !regionMask(g.w, g.h, transformShapes(region.shapes, box, g.to)).data.some((v) => v);
}

/** Whether a shape selects anything inside an image of this size (a lasso can loop outside it). */
export function selectsInImage(shape: Shape, width: number, height: number): boolean {
  const image = { x0: 0, y0: 0, x1: width, y1: height };
  const g = grid(image);
  return regionMask(g.w, g.h, transformShapes([withOp(shape, "add")], image, g.to)).data.some((v) => v);
}

/** Whether a shape covers any of what a region selects. */
function overlaps(region: Region, shape: Shape): boolean {
  const a = regionBox(region);
  const b = shapeBox(shape);
  if (!a || a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0) return false;
  const box = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  const g = grid(box);
  const mine = regionMask(g.w, g.h, transformShapes(region.shapes, box, g.to)).data;
  const theirs = regionMask(g.w, g.h, transformShapes([withOp(shape, "add")], box, g.to)).data;
  return mine.some((v, i) => v && theirs[i]);
}

/**
 * The brush size after ``[`` or ``]``, in Photoshop's steps: by 1 px below 10, 10 below 100,
 * 25 below 200, 50 below 300, then 100; from 2 to 1000 px.
 */
export function brushStep(size: number, dir: 1 | -1): number {
  const stepAt = (s: number) => (s < 10 ? 1 : s < 100 ? 10 : s < 200 ? 25 : s < 300 ? 50 : 100);
  const next = dir > 0 ? (Math.floor(size / stepAt(size)) + 1) * stepAt(size) : (Math.ceil(size / stepAt(size - 1)) - 1) * stepAt(size - 1);
  return Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, next));
}
export const BRUSH_MIN = 2;
export const BRUSH_MAX = 1000;

/** A request error in the UI language; falls back to the server's English text. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError && e.code) {
    const key = `error.${e.code}`;
    if (i18n.has(key)) {
      const params = { ...e.params };
      if (typeof params.what === "string" && i18n.has(`what.${params.what}`)) {
        params.what = t(`what.${params.what}` as Key);
      }
      return t(key, params);
    }
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/** A job error in the UI language, with the API's own text appended. */
export function jobErrorText(error: JobError | string | undefined, model: string, lenient = ""): string {
  if (!error) return t("jobError.unknown");
  if (typeof error === "string") return error; // stored before errors had codes
  let text: string;
  if (error.code === "moderated") {
    text = lenient && model !== lenient ? t("jobError.moderatedTry", { model: lenient }) : t("jobError.moderated");
  } else {
    const key = `jobError.${error.code}`;
    text = i18n.has(key) ? t(key) : error.code;
  }
  const variant = error.variant ? `[${error.variant}] ` : "";
  return `${variant}${text}${error.detail ? ` (${error.detail})` : ""}`;
}

const undoLabel = () => undoKey;

/** ``shape`` with ``op`` set; "add" is the default and isn't written down. */
function withOp(shape: Shape, op: ShapeOp): Shape {
  const out = { ...shape };
  if (op === "add") delete out.op;
  else out.op = op;
  return out;
}

function moveShape(shape: Shape, dx: number, dy: number): Shape {
  if (shape.type === "rect" || shape.type === "ellipse") return { ...shape, x: shape.x + dx, y: shape.y + dy };
  return { ...shape, points: shape.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) } as Shape;
}

class AppState {
  config = $state<Config | null>(null);
  fatal = $state("");
  online = $state(true);
  projects = $state<Project[]>([]);
  projectId = $state<string | null>(null);
  nodes = $state<Record<string, TreeNode>>({});
  jobs = $state<Record<string, Job>>({});
  logs = $state<Record<string, LogLine[]>>({});
  /** the website's legal line (an ICP filing number), from site.json beside the page; browser build only */
  site = $state<{ icp: string; url: string } | null>(null);

  selectedId = $state<string | null>(null);
  mode = $state<Mode>("generate");
  drafts = $state<Record<string, Draft>>({ [NEW_DRAFT]: emptyDraft() });
  selectedRegion = $state(-1);

  tool = $state<Tool>(TOOLS.includes(loadPref<Tool>("tool", "rect")) ? loadPref<Tool>("tool", "rect") : "rect");
  /** the variant each tool group shows: the marquee, lasso and brush groups remember their last one */
  marquee = $state<"rect" | "ellipse">(loadPref("marquee", "rect"));
  lassoKind = $state<"lasso" | "polygon">(loadPref("lassoKind", "lasso"));
  brushKind = $state<"brush" | "eraser">(loadPref("brushKind", "brush"));
  selectMode = $state<SelectMode>(loadPref("selectMode", "new"));
  /** the brush's diameter in image pixels, as in Photoshop: it covers the same part of the image at any zoom */
  brushSize = $state(Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, loadPref("brushDiameter", 80))));
  model = $state(loadPref("model", ""));
  n = $state(loadPref("n", 1));
  size = $state(loadPref("size", ""));
  composite = $state(loadPref("composite", true));
  theme = $state<Theme>(loadPref("theme", "system"));
  compare = $state(false);
  /** show the version's other image on the canvas (pasted result vs whole output) */
  showAlt = $state(false);

  layout = $state<Layout>("wide");
  treeOpen = $state(false);
  sheetOpen = $state(false);
  settingsOpen = $state(false);
  queueOpen = $state(false);
  /** requests on their way, by what they send (a draft's key, or "again:" and a job's id): how many */
  #sending = $state<Record<string, number>>({});
  /** whether a request for ``key`` is on its way (the default: the draft being edited) */
  isSending(key = this.draftKey): boolean {
    return (this.#sending[key] ?? 0) > 0;
  }
  /** cursor position on the canvas, in image pixels, for the status bar */
  cursor = $state<[number, number] | null>(null);
  zoom = $state(1);
  toast = $state<{ text: string; error: boolean; action?: { label: string; run: () => void } } | null>(null);
  /** a polygonal lasso is being drawn: the canvas owns Enter, Esc and Backspace meanwhile */
  polygonOpen = $state(false);
  /** a drag on the canvas is under way: its keys go to the canvas, and a finished job doesn't switch versions */
  gestureOpen = $state(false);
  #toastTimer = 0;
  /** a message waiting for the toast on screen to go */
  #queued: (() => void) | null = null;
  #draftTimer = 0;
  // Undo and redo per draft: snapshots of its regions, kept for this session only
  #stacks: Record<string, { undo: Region[][]; redo: Region[][] }> = {};
  #historyTick = $state(0);
  #lastNudge = { at: 0, key: "" };
  // when the event stream (or a submit) last changed each node and job: a tree reload that was
  // already on its way when that happened mustn't undo it
  #seq = 0;
  #touched = new Map<string, number>();

  // -- derived --------------------------------------------------------------
  selected = $derived(this.selectedId ? (this.nodes[this.selectedId] ?? null) : null);
  draftKey = $derived(this.mode === "edit" && this.selectedId ? this.selectedId : NEW_DRAFT);
  draft = $derived(this.drafts[this.draftKey] ?? emptyDraft());
  project = $derived(this.projects.find((p) => p.id === this.projectId) ?? null);
  isCustomModel = $derived(!!this.config && !this.config.models.some((m) => m.name === this.model));

  /** parent_id ("" for roots) → children, oldest first */
  children = $derived.by(() => {
    const map: Record<string, TreeNode[]> = {};
    for (const node of Object.values(this.nodes)) (map[node.parent_id ?? ""] ??= []).push(node);
    for (const list of Object.values(map)) list.sort((a, b) => a.created_at - b.created_at);
    return map;
  });

  /** version numbers: roots are 1, 2, 3...; children extend the parent's, as in 1.2.1 */
  versions = $derived.by(() => {
    const out: Record<string, string> = {};
    const walk = (key: string, prefix: string) => {
      (this.children[key] ?? []).forEach((node, i) => {
        out[node.id] = prefix ? `${prefix}.${i + 1}` : String(i + 1);
        walk(node.id, out[node.id]);
      });
    };
    walk("", "");
    return out;
  });

  /** running or failed jobs not yet cleared, by parent; shown as placeholder rows */
  pendingJobs = $derived.by(() => {
    const map: Record<string, Job[]> = {};
    for (const job of Object.values(this.jobs)) {
      if (job.status === "done") continue;
      (map[job.parent_id ?? ""] ??= []).push(job);
    }
    for (const list of Object.values(map)) list.sort((a, b) => a.created_at - b.created_at);
    return map;
  });

  activeJobs = $derived(
    Object.values(this.jobs)
      .filter((j) => j.status === "queued" || j.status === "running")
      .sort((a, b) => a.created_at - b.created_at),
  );

  /** the path from the root to the selected node */
  lineage = $derived.by(() => {
    const chain: TreeNode[] = [];
    let node = this.selected;
    while (node) {
      chain.unshift(node);
      node = node.parent_id ? (this.nodes[node.parent_id] ?? null) : null;
    }
    return chain;
  });

  lineageIds = $derived(new Set(this.lineage.map((n) => n.id)));
  selectedJob = $derived(this.selected?.job_id ? (this.jobs[this.selected.job_id] ?? null) : null);
  parentNode = $derived(this.selected?.parent_id ? (this.nodes[this.selected.parent_id] ?? null) : null);
  nodeCount = $derived(Object.keys(this.nodes).length);

  /** the edit the selected version was made with (its regions and instructions) */
  madeWith = $derived(this.selectedJob && this.selectedJob.kind === "edit" ? this.selectedJob : null);
  /** the regions to outline on the canvas: in the parent's pixels, so only when the sizes match */
  madeWithRegions = $derived(
    this.madeWith?.regions.length &&
      this.parentNode &&
      this.selected &&
      this.parentNode.width === this.selected.width &&
      this.parentNode.height === this.selected.height
      ? this.madeWith.regions
      : [],
  );
  showMadeWith = $state(loadPref("showMadeWith", true));
  /** the wheel zooms and Alt + wheel scrolls (Photoshop's "Zoom with Scroll Wheel") */
  wheelZoom = $state(loadPref("wheelZoom", false));
  /** the "made with" block above the tabs; null = not chosen yet (open, except on phones) */
  madeWithOpen = $state<boolean | null>(loadPref("madeWithOpen", null));

  setMadeWithOpen(open: boolean): void {
    this.madeWithOpen = open;
    savePref("madeWithOpen", open);
  }

  /** the asset library, newest first: images every project can use as references */
  assets = $state<Asset[]>([]);
  assetById = $derived(Object.fromEntries(this.assets.map((a) => [a.id, a])));
  /** the library's panel under the version tree: open, and its height in px */
  libraryOpen = $state(loadPref("libraryOpen", true));
  libraryHeight = $state(loadPref("libraryHeight", 260));

  setLibrary(open: boolean, height = this.libraryHeight): void {
    this.libraryOpen = open;
    this.libraryHeight = height;
    savePref("libraryOpen", open);
    savePref("libraryHeight", height);
  }

  /** whether a reference (a version's id, or "asset:" + an asset's id) still exists */
  refExists(ref: string): boolean {
    return ref.startsWith(ASSET_REF) ? !!this.assetById[ref.slice(ASSET_REF.length)] : !!this.nodes[ref];
  }

  /** why the current draft can't be sent yet; the button and the shortcut share this */
  blocker = $derived.by((): "model" | "empty" | "instruction" | "tooLong" | null => {
    const d = this.draft;
    if (!this.model.trim()) return "model";
    if (!d.prompt.trim() && !d.regions.length) return "empty";
    if (!d.prompt.trim() && d.regions.some((r) => !r.instruction.trim())) return "instruction";
    if (charCount(d.prompt.trim()) > spec.max_prompt || d.regions.some((r) => charCount(r.instruction.trim()) > spec.max_instruction)) {
      return "tooLong";
    }
    return null;
  });

  canUndo = $derived((void this.#historyTick, (this.#stacks[this.draftKey]?.undo.length ?? 0) > 0));
  canRedo = $derived((void this.#historyTick, (this.#stacks[this.draftKey]?.redo.length ?? 0) > 0));

  /** the version is longer than any size the models make (3:1): a result can't line up with it */
  tooOblong = $derived.by(() => {
    const n = this.selected;
    if (!n) return false;
    const ratio = Math.max(n.width / n.height, n.height / n.width);
    return ratio / spec.sizes.max_aspect - 1 > spec.imaging.aspect_tolerance;
  });

  canComposite = $derived(
    this.mode === "edit" &&
      this.draft.regions.length > 0 &&
      (this.modelInfo(this.model)?.aligned ?? true) &&
      !this.tooOblong,
  );

  /** a version's note (a code from the server) in the UI language */
  noteText(note: string): string {
    const key = `note.${note}`;
    return i18n.has(key) ? t(key) : note;
  }

  /** the latest error of a job, in the UI language */
  jobError(job: Job): string {
    return jobErrorText(job.errors.at(-1), job.model, this.config?.lenient_model);
  }

  modelInfo(name: string): ModelInfo | undefined {
    return this.config?.models.find((m) => m.name === name);
  }

  regionColor(index: number): string {
    const colors = this.config?.region_colors ?? ["#ff3b30"];
    return colors[index % colors.length];
  }

  /** a node's caption: its instructions and request, or the file name of an import */
  caption(node: TreeNode): string {
    const job = node.job_id ? this.jobs[node.job_id] : null;
    if (!job) return node.label ? t("caption.imported", { name: node.label }) : t("caption.importedImage");
    return describeJob(job);
  }

  // -- startup and sync -----------------------------------------------------
  async init(): Promise<void> {
    applyTheme(this.theme);
    try {
      this.config = await backend.start();
    } catch (e) {
      this.fatal =
        e instanceof ApiError && e.status === 401
          ? t("app.tokenRequired")
          : e instanceof ApiError && e.code
            ? t("app.startFailed", { error: errorText(e) })
            : t("app.unreachable", { error: errorText(e) });
      return;
    }
    void this.#loadSite();
    const cfg = this.config;
    if (!this.model.trim()) this.model = cfg.default_model;
    if (!cfg.size_presets.includes(this.size) && !/^\d+x\d+$/.test(this.size)) this.size = cfg.default_size;

    this.projects = await backend.projects();
    if (!this.projects.length) this.projects = [await backend.createProject(t("app.firstProject"))];
    const last = loadPref<string | null>("project", null);
    await this.loadAssets();
    this.#connect();
    await this.openProject(this.projects.some((p) => p.id === last) ? last! : this.projects[0].id);
    if (!cfg.settings.api_key_set) this.settingsOpen = true;
  }

  /** Whoever hosts the page can put a filing number in site.json next to it; absent or malformed means none. */
  async #loadSite(): Promise<void> {
    if (backend.kind !== "browser") return;
    try {
      const resp = await fetch("site.json", { cache: "no-cache" });
      if (!resp.ok) return;
      const data: unknown = await resp.json();
      const icp = (data as { icp?: unknown }).icp;
      const url = (data as { icp_url?: unknown }).icp_url;
      if (typeof icp === "string" && icp.trim() && icp.length <= 100) {
        this.site = { icp: icp.trim(), url: typeof url === "string" && /^https:\/\//.test(url) ? url : "https://beian.miit.gov.cn/" };
      }
    } catch {
      // no site.json, or not JSON: nothing to show
    }
  }

  #connect(): void {
    backend.subscribe({
      event: (ev) => this.#apply(ev),
      error: () => {
        this.online = false;
      },
      open: () => {
        // Events sent before connecting (or while disconnected) are lost; reload
        this.online = true;
        if (this.projectId) void this.reloadTree();
        void this.loadAssets();
      },
    });
  }

  #apply(ev: ServerEvent): void {
    if (ev.type === "log") {
      const list = (this.logs[ev.job_id] ??= []);
      list.push({ t: ev.t, level: ev.level, msg: ev.msg });
      if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
      return;
    }
    if (ev.type === "tree") {
      if (ev.project_id === this.projectId) void this.reloadTree();
      return;
    }
    if (ev.type === "assets") {
      void this.loadAssets();
      return;
    }
    if (ev.type === "node" && ev.node.project_id === this.projectId) {
      this.nodes[ev.node.id] = ev.node;
      this.#touched.set(ev.node.id, ++this.#seq);
    }
    if (ev.type === "job" && ev.job.project_id === this.projectId) {
      const before = this.jobs[ev.job.id];
      this.jobs[ev.job.id] = ev.job;
      this.#touched.set(ev.job.id, ++this.#seq);
      if (before && before.status !== ev.job.status) this.#announce(ev.job);
    }
  }

  #announce(job: Job): void {
    if (job.status === "failed") {
      this.notify(t("toast.failed", { error: this.jobError(job) }), true);
      return;
    }
    if (job.status !== "done") return;
    const results = Object.values(this.nodes)
      .filter((n) => n.job_id === job.id)
      .sort((a, b) => a.created_at - b.created_at);
    const text = job.failed
      ? t("toast.doneWithFailures", { n: results.length, failed: job.failed })
      : t("toast.done", { n: results.length });
    // a job finishing in the background mustn't cover an error still on screen (another
    // job's, say, that failed a moment ago): it waits for that one to go
    if (this.toast?.error && !job.failed) this.#queued = () => this.notify(text);
    else this.notify(text, job.failed > 0);
    // Still editing the version this job started from (not on "New image"): show the result,
    // unless the next edit is already under way there (don't pull the user away from it)
    const next = this.drafts[job.parent_id ?? NEW_DRAFT];
    const busy = this.polygonOpen || this.gestureOpen;
    const here = this.selectedId === job.parent_id && this.draftKey === (job.parent_id ?? NEW_DRAFT);
    if (results.length && here && !this.compare && isEmpty(next) && !busy) {
      this.select(results[0].id);
    }
  }

  async openProject(id: string): Promise<void> {
    this.projectId = id;
    savePref("project", id);
    this.selectedId = null;
    this.selectedRegion = -1;
    this.mode = "generate";
    this.logs = {};
    // Unsent drafts survive a reload; they live in this browser only
    const saved = loadPref<Record<string, Draft>>(`drafts.${id}`, {});
    for (const d of Object.values(saved)) d.regions = withUids(d.regions ?? []);
    this.drafts = { [NEW_DRAFT]: emptyDraft(), ...saved };
    this.#dropMissingAssets();
    this.#stacks = {};
    this.#historyTick++;
    this.#touched.clear();
    await this.reloadTree();
  }

  async reloadTree(): Promise<void> {
    const projectId = this.projectId;
    if (!projectId) return;
    const since = this.#seq;
    try {
      const { nodes, jobs } = await backend.tree(projectId);
      if (projectId !== this.projectId) return; // switched projects meanwhile
      // what changed while the snapshot was on its way is newer than the snapshot: keep it
      const changed = (id: string) => (this.#touched.get(id) ?? 0) > since;
      const nextNodes = Object.fromEntries(nodes.map((n) => [n.id, n]));
      for (const [id, n] of Object.entries(this.nodes)) if (changed(id)) nextNodes[id] = n;
      const nextJobs = Object.fromEntries(jobs.map((j) => [j.id, j]));
      for (const [id, j] of Object.entries(this.jobs)) if (changed(id)) nextJobs[id] = j;
      const before = this.jobs;
      this.nodes = nextNodes;
      this.jobs = nextJobs;
      // the snapshot may be first to tell (the stream was down, or its event is still coming);
      // that event then changes nothing, so announce here
      for (const job of jobs) {
        const was = before[job.id];
        if (was && was.status !== job.status && !changed(job.id)) this.#announce(job);
      }
    } catch (e) {
      this.notify(errorText(e), true);
      return;
    }
    for (const key of Object.keys(this.drafts)) {
      if (key !== NEW_DRAFT && !this.nodes[key]) delete this.drafts[key];
    }
    // a deleted version (here or in another tab) is no longer a reference in any draft
    for (const draft of Object.values(this.drafts)) {
      const kept = draft.refs.filter((r) => r.startsWith(ASSET_REF) || this.nodes[r]);
      if (kept.length !== draft.refs.length) draft.refs = kept;
    }
    if (this.selectedId && !this.nodes[this.selectedId]) this.select(null);
  }

  async refreshProjects(): Promise<void> {
    this.projects = await backend.projects();
  }

  // -- projects -------------------------------------------------------------
  async newProject(): Promise<void> {
    const name = (
      await dialogs.prompt({
        title: t("project.newTitle"),
        label: t("project.name"),
        value: t("app.untitledProject"),
        confirmLabel: t("project.create"),
      })
    )?.trim();
    if (!name) return;
    try {
      const project = await backend.createProject(name);
      await this.refreshProjects();
      await this.openProject(project.id);
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  async renameProject(): Promise<void> {
    const current = this.project;
    if (!current) return;
    const name = (
      await dialogs.prompt({
        title: t("project.renameTitle"),
        label: t("project.name"),
        value: current.name,
        confirmLabel: t("common.save"),
      })
    )?.trim();
    if (!name || name === current.name) return;
    try {
      await backend.renameProject(current.id, name);
      await this.refreshProjects();
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  async deleteProject(): Promise<void> {
    const current = this.project;
    if (!current) return;
    const ok = await dialogs.confirm({
      title: t("project.deleteTitle"),
      message: t("project.deleteMessage", { name: current.name, n: this.nodeCount }),
      confirmLabel: t("project.deleteConfirm"),
      danger: true,
    });
    if (!ok) return;
    try {
      await backend.deleteProject(current.id);
      await this.refreshProjects();
      if (!this.projects.length) this.projects = [await backend.createProject(t("app.untitledProject"))];
      await this.openProject(this.projects[0].id);
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  // -- selection and drafts -------------------------------------------------
  select(id: string | null): void {
    this.selectedId = id;
    this.selectedRegion = -1;
    this.showAlt = false;
    this.setMode(id ? "edit" : "generate");
    if (this.layout !== "wide") this.treeOpen = false;
  }

  setMode(mode: Mode): void {
    this.mode = mode === "edit" && !this.selectedId ? "generate" : mode;
    this.drafts[this.draftKey] ??= emptyDraft();
  }

  /** the current draft, stored in drafts so it can be modified in place */
  get editable(): Draft {
    return (this.drafts[this.draftKey] ??= emptyDraft());
  }

  // -- regions: every change can be undone (and redone) ------------------------
  #stack(key = this.draftKey) {
    return (this.#stacks[key] ??= { undo: [], redo: [] });
  }

  /** Remember the regions as they are, before a change; a change ends what there was to redo. */
  #checkpoint(clearRedo = true): void {
    const stack = this.#stack();
    stack.undo.push($state.snapshot(this.editable.regions) as Region[]);
    if (stack.undo.length > UNDO_LIMIT) stack.undo.shift();
    if (clearRedo) stack.redo = [];
    this.#historyTick++;
  }

  /** Start a change made in steps (a drag); call endChange when it's done, or cancelChange. */
  beginChange(): void {
    this.#checkpoint(false);
  }

  /** A change that turned out to change nothing (a click without a drag) leaves no undo step, and keeps the redo. */
  endChange(): void {
    const stack = this.#stack();
    const before = stack.undo.at(-1);
    if (before && JSON.stringify(before) === JSON.stringify($state.snapshot(this.editable.regions))) stack.undo.pop();
    else stack.redo = [];
    this.#historyTick++;
  }

  /** Drop a change in progress (Esc during a drag): the regions go back to how they were. */
  cancelChange(): void {
    const before = this.#stack().undo.pop();
    if (!before) return;
    const draft = this.editable;
    const typed = new Map(draft.regions.map((r) => [r.uid, r.instruction]));
    draft.regions = before.map((r) => (typed.has(r.uid) ? { ...r, instruction: typed.get(r.uid)! } : r));
    this.#historyTick++;
  }

  /** Put back regions from the history, keeping what was typed since into the instructions. */
  #restore(from: "undo" | "redo"): void {
    const stack = this.#stack();
    const next = stack[from].pop();
    if (!next) return;
    const draft = this.editable;
    stack[from === "undo" ? "redo" : "undo"].push($state.snapshot(draft.regions) as Region[]);
    const typed = new Map(draft.regions.map((r) => [r.uid, r.instruction]));
    const selected = draft.regions[this.selectedRegion]?.uid;
    draft.regions = next.map((r) => (typed.has(r.uid) ? { ...r, instruction: typed.get(r.uid)! } : r));
    // the same region stays selected, wherever it is now; none if it's gone
    this.selectedRegion = selected ? draft.regions.findIndex((r) => r.uid === selected) : -1;
    this.#historyTick++;
  }

  undo(): void {
    this.#restore("undo");
    this.#lastNudge = { at: 0, key: "" }; // the next nudge is a step of its own
  }

  redo(): void {
    this.#restore("redo");
    this.#lastNudge = { at: 0, key: "" };
  }

  /**
   * Apply a shape the way a selection tool does. "new" makes a region; "add" adds to the selected
   * region (a new one when none is selected); "subtract" and "intersect" change the selected
   * region, or every region when none is selected. Regions left with nothing in them go.
   */
  applyShape(shape: Shape, mode: SelectMode): void {
    const draft = this.editable;
    const max = this.config?.max_regions ?? 20;
    const selected = draft.regions[this.selectedRegion] ? this.selectedRegion : -1;
    if (mode === "new" || (mode === "add" && selected < 0)) {
      if (draft.regions.length >= max) {
        this.notify(t("toast.maxRegions", { max }), true);
        return;
      }
      this.#checkpoint();
      draft.regions.push({ shapes: [withOp(shape, "add")], instruction: "", uid: newUid() });
      this.selectedRegion = draft.regions.length - 1;
      return;
    }
    const full = (i: number) => draft.regions[i].shapes.length >= spec.max_shapes;
    if (mode === "add") {
      if (full(selected)) {
        this.notify(t("toast.maxShapes", { max: spec.max_shapes }), true);
        return;
      }
      this.#checkpoint();
      draft.regions[selected].shapes.push(withOp(shape, "add"));
      return;
    }
    const op: ShapeOp = mode;
    if (!draft.regions.length) {
      this.notify(t(op === "subtract" ? "toast.nothingToSubtract" : "toast.nothingToIntersect"));
      return;
    }
    // A subtraction changes only the regions it touches; one that touches none changes nothing
    let targets = selected >= 0 ? [selected] : draft.regions.map((_, i) => i);
    if (op === "subtract") targets = targets.filter((i) => overlaps(draft.regions[i], shape));
    if (!targets.length) return;
    if (targets.some(full)) {
      this.notify(t("toast.maxShapes", { max: spec.max_shapes }), true);
      return;
    }
    this.#checkpoint();
    for (const i of targets) draft.regions[i].shapes.push(withOp(shape, op));
    const emptied = targets.filter((i) => selectsNothing(draft.regions[i]));
    for (const i of emptied.reverse()) this.#dropRegion(i);
    if (emptied.length) this.notify(t("toast.regionEmptied", { n: emptied.length, key: undoLabel() }));
  }

  /** Replace a region's shapes (a transform in progress; wrap it in beginChange and endChange). */
  setShapes(index: number, shapes: Shape[]): void {
    const region = this.editable.regions[index];
    if (region) region.shapes = shapes;
  }

  moveRegion(index: number, dx: number, dy: number): void {
    const region = this.editable.regions[index];
    if (region) region.shapes = region.shapes.map((s) => moveShape(s, dx, dy));
  }

  /** Move the selected region by a few pixels (arrow keys); a run of nudges is one undo step. */
  nudge(dx: number, dy: number): void {
    const region = this.editable.regions[this.selectedRegion];
    if (!region) return;
    const key = `${this.draftKey}/${region.uid}`;
    const now = Date.now();
    if (now - this.#lastNudge.at > 1000 || this.#lastNudge.key !== key) this.#checkpoint();
    this.#lastNudge = { at: now, key };
    this.moveRegion(this.selectedRegion, dx, dy);
  }

  #dropRegion(index: number): void {
    this.editable.regions.splice(index, 1);
    if (this.selectedRegion === index) this.selectedRegion = -1;
    else if (this.selectedRegion > index) this.selectedRegion--;
  }

  removeRegion(index: number): void {
    if (!this.editable.regions[index]) return;
    this.#checkpoint();
    this.#dropRegion(index);
  }

  /** Select All: a region covering the whole image (the one there is, if there is one already). */
  selectAll(): void {
    const node = this.selected;
    if (!node || this.mode !== "edit") return;
    const whole = this.editable.regions.findIndex(
      (r) => r.shapes.length === 1 && JSON.stringify(r.shapes[0]) === JSON.stringify({ type: "rect", x: 0, y: 0, w: node.width, h: node.height }),
    );
    if (whole >= 0) this.selectedRegion = whole;
    else this.applyShape({ type: "rect", x: 0, y: 0, w: node.width, h: node.height }, "new");
  }

  clearDraft(): void {
    if (!this.editable.regions.length) return;
    this.#checkpoint();
    this.editable.regions = [];
    this.selectedRegion = -1;
  }

  /** save unsent drafts in this browser (debounced; App calls it on every change) */
  saveDrafts(): void {
    const projectId = this.projectId;
    if (!projectId) return;
    // Take the snapshot now: by the time the timer fires, another project may be open
    const kept = Object.fromEntries(Object.entries($state.snapshot(this.drafts)).filter(([, d]) => !isEmpty(d)));
    clearTimeout(this.#draftTimer);
    this.#draftTimer = window.setTimeout(() => savePref(`drafts.${projectId}`, kept), 300);
  }

  /** Use a version (its id) or an asset ("asset:" + its id) as a reference in the current draft, or stop. */
  toggleRef(ref: string): void {
    const draft = this.editable;
    const i = draft.refs.indexOf(ref);
    if (i < 0 && this.mode === "edit" && ref === this.selectedId) {
      this.notify(t("toast.selfRef"));
      return;
    }
    if (i >= 0) draft.refs.splice(i, 1);
    else if (draft.refs.length >= MAX_REFS) this.notify(t("toast.maxRefs", { max: MAX_REFS }), true);
    else draft.refs.push(ref);
  }

  // -- the asset library ------------------------------------------------------
  async loadAssets(): Promise<void> {
    try {
      this.assets = await backend.assets();
    } catch (e) {
      this.notify(errorText(e), true);
      return;
    }
    this.#dropMissingAssets();
  }

  /** an asset taken out of the library (here or in another tab) is no longer a reference in any draft */
  #dropMissingAssets(): void {
    for (const draft of Object.values(this.drafts)) {
      const kept = draft.refs.filter((r) => !r.startsWith(ASSET_REF) || this.assetById[r.slice(ASSET_REF.length)]);
      if (kept.length !== draft.refs.length) draft.refs = kept;
    }
  }

  /** Image files into the library; an asset pack (.zip made by Export) is added to it. */
  async addAssets(files: Iterable<File>): Promise<void> {
    const all = [...files];
    for (const pack of all.filter((f) => /\.zip$/i.test(f.name) || f.type === "application/zip")) await this.importAssets(pack);
    const known = new Set(this.assets.map((a) => a.id));
    let added = 0;
    let already: Asset | null = null;
    for (const file of all) {
      if (!file.type.startsWith("image/")) continue;
      try {
        const asset = await backend.addAsset(file);
        if (known.has(asset.id)) already = asset;
        else added++;
        known.add(asset.id);
      } catch (e) {
        this.notify(t("toast.uploadFailed", { name: file.name || t("toast.image"), error: errorText(e) }), true);
        return;
      }
    }
    await this.loadAssets();
    if (added) this.notify(t("toast.assetsAdded", { n: added }));
    else if (already) this.notify(t("toast.assetAlready", { name: already.name }));
  }

  /** The version's image into the library, named after the version. */
  async saveAsAsset(node: TreeNode): Promise<void> {
    const known = new Set(this.assets.map((a) => a.id));
    const name = (node.label.replace(/\.[^.]*$/, "") || `${this.project?.name ?? ""} ${fig(this.versions[node.id])}`).trim().slice(0, 100);
    try {
      const asset = await backend.assetFromNode(node.id, name || t("assets.untitled"));
      await this.loadAssets();
      this.setLibrary(true);
      this.notify(known.has(asset.id) ? t("toast.assetAlready", { name: asset.name }) : t("toast.assetSaved", { name: asset.name }));
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  async renameAsset(asset: Asset): Promise<void> {
    const name = (
      await dialogs.prompt({ title: t("assets.renameTitle"), label: t("assets.name"), value: asset.name, confirmLabel: t("common.save") })
    )?.trim();
    if (!name || name === asset.name) return;
    try {
      await backend.renameAsset(asset.id, name);
      await this.loadAssets();
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  async deleteAsset(asset: Asset): Promise<void> {
    const ok = await dialogs.confirm({
      title: t("assets.deleteTitle", { name: asset.name }),
      message: t("assets.deleteMessage"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await backend.deleteAsset(asset.id);
      await this.loadAssets();
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  /** The asset as a new root version of the current project, selected. */
  async addAssetToProject(asset: Asset): Promise<void> {
    if (!this.projectId) return;
    try {
      const node = await backend.addFromAsset(this.projectId, asset.id);
      this.nodes[node.id] = node;
      this.#touched.set(node.id, ++this.#seq);
      this.select(node.id);
      if (this.layout !== "wide") this.treeOpen = false;
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  /** A new project named after the asset, with it as the first version. */
  async newProjectFromAsset(asset: Asset): Promise<void> {
    try {
      const project = await backend.createProject(asset.name);
      await this.refreshProjects();
      await this.openProject(project.id);
      await this.addAssetToProject(asset);
      await this.refreshProjects();
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  async exportAssets(): Promise<void> {
    try {
      await backend.exportAssets();
      this.notify(t("toast.assetsExported", { n: this.assets.length }));
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  async importAssets(file: File): Promise<void> {
    try {
      const { added, skipped } = await backend.importAssets(file);
      await this.loadAssets();
      this.setLibrary(true);
      this.notify(t("toast.assetsImported", { added, skipped }));
    } catch (e) {
      this.notify(t("toast.importFailed", { name: file.name, error: errorText(e) }), true);
    }
  }

  /** true unless the draft in this slot holds an unsent edit the user wants to keep */
  async #mayReplace(key: string): Promise<boolean> {
    if (isEmpty(this.drafts[key])) return true;
    return dialogs.confirm({
      title: t("reuse.replaceTitle"),
      message: t("reuse.replaceMessage", { fig: key === NEW_DRAFT ? t("reuse.newImage") : fig(this.versions[key]) }),
      confirmLabel: t("reuse.replace"),
    });
  }

  /** put a sent draft back where it was (after Restore, or a failed request) */
  async #restoreDraft(key: string, draft: Draft): Promise<void> {
    if (key !== NEW_DRAFT && !this.nodes[key]) return; // that version is gone
    if (!(await this.#mayReplace(key))) return;
    this.select(key === NEW_DRAFT ? null : key);
    this.drafts[key] = draft;
    delete this.#stacks[key];
    this.#historyTick++;
    if (this.layout === "narrow") this.sheetOpen = true;
  }

  /** load a job's settings into its parent's draft, to adjust and run again */
  async reuseJob(job: Job): Promise<void> {
    const parent = job.parent_id && this.nodes[job.parent_id] ? job.parent_id : null;
    const target = parent ?? NEW_DRAFT;
    if (!(await this.#mayReplace(target))) return;
    this.select(parent);
    if (!parent) this.size = job.size;
    this.drafts[target] = draftOf(job, (ref) => this.refExists(ref));
    delete this.#stacks[target];
    this.#historyTick++;
    this.model = job.model;
    this.n = Math.min(4, job.n);
    this.composite = job.composite || !job.regions.length;
    this.persistPrefs();
    if (this.layout === "narrow") this.sheetOpen = true;
    // the rest are numbered anew: an instruction that names "reference image 2" may need a look
    const gone = job.refs.length - this.drafts[target].refs.length;
    if (gone) this.notify(t("toast.refsDropped", { n: gone }), true);
  }

  /** run the same edit (or prompt) again: more variants under the same parent */
  async variations(job: Job): Promise<void> {
    const parent = job.parent_id && this.nodes[job.parent_id] ? job.parent_id : null;
    if (job.parent_id && !parent) return;
    // without one, the others would be renumbered and the instructions point at the wrong image
    if (!job.refs.every((ref) => this.refExists(ref))) {
      this.notify(t("toast.refsGone"), true);
      return;
    }
    try {
      const sent = await this.#send(`again:${job.id}`, {
        parent_id: parent,
        prompt: job.prompt,
        regions: JSON.parse(JSON.stringify(job.regions)) as Region[],
        refs: [...job.refs],
        model: job.model,
        size: parent ? null : job.size,
        n: this.n,
        composite: job.composite,
      });
      if (sent && (sent.status === "queued" || sent.status === "running")) {
        this.notify(t("toast.variations", { n: sent.n, fig: parent ? fig(this.versions[parent]) : "" }));
      }
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  // -- actions --------------------------------------------------------------
  async submit(): Promise<void> {
    if (this.blocker) return; // the shortcut doesn't go through the button's disabled state
    const editing = this.mode === "edit" && this.selected;
    const key = this.draftKey;
    const draft = $state.snapshot(this.editable) as Draft;
    let cleared = false;
    let job: Job | null;
    try {
      job = await this.#send(
        key,
        {
          parent_id: editing ? this.selected!.id : null,
          prompt: draft.prompt,
          regions: editing ? draft.regions : [],
          refs: [...draft.refs],
          model: this.model.trim(),
          size: editing ? null : this.size,
          n: this.n,
          composite: this.canComposite && this.composite,
        },
        () => {
          // The edit now belongs to the job (and to the versions it makes). Clear it as
          // the request leaves, so whatever is typed while it's in flight is the next edit.
          this.drafts[key] = emptyDraft();
          delete this.#stacks[key];
          this.#historyTick++;
          if (this.draftKey === key) this.selectedRegion = -1;
          cleared = true;
        },
        false,
      );
    } catch (e) {
      if (!cleared) {
        this.notify(errorText(e), true);
      } else if (isEmpty(this.drafts[key])) {
        this.drafts[key] = draft; // nothing typed meanwhile: put the edit back as it was
        this.notify(errorText(e), true);
      } else {
        this.notify(errorText(e), true, {
          label: t("toast.restoreDraft"),
          run: () => void this.#restoreDraft(key, draft),
        });
      }
      return;
    }
    if (!job || job.project_id !== this.projectId) return;
    const status = this.jobs[job.id]?.status ?? job.status;
    // The event stream may already have reported the outcome (a request that
    // fails at once); don't cover that message with "Submitted"
    if (status === "queued" || status === "running") {
      this.notify(job.n > 1 ? t("toast.submittedMany", { n: job.n }) : t("toast.submitted"), false, {
        label: t("toast.restoreDraft"),
        run: () => void this.#restoreDraft(key, draft),
      });
    }
  }

  /**
   * Send a job. Returns null when nothing was sent (no key, or, with ``exclusive``, the same thing is
   * on its way already: a double press); throws if the request fails. ``onStart`` runs right as the
   * request leaves. A draft needn't be exclusive: it is emptied as it leaves, and an empty draft
   * can't be sent, so a second press sends only what was written since. Nothing waits for another
   * request, so a slow network never swallows one.
   */
  async #send(what: string, body: Omit<JobRequest, "project_id" | "lang">, onStart?: () => void, exclusive = true): Promise<Job | null> {
    const projectId = this.projectId;
    if (!projectId || (exclusive && this.isSending(what))) return null;
    if (!this.config?.settings.api_key_set) {
      this.settingsOpen = true;
      return null;
    }
    this.#sending[what] = (this.#sending[what] ?? 0) + 1;
    try {
      onStart?.();
      // the regions as the server knows them: shapes and instruction, nothing client-side
      const regions = body.regions.map((r) => ({ shapes: r.shapes, instruction: r.instruction }));
      const job = await backend.createJob({ ...body, regions, project_id: projectId, lang: i18n.lang });
      // another project may be open by now: the job is that one's
      if (projectId === this.projectId) {
        this.jobs[job.id] ??= job;
        this.#touched.set(job.id, ++this.#seq);
      }
      this.persistPrefs();
      if (this.layout === "narrow") this.sheetOpen = false;
      return job;
    } finally {
      if (--this.#sending[what] <= 0) delete this.#sending[what];
    }
  }

  /** Open project files (.zip made by Export) as new projects. */
  async importProjects(files: Iterable<File>): Promise<void> {
    for (const file of files) {
      try {
        const project = await backend.importProject(file);
        await this.refreshProjects();
        await this.openProject(project.id);
        this.notify(t("toast.imported", { name: project.name }));
      } catch (e) {
        this.notify(t("toast.importFailed", { name: file.name, error: errorText(e) }), true);
      }
    }
  }

  async exportProject(): Promise<void> {
    const project = this.project;
    if (!project) return;
    try {
      await backend.exportProject(project.id);
      this.notify(t("toast.exported", { name: project.name }));
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  /** Images become versions of the current project; a .zip (an exported project) is imported as a new one. */
  async upload(files: Iterable<File>): Promise<void> {
    if (!this.projectId) return;
    const all = [...files];
    const archives = all.filter((f) => /\.zip$/i.test(f.name) || f.type === "application/zip");
    if (archives.length) await this.importProjects(archives);
    let last: TreeNode | null = null;
    for (const file of all) {
      if (!file.type.startsWith("image/")) continue;
      try {
        last = await backend.upload(this.projectId, file);
        this.nodes[last.id] = last;
      } catch (e) {
        this.notify(t("toast.uploadFailed", { name: file.name || t("toast.image"), error: errorText(e) }), true);
      }
    }
    if (last) this.select(last.id);
  }

  async deleteNode(node: TreeNode): Promise<void> {
    let count = 0;
    const stack = [node.id];
    while (stack.length) {
      for (const child of this.children[stack.pop()!] ?? []) {
        count++;
        stack.push(child.id);
      }
    }
    const ok = await dialogs.confirm({
      title: t("node.deleteTitle", { v: this.versions[node.id] ?? "" }),
      message: count ? t("node.deleteWithChildren", { n: count }) : t("node.deleteSingle"),
      confirmLabel: count ? t("node.deleteBranch") : t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    // the selection moves to the parent only if it was in the branch that goes
    const inside = this.lineageIds.has(node.id);
    try {
      await backend.deleteNode(node.id);
      await this.reloadTree();
      if (inside) this.select(node.parent_id && this.nodes[node.parent_id] ? node.parent_id : null);
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  async dismissJob(job: Job): Promise<void> {
    try {
      await backend.deleteJob(job.id);
      delete this.jobs[job.id];
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  /** adopt the pasted-back result or the model's whole output for this version */
  async useRaw(node: TreeNode, useRaw: boolean): Promise<void> {
    try {
      const updated = await backend.patchNode(node.id, { use_raw: useRaw });
      this.nodes[node.id] = updated;
      this.showAlt = false;
      // Regions are in image pixels; they no longer fit a different size (nor does their undo
      // history). What was typed for the whole image, and the references, still apply
      const draft = this.drafts[node.id];
      if (draft && (updated.width !== node.width || updated.height !== node.height)) {
        draft.regions = [];
        this.selectedRegion = -1;
        delete this.#stacks[node.id];
        this.#historyTick++;
      }
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  async toggleStar(node: TreeNode): Promise<void> {
    try {
      this.nodes[node.id] = await backend.patchNode(node.id, { starred: !node.starred });
    } catch (e) {
      this.notify(errorText(e), true);
    }
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    applyTheme(theme);
    savePref("theme", theme);
  }

  persistPrefs(): void {
    savePref("model", this.model);
    savePref("n", this.n);
    savePref("size", this.size);
    savePref("composite", this.composite);
    savePref("tool", this.tool);
    savePref("marquee", this.marquee);
    savePref("lassoKind", this.lassoKind);
    savePref("brushKind", this.brushKind);
    savePref("selectMode", this.selectMode);
    savePref("brushDiameter", this.brushSize);
    savePref("showMadeWith", this.showMadeWith);
    savePref("wheelZoom", this.wheelZoom);
  }

  notify(text: string, error = false, action?: { label: string; run: () => void }): void {
    this.toast = { text, error, action };
    clearTimeout(this.#toastTimer);
    this.#toastTimer = window.setTimeout(() => {
      this.toast = null;
      const next = this.#queued;
      this.#queued = null;
      next?.();
    }, error || action ? 7000 : 3000);
  }

  /** run the toast's action and dismiss it */
  toastAction(): void {
    this.toast?.action?.run();
    this.toast = null;
  }
}

export function describeJob(job: Job): string {
  const parts = job.regions.map((r) => r.instruction.trim()).filter(Boolean);
  if (job.prompt) parts.push(job.prompt);
  return parts.join(t("caption.sep")) || t("caption.empty");
}

export const app = new AppState();
