import { describe, expect, it } from "vitest";
import spec from "../../generated/spec.json";

describe("spec", () => {
  it("is loaded from the generated file", () => {
    expect(spec.models.length).toBeGreaterThan(5);
    expect(spec.prompt.circled).toHaveLength(spec.max_regions);
  });
});
