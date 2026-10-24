// The same interface served by the local Python server (server mode), with the image API faked:
// the steps of browser.spec.ts that both modes share, so they keep behaving alike.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { strFromU8, unzipSync } from "fflate";
import { drag, imageToPage } from "./tools";

const SERVER = "http://127.0.0.1:4175";

function photo(): Buffer {
  const [w, h] = [1200, 800];
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = Math.sin(x * 0.05) * Math.cos(y * 0.04) * 40;
      p.data.set([Math.min(255, 110 + x * 0.1 + n), Math.min(255, 130 + y * 0.12 - n), 120, 255], (y * w + x) * 4);
    }
  }
  return PNG.sync.write(p);
}

async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem("brushgraft.lang", '"en"'));
  await page.goto(`${SERVER}/?token=e2e-token`);
  await page.locator(".shell").waitFor();
}

test.describe.configure({ mode: "serial" });

test("server mode: settings describe the workspace, and the token link opens the app", async ({ page }) => {
  await open(page);
  expect(new URL(page.url()).searchParams.get("token")).toBeNull(); // traded for a cookie, then removed
  await expect(page.locator(".status")).toContainText("Connected");
  await page.locator("header .settings").click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toContainText("Workspace");
  await expect(dialog).not.toContainText("Your data");
  await expect(dialog.getByRole("button", { name: "Save and test connection" })).toHaveCount(0);
});

test("server mode: an edit is pasted back, and a project round-trips through a zip", async ({ page }) => {
  await open(page);
  await page.locator("input[type=file][accept*='image']").first().setInputFiles({ name: "room.png", mimeType: "image/png", buffer: photo() });
  await expect(page.locator(".tree .row")).toHaveCount(1);
  const vp = (await page.locator(".viewport").boundingBox())!;
  const s = Math.min((vp.width - 56) / 1200, (vp.height - 56) / 800, 4);
  const [ox, oy] = [vp.x + (vp.width - 1200 * s) / 2, vp.y + (vp.height - 800 * s) / 2];
  await page.keyboard.press("r");
  await page.mouse.move(ox + 450 * s, oy + 250 * s);
  await page.mouse.down();
  await page.mouse.move(ox + 750 * s, oy + 550 * s, { steps: 6 });
  await page.mouse.up();
  await page.locator(".regions textarea").first().fill("leather chair");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".tree .row")).toHaveCount(2, { timeout: 20_000 });
  await expect(page.locator(".made")).toContainText("leather chair");

  // a project named in Chinese exports too, under its own name
  await page.locator("header .picker").click();
  await page.getByRole("menuitem", { name: "Rename project" }).click();
  await page.locator("dialog[open] input").fill("小猫 测试");
  await page.locator("dialog[open] input").press("Enter");
  await page.locator("header .picker").click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export project" }).click();
  expect((await download).suggestedFilename()).toBe("brushgraft-小猫_测试.zip");
  const file = await (await download).path();
  const manifest = JSON.parse(strFromU8(unzipSync(new Uint8Array(readFileSync(file)))["project.json"]));
  expect(manifest.format).toBe("brushgraft-project");
  expect(manifest.jobs[0].regions[0].instruction).toBe("leather chair");

  await page.locator("header .picker").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Import project" }).click();
  await (await chooser).setFiles(file);
  await expect(page.locator(".toast")).toContainText("Imported");
  await expect(page.locator(".tree .row")).toHaveCount(2);
});

test("server mode: a shape subtracted with Alt reaches the server and cuts the mask", async ({ page }) => {
  await open(page);
  await page.locator(".tree .row").first().locator(".select").click();
  const P = await imageToPage(page, [1200, 800]);
  await page.keyboard.press("m");
  await drag(page, [P(300, 200), P(700, 600)]);
  await page.keyboard.press("Shift+M");
  await page.keyboard.down("Alt");
  await drag(page, [P(450, 350), P(550, 450)]);
  await page.keyboard.up("Alt");
  await page.locator(".regions textarea").first().fill("a round table");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".toast")).toContainText(/Done|Submitted/, { timeout: 20_000 });
  const tree = await page.evaluate(async () => {
    const projects = await (await fetch("/api/projects")).json();
    const t = await (await fetch(`/api/projects/${projects[0].id}/tree`)).json();
    return t;
  });
  const job = tree.jobs.find((j: { regions: { shapes: { op?: string }[] }[] }) => j.regions[0]?.shapes.some((s) => s.op === "subtract"));
  expect(job).toBeTruthy();
  const at = await page.evaluate(async ([sha]) => {
    const bitmap = await createImageBitmap(await (await fetch(`/api/images/${sha}`)).blob());
    const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    c.drawImage(bitmap, 0, 0);
    return [c.getImageData(350, 250, 1, 1).data[0], c.getImageData(500, 400, 1, 1).data[0]];
  }, [job.mask_image]);
  expect(at).toEqual([255, 0]);
  // the server is shared by the tests that follow: let this job finish first
  await expect
    .poll(() => page.evaluate(async (id) => {
      const projects = await (await fetch("/api/projects")).json();
      const t = await (await fetch(`/api/projects/${projects[0].id}/tree`)).json();
      return t.jobs.find((j: { id: string }) => j.id === id)?.status;
    }, job.id), { timeout: 20_000 })
    .toBe("done");
});

test("server mode: the asset library works as in the browser build", async ({ page }) => {
  await open(page);
  const library = page.locator(".library");
  const swatch = new PNG({ width: 80, height: 60 });
  for (let i = 0; i < 80 * 60; i++) swatch.data.set([20, 160, 90, 255], i * 4);
  await library.locator("input[type=file][multiple]").setInputFiles({ name: "green scarf.png", mimeType: "image/png", buffer: PNG.sync.write(swatch) });
  await expect(library.locator(".grid li")).toHaveCount(1);
  await page.locator(".tree .row").first().locator(".select").click();
  await library.getByRole("button", { name: "green scarf: Use as reference image" }).click();
  await expect(page.locator(".composer .refs")).toContainText("green scarf");
  await page.locator("#prompt").fill("add the scarf of reference image 1");
  await page.keyboard.press("Control+Enter");
  // the job sent the asset's image, and keeps it after the asset goes
  await expect
    .poll(async () => page.evaluate(async () => {
      const projects = await (await fetch("/api/projects")).json();
      const t = await (await fetch(`/api/projects/${projects[0].id}/tree`)).json();
      return t.jobs.find((j: { refs: string[]; status: string }) => j.refs.some((r) => r.startsWith("asset:")) && j.status === "done") ?? null;
    }), { timeout: 20_000 })
    .not.toBeNull();
  const assets = await page.evaluate(async () => (await fetch("/api/assets")).json());
  await library.locator(".grid li").hover();
  await library.getByRole("button", { name: "Options for “green scarf”" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.locator("dialog[open] button[type=submit]").click();
  await expect(library.locator(".grid li")).toHaveCount(0);
  const refImages = await page.evaluate(async () => {
    const projects = await (await fetch("/api/projects")).json();
    const t = await (await fetch(`/api/projects/${projects[0].id}/tree`)).json();
    return t.jobs.filter((j: { refs: string[] }) => j.refs.some((r) => r.startsWith("asset:"))).map((j: { ref_images: string[] }) => j.ref_images);
  });
  expect(refImages).toEqual([[assets[0].image]]);
});

test("server mode: a moderation failure reads the same as in the browser build", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("brushgraft.model", '"fail-451"'));
  await open(page);
  await page.locator(".tree .row").first().locator(".select").click();
  await page.locator("#prompt").fill("make it nicer");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".toast.error")).toContainText("content moderation", { timeout: 20_000 });
});

test("server mode: a job finishing in the background doesn't cover another job's error", async ({ page }) => {
  // a slow network: the first submit is still on its way when the second is pressed
  await page.route("**/api/jobs", async (route) => {
    if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 600));
    await route.continue();
  });
  await open(page);
  await page.locator(".tree .row").first().locator(".select").click();
  await page.locator("#prompt").fill("[slow] warmer light");
  await page.keyboard.press("Control+Enter");
  await page.locator(".tree .row").first().locator(".select").click();
  await page.locator("#prompt").fill("[blocked] make it nicer");
  await page.keyboard.press("Control+Enter");
  const error = page.locator(".toast.error");
  await expect(error).toContainText("content moderation", { timeout: 20_000 });
  // the slow job finishes while the error is up: its message waits
  await expect(page.locator(".tree .row", { hasText: "warmer light" })).toHaveCount(1, { timeout: 20_000 });
  await page.waitForTimeout(300);
  await expect(error).toContainText("content moderation");
  await expect(page.locator(".toast:not(.error)")).toContainText("Done", { timeout: 10_000 });
});

test("server mode: a tree reload that was already on its way doesn't swallow a job's outcome", async ({ page }) => {
  // The snapshot of the event stream's opening reload is taken before the job exists and arrives
  // after its submit returns: the job must survive it, and its failure must still be announced.
  let trees = 0;
  let posted = () => {};
  const submitted = new Promise<void>((resolve) => (posted = resolve));
  await page.route("**/api/projects/*/tree", async (route) => {
    if (++trees === 1) return route.continue();
    const response = await route.fetch();
    await submitted;
    await route.fulfill({ response });
  });
  page.on("response", (r) => {
    if (r.url().endsWith("/api/jobs") && r.request().method() === "POST") posted();
  });
  await page.addInitScript(() => localStorage.setItem("brushgraft.model", '"fail-451"'));
  await open(page);
  await page.locator(".tree .row").first().locator(".select").click();
  await page.locator("#prompt").fill("make it nicer");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".toast.error")).toContainText("content moderation", { timeout: 20_000 });
  expect(trees).toBeGreaterThan(1);
});

test("server mode: the canvas's menu copies the image from the server", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page);
  // a project of its own, so the test runs alone too
  await page.locator("header .picker").click();
  await page.getByRole("menuitem", { name: /New project/ }).click();
  await page.locator("dialog[open] input").fill("clipboard");
  await page.locator("dialog[open] button[type=submit]").click();
  await page.locator("input[type=file][accept*='image']").first().setInputFiles({ name: "room.png", mimeType: "image/png", buffer: photo() });
  await expect(page.locator(".tree .row")).toHaveCount(1);
  const vp = (await page.locator(".viewport").boundingBox())!;
  await page.mouse.click(vp.x + vp.width / 2, vp.y + vp.height / 2, { button: "right" });
  await page.getByRole("menu", { name: "Canvas menu" }).getByRole("menuitem", { name: "Copy image" }).click();
  await expect(page.locator(".toast")).toContainText("Image copied");
  const size = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const bitmap = await createImageBitmap(await item.getType("image/png"));
    return [bitmap.width, bitmap.height];
  });
  expect(size).toEqual([1200, 800]);
});

test("server mode: the same version sent again by the server leaves the canvas's menu open", async ({ page }) => {
  // The upload's own event can arrive after the menu opens, and a star or a tree reload sends the
  // version again too: a new object for the same version, which must not close the menu.
  await open(page);
  // a project of its own: the menu opens on the version just uploaded, not an earlier test's
  await page.locator("header .picker").click();
  await page.getByRole("menuitem", { name: /New project/ }).click();
  await page.locator("dialog[open] input").fill("same version");
  await page.locator("dialog[open] button[type=submit]").click();
  await page.locator("input[type=file][accept*='image']").first().setInputFiles({ name: "room.png", mimeType: "image/png", buffer: photo() });
  await expect(page.locator(".tree .row")).toHaveCount(1);
  const vp = (await page.locator(".viewport").boundingBox())!;
  await page.mouse.click(vp.x + vp.width / 2, vp.y + vp.height / 2, { button: "right" });
  const menu = page.getByRole("menu", { name: "Canvas menu" });
  await expect(menu).toBeVisible();
  const event = page.waitForResponse((r) => r.url().includes("/api/nodes/") && r.request().method() === "PATCH");
  await page.evaluate(async () => {
    const project = JSON.parse(localStorage.getItem("brushgraft.project")!);
    const [node] = (await (await fetch(`/api/projects/${project}/tree`)).json()).nodes;
    await fetch(`/api/nodes/${node.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" });
  });
  await event;
  await page.waitForTimeout(500); // the stream delivers the node event
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Copy image" }).focus();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});
