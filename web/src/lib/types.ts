// Types matching the server's JSON. Coordinates are original-image pixels.

export type Point = [number, number];

/** How a shape combines with the shapes before it in its region: add (default), subtract, intersect */
export type ShapeOp = "add" | "subtract" | "intersect";

export type Shape = (
  | { type: "rect"; x: number; y: number; w: number; h: number }
  | { type: "ellipse"; x: number; y: number; w: number; h: number }
  | { type: "lasso"; points: Point[] }
  | { type: "brush"; points: Point[]; radius: number }
) & { op?: ShapeOp };

export interface Region {
  shapes: Shape[];
  instruction: string;
  /** client-side identity, kept across undo; never sent */
  uid?: string;
}

export interface ModelInfo {
  name: string;
  seconds: string;
  size: "exact" | "aspect" | "fixed";
  aligned: boolean;
  mask: boolean;
  note: string;
}

export interface Settings {
  api_key_set: boolean;
  api_key_source: "env" | "file" | "";
  base_url: string;
  base_url_source: "env" | "file" | "";
  env_file: string;
  /** browser build: the key is kept on this device (true) or until this tab closes (false) */
  remember?: boolean;
}

export interface Config {
  version: string;
  promptbrush_version: string;
  models: ModelInfo[];
  default_model: string;
  lenient_model: string;
  size_presets: string[];
  default_size: string;
  region_colors: string[];
  max_regions: number;
  settings: Settings;
  home: string;
}

export interface Project {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  node_count?: number;
}

export interface TreeNode {
  id: string;
  project_id: string;
  parent_id: string | null;
  job_id: string | null;
  /** the adopted image */
  image: string;
  /** the model's whole output (when pasted back) */
  raw_image: string | null;
  /** the pasted-back result (when pasted back) */
  merged_image: string | null;
  /** a note code, see note.* in the locales */
  note: string;
  /** for an edit sent in several requests: what each made on its own, to be looked at */
  parts: NodePart[];
  label: string;
  starred: boolean;
  width: number;
  height: number;
  created_at: number;
}

/** What one request of an edit sent in parts made: images to put on the parent's image at [x, y]. */
export interface NodePart {
  /** its index in the job's requests */
  request: number;
  note: string;
  usage: Record<string, number> | null;
  /** its output, lined up with the original */
  raw_image: string | null;
  raw_at: [number, number] | null;
  /** its regions pasted back; null when they couldn't be */
  merged_image: string | null;
  merged_at: [number, number] | null;
}

export interface JobError {
  /** see jobError.* in the locales */
  code: string;
  /** raw detail from the API or exception, in English */
  detail: string;
  /** "2/3" when the job made several images */
  variant: string;
}

export type JobStatus = "queued" | "running" | "done" | "failed";

/** One request of an edit sent in parts. */
export interface SentRequest {
  prompt: string;
  /** the close-up sent; null for the whole image */
  box: [number, number, number, number] | null;
  /** the regions it showed, by index (missing from older records) */
  regions?: number[];
  size: string;
  /** the annotated image sent */
  annot_image: string | null;
}

export interface Job {
  id: string;
  project_id: string;
  parent_id: string | null;
  kind: "generate" | "edit";
  prompt: string;
  full_prompt: string;
  regions: Region[];
  /** versions of the project by id, and assets as "asset:" + id; in the order they were sent */
  refs: string[];
  /** each reference's image as it was sent (null: not known, from before this was recorded) */
  ref_images: (string | null)[];
  model: string;
  size: string;
  n: number;
  composite: boolean;
  mask_image: string | null;
  annot_image: string | null;
  /** an edit sent in parts (close-ups of its regions): each request, in the order sent; else empty */
  requests: SentRequest[];
  status: JobStatus;
  done: number;
  failed: number;
  errors: (JobError | string)[];
  usage: Record<string, number> | null;
  created_at: number;
  finished_at: number | null;
}

export interface LogLine {
  t: number;
  level: string;
  msg: string;
}

export type ServerEvent =
  | { type: "node"; node: TreeNode }
  | { type: "job"; job: Job }
  | ({ type: "log"; job_id: string } & LogLine)
  | { type: "tree"; project_id: string }
  | { type: "assets" };

/** An image in the asset library: every project can use it */
export interface Asset {
  id: string;
  name: string;
  image: string;
  width: number;
  height: number;
  created_at: number;
}

/** A job's reference to an asset: "asset:" + its id (anything else is a version's id) */
export const ASSET_REF = "asset:";
