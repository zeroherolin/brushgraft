import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImageOps } from "../../imaging/client";
import { merge, mergeParts, normalizeUpload, placeParts, prepare, thumbnail } from "../../imaging/ops";
import { describeJobError } from "../../joberror";
import type { Job, JobError, ServerEvent, TreeNode } from "../../types";
import { makePng, scenePng, b64, jsonResponse } from "../../../test/images";
import { decodePng } from "../../../test/png";
import { zoomBox, zoomParts, zoomSize, type Box } from "../../imaging/zoom";
import { bbox, type Raster } from "../../imaging/raster";
import { regionMask, unionMask } from "../../imaging/shapes";
import { fitSize } from "../sizes";
import { testCodec } from "../../../test/codec";
import { ApiError } from "../errors";
import { JobRunner } from "./jobs";
import { BrowserStore } from "./store";
import type { JobRequest } from "../types";

const ops: ImageOps = {
  normalize: (d) => normalizeUpload(testCodec, d),
  prepare: (parent, regions, refs, zoom) => prepare(testCodec, { parent, regions, refs, zoom }),
  merge: (parent, result, mask, annot, overall) => merge(testCodec, { parent, result, mask, annot, overall }),
  mergeParts: (parent, pieces, overall) => mergeParts(testCodec, { parent, pieces, overall }),
  placeParts: (parent, pieces) => placeParts(testCodec, { parent, pieces }),
  thumb: (d) => thumbnail(testCodec, d),
};

type Reply = Response | Error | ((req: { url: string; body: unknown; headers: unknown }) => Response | Promise<Response>);

function setup(opts: { maxParallel?: number; key?: string } = {}) {
  const store = new BrowserStore(new IDBFactory(), "t");
  const events: ServerEvent[] = [];
  const calls: { url: string; body: unknown; headers: unknown }[] = [];
  const replies: Reply[] = [];
  let inFlight = 0;
  let peak = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    const call = { url, body: init.body, headers: init.headers };
    calls.push(call);
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5));
      const next = replies.shift();
      if (!next) throw new Error("unexpected call");
      if (next instanceof Error) throw next;
      return typeof next === "function" ? await next(call) : next;
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
  const runner = new JobRunner({
    store, images: ops, owner: "tab1", maxParallel: opts.maxParallel,
    settings: () => ({ apiKey: opts.key ?? "sk-test", baseUrl: "https://api.example/v1" }),
    publish: (e) => void events.push(e), fetch: fetcher, sleep: async () => {},
  });
  return { store, runner, events, calls, replies, peak: () => peak };
}

async function waitDone(s: ReturnType<typeof setup>, jobId: string): Promise<Job> {
  for (let i = 0; i < 400; i++) {
    const job = await s.store.getJob(jobId);
    if (job.status === "done" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job did not finish");
}

const REGION = { shapes: [{ type: "rect" as const, x: 90, y: 60, w: 50, h: 40 }], instruction: "a red patch" };
const base = (project_id: string, extra: Partial<JobRequest> = {}): JobRequest => ({
  project_id, parent_id: null, prompt: "a cat", regions: [], refs: [], model: "gpt-image-2", size: "1024x1024",
  n: 1, composite: true, lang: "en", ...extra,
});
const ok = (png: Uint8Array) => jsonResponse({ data: [{ b64_json: b64(png) }], usage: { total_tokens: 7 } });

const codeOf = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as ApiError).code;

interface Sent {
  prompt: string;
  /** the size asked for */
  size: string;
  images: Raster[];
}

/**
 * A model that does as it is asked: what it was sent (the whole image, or the close-up in ``zooms`` of
 * its size, told apart by its content on ``original``) at the size asked for, with ``objects`` (boxes on
 * the whole image) drawn white in it; with ``overcast``, every color grey-blue. What it got goes in ``sent``.
 */
function drawing(original: Raster, zooms: Box[], objects: Box[], sent: Sent[], overcast = false): Reply {
  return async (call) => {
    const form = await new Request("http://x", { method: "POST", headers: call.headers as HeadersInit, body: call.body as Blob }).formData();
    const ims = await Promise.all((form.getAll("image[]") as Blob[]).map(async (f) => decodePng(Buffer.from(await f.arrayBuffer()), "RGB")));
    const size = form.get("size") as string;
    sent.push({ prompt: form.get("prompt") as string, size, images: ims });
    const im = ims[0];
    const differs = (z: Box) => {
      let sum = 0;
      for (let y = 0; y < im.height; y += 7) for (let x = 0; x < im.width; x += 7) sum += Math.abs(im.data[(y * im.width + x) * 3] - original.data[((z[1] + y) * original.width + z[0] + x) * 3]);
      return sum;
    };
    const fits = zooms.filter((z) => z[2] - z[0] === im.width && z[3] - z[1] === im.height).sort((a, b) => differs(a) - differs(b));
    const [x0, y0, x1] = fits[0] ?? [0, 0, original.width];
    const [w, h] = size.split("x").map(Number);
    const k = w / (x1 - x0);
    return ok(
      makePng(w, h, (x, y) => {
        const [ox, oy] = [x0 + x / k, y0 + y / k];
        if (objects.some(([a, b, c, d]) => ox >= a && ox < c && oy >= b && oy < d)) return [255, 255, 255];
        const i = (Math.min(im.height - 1, Math.floor((y * im.height) / h)) * im.width + Math.min(im.width - 1, Math.floor((x * im.width) / w))) * 3;
        const [r, g, b] = [im.data[i], im.data[i + 1], im.data[i + 2]];
        if (!overcast) return [r, g, b];
        const v = (r * 299 + g * 587 + b * 114) / 1000;
        return [v * 0.55 + 20, v * 0.6 + 30, v * 0.7 + 70].map(Math.round) as [number, number, number];
      }),
    );
  };
}

let s: ReturnType<typeof setup>;
let projectId: string;
beforeEach(async () => {
  s = setup();
  projectId = (await s.store.createProject("p")).id;
});

async function root(png = scenePng()): Promise<TreeNode> {
  const { sha } = await s.store.putImage(png);
  return s.store.addNode({ projectId, image: sha, label: "room.png" });
}

describe("generating", () => {
  it("sends the prompt, saves the image, and reports progress in order", async () => {
    s.replies.push(ok(scenePng(64, 48)));
    const job = await s.runner.submit(base(projectId));
    expect(job).toMatchObject({ status: "queued", kind: "generate", size: "1024x1024", full_prompt: "a cat" });
    const done = await waitDone(s, job.id);
    expect(done).toMatchObject({ status: "done", done: 1, failed: 0, usage: { total_tokens: 7 } });
    const tree = await s.store.projectTree(projectId);
    expect(tree.nodes).toHaveLength(1);
    expect(tree.nodes[0]).toMatchObject({ job_id: job.id, parent_id: null, width: 64, height: 48, raw_image: null });
    const calls = s.calls;
    expect(calls[0].url).toBe("https://api.example/v1/images/generations");
    expect(JSON.parse(calls[0].body as string)).toMatchObject({ model: "gpt-image-2", prompt: "a cat", n: 1, size: "1024x1024" });
    // events: job queued, running, then node before the final job state
    const kinds = s.events.filter((e) => e.type !== "log").map((e) => e.type === "job" ? `job:${e.job.status}` : e.type);
    expect(kinds).toEqual(["job:queued", "job:running", "node", "job:done"]);
    const logs = s.runner.logs(job.id).map((l) => l.msg);
    expect(logs[0]).toBe("Requesting gpt-image-2 at 1024x1024");
    expect(logs.at(-1)).toMatch(/^Done in \d+s$/);
  });

  it("makes n variants as separate requests, at most maxParallel at once", async () => {
    s = setup({ maxParallel: 2 });
    projectId = (await s.store.createProject("p")).id;
    for (let i = 0; i < 4; i++) s.replies.push(ok(scenePng(64, 48, i)));
    const job = await s.runner.submit(base(projectId, { n: 4 }));
    expect(s.runner.active).toBe(4);
    const done = await waitDone(s, job.id);
    expect(done).toMatchObject({ status: "done", done: 4 });
    expect(s.calls).toHaveLength(4);
    expect(s.peak()).toBe(2);
    expect(s.runner.active).toBe(0);
    expect(s.runner.logs(job.id).some((l) => l.msg.startsWith("[2/4] "))).toBe(true);
  });

  it("records partial success: done, with the error of the variant that failed", async () => {
    s.replies.push(ok(scenePng(64, 48)), jsonResponse("blocked", 451));
    const job = await s.runner.submit(base(projectId, { n: 2 }));
    const done = await waitDone(s, job.id);
    expect(done.status).toBe("done");
    expect([done.done, done.failed]).toEqual([1, 1]);
    expect(done.errors).toEqual([expect.objectContaining({ code: "moderated" })]);
    expect(done.errors[0]).toMatchObject({ detail: "HTTP 451: blocked" });
    expect((done.errors[0] as { variant: string }).variant).toMatch(/^\d\/2$/);
  });

  it.each([
    ["an API error", () => jsonResponse("nope", 400), "api_error"],
    ["a prompt the API finds too long (413)", () => jsonResponse({ error: { message: "input_too_large" } }, 413), "prompt_too_long"],
    ["a prompt a relay finds too long (400, in its words)", () => jsonResponse({ error: { message: "你提交的消息过长，请编辑后重新发送。" } }, 400), "prompt_too_long"],
    ["an empty answer", () => jsonResponse({ data: [] }), "no_image"],
    ["a network failure", () => new TypeError("Failed to fetch"), "network"],
  ] as const)("fails the job on %s with the code the UI translates", async (_, reply, code) => {
    const r = reply();
    s.replies.push(...(r instanceof Error ? Array(5).fill(r) : [r]));
    const job = await s.runner.submit(base(projectId));
    const done = await waitDone(s, job.id);
    expect(done.status).toBe("failed");
    expect((done.errors[0] as { code: string }).code).toBe(code);
    expect((await s.store.projectTree(projectId)).nodes).toHaveLength(0);
  });

  it("explains a network failure that looks like CORS or a wrong address", async () => {
    s.replies.push(...Array(5).fill(new TypeError("Failed to fetch")));
    const job = await s.runner.submit(base(projectId));
    const done = await waitDone(s, job.id);
    // the raw text is kept; the UI explains it (CORS, the address, the connection)
    expect(done.errors[0]).toMatchObject({ code: "network", detail: "Failed to fetch" });
    expect(describeJobError(done.errors[0] as JobError).kind).toBe("fetch");
  });

  it("names the address when the API gave a url this page can't download", async () => {
    s.replies.push(jsonResponse({ data: [{ url: "https://cdn.example/x.png" }] }), ...Array(5).fill(new TypeError("Failed to fetch")));
    const job = await s.runner.submit(base(projectId));
    const done = await waitDone(s, job.id);
    expect(done.errors[0]).toMatchObject({ code: "image_unreachable", detail: "https://cdn.example/x.png" });
  });
});

describe("editing", () => {
  it("sends original, annotated copy and references in order, with the compiled prompt", async () => {
    const parent = await root();
    const ref = await root(scenePng(80, 60, 5));
    s.replies.push(ok(scenePng(240, 160)));
    const job = await s.runner.submit(base(projectId, { parent_id: parent.id, prompt: "", regions: [REGION], refs: [ref.id], size: null }));
    expect(job.size).toMatch(/^\d+x\d+$/);
    expect(job.kind).toBe("edit");
    expect(job.mask_image).toMatch(/^[0-9a-f]{64}$/);
    expect(job.annot_image).toMatch(/^[0-9a-f]{64}$/);
    await waitDone(s, job.id);
    const form = await new Response(s.calls[0].body as Blob, { headers: s.calls[0].headers as HeadersInit }).formData();
    expect(s.calls[0].url).toBe("https://api.example/v1/images/edits");
    expect(form.getAll("image[]")).toHaveLength(3);
    expect(String(form.get("prompt"))).toContain("Area 1 (red): a red patch");
    expect(String(form.get("prompt"))).toContain("Images 3 onward are, in order, reference image 1.");
  });

  it("pastes the edited region back onto the original, undoing the model's tone drift", async () => {
    // large enough that there is picture far from the region to measure the drift on
    const [W, H] = [720, 480];
    const original = scenePng(W, H);
    const parent = await root(original);
    const o = decodePng(Buffer.from(original), "RGB");
    const up = (v: number) => Math.min(255, v + 7);
    // the model draws a patch in the region and makes everything 7 levels brighter, as real ones drift
    const result = makePng(W, H, (x, y) => {
      const i = (y * W + x) * 3;
      return x >= 95 && x < 135 && y >= 65 && y < 95 ? [207, 157, 127] : [up(o.data[i]), up(o.data[i + 1]), up(o.data[i + 2])];
    });
    s.replies.push(ok(result));
    const job = await s.runner.submit(base(projectId, { parent_id: parent.id, prompt: "", regions: [REGION], size: null }));
    expect((await waitDone(s, job.id)).status).toBe("done");
    const node = (await s.store.projectTree(projectId)).nodes.find((n) => n.job_id === job.id)!;
    expect(node.raw_image).not.toBeNull();
    expect(node.merged_image).toBe(node.image);
    expect(node.image).not.toBe(node.raw_image); // the whole output is kept beside the pasted result
    const merged = decodePng(Buffer.from((await s.store.getImage(node.image)).data), "RGB");
    const raw = decodePng(Buffer.from((await s.store.getImage(node.raw_image!)).data), "RGB");
    const at = (im: typeof merged, x: number, y: number) => Array.from(im.data.subarray((y * W + x) * 3, (y * W + x) * 3 + 3));
    expect(at(raw, 5, 5)).toEqual(at(o, 5, 5).map(up));
    // the patch is in, its brightness drift undone (to within rounding of the fitted correction)
    at(merged, 115, 80).forEach((v, k) => expect(Math.abs(v - [200, 150, 120][k])).toBeLessThanOrEqual(1));
    expect(at(merged, 5, 5)).toEqual(at(o, 5, 5)); // far away is the original, untouched
    expect(at(merged, 700, 460)).toEqual(at(o, 700, 460));
  });

  it("sends a small edit of a large image as a close-up, and pastes the result back within it", async () => {
    const [W, H] = [2000, 1250];
    const original = scenePng(W, H);
    const parent = await root(original);
    const o = decodePng(Buffer.from(original), "RGB");
    const region = { instruction: "a red teapot", shapes: [{ type: "rect" as const, x: 1200, y: 200, w: 80, h: 60 }] };
    // from the mask's bounds, as the job does (a rectangle includes its far edge)
    const zoom = zoomBox(W, H, bbox(unionMask(W, H, [region]))!)!;
    const sent: Sent[] = [];
    s.replies.push(drawing(o, [zoom], [[1208, 208, 1272, 252]], sent));
    const job = await s.runner.submit(base(projectId, { parent_id: parent.id, prompt: "", regions: [region], size: null, model: "gpt-image-2.5-flare" }));
    expect((await waitDone(s, job.id)).status).toBe("done");
    expect(sent[0].images.map((im) => [im.width, im.height])).toEqual([[zoom[2] - zoom[0], zoom[3] - zoom[1]], [zoom[2] - zoom[0], zoom[3] - zoom[1]]]);
    expect(sent[0].size).toBe(zoomSize(zoom));
    const stored = await s.store.getJob(job.id);
    expect(stored.size).toBe(fitSize(W, H)); // what the whole image would be sent at
    expect(stored.requests).toEqual([{ prompt: sent[0].prompt, box: zoom, size: sent[0].size, annot_image: stored.annot_image }]);
    expect(s.runner.logs(job.id).some((l) => l.msg.includes("a close-up of"))).toBe(true);
    const node = (await s.store.projectTree(projectId)).nodes.find((n) => n.job_id === job.id)!;
    const merged = decodePng(Buffer.from((await s.store.getImage(node.image)).data), "RGB");
    const whole = decodePng(Buffer.from((await s.store.getImage(node.raw_image!)).data), "RGB");
    expect([merged.width, merged.height, whole.width, whole.height]).toEqual([W, H, W, H]);
    const at = (im: typeof merged, x: number, y: number) => Array.from(im.data.subarray((y * W + x) * 3, (y * W + x) * 3 + 3));
    expect(at(merged, 1240, 230)).toEqual([255, 255, 255]); // the object, where it belongs
    // outside the close-up, both are the original, pixel for pixel
    for (const im of [merged, whole]) {
      for (const [x, y] of [[zoom[0] - 1, 230], [5, 5], [W - 1, zoom[3]], [1240, zoom[3] + 2]]) expect(at(im, x, y)).toEqual(at(o, x, y));
    }
  }, 30_000); // a large image: slow on a shared CI machine

  it("sends regions far apart as close-ups, made into one version", async () => {
    const [W, H] = [1600, 1100];
    const original = scenePng(W, H);
    const parent = await root(original);
    const o = decodePng(Buffer.from(original), "RGB");
    const regions = [
      { instruction: "a red teapot", shapes: [{ type: "rect" as const, x: 100, y: 100, w: 60, h: 50 }] },
      { instruction: "a blue cup", shapes: [{ type: "rect" as const, x: 1400, y: 950, w: 60, h: 50 }] },
    ];
    const zooms = zoomParts(W, H, regions.map((r) => bbox(regionMask(W, H, r.shapes)))).map(([z]) => z);
    expect(zooms).toHaveLength(2);
    const sent: Sent[] = [];
    const objects: Box[] = [[105, 105, 155, 145], [1405, 955, 1455, 995]];
    s.replies.push(drawing(o, zooms, objects, sent), drawing(o, zooms, objects, sent));
    const job = await s.runner.submit(base(projectId, { parent_id: parent.id, prompt: "", regions, size: null, model: "gpt-image-2.5-flare" }));
    const done = await waitDone(s, job.id);
    expect([done.status, done.usage]).toEqual(["done", { total_tokens: 14 }]);
    const second = sent.find((c) => c.prompt.includes("a blue cup"))!;
    // each close-up shows its own regions, with their numbers and colors
    expect(second.prompt).toContain("Area 2 (blue): a blue cup");
    expect(second.prompt).not.toContain("Area 1");
    const colors = new Set<string>();
    const annot = second.images[1];
    for (let i = 0; i < annot.data.length; i += 3) colors.add(`${annot.data[i]},${annot.data[i + 1]},${annot.data[i + 2]}`);
    expect([colors.has("0,122,255"), colors.has("255,59,48")]).toEqual([true, false]);
    expect(done.requests.map((r) => r.box)).toEqual(zooms);
    const nodes = (await s.store.projectTree(projectId)).nodes.filter((n) => n.job_id === job.id);
    expect(nodes).toHaveLength(1);
    const merged = decodePng(Buffer.from((await s.store.getImage(nodes[0].image)).data), "RGB");
    const at = (x: number, y: number) => Array.from(merged.data.subarray((y * W + x) * 3, (y * W + x) * 3 + 3));
    expect([at(130, 125), at(1430, 975)]).toEqual([[255, 255, 255], [255, 255, 255]]);
  }, 30_000);

  it("sends the whole image as well when the overall request changed all of a close-up", async () => {
    const [W, H] = [1600, 1100];
    const original = scenePng(W, H);
    const parent = await root(original);
    const o = decodePng(Buffer.from(original), "RGB");
    const region = { instruction: "a red teapot", shapes: [{ type: "rect" as const, x: 1200, y: 200, w: 60, h: 50 }] };
    const zoom = zoomBox(W, H, bbox(unionMask(W, H, [region]))!)!;
    const sent: Sent[] = [];
    const objects: Box[] = [[1205, 205, 1255, 245]];
    s.replies.push(drawing(o, [zoom], objects, sent, true), drawing(o, [zoom], objects, sent, true));
    const job = await s.runner.submit(
      base(projectId, { parent_id: parent.id, prompt: "make the sky overcast", regions: [region], size: null, model: "gpt-image-2.5-flare" }),
    );
    const done = await waitDone(s, job.id);
    expect([done.status, done.usage]).toEqual(["done", { total_tokens: 14 }]);
    expect(sent.map((c) => [c.images[0].width, c.images[0].height])).toEqual([[zoom[2] - zoom[0], zoom[3] - zoom[1]], [W, H]]);
    expect(sent[1].prompt).toBe(done.full_prompt);
    expect(done.requests.map((r) => r.box)).toEqual([zoom, null]);
    expect(s.runner.logs(job.id).some((l) => l.msg.includes("sending the whole image as well"))).toBe(true);
    const node = (await s.store.projectTree(projectId)).nodes.find((n) => n.job_id === job.id)!;
    expect(node.note).toBe("overall_change");
    expect(node.image).toBe(node.raw_image);
    const adopted = decodePng(Buffer.from((await s.store.getImage(node.image)).data), "RGB");
    const merged = decodePng(Buffer.from((await s.store.getImage(node.merged_image!)).data), "RGB");
    const at = (im: Raster, x: number, y: number) => Array.from(im.data.subarray((y * W + x) * 3, (y * W + x) * 3 + 3));
    // the whole image changed, with the region's object from the close-up in it; the pasted-back one changed the region only
    expect(Math.min(...at(adopted, 1230, 225))).toBeGreaterThan(230);
    expect(at(adopted, 200, 900)).not.toEqual(at(o, 200, 900));
    expect(at(merged, 200, 900)).toEqual(at(o, 200, 900));
  }, 30_000);

  it("adopts the whole output when the overall request changed the whole image, keeping the pasted one", async () => {
    const [W, H] = [720, 480];
    const original = scenePng(W, H);
    const parent = await root(original);
    const o = decodePng(Buffer.from(original), "RGB");
    // "make the sky overcast": every color goes grey-blue, the drawing stays in place
    const overcast = makePng(W, H, (x, y) => {
      const i = (y * W + x) * 3;
      const g = (o.data[i] * 299 + o.data[i + 1] * 587 + o.data[i + 2] * 114) / 1000;
      return [g * 0.55 + 20, g * 0.6 + 30, g * 0.7 + 70].map(Math.round) as [number, number, number];
    });
    for (const prompt of ["make the sky overcast", ""]) {
      s.replies.push(ok(overcast));
      const job = await s.runner.submit(base(projectId, { parent_id: parent.id, prompt, regions: [REGION], size: null }));
      await waitDone(s, job.id);
      const node = (await s.store.projectTree(projectId)).nodes.find((n) => n.job_id === job.id)!;
      if (prompt) {
        expect(node.note).toBe("overall_change");
        expect(node.image).toBe(node.raw_image); // the whole output is adopted
        expect(node.merged_image).not.toBe(node.raw_image); // the pasted-back one is kept beside it
        expect((await s.store.updateNode(node.id, { useRaw: false })).image).toBe(node.merged_image);
      } else {
        // the same change, unasked for: pasted back as usual
        expect(node.note).not.toBe("overall_change");
        expect(node.image).toBe(node.merged_image);
      }
    }
  });

  it("keeps the output whole, with a note, when its shape differs from the original", async () => {
    const parent = await root();
    s.replies.push(ok(scenePng(100, 100)));
    const job = await s.runner.submit(base(projectId, { parent_id: parent.id, prompt: "", regions: [REGION], size: null }));
    await waitDone(s, job.id);
    const node = (await s.store.projectTree(projectId)).nodes.find((n) => n.job_id === job.id)!;
    expect(node).toMatchObject({ note: "aspect_mismatch", raw_image: null, width: 100, height: 100 });
    expect(s.runner.logs(job.id).some((l) => l.level === "warn" && /different aspect ratio/.test(l.msg))).toBe(true);
  });

  it("keeps the whole output when the model redrew the scene (reframed)", async () => {
    // big enough that there is picture far from the region to compare (see imaging.aligned)
    const parent = await root(scenePng(720, 480));
    s.replies.push(ok(makePng(720, 480, (x, y) => [(x * 3 + y * 5) % 256, (x * 11) % 256, (y * 7) % 256])));
    const job = await s.runner.submit(base(projectId, { parent_id: parent.id, prompt: "", regions: [REGION], size: null }));
    await waitDone(s, job.id);
    const node = (await s.store.projectTree(projectId)).nodes.find((n) => n.job_id === job.id)!;
    expect(node.note).toBe("reframed");
    expect(node.raw_image).toBeNull();
  });

  it("keeps the paid-for image when pasting back fails, with a note and a warning", async () => {
    const parent = await root();
    s.replies.push(ok(scenePng(240, 160, 4)));
    const failing = { ...ops, merge: async () => { throw new RangeError("Array buffer allocation failed"); } };
    const runner = new JobRunner({
      store: s.store, images: failing, owner: "tab1", settings: () => ({ apiKey: "k", baseUrl: "https://api.example/v1" }),
      publish: () => {}, fetch: (async () => s.replies.shift() as Response) as typeof fetch, sleep: async () => {},
    });
    const job = await runner.submit(base(projectId, { parent_id: parent.id, prompt: "", regions: [REGION], size: null }));
    expect((await waitDone(s, job.id)).status).toBe("done");
    const node = (await s.store.projectTree(projectId)).nodes.find((n) => n.job_id === job.id)!;
    expect([node.note, node.raw_image]).toEqual(["paste_failed", null]);
    expect(runner.logs(job.id).some((l) => l.level === "warn" && /Pasting back failed.*Array buffer/.test(l.msg))).toBe(true);
  });

  it("doesn't paste back when composite is off", async () => {
    const parent = await root();
    s.replies.push(ok(scenePng(240, 160, 9)));
    const job = await s.runner.submit(base(projectId, { parent_id: parent.id, prompt: "", regions: [REGION], size: null, composite: false }));
    await waitDone(s, job.id);
    const node = (await s.store.projectTree(projectId)).nodes.find((n) => n.job_id === job.id)!;
    expect([node.raw_image, node.note]).toEqual([null, ""]);
  });
});

describe("refusing before any request is made", () => {
  it.each([
    ["no key", () => setup({ key: "" }), (id: string) => base(id), "api_key_missing"],
    ["no model", null, (id: string) => base(id, { model: "  " }), "model_required"],
    ["no size", null, (id: string) => base(id, { size: null }), "size_required"],
    ["a size that isn't one", null, (id: string) => base(id, { size: "big" }), "size_format"],
    ["a size the model rejects", null, (id: string) => base(id, { model: "gpt-image-2.5-flare", size: "1000x1000" }), "size_invalid"],
    ["nothing to say", null, (id: string) => base(id, { prompt: " " }), "prompt_required"],
    ["regions without an image", null, (id: string) => base(id, { regions: [REGION] }), "regions_need_parent"],
    ["an unknown project", null, () => base("nope"), "not_found"],
    ["an unknown version", null, (id: string) => base(id, { parent_id: "nope" }), "not_found"],
    ["too many variants", null, (id: string) => base(id, { n: 5 }), "invalid_request"],
  ])("%s", async (_, make, body, code) => {
    if (make) {
      s = make();
      projectId = (await s.store.createProject("p")).id;
    }
    expect(await codeOf(s.runner.submit(body(projectId)))).toBe(code);
    expect(s.calls).toHaveLength(0);
    expect((await s.store.projectTree(projectId)).jobs).toHaveLength(0);
  });

  it("an empty region, and an image from another project", async () => {
    const parent = await root();
    const empty = { shapes: [{ type: "rect" as const, x: 1000, y: 1000, w: 5, h: 5 }], instruction: "x" };
    expect(await codeOf(s.runner.submit(base(projectId, { parent_id: parent.id, regions: [empty], size: null })))).toBe("empty_region");
    const other = await s.store.createProject("q");
    const { sha } = await s.store.putImage(scenePng(50, 50, 3));
    const foreign = await s.store.addNode({ projectId: other.id, image: sha });
    expect(await codeOf(s.runner.submit(base(projectId, { refs: [foreign.id] })))).toBe("cross_project");
  });
});

describe("while a job runs", () => {
  it("survives the project being deleted, and a deleted version being waited on", async () => {
    s.replies.push(async () => {
      await s.store.deleteProject(projectId).catch(() => {}); // refused while running: the job continues
      return ok(scenePng(64, 48));
    });
    const job = await s.runner.submit(base(projectId));
    expect((await waitDone(s, job.id)).status).toBe("done");
  });
});
