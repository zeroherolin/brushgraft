import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PARITY } from "../../test/png";
import { ApiError } from "./errors";
import { compilePrompt } from "./prompts";
import { checkSize, fitSize } from "./sizes";
import { zoomBox, zoomSize } from "../imaging/zoom";

const file = `${PARITY}rules/rules.json`;
const have = existsSync(file);
const data = have ? JSON.parse(readFileSync(file, "utf8")) : { prompts: [], sizes: [], checks: [] };

describe.skipIf(!have)("prompts and size rules match Python's", () => {
  it("compiles every prompt the same", () => {
    for (const c of data.prompts) {
      const run = () => compilePrompt(c.prompt, c.regions, { hasParent: c.parent, refCount: c.refs, lang: c.lang });
      if (c.error) {
        let caught: unknown;
        try {
          run();
        } catch (e) {
          caught = e;
        }
        expect(caught, JSON.stringify(c)).toBeInstanceOf(ApiError);
        const e = caught as ApiError;
        expect([e.code, e.params, e.message], JSON.stringify(c)).toEqual([c.error, c.params, c.message]);
      } else {
        expect(run(), JSON.stringify(c)).toBe(c.text);
      }
    }
    expect(data.prompts.length).toBeGreaterThan(400);
  });

  it("fits every size the same", () => {
    for (const c of data.sizes) expect(fitSize(c.w, c.h), `${c.w}x${c.h}`).toBe(c.fit);
  });

  it("picks the same close-up for a small edit, asked for in the same size", () => {
    for (const c of data.zooms) {
      const zoom = zoomBox(c.size[0], c.size[1], c.box);
      expect(zoom, JSON.stringify(c)).toEqual(c.zoom);
      if (zoom) expect(zoomSize(zoom), JSON.stringify(c)).toBe(c.output);
    }
    expect(data.zooms.filter((c: { zoom: unknown }) => c.zoom).length).toBeGreaterThan(5);
  });

  it("checks sizes the same", () => {
    for (const c of data.checks) {
      if (c.ok) expect(() => checkSize(c.model, c.size), `${c.model} ${c.size}`).not.toThrow();
      else expect(() => checkSize(c.model, c.size), `${c.model} ${c.size}`).toThrow(c.message);
    }
  });
});
