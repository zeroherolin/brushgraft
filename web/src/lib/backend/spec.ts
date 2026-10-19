// Values shared with the Python side, exported by scripts/export_spec.py
// (python scripts/export_spec.py rewrites generated/spec.json; CI checks it is current).

import raw from "../../generated/spec.json";
import type { ModelInfo } from "../types";

export interface Spec {
  version: string;
  promptbrush_version: string;
  models: ModelInfo[];
  default_model: string;
  lenient_model: string;
  size_presets: string[];
  default_size: string;
  default_base_url: string;
  region_colors: string[];
  max_regions: number;
  /** shapes in one region */
  max_shapes: number;
  /** characters (code points) the request and each instruction may have, and the whole prompt sent */
  max_prompt: number;
  max_instruction: number;
  max_full_prompt: number;
  sizes: {
    /** regular expression source of a valid size: "auto" or "1536x1024" */
    pattern: string;
    multiple: number;
    max_edge: number;
    min_pixels: number;
    max_pixels: number;
    max_aspect: number;
    strict_prefix: string;
  };
  http: {
    max_retries: number;
    retry_backoff: number;
    max_retry_after: number;
    retry_status: number[];
    connect_timeout: number;
    timeout_generate: number;
    timeout_edit: number;
    timeout_download: number;
    max_parallel: number;
    /** error codes that mean content moderation blocked the image, besides HTTP 451 */
    moderation_codes: string[];
    /** ImageAPIError.code of a successful response that holds no image */
    no_image: string;
  };
  prompt: {
    circled: string;
    text: Record<"en" | "zh", Record<string, string>>;
    /** names of region_colors, in the same order */
    colors: Record<"en" | "zh", string[]>;
  };
  archive: {
    format: string;
    version: number;
    max_nodes: number;
    max_file_bytes: number;
    max_total_bytes: number;
    assets_format: string;
    assets_version: number;
    max_assets: number;
  };
  notes: { spill_grown: string; spill_too_large: string; aspect_mismatch: string; reframed: string; paste_failed: string; overall_change: string };
  imaging: {
    aspect_tolerance: number;
    annot_gap: number;
    echo_min_share: number;
    spill_scale: number;
    spill_min_delta: number;
    spill_drift_factor: number;
    spill_near: number;
    bridge_radii: number;
    spill_min_patch: number;
    spill_patch_share: number;
    spill_max_growth: number;
    spill_max_share: number;
    spill_escalate: number;
    spill_note_growth: number;
    align_margin: number;
    align_min_corr: number;
    tone_max_gain: number;
    tone_max_offset: number;
    tone_min_span: number;
    tone_fade: number;
    tone_keep: number;
    api_max_bytes: number;
    ref_max_pixels: number;
    overall_delta: number;
    overall_share: number;
    register_coarse: number;
    register_reach: number;
    register_tile: number;
    register_max_tiles: number;
    register_min_shift: number;
    register_max_spread: number;
    register_near: number;
    piece_blur: number;
    piece_weak: number;
    piece_core: number;
    piece_zone: number;
    /** the farthest a shape's coordinates may lie from the image, in px */
    max_coord: number;
    /** a small edit of a large image is sent as a close-up: see imaging.ZOOM_* */
    zoom_context: number;
    zoom_min_pixels: number;
    zoom_max_share: number;
    zoom_output_pixels: number;
    zoom_max_parts: number;
  };
}

export const spec = raw as Spec;
