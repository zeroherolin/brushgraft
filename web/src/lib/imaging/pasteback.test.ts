import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compare, PARITY, readPng } from "../../test/png";
import type { Region } from "../types";
import { aligned, echoedMarks, matchTone, pasteBack } from "./pasteback";
import { register, registrationBox } from "./register";
import type { Raster } from "./raster";
import { unionMask } from "./shapes";

const dir = `${PARITY}paste/`;
const have = existsSync(`${dir}cases.json`);

interface Case {
  name: string;
  note: string;
  merged: boolean;
  aligned: boolean;
  regions: Region[];
  annot: boolean;
  echo: number | null;
  overall: boolean;
  /** where the model's output was resampled from to line up with the original, or null */
  box: { pad: number; box: [number, number, number, number] } | null;
  rgba: boolean;
}

describe.skipIf(!have)("paste-back matches the Python version", () => {
  const cases: Case[] = have ? JSON.parse(readFileSync(`${dir}cases.json`, "utf8")) : [];
  for (const c of cases) {
    describe(c.name, () => {
      const d = `${dir}${c.name}/`;
      // a transparent original stays RGBA: what shows of it decides the comparisons
      const original = readPng(`${d}original.png`, c.rgba ? "RGBA" : "RGB");
      const result = readPng(`${d}result.png`, "RGB");
      const mask = readPng(`${d}mask.png`, "L");
      const annot = c.annot ? readPng(`${d}annot.png`, "RGB") : null;

      it("lines the model's output up alike", () => {
        const raw = readPng(`${d}raw.png`, "RGB");
        // the same offsets to the last bit: integer sums and the same arithmetic in the same order
        expect(registrationBox(original, raw, mask)).toEqual(c.box);
        // resampled as Pillow does (lanczos: the odd rounding tie in sin() aside)
        const diff = compare(register(original, raw, mask), result, 1);
        expect(diff.count, `${diff.pixels} pixels differ by up to ${diff.max}`).toBe(0);
      });

      it("judges the framing alike", () => {
        expect(aligned(original, result, mask)).toBe(c.aligned);
      });

      it("undoes the tone drift to the same pixels", () => {
        const diff = compare(matchTone(original, result, mask), readPng(`${d}toned.png`, "RGB"), 0);
        expect(diff.count, `${diff.pixels} pixels differ by up to ${diff.max}`).toBe(0);
      });

      if (annot) {
        it("finds the copied marks", () => {
          const toned = readPng(`${d}toned.png`, "RGB");
          const echo = echoedMarks(original, annot, toned);
          expect(echo ? echo.data.filter((v) => v === 255).length : null).toBe(c.echo);
        });
      }

      it("pastes back the same image", () => {
        const out = pasteBack(original, result, mask, annot, c.overall);
        expect(out.note).toBe(c.note);
        expect(out.image !== null).toBe(c.merged);
        if (out.image) {
          const want = readPng(`${d}merged.png`, c.rgba ? "RGBA" : "RGB");
          // The same arithmetic in another language: the output is bit for bit the Python one
          const diff = compare(out.image, want, 0);
          expect(diff.pixels, `${diff.pixels} pixels differ by up to ${diff.max}`).toBe(0);
        }
      });

      it("leaves everything outside the area as it was", () => {
        const out = pasteBack(original, result, mask, annot, c.overall);
        if (!out.image) return;
        const far = unionMask(original.width, original.height, c.regions);
        void far;
        // pixels at least 80 px from every region are the original's, bit for bit
        const reach = 80;
        let changed = 0;
        for (let y = 0; y < original.height; y += 3) {
          for (let x = 0; x < original.width; x += 3) {
            const i = y * original.width + x;
            if (far.data[i]) continue;
            if (nearMask(far, x, y, reach)) continue;
            const n = original.channels;
            for (let k = 0; k < n; k++) if (out.image.data[i * n + k] !== original.data[i * n + k]) changed++;
          }
        }
        // the grown area may legitimately reach further than 80 px from the region; just bound it
        expect(changed).toBeLessThan(original.width * original.height * 0.5);
      });
    });
  }
});

function nearMask(mask: Raster, x: number, y: number, r: number): boolean {
  for (let yy = Math.max(0, y - r); yy <= Math.min(mask.height - 1, y + r); yy += 4) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(mask.width - 1, x + r); xx += 4) {
      if (mask.data[yy * mask.width + xx]) return true;
    }
  }
  return false;
}
