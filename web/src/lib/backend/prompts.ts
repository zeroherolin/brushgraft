// The prompt sent to the model: region instructions and the overall request, wrapped in text that
// explains each image by position, and each box by number and color. A port of
// brushgraft.prompts.compile_prompt; the texts come from generated/spec.json.

import { spec } from "./spec";
import { userError } from "./errors";
import type { Region } from "../types";

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));

/** A text's length as Python's len counts it (code points), so both builds agree on the limits. */
export const charCount = (text: string): number => {
  let n = 0;
  for (const _ of text) n++;
  return n;
};

/** The whole prompt to send, if it isn't too long for the API altogether. */
function checked(full: string): string {
  const length = charCount(full);
  if (length > spec.max_full_prompt) {
    throw userError(
      "full_prompt_too_long",
      `The instructions and the request together can have at most about ${spec.max_full_prompt} characters`,
      { max: spec.max_full_prompt, length },
    );
  }
  return full;
}

export function compilePrompt(
  promptIn: string,
  regions: Pick<Region, "instruction">[],
  // numbers: each region's place among all of an edit's (from 0), when only some are sent (a
  // close-up): it keeps its number and color, as in annotate
  opts: { hasParent: boolean; refCount?: number; lang?: "en" | "zh"; numbers?: number[] },
): string {
  const prompt = promptIn.trim();
  const refCount = opts.refCount ?? 0;
  const instructions = regions.map((r) => (r.instruction ?? "").trim());
  const max = spec.max_regions;
  if (regions.length && !opts.hasParent) {
    throw userError("regions_need_parent", "Regions can only be used when editing an existing image");
  }
  if (regions.length > max) throw userError("too_many_regions", `At most ${max} regions are allowed`, { max });
  if (!prompt && !regions.length) throw userError("prompt_required", "Write a prompt");
  if (!prompt && !instructions.every(Boolean)) {
    throw userError("instruction_required", "Write an instruction for every region, or an overall request");
  }
  const promptLength = charCount(prompt);
  if (promptLength > spec.max_prompt) {
    throw userError("prompt_too_long", `The prompt can have at most ${spec.max_prompt} characters`, { max: spec.max_prompt, length: promptLength });
  }
  instructions.forEach((instruction, k) => {
    const length = charCount(instruction);
    if (length > spec.max_instruction) {
      throw userError("instruction_too_long", `Region ${k + 1}'s instruction can have at most ${spec.max_instruction} characters`, {
        k: k + 1,
        max: spec.max_instruction,
        length,
      });
    }
  });

  const text = spec.prompt.text[opts.lang ?? "en"];
  const refs = Array.from({ length: refCount }, (_, k) => fill(text.ref, { k: k + 1 })).join(text.sep);
  if (!opts.hasParent) return refCount ? `${fill(text.gen_refs, { refs })}\n${prompt}` : prompt;
  if (!regions.length) return refCount ? `${fill(text.edit_refs, { refs })}\n${prompt}` : prompt;

  const lines = [text.intro];
  if (refCount) lines.push(fill(text.region_refs, { refs }));
  lines.push(text.lead);
  const colors = spec.prompt.colors[opts.lang ?? "en"];
  instructions.forEach((instruction, i) => {
    const k = opts.numbers ? opts.numbers[i] : i;
    lines.push(
      fill(text.region, {
        k: k + 1,
        circled: [...spec.prompt.circled][k],
        color: colors[k % colors.length],
        text: instruction || text.region_default,
      }),
    );
  });
  // An overall request may change things outside the boxes (a new sky): the closing line
  // must not forbid what it asks for
  if (prompt) lines.push(fill(text.overall, { text: prompt }));
  lines.push(prompt ? text.outro_overall : text.outro);
  return checked(lines.join("\n"));
}
