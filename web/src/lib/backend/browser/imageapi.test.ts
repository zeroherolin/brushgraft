import { describe, expect, it } from "vitest";
import { createImage, ImageAPIError, NetworkError, testConnection } from "./imageapi";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const b64 = (d: Uint8Array) => btoa(String.fromCharCode(...d));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

function scripted(...replies: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  const queue = [...replies];
  return {
    calls,
    waits,
    logs,
    options: {
      apiKey: "sk-test",
      baseUrl: "https://api.example/v1/",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const next = queue.shift();
        if (!next) throw new Error("unexpected call");
        if (next instanceof Error) throw next;
        return next;
      }) as typeof fetch,
      sleep: async (s: number) => void waits.push(s),
      log: (level: string, msg: string) => void logs.push(`${level}: ${msg}`),
    },
  };
}

describe("createImage", () => {
  it("generates with a JSON body and returns the decoded image", async () => {
    const s = scripted(json({ data: [{ b64_json: b64(PNG) }], usage: { total_tokens: 5 } }));
    const g = await createImage("a cat", { model: "m", size: "1024x1024" }, s.options);
    expect(g.images).toEqual([PNG]);
    expect(g.usage).toEqual({ total_tokens: 5 });
    expect(s.calls[0].url).toBe("https://api.example/v1/images/generations");
    const init = s.calls[0].init;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body as string)).toEqual({ model: "m", prompt: "a cat", n: 1, size: "1024x1024" });
  });

  it("edits with a multipart body, image by image in order", async () => {
    const s = scripted(json({ data: [{ b64_json: b64(PNG) }] }));
    await createImage("x", { images: [PNG, PNG], model: "m", size: "1024x1024" }, s.options);
    expect(s.calls[0].url).toBe("https://api.example/v1/images/edits");
    const init = s.calls[0].init;
    const form = await new Response(init.body, { headers: init.headers }).formData();
    const parts = form.getAll("image[]") as File[];
    expect(parts.map((p) => [p.name, p.type])).toEqual([["image_1.png", "image/png"], ["image_2.png", "image/png"]]);
    expect(new Uint8Array(await parts[1].arrayBuffer())).toEqual(PNG);
    expect([form.get("model"), form.get("prompt"), form.get("n"), form.get("size")]).toEqual(["m", "x", "1", "1024x1024"]);
  });

  it("sends the prompt byte for byte: newlines stay LF, as the Python client sends them", async () => {
    const s = scripted(json({ data: [{ b64_json: b64(PNG) }] }));
    const prompt = "Image 1 is the image to edit.\nBox 1: a \"red\" hat — 红色的帽子\nDone.";
    await createImage(prompt, { images: [PNG], model: "m", size: "1024x1024" }, s.options);
    const raw = new TextDecoder().decode(await (s.calls[0].init.body as Blob).arrayBuffer());
    expect(raw).toContain(`\r\n\r\n${prompt}\r\n--`);
    const init = s.calls[0].init;
    expect((await new Response(init.body, { headers: init.headers }).formData()).get("prompt")).toBe(prompt);
  });

  it("retries 429 and 5xx with back-off, then succeeds", async () => {
    const s = scripted(json("busy", 429), json("down", 503), json({ data: [{ b64_json: b64(PNG) }] }));
    const g = await createImage("p", { model: "m", size: "1024x1024" }, s.options);
    expect(g.images).toHaveLength(1);
    expect(s.waits).toEqual([2, 4]);
    expect(s.logs.filter((l) => l.startsWith("retry")).length).toBe(2);
  });

  it("honours Retry-After up to the cap", async () => {
    const s = scripted(json("", 429, { "Retry-After": "7" }), json("", 429, { "Retry-After": "900" }), json({ data: [{ b64_json: b64(PNG) }] }));
    await createImage("p", { model: "m", size: "1024x1024" }, s.options);
    expect(s.waits).toEqual([7, 60]);
  });

  it("retries network errors, and gives up as a NetworkError", async () => {
    const boom = new TypeError("Failed to fetch");
    const s = scripted(boom, boom, boom, boom, boom);
    await expect(createImage("p", { model: "m", size: "1024x1024" }, s.options)).rejects.toBeInstanceOf(NetworkError);
    expect(s.calls).toHaveLength(5);
    expect(s.waits).toEqual([2, 4, 8, 16]);
  });

  it("returns the last response once retries run out", async () => {
    const s = scripted(...Array.from({ length: 5 }, () => json("still busy", 503)));
    await expect(createImage("p", { model: "m", size: "1024x1024" }, s.options)).rejects.toMatchObject({ status: 503 });
  });

  it("reports moderation (451) and other API failures", async () => {
    const mod = await createImage("p", { model: "m", size: "1024x1024" }, scripted(json("blocked", 451)).options).catch((e) => e);
    expect(mod).toBeInstanceOf(ImageAPIError);
    expect(mod.moderated).toBe(true);
    expect(mod.message).toBe("HTTP 451: blocked");
    const bad = await createImage("p", { model: "m", size: "1024x1024" }, scripted(json("<html>", 200)).options).catch((e) => e);
    expect(bad.message).toMatch(/not valid JSON/);
    const err = await createImage("p", { model: "m", size: "1024x1024" }, scripted(json({ error: { message: "quota" } })).options).catch((e) => e);
    expect(err.message).toMatch(/API returned an error: .*quota/);
    const arr = await createImage("p", { model: "m", size: "1024x1024" }, scripted(json([1])).options).catch((e) => e);
    expect(arr.message).toMatch(/Unexpected response format/);
  });

  it("downloads url results (with retries) and skips images that fail, keeping the others", async () => {
    const s = scripted(
      json({ data: [{ url: "https://img.example/a.png" }, { b64_json: b64(PNG) }, { url: "https://img.example/b.png" }, {}] }),
      new Response(PNG, { status: 200 }),
      new Response("nope", { status: 404 }),
    );
    const g = await createImage("p", { model: "m", size: "1024x1024" }, s.options);
    expect(g.images).toHaveLength(2);
    expect(g.lost).toEqual(["https://img.example/b.png"]);
    expect(s.logs.some((l) => l.includes("Failed to fetch image 3"))).toBe(true);
    expect(s.logs.some((l) => l.includes("Image 4 has no usable data"))).toBe(true);
  });

  it("rejects an invalid size for strict models before sending", async () => {
    const s = scripted();
    await expect(createImage("p", { model: "gpt-image-2.5-flare", size: "1000x1000" }, s.options)).rejects.toMatchObject({ code: "size_invalid" });
    expect(s.calls).toHaveLength(0);
  });

  it("refuses an empty prompt and non-image references", async () => {
    await expect(createImage("  ", { model: "m", size: "auto" }, scripted().options)).rejects.toThrow(/empty/);
    await expect(createImage("p", { images: [new Uint8Array([1, 2, 3])], model: "m", size: "auto" }, scripted().options)).rejects.toThrow(/Reference image 1/);
  });
});

describe("testConnection", () => {
  it("passes on 200 and explains 401 and network failures", async () => {
    await expect(testConnection("k", "https://x/v1", scripted(json({ data: [] })).options)).resolves.toBeUndefined();
    await expect(testConnection("k", "https://x/v1", scripted(json("bad key", 401)).options)).rejects.toMatchObject({ status: 401 });
    await expect(testConnection("k", "https://x/v1", scripted(new TypeError("Failed to fetch")).options)).rejects.toBeInstanceOf(NetworkError);
  });
});
