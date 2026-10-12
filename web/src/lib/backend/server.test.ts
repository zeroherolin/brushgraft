import { describe, expect, it } from "vitest";
import { dispositionName } from "./server";

describe("the name of a download, from Content-Disposition", () => {
  it("prefers the UTF-8 name, so a project named in Chinese keeps its name", () => {
    const header = "attachment; filename=\"brushgraft-___.zip\"; filename*=UTF-8''brushgraft-%E5%B0%8F%E7%8C%AB.zip";
    expect(dispositionName(header, "x.zip")).toBe("brushgraft-小猫.zip");
  });
  it("reads a plain name, and falls back when there is none or the escape is broken", () => {
    expect(dispositionName('attachment; filename="brushgraft-Test.zip"', "x.zip")).toBe("brushgraft-Test.zip");
    expect(dispositionName(null, "x.zip")).toBe("x.zip");
    expect(dispositionName("attachment; filename=\"a.zip\"; filename*=UTF-8''%E7%ZZ", "x.zip")).toBe("a.zip");
  });
});
