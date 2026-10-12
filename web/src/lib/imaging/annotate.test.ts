import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PARITY, readPng } from "../../test/png";
import { testCodec } from "../../test/codec";
import type { Region } from "../types";
import { annotate, annotationLayout, badgeCenter } from "./annotate";
import { annotationBadge } from "./pasteback";
import { unionMask } from "./shapes";

const dir = `${PARITY}masks/`;
const have = existsSync(`${dir}cases.json`);

interface Case {
  size: [number, number];
  regions: Region[];
  badges: [number, number][];
  badge: number;
  exact: boolean;
}

describe.skipIf(!have)("annotation boxes match Python's", () => {
  const cases: Case[] = have ? JSON.parse(readFileSync(`${dir}cases.json`, "utf8")) : [];
  cases.forEach((c, k) => {
    it(`${k}: ${c.regions.length} region(s) on ${c.size.join("x")}`, async () => {
      const got = await annotate(testCodec, readPng(`${dir}${k}_orig.png`, "RGB"), c.regions);
      const want = readPng(`${dir}${k}_annot.png`, "RGB");
      // Compare away from the badges: their numbers use another font, their discs another edge rule
      const near = (x: number, y: number) => c.badges.some(([bx, by]) => Math.abs(x - bx) <= c.badge + 3 && Math.abs(y - by) <= c.badge + 3);
      let different = 0;
      let drawn = 0;
      for (let y = 0; y < got.height; y++) {
        for (let x = 0; x < got.width; x++) {
          if (near(x, y)) continue;
          const i = (y * got.width + x) * 3;
          if (got.data[i] !== want.data[i] || got.data[i + 1] !== want.data[i + 1] || got.data[i + 2] !== want.data[i + 2]) different++;
          drawn++;
        }
      }
      if (c.exact) {
        expect(different, `${different} of ${drawn} pixels outside the badges differ`).toBe(0);
        // the numbers sit where Python puts them (off the regions, at the image's edge too)
        const [w, h] = c.size;
        const occupied = unionMask(w, h, c.regions);
        const placed = annotationLayout(w, h, c.regions)
          .filter((l) => l.ring)
          .map((l) => badgeCenter(occupied, l.anchors, annotationBadge(w, h)));
        expect(placed).toEqual(c.badges);
      } else {
        // A brush or lasso outline can differ from Pillow's by a pixel (see shapes.test.ts), which
        // moves a box edge by a pixel: a couple of rows or columns of its length
        expect(different, `${different} of ${drawn} pixels outside the badges differ`).toBeLessThan(8 * (got.width + got.height));
      }
    });
  });
});
