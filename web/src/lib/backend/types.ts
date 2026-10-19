// What the UI needs from "somewhere that keeps projects and runs edits". The
// server backend talks to a local brushgraft over HTTP; the browser backend
// keeps everything in this browser (IndexedDB) and calls the image API itself.
// The UI doesn't know which one it has, beyond `kind` for the few words that differ.

import type { Asset, Config, Job, LogLine, Project, Region, Settings, ServerEvent, TreeNode } from "../types";

export interface JobRequest {
  project_id: string;
  parent_id: string | null;
  prompt: string;
  regions: Region[];
  refs: string[];
  model: string;
  size: string | null;
  n: number;
  composite: boolean;
  /** language of the text wrapped around the prompt */
  lang: "en" | "zh";
}

export interface SettingsUpdate {
  api_key?: string;
  base_url?: string;
  /** browser backend: keep the key on this device (true) or for this tab's session only (false) */
  remember?: boolean;
}

export interface StorageInfo {
  /** bytes this site stores in the browser */
  used: number;
  /** bytes the browser allows, when it says */
  quota: number | null;
  /** the browser promised not to evict the data */
  persistent: boolean;
}

export interface Subscription {
  /** a live event; events that happened while disconnected are lost, so reload on ``open`` */
  event(ev: ServerEvent): void;
  /** connected (also after a reconnect) */
  open(): void;
  /** the connection dropped; the backend retries by itself */
  error(): void;
}

export interface Backend {
  readonly kind: "server" | "browser";

  /** Get ready (the server backend trades the ?token= link for a session) and return the config. */
  start(): Promise<Config>;
  saveSettings(body: SettingsUpdate): Promise<Settings>;
  /** browser backend only: ask the API whether the key and base URL work; throws with the reason if not */
  testConnection?(): Promise<void>;

  projects(): Promise<Project[]>;
  createProject(name: string): Promise<Project>;
  renameProject(id: string, name: string): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  tree(id: string): Promise<{ nodes: TreeNode[]; jobs: Job[] }>;
  /** the whole project (versions, edit settings, every image) as a .zip the user saves */
  exportProject(id: string): Promise<void>;
  /** a .zip made by exportProject, as a new project */
  importProject(file: File): Promise<Project>;

  upload(projectId: string, file: File): Promise<TreeNode>;
  patchNode(id: string, body: { starred?: boolean; label?: string; use_raw?: boolean }): Promise<TreeNode>;
  deleteNode(id: string): Promise<void>;

  /** the asset library, newest first: images every project can use */
  assets(): Promise<Asset[]>;
  /** an image file into the library; one already there is returned as it is */
  addAsset(file: File): Promise<Asset>;
  /** a version's image into the library, under ``name`` */
  assetFromNode(nodeId: string, name: string): Promise<Asset>;
  renameAsset(id: string, name: string): Promise<Asset>;
  /** out of the library; versions made with it keep its image */
  deleteAsset(id: string): Promise<void>;
  /** an asset as a new root version of a project */
  addFromAsset(projectId: string, assetId: string): Promise<TreeNode>;
  /** the whole library as a .zip the user saves */
  exportAssets(): Promise<void>;
  /** a .zip made by exportAssets into the library; images already there are skipped */
  importAssets(file: File): Promise<{ added: number; skipped: number }>;

  createJob(body: JobRequest): Promise<Job>;
  deleteJob(id: string): Promise<void>;
  logs(jobId: string): Promise<LogLine[]>;

  subscribe(handlers: Subscription): () => void;

  /** A URL the image loads from: a plain one on the server, a blob URL (kept by the backend) in the browser */
  imageSrc(sha: string): Promise<string>;
  thumbSrc(sha: string): Promise<string>;
  /** hand the image to the user as a file; ``name`` has no extension */
  download(sha: string, name: string): Promise<void>;
  /** the image's bytes, typed (PNG, JPEG or WebP) */
  imageBlob(sha: string): Promise<Blob>;

  /** browser backend only: how much space the data takes, and a request that the browser keep it */
  storage?(): Promise<StorageInfo | null>;
  persistStorage?(): Promise<boolean>;
}
