import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compare, PARITY, readPng } from "../../test/png";
import { gaussianBlur, resize, resizeNearest, toGray, type Raster } from "./raster";

const dir = `${PARITY}primitives/`;
const have = existsSync(`${dir}cases.json`);

interface Case {
  op: string;
  args: { radius?: number; size?: [number, number]; box?: [number, number, number, number] };
  in: { file: string; mode: "L" | "RGB" | "RGBA" };
  out: { file: string; mode: "L" | "RGB" | "RGBA" };
}

// Fixtures come from `python scripts/parity_fixtures.py`; the web tests need them (CI makes them first)
describe.skipIf(!have)("pixel operations match Pillow", () => {
  const cases: Case[] = have ? JSON.parse(readFileSync(`${dir}cases.json`, "utf8")) : [];
  const run = (c: Case, im: Raster): Raster => {
    switch (c.op) {
      case "blur":
        return gaussianBlur(im, c.args.radius!);
      case "box":
        return resize(im, ...c.args.size!, "box");
      case "bilinear":
        return resize(im, ...c.args.size!, "bilinear");
      case "lanczos":
        return resize(im, ...c.args.size!, "lanczos", c.args.box);
      case "nearest":
        return resizeNearest(im, ...c.args.size!);
      case "gray":
        return toGray(im);
      default:
        throw new Error(c.op);
    }
  };
  cases.forEach((c, k) => {
    const label = `${c.op} ${JSON.stringify(c.args)} on ${c.in.mode}`;
    it(`${k}: ${label}`, () => {
      const got = run(c, readPng(`${dir}${c.in.file}`, c.in.mode));
      const want = readPng(`${dir}${c.out.file}`, c.out.mode);
      // Filters in float math: the integer pipeline is the same, so results are identical, bar
      // the odd rounding tie in sin()
      const diff = compare(got, want, c.op === "lanczos" ? 1 : 0);
      expect(diff.count, `${diff.pixels} pixels differ, by up to ${diff.max}`).toBe(0);
    });
  });
});
