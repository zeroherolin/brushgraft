import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PARITY } from "../../test/png";
import { ApiError } from "./errors";
import { parseManifest, readArchive, readAssetPack, remapIds, sha256Hex, writeArchive, writeAssetPack, type ArchiveContent } from "./archive";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const dir = `${PARITY}archive/`;
const have = existsSync(`${dir}project.zip`);

const PNG = (n: number) => {
  const d = new Uint8Array(40);
  d.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(d.buffer).setUint32(16, 8);
  new DataView(d.buffer).setUint32(20, 6);
  d[39] = n;
  return d;
};

async function sample(): Promise<ArchiveContent> {
  const a = PNG(1);
  const b = PNG(2);
  const [sa, sb] = [await sha256Hex(a), await sha256Hex(b)];
  return {
    project: { name: "P", created_at: 1, updated_at: 2 },
    nodes: [
      { id: "n1", parent_id: null, job_id: null, image: sa, raw_image: null, merged_image: null, note: "", label: "x.png", starred: true, created_at: 1 },
      { id: "n2", parent_id: "n1", job_id: "j1", image: sb, raw_image: sa, merged_image: sb, note: "reframed", label: "", starred: false, created_at: 2 },
    ],
    jobs: [{
      id: "j1", parent_id: "n1", kind: "edit", prompt: "p", full_prompt: "fp", regions: [{ shapes: [{ type: "rect", x: 1, y: 2, w: 3, h: 4 }], instruction: "i" }],
      refs: ["n1", "asset:a1"], ref_images: [sa, sb], model: "m", size: "1536x1024", n: 1, composite: true, mask_image: null, annot_image: null, status: "done", done: 1, failed: 0,
      errors: [], usage: { total_tokens: 3 }, created_at: 1, finished_at: 2,
    }],
    images: new Map([[sa, a], [sb, b]]),
  };
}

const rejects = async (p: Promise<unknown> | (() => unknown), code = "bad_archive") => {
  const e = await (typeof p === "function" ? Promise.resolve().then(p) : p).then(() => null, (x) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect((e as ApiError).code).toBe(code);
};

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe("asset pack", () => {
  it("round-trips the library, and refuses a project file", async () => {
    const a = PNG(3);
    const sa = await sha256Hex(a);
    const assets = [{ name: "hat", image: sa, created_at: 5 }];
    const back = await readAssetPack(await bytesOf(writeAssetPack(assets, new Map([[sa, a]]))));
    expect(back.assets).toEqual(assets);
    expect([...back.images.keys()]).toEqual([sa]);
    await rejects(readAssetPack(await bytesOf(writeArchive(await sample()))), "bad_asset_pack");
  });

  it.skipIf(!have)("reads the pack Python wrote", async () => {
    const want = JSON.parse(readFileSync(`${dir}assets.json`, "utf8"));
    const got = await readAssetPack(new Uint8Array(readFileSync(`${dir}assets.zip`)));
    expect(got.assets).toEqual(want.assets);
    expect([...got.images.keys()].sort()).toEqual(want.assets.map((a: { image: string }) => a.image).sort());
  });
});

describe("project archive", () => {
  it("round-trips what it writes", async () => {
    const content = await sample();
    const back = await readArchive(await bytesOf(writeArchive(content)));
    expect(back.project).toEqual(content.project);
    expect(back.nodes).toEqual(content.nodes);
    expect(back.jobs).toEqual(content.jobs);
    expect([...back.images.keys()].sort()).toEqual([...content.images.keys()].sort());
  });

  it.skipIf(!have)("reads the zip Python wrote, field for field", async () => {
    const want = JSON.parse(readFileSync(`${dir}expected.json`, "utf8"));
    const got = await readArchive(new Uint8Array(readFileSync(`${dir}project.zip`)));
    expect(got.project).toEqual(want.project);
    expect(got.nodes).toEqual(want.nodes);
    expect(got.jobs).toEqual(want.jobs);
    expect([...got.images.keys()].sort()).toEqual([...want.images].sort());
  });

  it("gives imported versions and jobs fresh ids and keeps their links", async () => {
    const content = await sample();
    let k = 0;
    const { nodes, jobs } = remapIds(content, () => `new${k++}`);
    expect(nodes.map((n) => n.id)).toEqual(["new0", "new1"]);
    expect(nodes[1].parent_id).toBe("new0");
    expect(nodes[1].job_id).toBe("new2");
    // an asset stays as it is: the library is another one, and its image travels in ref_images
    expect(jobs[0]).toMatchObject({ id: "new2", parent_id: "new0", refs: ["new0", "asset:a1"] });
  });

  it("reads a version 1 file: the references' images come from its versions", async () => {
    const content = await sample();
    const zip = unzipSync(await bytesOf(writeArchive(content)));
    const manifest = JSON.parse(strFromU8(zip["project.json"]));
    manifest.version = 1;
    for (const j of manifest.jobs) delete j.ref_images;
    zip["project.json"] = strToU8(JSON.stringify(manifest));
    const back = await readArchive(zipSync(zip));
    expect(back.jobs[0].ref_images).toEqual([content.nodes[0].image, null]);
  });

  it("rejects files that are not projects", async () => {
    await rejects(readArchive(new Uint8Array([1, 2, 3])));
    await rejects(readArchive(zipSync({ "readme.txt": strToU8("hi") })));
    await rejects(readArchive(zipSync({ "project.json": strToU8("{nope") })));
    await rejects(readArchive(zipSync({ "project.json": strToU8(JSON.stringify({ format: "other" })) })));
  });

  it("rejects an image that doesn't match its name, or is missing", async () => {
    const content = await sample();
    const good = await bytesOf(writeArchive(content));
    const files = (await import("fflate")).unzipSync(good);
    const sha = [...content.images.keys()][0];
    const key = Object.keys(files).find((k) => k.includes(sha))!;
    await rejects(readArchive(zipSync({ ...files, [key]: PNG(9) })));
    const { [key]: _drop, ...rest } = files;
    void _drop;
    await rejects(readArchive(zipSync(rest)));
  });

  it("rejects a newer format with its own code", async () => {
    const content = await sample();
    const manifest = JSON.parse(JSON.stringify({ format: "brushgraft-project", version: 99, project: content.project, nodes: [], jobs: [] }));
    await rejects(() => parseManifest(manifest), "archive_newer");
  });

  it("rejects malformed content: loops, dangling links, bad ids, odd shapes, too many items", async () => {
    const content = await sample();
    const base = () => JSON.parse(JSON.stringify({ format: "brushgraft-project", version: 1, project: content.project, nodes: content.nodes, jobs: content.jobs }));
    const cases: ((m: ReturnType<typeof base>) => void)[] = [
      (m) => (m.nodes[0].parent_id = "n1"),
      (m) => (m.nodes[0].parent_id = "nope"),
      (m) => (m.nodes[1].job_id = "nope"),
      (m) => (m.nodes[0].id = "../x"),
      (m) => (m.nodes[1].id = "n1"),
      (m) => (m.nodes[0].image = "xyz"),
      (m) => (m.jobs[0].regions[0].shapes[0].type = "circle"),
      (m) => (m.jobs[0].regions[0].shapes[0].w = -1),
      (m) => (m.jobs[0].n = 9),
      (m) => (m.jobs[0].kind = "other"),
      (m) => (m.jobs[0].refs = new Array(9).fill("n1")),
      (m) => (m.project.name = 5),
      (m) => (m.nodes = new Array(6000).fill(m.nodes[0])),
    ];
    for (const [i, change] of cases.entries()) {
      const m = base();
      change(m);
      await rejects(() => parseManifest(m), "bad_archive").catch((e) => {
        throw new Error(`case ${i}: ${e.message}`);
      });
    }
  });

  it("repairs what is merely odd: unknown job status becomes failed, long error lists are cut", async () => {
    const content = await sample();
    const m = JSON.parse(JSON.stringify({ format: "brushgraft-project", version: 1, project: content.project, nodes: content.nodes, jobs: content.jobs }));
    m.jobs[0].status = "weird";
    m.jobs[0].errors = new Array(80).fill({ code: "x", detail: "", variant: "" });
    const out = parseManifest(m);
    expect(out.jobs[0].status).toBe("failed");
    expect(out.jobs[0].errors).toHaveLength(50);
  });
});
