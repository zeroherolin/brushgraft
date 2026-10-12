// Size rules of the image API, as promptbrush.check_size and fit_size.

import { spec } from "./spec";
import { userError } from "./errors";
import { roundHalfEven } from "../imaging/stats";

const S = spec.sizes;
export const SIZE_PATTERN = new RegExp(S.pattern);

function sizeProblems(w: number, h: number): string[] {
  const problems: string[] = [];
  if (w % S.multiple || h % S.multiple) problems.push(`width and height must be multiples of ${S.multiple}`);
  if (Math.max(w, h) > S.max_edge) problems.push(`each side must be at most ${S.max_edge}`);
  if (Math.max(w, h) / Math.min(w, h) > S.max_aspect) problems.push(`aspect ratio must be at most ${S.max_aspect.toFixed(0)}:1`);
  if (!(S.min_pixels <= w * h && w * h <= S.max_pixels)) {
    problems.push(`total pixels must be between ${S.min_pixels.toLocaleString("en-US")} and ${S.max_pixels.toLocaleString("en-US")}`);
  }
  return problems;
}

/**
 * Check a size against the measured rules: throws for strict models, returns a warning
 * for the others when the aspect ratio is beyond what they were seen to render.
 */
export function checkSize(model: string, size: string): string | null {
  if (size === "auto") return null;
  const [w, h] = size.split("x").map(Number);
  if (!model.startsWith(S.strict_prefix)) {
    const ratio = Math.max(w, h) / Math.min(w, h);
    return ratio > S.max_aspect
      ? `Aspect ratio ${ratio.toFixed(1)}:1 exceeds ${S.max_aspect.toFixed(0)}:1; in testing the server did not render at this ratio`
      : null;
  }
  const problems = sizeProblems(w, h);
  if (problems.length) {
    const detail =
      `${model} does not support size ${size}: ${problems.join("; ")}. ` +
      "Common valid sizes: 1024x1024, 1536x1024, 1600x1200, 3840x2160 or auto";
    throw userError("size_invalid", detail, { detail, model, size });
  }
  return null;
}

/** Any width and height as a ``WxH`` size every model accepts, keeping the aspect ratio and pixel count as close as possible. */
export function fitSize(width: number, height: number): string {
  if (width < 1 || height < 1) throw new Error(`Invalid width/height: ${width}x${height}`);
  const ratio = Math.min(Math.max(width / height, 1 / S.max_aspect), S.max_aspect);
  const pixels = Math.min(Math.max(width * height, S.min_pixels), S.max_pixels);
  const h = Math.sqrt(pixels / ratio);
  const w = h * ratio;
  const shrink = Math.min(1, S.max_edge / Math.max(w, h));
  const w0 = roundHalfEven((w * shrink) / S.multiple);
  const h0 = roundHalfEven((h * shrink) / S.multiple);
  let best: { score: [number, number]; w: number; h: number } | null = null;
  for (let dw = -3; dw <= 3; dw++) {
    for (let dh = -3; dh <= 3; dh++) {
      const cw = (w0 + dw) * S.multiple;
      const ch = (h0 + dh) * S.multiple;
      if (cw < 1 || ch < 1 || sizeProblems(cw, ch).length) continue;
      const score: [number, number] = [Math.abs(Math.log(cw / ch / ratio)), Math.abs(cw * ch - pixels)];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) {
        best = { score, w: cw, h: ch };
      }
    }
  }
  if (!best) throw new Error("there is always a valid size nearby");
  return `${best.w}x${best.h}`;
}
