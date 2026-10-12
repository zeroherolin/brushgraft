import { describe, expect, it } from "vitest";
import { spec } from "../spec";
import { BrowserSettings } from "./settings";

const area = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const make = () => {
  const local = area();
  const session = area();
  return { local, session, s: new BrowserSettings(local, session) };
};

describe("BrowserSettings", () => {
  it("starts empty with the default address, remembering by default", () => {
    const { s } = make();
    expect([s.apiKey, s.baseUrl, s.remember]).toEqual(["", spec.default_base_url, true]);
  });

  it("keeps the key on the device when remembered, and in the session only when not", () => {
    const { s, local, session } = make();
    s.save({ apiKey: " sk-1 " });
    expect([s.apiKey, local.m.size, session.m.size, s.remember]).toEqual(["sk-1", 1, 0, true]);
    s.save({ remember: false });
    expect([s.apiKey, local.m.size, session.m.size, s.remember]).toEqual(["sk-1", 0, 1, false]);
    s.save({ remember: true });
    expect([local.m.size, session.m.size]).toEqual([1, 0]);
  });

  it("leaves the key alone when only the address is saved, and removes it when emptied", () => {
    const { s } = make();
    s.save({ apiKey: "sk-1", remember: false });
    s.save({ baseUrl: "https://relay.example/v1" });
    expect([s.apiKey, s.baseUrl, s.remember]).toEqual(["sk-1", "https://relay.example/v1", false]);
    s.save({ apiKey: "" });
    expect(s.apiKey).toBe("");
    s.save({ baseUrl: "" });
    expect(s.baseUrl).toBe(spec.default_base_url);
  });

  it("refuses an address that isn't http(s), keeping what was saved", () => {
    const { s } = make();
    s.save({ baseUrl: "https://ok.example/v1" });
    expect(() => s.save({ baseUrl: "ftp://x" })).toThrow(/http/);
    expect(() => s.save({ baseUrl: "api.example.com" })).toThrow();
    expect(s.baseUrl).toBe("https://ok.example/v1");
  });

  it("forgets the key", () => {
    const { s } = make();
    s.save({ apiKey: "k" });
    s.clearKey();
    expect(s.apiKey).toBe("");
  });
});
