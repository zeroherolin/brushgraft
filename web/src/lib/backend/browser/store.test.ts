import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import { BrowserStore } from "./store";

const PNG = (n: number) => {
  // a PNG header with a width/height of n x n and distinct trailing bytes, enough for sniffing
  const d = new Uint8Array(33);
  d.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(d.buffer).setUint32(16, n + 10);
  new DataView(d.buffer).setUint32(20, n + 20);
  d[32] = n;
  return d;
};

const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as ApiError).code;

let store: BrowserStore;
beforeEach(() => {
  store = new BrowserStore(new IDBFactory(), "t");
});

const jobFor = (projectId: string, parentId: string | null = null, n = 1) => ({
  project_id: projectId, parent_id: parentId, kind: (parentId ? "edit" : "generate") as "edit" | "generate", prompt: "p", full_prompt: "p",
  regions: [], refs: [], ref_images: [], model: "m", size: "1024x1024", n, composite: false, mask_image: null, annot_image: null, owner: "tab",
});

describe("images", () => {
  it("keeps identical content once and reports its size", async () => {
    const a = await store.putImage(PNG(1));
    const b = await store.putImage(PNG(1));
    expect(a).toEqual(b);
    expect(a).toMatchObject({ width: 11, height: 21 });
    expect(await store.imageBytes()).toBe(33);
    expect(a.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses what isn't an image", async () => {
    expect(await code(store.putImage(new Uint8Array([1, 2, 3, 4])))).toBe("not_an_image");
    expect(await code(store.getImage("0".repeat(64)))).toBe("not_found");
  });

  it("removes unreferenced images on collection and keeps referenced ones", async () => {
    const p = await store.createProject("a");
    const kept = await store.putImage(PNG(1));
    await store.putImage(PNG(2));
    await store.addNode({ projectId: p.id, image: kept.sha });
    expect(await store.collectGarbage()).toBe(1);
    expect((await store.getImage(kept.sha)).width).toBe(11);
  });
});

describe("projects", () => {
  it("lists newest-updated first with a version count, renames and deletes", async () => {
    const a = await store.createProject("a");
    const b = await store.createProject("b");
    const img = await store.putImage(PNG(1));
    await store.addNode({ projectId: a.id, image: img.sha });
    expect((await store.listProjects()).map((p) => [p.name, p.node_count])).toEqual([["a", 1], ["b", 0]]);
    await store.renameProject(b.id, "bb");
    expect((await store.listProjects())[0].name).toBe("bb");
    await store.deleteProject(a.id);
    expect(await code(store.getProject(a.id))).toBe("not_found");
    expect((await store.listProjects()).map((p) => p.name)).toEqual(["bb"]);
  });

  it("won't delete a project with a running job", async () => {
    const p = await store.createProject("a");
    await store.createJob(jobFor(p.id));
    expect(await code(store.deleteProject(p.id))).toBe("project_busy");
  });
});

describe("versions", () => {
  async function tree() {
    const p = await store.createProject("a");
    const img = await store.putImage(PNG(1));
    const other = await store.putImage(PNG(2));
    const root = await store.addNode({ projectId: p.id, image: img.sha, label: "up.png" });
    const job = await store.createJob(jobFor(p.id, root.id));
    const child = await store.addNode({ projectId: p.id, parentId: root.id, jobId: job.id, image: other.sha, rawImage: img.sha });
    return { p, root, job, child, img, other };
  }

  it("records the pasted-back image as merged and lets the user adopt the whole output", async () => {
    const { child, img, other } = await tree();
    expect([child.image, child.raw_image, child.merged_image]).toEqual([other.sha, img.sha, other.sha]);
    const raw = await store.updateNode(child.id, { useRaw: true });
    expect([raw.image, raw.width]).toEqual([img.sha, 11]);
    expect((await store.updateNode(child.id, { useRaw: false })).image).toBe(other.sha);
  });

  it("only offers the other image when there is one, and not once later versions exist", async () => {
    const { root, child, p, other } = await tree();
    expect(await code(store.updateNode(root.id, { useRaw: true }))).toBe("no_alternative");
    await store.addNode({ projectId: p.id, parentId: child.id, image: other.sha });
    expect(await code(store.updateNode(child.id, { useRaw: true }))).toBe("has_successors");
  });

  it("stars and labels", async () => {
    const { root } = await tree();
    const n = await store.updateNode(root.id, { starred: true, label: "x" });
    expect([n.starred, n.label]).toEqual([true, "x"]);
  });

  it("deletes a version with everything made from it, and the jobs behind them", async () => {
    const { p, root, child, other } = await tree();
    const deeper = await store.createJob(jobFor(p.id, child.id));
    await store.recordAttempt(deeper.id, { ok: true });
    await store.addNode({ projectId: p.id, parentId: child.id, jobId: deeper.id, image: other.sha });
    await store.deleteNode(child.id);
    const t = await store.projectTree(p.id);
    expect(t.nodes.map((n) => n.id)).toEqual([root.id]);
    expect(t.jobs.map((j) => j.id)).not.toContain(deeper.id);
  });

  it("refuses to delete a branch that is still generating", async () => {
    const { p, child, root } = await tree();
    await store.createJob(jobFor(p.id, child.id));
    expect(await code(store.deleteNode(root.id))).toBe("branch_busy");
    expect(await code(store.deleteNode(child.id))).toBe("branch_busy");
  });

  it("orders versions made in the same instant", async () => {
    const p = await store.createProject("a");
    const img = await store.putImage(PNG(1));
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await store.addNode({ projectId: p.id, image: img.sha })).id);
    expect((await store.projectTree(p.id)).nodes.map((n) => n.id)).toEqual(ids);
  });
});

describe("jobs", () => {
  it("counts attempts and settles done or failed, summing usage", async () => {
    const p = await store.createProject("a");
    const job = await store.createJob(jobFor(p.id, null, 3));
    expect(job.status).toBe("queued");
    expect((await store.setJobRunning(job.id)).status).toBe("running");
    await store.recordAttempt(job.id, { ok: true, usage: { total_tokens: 5 } });
    await store.recordAttempt(job.id, { ok: false, error: { code: "network", detail: "x", variant: "2/3" }, usage: { total_tokens: 2 } });
    const last = await store.recordAttempt(job.id, { ok: true, usage: { total_tokens: 1, note: "x" as unknown as number } });
    expect([last.status, last.done, last.failed, last.usage]).toEqual(["done", 2, 1, { total_tokens: 8 }]);
    expect(last.finished_at).not.toBeNull();
    const failed = await store.createJob(jobFor(p.id));
    expect((await store.recordAttempt(failed.id, { ok: false })).status).toBe("failed");
  });

  it("won't delete a running job, and public jobs don't carry the owner", async () => {
    const p = await store.createProject("a");
    const job = await store.createJob(jobFor(p.id));
    expect(await code(store.deleteJob(job.id))).toBe("job_active");
    expect(job).not.toHaveProperty("owner");
    await store.recordAttempt(job.id, { ok: false });
    await store.deleteJob(job.id);
    expect(await code(store.getJob(job.id))).toBe("not_found");
  });

  it("settles jobs left by a closed page: done if an image came back, and leaves live owners alone", async () => {
    const p = await store.createProject("a");
    const a = await store.createJob(jobFor(p.id, null, 2));
    await store.recordAttempt(a.id, { ok: true });
    const b = await store.createJob(jobFor(p.id));
    const c = await store.createJob({ ...jobFor(p.id), owner: "live" });
    expect(await store.recoverInterrupted((owner) => owner === "live")).toBe(2);
    const t = await store.projectTree(p.id);
    const by = Object.fromEntries(t.jobs.map((j) => [j.id, j]));
    expect([by[a.id].status, by[b.id].status, by[c.id].status]).toEqual(["done", "failed", "queued"]);
    expect(by[b.id].errors).toEqual([{ code: "interrupted", detail: "", variant: "" }]);
  });
});

describe("the asset library", () => {
  it("keeps an image once, renames, lists newest first, and deletes", async () => {
    const a = await store.putImage(PNG(1));
    const b = await store.putImage(PNG(2));
    const hat = await store.addAsset(a.sha, "hat");
    expect(hat).toMatchObject({ name: "hat", image: a.sha, width: 11, height: 21 });
    expect((await store.addAsset(a.sha, "again")).id).toBe(hat.id);
    const coat = await store.addAsset(b.sha, "coat");
    await store.renameAsset(hat.id, "red hat");
    expect((await store.listAssets()).map((x) => x.name)).toEqual(["coat", "red hat"]);
    await store.deleteAsset(coat.id);
    expect(await code(store.getAsset(coat.id))).toBe("not_found");
  });

  it("keeps the image of a deleted asset while a job used it", async () => {
    const p = await store.createProject("p");
    const a = await store.putImage(PNG(3));
    const hat = await store.addAsset(a.sha, "hat");
    await store.createJob({ ...jobFor(p.id), refs: [`asset:${hat.id}`], ref_images: [a.sha] });
    await store.deleteAsset(hat.id);
    expect(await store.collectGarbage()).toBe(0);
    expect((await store.getImage(a.sha)).sha).toBe(a.sha);
  });

  it("imports a pack, skipping images already in the library", async () => {
    const a = await store.putImage(PNG(4));
    const b = await store.putImage(PNG(5));
    await store.addAsset(a.sha, "mine");
    expect(await store.importAssets([{ name: "same", image: a.sha, created_at: 1 }, { name: "new", image: b.sha, created_at: 2 }])).toEqual([1, 1]);
    expect((await store.listAssets()).map((x) => x.name).sort()).toEqual(["mine", "new"]);
  });

  it("upgrades a version 1 database: the library is added, and jobs get their references' images", async () => {
    const factory = new IDBFactory();
    // the database as version 1 of this page made it
    await new Promise<void>((resolve, reject) => {
      const open = factory.open("old", 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore("projects", { keyPath: "id" });
        const nodes = db.createObjectStore("nodes", { keyPath: "id" });
        nodes.createIndex("project_id", "project_id");
        nodes.createIndex("parent_id", "parent_id");
        const jobs = db.createObjectStore("jobs", { keyPath: "id" });
        jobs.createIndex("project_id", "project_id");
        db.createObjectStore("images", { keyPath: "sha" });
        db.createObjectStore("thumbs", { keyPath: "sha" });
        nodes.put({ id: "n1", project_id: "p", parent_id: null, image: "a".repeat(64) });
        jobs.put({ id: "j1", project_id: "p", refs: ["n1", "gone"], status: "done" });
        jobs.put({ id: "j2", project_id: "p", refs: [], status: "done" });
      };
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });
    const upgraded = new BrowserStore(factory, "old");
    expect((await upgraded.getJob("j1")).ref_images).toEqual(["a".repeat(64), null]);
    expect((await upgraded.getJob("j2")).ref_images).toEqual([]);
    expect(await upgraded.listAssets()).toEqual([]);
  });
});
