import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testCodec } from "../../test/codec";
import { compare, decodePng, PARITY, readPng } from "../../test/png";
import { mergeParts } from "./ops";

const dir = `${PARITY}parts/`;
const have = existsSync(`${dir}cases.json`);

interface Case {
  name: string;
  overall: boolean;
  note: string;
  merged: boolean;
  boxes: ([number, number, number, number] | null)[];
  parts: { raw_at: [number, number]; merged_at: [number, number] | null; note: string }[];
}

describe.skipIf(!have)("an edit sent in parts is put together as in Python", () => {
  const cases: Case[] = have ? JSON.parse(readFileSync(`${dir}cases.json`, "utf8")) : [];
  for (const c of cases) {
    it(c.name, async () => {
      const d = `${dir}${c.name}/`;
      const bytes = (file: string) => new Uint8Array(readFileSync(`${d}${file}`));
      const out = await mergeParts(testCodec, {
        parent: bytes("full.png"),
        pieces: c.boxes.map((box, k) => ({ box, result: bytes(`out${k}.png`), mask: bytes(`mask${k}.png`), annot: bytes(`annot${k}.png`) })),
        overall: c.overall,
        askWhole: false,
      });
      expect(out.note).toBe(c.note);
      expect(!!out.merged).toBe(c.merged);
      const same = (got: Uint8Array, file: string) => {
        const diff = compare(decodePng(Buffer.from(got), "RGB"), readPng(`${d}${file}`, "RGB"), 0);
        expect(diff.pixels, `${file}: ${diff.pixels} pixels differ by up to ${diff.max}`).toBe(0);
      };
      if (out.merged) {
        same(out.merged, "merged.png");
        same(out.raw!, "raw.png");
      }
      // what each request made on its own, for Version details
      expect(out.parts!.map((p) => [p.rawAt, p.mergedAt, p.note])).toEqual(c.parts.map((p) => [p.raw_at, p.merged_at, p.note]));
      out.parts!.forEach((p, k) => {
        same(p.raw, `part${k}_raw.png`);
        if (p.merged) same(p.merged, `part${k}_merged.png`);
      });
    }, 60_000); // a 2400 x 1600 image, pasted back a few times over
  }
});
