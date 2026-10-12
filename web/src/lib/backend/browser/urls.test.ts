import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UrlCache } from "./urls";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("UrlCache", () => {
  it("makes each URL once and releases the least recently used when full, after a delay", async () => {
    const released: string[] = [];
    const cache = new UrlCache(2, (u) => void released.push(u));
    const made: string[] = [];
    const make = (k: string) => () => (made.push(k), Promise.resolve(`blob:${k}`));
    await cache.get("a", make("a"));
    await cache.get("b", make("b"));
    await cache.get("a", make("a")); // a is fresh again
    await cache.get("c", make("c")); // evicts b
    expect(made).toEqual(["a", "b", "c"]);
    expect(released).toEqual([]);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(released).toEqual(["blob:b"]);
    await cache.get("b", make("b")); // gone: made again
    expect(made).toEqual(["a", "b", "c", "b"]);
  });

  it("shares a URL that is still being made, and forgets one that failed", async () => {
    const cache = new UrlCache(5, () => {});
    let calls = 0;
    const slow = () => new Promise<string>((r) => setTimeout(() => r("blob:x"), 10)).then((v) => (calls++, v));
    const [p, q] = [cache.get("x", slow), cache.get("x", slow)];
    await vi.advanceTimersByTimeAsync(20);
    expect(await p).toBe(await q);
    expect(calls).toBe(1);
    await expect(cache.get("bad", () => Promise.reject(new Error("no")))).rejects.toThrow();
    expect(await cache.get("bad", () => Promise.resolve("blob:ok"))).toBe("blob:ok");
  });
});
