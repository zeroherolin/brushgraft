// The backend of the local server: brushgraft's HTTP API, image URLs and the
// event stream. A thin layer; the server does the work.

import type { Asset, Config, Job, LogLine, Project, ServerEvent, Settings, TreeNode } from "../types";
import { ApiError } from "./errors";
import type { Backend, JobRequest, SettingsUpdate, Subscription } from "./types";

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const resp = await fetch(url, init);
  if (!resp.ok) throw await failure(resp);
  return resp.status === 204 ? (undefined as T) : resp.json();
}

async function failure(resp: Response): Promise<ApiError> {
  let detail = `${resp.status} ${resp.statusText}`;
  let code = "";
  let params = {};
  try {
    const data = await resp.json();
    if (typeof data.detail === "string") detail = data.detail;
    if (typeof data.code === "string") code = data.code;
    if (data.params && typeof data.params === "object") params = data.params;
  } catch {
    // not JSON: keep the status line
  }
  return new ApiError(detail, resp.status, code, params);
}

/**
 * The file name a Content-Disposition gives: ``filename*`` (UTF-8, RFC 6266: names in any
 * language) when there is one, else ``filename``.
 */
export function dispositionName(header: string | null, fallback: string): string {
  const star = /filename\*\s*=\s*UTF-8''([^;\s]+)/i.exec(header ?? "")?.[1];
  if (star) {
    try {
      return decodeURIComponent(star);
    } catch {
      // a broken escape: use the plain name
    }
  }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(header ?? "")?.[1] ?? fallback;
}

/** Save a response body the way a download link would. */
function saveAs(href: string, name: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}

export class ServerBackend implements Backend {
  readonly kind = "server" as const;

  async start(): Promise<Config> {
    const url = new URL(location.href);
    const token = url.searchParams.get("token");
    if (token) {
      try {
        await request<void>("POST", "/api/session", { token });
      } catch {
        // a wrong token shows up when reading the config below
      }
      url.searchParams.delete("token");
      history.replaceState(null, "", url);
    }
    return request<Config>("GET", "/api/config");
  }

  saveSettings(body: SettingsUpdate): Promise<Settings> {
    const { api_key, base_url } = body;
    return request<Settings>("PUT", "/api/settings", { api_key, base_url });
  }

  projects = () => request<Project[]>("GET", "/api/projects");
  createProject = (name: string) => request<Project>("POST", "/api/projects", { name });
  renameProject = (id: string, name: string) => request<Project>("PATCH", `/api/projects/${id}`, { name });
  deleteProject = (id: string) => request<void>("DELETE", `/api/projects/${id}`);
  tree = (id: string) => request<{ nodes: TreeNode[]; jobs: Job[] }>("GET", `/api/projects/${id}/tree`);

  async exportProject(id: string): Promise<void> {
    const resp = await fetch(`/api/projects/${id}/export`, { credentials: "same-origin" });
    if (!resp.ok) throw await failure(resp);
    const name = dispositionName(resp.headers.get("Content-Disposition"), "brushgraft-project.zip");
    const href = URL.createObjectURL(await resp.blob());
    saveAs(href, name);
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }

  importProject(file: File): Promise<Project> {
    const form = new FormData();
    form.append("file", file);
    return request<Project>("POST", "/api/projects/import", form);
  }

  upload(projectId: string, file: File): Promise<TreeNode> {
    const form = new FormData();
    form.append("file", file);
    return request<TreeNode>("POST", `/api/projects/${projectId}/uploads`, form);
  }

  patchNode = (id: string, body: { starred?: boolean; label?: string; use_raw?: boolean }) =>
    request<TreeNode>("PATCH", `/api/nodes/${id}`, body);
  deleteNode = (id: string) => request<void>("DELETE", `/api/nodes/${id}`);

  addFromAsset = (projectId: string, assetId: string) =>
    request<TreeNode>("POST", `/api/projects/${projectId}/from-asset`, { asset_id: assetId });

  assets = () => request<Asset[]>("GET", "/api/assets");

  addAsset(file: File): Promise<Asset> {
    const form = new FormData();
    form.append("file", file);
    return request<Asset>("POST", "/api/assets", form);
  }

  assetFromNode = (nodeId: string, name: string) => request<Asset>("POST", "/api/assets/from-node", { node_id: nodeId, name });
  renameAsset = (id: string, name: string) => request<Asset>("PATCH", `/api/assets/${id}`, { name });
  deleteAsset = (id: string) => request<void>("DELETE", `/api/assets/${id}`);

  async exportAssets(): Promise<void> {
    const resp = await fetch("/api/assets/export", { credentials: "same-origin" });
    if (!resp.ok) throw await failure(resp);
    const href = URL.createObjectURL(await resp.blob());
    saveAs(href, dispositionName(resp.headers.get("Content-Disposition"), "brushgraft-assets.zip"));
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }

  importAssets(file: File): Promise<{ added: number; skipped: number }> {
    const form = new FormData();
    form.append("file", file);
    return request("POST", "/api/assets/import", form);
  }

  createJob = (body: JobRequest) => request<Job>("POST", "/api/jobs", body);
  deleteJob = (id: string) => request<void>("DELETE", `/api/jobs/${id}`);
  logs = (jobId: string) => request<LogLine[]>("GET", `/api/jobs/${jobId}/logs`);

  subscribe(handlers: Subscription): () => void {
    const source = new EventSource("/api/events");
    source.onopen = () => handlers.open();
    source.onerror = () => handlers.error();
    source.onmessage = (msg) => handlers.event(JSON.parse(msg.data) as ServerEvent);
    return () => source.close();
  }

  imageSrc = async (sha: string) => `/api/images/${sha}`;
  thumbSrc = async (sha: string) => `/api/thumbs/${sha}`;

  async download(sha: string, name: string): Promise<void> {
    saveAs(`/api/images/${sha}?download=${encodeURIComponent(name)}`, name);
  }

  async imageBlob(sha: string): Promise<Blob> {
    const resp = await fetch(`/api/images/${sha}`, { credentials: "same-origin" });
    if (!resp.ok) throw await failure(resp);
    return resp.blob();
  }
}
