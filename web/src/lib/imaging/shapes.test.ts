import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PARITY, readPng } from "../../test/png";
import type { Region } from "../types";
import { unionMask } from "./shapes";

const dir = `${PARITY}masks/`;
const have = existsSync(`${dir}cases.json`);

describe.skipIf(!have)("region masks match Pillow's", () => {
  const cases: { size: [number, number]; regions: Region[] }[] = have ? JSON.parse(readFileSync(`${dir}cases.json`, "utf8")) : [];
  cases.forEach((c, k) => {
    it(`${k}: ${c.regions.map((r) => r.shapes[0].type).join("+")} on ${c.size.join("x")}`, () => {
      const got = unionMask(c.size[0], c.size[1], c.regions);
      const want = readPng(`${dir}${k}.png`, "L");
      const [w, h] = c.size;
      let inside = 0;
      const far: number[] = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (want.data[i]) inside++;
          if (!got.data[i] === !want.data[i]) continue;
          // Pillow's polygon, ellipse and wide-line joint rules are quirky: a pixel or two of outline
          // either way is expected, and the paste-back feathers that edge away. Anything else is a
          // real difference.
          let on = false;
          let off = false;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
              if (want.data[yy * w + xx]) on = true;
              else off = true;
            }
          }
          if (!(on && off)) far.push(i);
        }
      }
      expect(inside).toBeGreaterThan(0);
      expect(far.length, `${far.length} pixels differ away from the outline`).toBe(0);
    });
  });
});

describe("shapes", () => {
  it("fills a rectangle through both end pixels, as Pillow does", () => {
    const m = unionMask(10, 10, [{ shapes: [{ type: "rect", x: 2, y: 3, w: 4, h: 2 }] }]);
    const rows = [...Array(10).keys()].map((y) => [...Array(10).keys()].filter((x) => m.data[y * 10 + x]).join(""));
    expect(rows[2]).toBe("");
    expect(rows[3]).toBe("23456");
    expect(rows[5]).toBe("23456");
    expect(rows[6]).toBe("");
  });

  it("keeps a lasso's outline and clips at the image edge", () => {
    const m = unionMask(8, 8, [{ shapes: [{ type: "lasso", points: [[-5, -5], [4, 0], [0, 4]] }] }]);
    expect(m.data[0]).toBe(255);
    expect(m.data.length).toBe(64);
  });

  it("draws a brush stroke as a round-ended band", () => {
    const m = unionMask(60, 30, [{ shapes: [{ type: "brush", radius: 5, points: [[10, 15], [50, 15]] }] }]);
    const at = (x: number, y: number) => m.data[y * 60 + x];
    expect(at(30, 15)).toBe(255);
    expect(at(30, 10)).toBe(255);
    expect(at(30, 9)).toBe(0);
    expect(at(6, 15)).toBe(255); // round cap
    expect(at(4, 15)).toBe(0);
  });
});
