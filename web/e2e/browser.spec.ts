// The website build, end to end in a real browser, against a fake image API: first run, key handling,
// an edit with paste-back, persistence, export and import, and what happens when the API fails.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { strFromU8, unzipSync } from "fflate";
import { drag, imageToPage } from "./tools";

const API = "http://127.0.0.1:4174";

/** a 1200x800 picture with enough structure for the paste-back to work on */
function photo(): Buffer {
  const [w, h] = [1200, 800];
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = Math.sin(x * 0.05) * Math.cos(y * 0.04) * 40 + ((x * 7 + y * 13) % 11) * 2;
      p.data.set([Math.min(255, 110 + x * 0.1 + n), Math.min(255, 130 + y * 0.12 - n), Math.min(255, 90 + (x + y) * 0.05 + n * 0.5), 255], (y * w + x) * 4);
    }
  }
  return PNG.sync.write(p);
}

const apiLog = async (): Promise<{ op: string; prompt: string; images?: number; auth: string }[]> => (await fetch(`${API}/log`)).json();

async function setUp(page: Page, model?: string) {
  await page.addInitScript(([m]) => {
    if (!localStorage.getItem("brushgraft.lang")) localStorage.setItem("brushgraft.lang", '"en"');
    if (m) localStorage.setItem("brushgraft.model", JSON.stringify(m));
  }, [model]);
  await page.goto("/");
  await page.locator(".shell").waitFor();
}

async function saveKey(page: Page) {
  const dialog = page.locator("dialog[open]");
  await dialog.locator("input[type=password]").fill("test-key");
  await dialog.locator("input[placeholder*='api.openai']").fill(`${API}/v1`);
  await dialog.locator("button[type=submit]").click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
}

async function importPhoto(page: Page) {
  await page.locator("input[type=file][accept*='image']").first().setInputFiles({ name: "room.png", mimeType: "image/png", buffer: photo() });
  await expect(page.locator(".tree .row")).toHaveCount(1);
  await expect.poll(() => page.locator(".tree img.thumb").first().evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
}

/** drag a rectangle over the image, in image pixels */
async function markRegion(page: Page, [x0, y0, x1, y1]: number[]) {
  const vp = (await page.locator(".viewport").boundingBox())!;
  const [W, H] = [1200, 800];
  const s = Math.min((vp.width - 56) / W, (vp.height - 56) / H, 4);
  const [ox, oy] = [vp.x + (vp.width - W * s) / 2, vp.y + (vp.height - H * s) / 2];
  await page.keyboard.press("r");
  await page.mouse.move(ox + x0 * s, oy + y0 * s);
  await page.mouse.down();
  await page.mouse.move(ox + x1 * s, oy + y1 * s, { steps: 6 });
  await page.mouse.up();
}

test("first run: the key stays in the browser, and connection testing says why it fails", async ({ page }) => {
  await setUp(page);
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toContainText("stored in this browser");
  await expect(dialog).not.toContainText("Workspace");
  await expect(dialog.locator("legend", { hasText: "Your data" })).toBeVisible();

  await dialog.locator("input[placeholder*='api.openai']").fill(`${API}/v1`);
  await dialog.locator("input[type=password]").fill("wrong-key");
  await dialog.getByRole("button", { name: "Save and test connection" }).click();
  await expect(dialog.locator("p.error")).toContainText("401");
  await dialog.locator("input[type=password]").fill("test-key");
  await dialog.getByRole("button", { name: "Save and test connection" }).click();
  await expect(dialog.locator("p.ok")).toBeVisible();
  await dialog.locator("button[type=submit]").click();
  await expect(page.locator("header .dot")).toHaveCount(0);
});

test("an edit goes to the API with the key, is pasted back, and survives a reload", async ({ page }) => {
  await setUp(page);
  await saveKey(page);
  await importPhoto(page);
  await markRegion(page, [400, 250, 800, 600]);
  await page.locator(".regions textarea").first().fill("leather chair");
  const sent = (await apiLog()).length;
  // a double press sends it once: the edit is emptied as it leaves, and an empty one can't go
  await page.keyboard.press("Control+Enter");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".tree .row")).toHaveCount(2, { timeout: 20_000 });
  await page.waitForTimeout(500);

  const log = await apiLog();
  expect(log.length - sent).toBe(1);
  const edit = log.find((l) => l.op === "edit")!;
  expect(edit.images).toBe(2); // the original and the annotated copy
  expect(edit.auth).toBe("Bearer test-key");
  expect(edit.prompt).toContain("Area 1 (red): leather chair");
  expect(edit.prompt).not.toContain("\r"); // sent byte for byte, as the server build sends it
  await expect(page.locator(".made")).toContainText("leather chair");

  const node = await page.evaluate(
    () =>
      new Promise<{ raw_image: string | null; merged_image: string | null; parent_id: string | null }[]>((resolve) => {
        const open = indexedDB.open("brushgraft");
        open.onsuccess = () => {
          const all = open.result.transaction(["nodes"]).objectStore("nodes").getAll();
          all.onsuccess = () => resolve(all.result);
        };
      }),
  );
  const child = node.find((n) => n.parent_id)!;
  expect(child.raw_image && child.merged_image).toBeTruthy(); // the pasted result beside the model's whole output

  await page.reload();
  await expect(page.locator(".tree .row")).toHaveCount(2);
  await expect(page.locator("dialog[open]")).toHaveCount(0); // the key is remembered
  await expect.poll(() => page.locator(".tree img.thumb").evaluateAll((els) => els.every((i) => (i as HTMLImageElement).naturalWidth > 0))).toBe(true);
});

test("a prompt near its limit shows a count, one past it says what to shorten, and an API's too-long is explained", async ({ page }) => {
  await setUp(page, "fail-413");
  await saveKey(page);
  await importPhoto(page);
  const prompt = page.locator("#prompt");
  const count = page.locator("#prompt-count");
  await prompt.fill("make it nicer");
  await expect(count).toHaveCount(0); // a sentence needs no counter
  await prompt.fill("猫".repeat(24_500));
  await expect(count).toHaveText("24,500 / 30,000");
  await expect(prompt).toHaveAttribute("aria-invalid", "false");
  await prompt.fill("猫".repeat(30_001));
  await expect(count).toHaveClass(/\bover\b/);
  await expect(prompt).toHaveAttribute("aria-invalid", "true");
  const submit = page.locator(".submit button.primary");
  await expect(submit).toBeDisabled();
  await expect(page.locator(".submit .hint")).toContainText("shorten the fields marked in red");
  await page.keyboard.press("Control+Enter"); // the shortcut is held back too
  await page.waitForTimeout(300);
  expect((await apiLog()).filter((l) => l.prompt?.startsWith("猫"))).toHaveLength(0);

  // within our limit, but this model turns it down: the error says what to do
  await prompt.fill("猫".repeat(20_000));
  await expect(submit).toBeEnabled();
  await page.keyboard.press("Control+Enter");
  const toast = page.locator(".toast.error");
  await expect(toast).toContainText("Prompt too long for this model (HTTP 413)", { timeout: 20_000 });
  await expect(toast).toContainText("Shorten the instructions");
  await expect(toast).not.toContainText("input_too_large"); // the raw body stays in the job's details
});

/** a small picture of one color, as an image file to add */
function swatch(rgb: [number, number, number], w = 96, h = 64): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) p.data.set([...rgb, 255], i * 4);
  return PNG.sync.write(p);
}

test("the asset library: any project uses an asset as a reference; history keeps it; packs move it", async ({ page }) => {
  await setUp(page);
  await saveKey(page);
  await importPhoto(page);
  const library = page.locator(".library");
  await library.locator("input[type=file][multiple]").setInputFiles([
    { name: "red hat.png", mimeType: "image/png", buffer: swatch([200, 30, 30]) },
    { name: "blue coat.png", mimeType: "image/png", buffer: swatch([30, 60, 200]) },
  ]);
  await expect(library.locator(".grid li")).toHaveCount(2);
  await expect(page.locator(".toast")).toContainText("Added 2 images");
  // the same image again is the asset already there
  await library.locator("input[type=file][multiple]").setInputFiles([{ name: "again.png", mimeType: "image/png", buffer: swatch([200, 30, 30]) }]);
  await expect(page.locator(".toast")).toContainText("“red hat” is already in the asset library");
  await expect(library.locator(".grid li")).toHaveCount(2);

  // clicking an asset makes it a reference of the edit being prepared
  await library.getByRole("button", { name: "red hat: Use as reference image" }).click();
  await expect(page.locator(".composer .refs")).toContainText("red hat");
  await page.locator("#prompt").fill("give her the hat of reference image 1");
  let sent = (await apiLog()).length;
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".tree .row")).toHaveCount(2, { timeout: 20_000 });
  let log = await apiLog();
  expect(log.slice(sent).map((l) => l.images)).toEqual([2]); // the version, and the asset

  // another project uses it too
  await page.locator("header .picker").click();
  await page.getByRole("menuitem", { name: "New project…" }).click();
  await page.locator("dialog[open] input").fill("Second");
  await page.locator("dialog[open] button[type=submit]").click();
  await expect(page.locator(".tree .row")).toHaveCount(0);
  await library.getByRole("button", { name: "Options for “blue coat”" }).click();
  await page.getByRole("menuitem", { name: "Add to current project" }).click();
  await expect(page.locator(".tree .row")).toHaveCount(1);
  await library.getByRole("button", { name: "red hat: Use as reference image" }).click();
  await page.locator("#prompt").fill("the hat of reference image 1");
  sent = (await apiLog()).length;
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".tree .row")).toHaveCount(2, { timeout: 20_000 });
  log = await apiLog();
  expect(log.slice(sent).map((l) => l.images)).toEqual([2]);

  // deleting the asset leaves what was made with it as it was
  await library.locator(".grid li").filter({ hasText: "red hat" }).hover();
  await library.getByRole("button", { name: "Options for “red hat”" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.locator("dialog[open] button[type=submit]").click();
  await expect(library.locator(".grid li")).toHaveCount(1);
  await page.locator(".tree .row").nth(1).locator(".select").click();
  const ref = page.locator(".made .refs .thumb");
  await expect(ref).toHaveAttribute("aria-label", /an asset since deleted/);
  await expect.poll(() => ref.locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);

  // the library as a pack: out, and back in, skipping what is there
  const download = page.waitForEvent("download");
  await library.getByRole("button", { name: "Asset library options" }).click();
  await page.getByRole("menuitem", { name: "Export asset library…" }).click();
  const pack = await (await download).path();
  await library.locator("input[type=file][accept*=zip]").setInputFiles(pack);
  await expect(page.locator(".toast")).toContainText("Added 0 images to the asset library; 1 already there");
});

test("failures are explained in the interface's language", async ({ page }) => {
  await setUp(page, "fail-451");
  await saveKey(page);
  await importPhoto(page);
  await page.locator("#prompt").fill("make it nicer");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".toast.error")).toContainText("content moderation (HTTP 451)", { timeout: 20_000 });
  await expect(page.locator(".tree .row")).toHaveCount(1);
  // the Jobs list: the same explanation, and what the service sent under it
  await page.getByRole("button", { name: "Jobs" }).click();
  await expect(page.locator(".queue .error").first()).toContainText("Revise the prompt");
  await page.locator(".queue .raw summary").first().click();
  await expect(page.locator(".queue .raw code").first()).toContainText("HTTP 451");
});

test("a result that comes as a url is downloaded by the page", async ({ page }) => {
  await setUp(page, "urls-only");
  await saveKey(page);
  await importPhoto(page);
  await page.locator("#prompt").fill("cooler tones");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".tree .row")).toHaveCount(2, { timeout: 20_000 });
});

test("export gives a zip without the key, and importing it makes a new project", async ({ page }) => {
  await setUp(page);
  await saveKey(page);
  await importPhoto(page);
  await page.locator("#prompt").fill("a variation");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".tree .row")).toHaveCount(2, { timeout: 20_000 });

  await page.locator("header .picker").click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export project" }).click();
  const file = await (await download).path();
  const files = unzipSync(new Uint8Array(readFileSync(file)));
  const manifest = JSON.parse(strFromU8(files["project.json"]));
  expect(manifest.nodes).toHaveLength(2);
  expect(Object.keys(files).filter((n) => n.startsWith("images/")).length).toBeGreaterThanOrEqual(2);
  expect(strFromU8(files["project.json"])).not.toContain("test-key");

  await page.locator("header .picker").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Import project" }).click();
  await (await chooser).setFiles(file);
  await expect(page.locator(".tree .row")).toHaveCount(2);
  await page.waitForTimeout(150);
  await page.locator("header .picker").click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(2);
});

test("a file that isn't a project is refused with a reason, and nothing is added", async ({ page }) => {
  await setUp(page);
  await saveKey(page);
  await page.locator("header .picker").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Import project" }).click();
  await (await chooser).setFiles({ name: "x.zip", mimeType: "application/zip", buffer: Buffer.from("not a zip") });
  await expect(page.locator(".toast.error")).toContainText("Not a brushgraft project file");
  await page.waitForTimeout(150);
  await page.locator("header .picker").click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(1);
});

test("the page talks only to itself and the image service, and the policy blocks nothing it needs", async ({ page }) => {
  const hosts = new Set<string>();
  const problems: string[] = [];
  page.on("request", (r) => r.url().startsWith("http") && hosts.add(new URL(r.url()).origin));
  page.on("console", (m) => /Content Security Policy|Refused to/.test(m.text()) && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  await setUp(page);
  await saveKey(page);
  await importPhoto(page);
  await markRegion(page, [300, 200, 700, 500]);
  await page.locator(".regions textarea").first().fill("a lamp");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".tree .row")).toHaveCount(2, { timeout: 20_000 });
  expect([...hosts].sort()).toEqual(["http://127.0.0.1:4173", API]);
  expect(problems).toEqual([]);
});

/** every stored job, and an image's bytes as base64, from the page's IndexedDB */
const readDb = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ jobs: { regions: { shapes: { type: string; op?: string }[] }[]; mask_image: string }[]; images: Record<string, string> }>((resolve) => {
        const open = indexedDB.open("brushgraft");
        open.onsuccess = () => {
          const tx = open.result.transaction(["jobs", "images"]);
          const jobs = tx.objectStore("jobs").getAll();
          const images = tx.objectStore("images").getAll();
          tx.oncomplete = () => {
            const out: Record<string, string> = {};
            for (const row of images.result) {
              const b = new Uint8Array(row.data);
              let s = "";
              for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
              out[row.sha] = btoa(s);
            }
            resolve({ jobs: jobs.result, images: out });
          };
        };
      }),
  );

const maskAt = (page: Page, png: string, x: number, y: number) =>
  page.evaluate(async ([png, x, y]) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png as string), (c) => c.charCodeAt(0))]));
    const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    c.drawImage(bitmap, 0, 0);
    return c.getImageData(x as number, y as number, 1, 1).data[0];
  }, [png, x, y] as const);

test("selection tools work as in Photoshop, and the mask sent has the hole Alt cut", async ({ page }) => {
  await setUp(page);
  await saveKey(page);
  await importPhoto(page);
  const P = await imageToPage(page, [1200, 800]);
  const regions = page.locator(".regions textarea");

  // M: a rectangle makes region 1
  await page.keyboard.press("m");
  await drag(page, [P(300, 200), P(700, 600)]);
  await expect(regions).toHaveCount(1);
  // Shift+M switches to the ellipse; Alt-drag cuts a hole out of the region
  await page.keyboard.press("Shift+M");
  await expect(page.getByRole("button", { name: "Ellipse" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.down("Alt");
  await drag(page, [P(450, 350), P(550, 450)]);
  await page.keyboard.up("Alt");
  await expect(regions).toHaveCount(1);
  // undo removes the hole, redo brings it back
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+Shift+z");
  // a subtraction that removes all of a region removes the region, and says so
  await page.keyboard.press("m");
  await drag(page, [P(800, 100), P(900, 200)]);
  await expect(regions).toHaveCount(2);
  await page.keyboard.down("Alt");
  await drag(page, [P(780, 80), P(920, 220)]);
  await page.keyboard.up("Alt");
  await expect(regions).toHaveCount(1);
  await expect(page.locator(".toast")).toContainText("removed");
  await page.keyboard.press("Control+z");
  await expect(regions).toHaveCount(2);
  await page.locator(".regions li").nth(1).locator("button.remove").click();
  await expect(regions).toHaveCount(1);
  // the polygonal lasso: L, Shift+L, click corners, Enter closes
  await page.keyboard.press("l");
  await page.keyboard.press("Shift+L");
  for (const p of [P(800, 500), P(1000, 500), P(1000, 700)]) await page.mouse.click(...p);
  await page.keyboard.press("Enter");
  await expect(regions).toHaveCount(2);
  // the selection mode buttons: Intersect, then an ellipse keeps only the overlap with region 2.
  // M picks the marquee used last (the ellipse since Shift+M), as in Photoshop
  await page.getByRole("radio", { name: "Intersect with region" }).click();
  await page.keyboard.press("m");
  await expect(page.getByRole("button", { name: "Ellipse" })).toHaveAttribute("aria-pressed", "true");
  await drag(page, [P(850, 450), P(1100, 750)]);
  await expect(regions).toHaveCount(2);
  await page.getByRole("radio", { name: "New region" }).click();
  // the eraser always subtracts
  await page.keyboard.press("e");
  await expect(page.getByRole("radio", { name: "Subtract from region" })).toHaveAttribute("aria-checked", "true");
  // Move (V): drag a handle to resize region 1, then nudge with the arrow keys
  await page.keyboard.press("v");
  await page.mouse.click(...P(320, 220));
  await drag(page, [P(700, 600), P(720, 620)]);
  await page.keyboard.press("ArrowLeft");
  // ⌘/Ctrl+A selects the whole image as a new region
  await page.keyboard.press("Control+a");
  await expect(regions).toHaveCount(3);
  await page.locator(".regions li").nth(2).locator("button.remove").click();

  await regions.nth(0).fill("a round table");
  await regions.nth(1).fill("a lamp");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".tree .row")).toHaveCount(2, { timeout: 20_000 });

  const { jobs, images } = await readDb(page);
  const job = jobs.find((j) => j.regions.length)!;
  const ops = job.regions.map((r) => r.shapes.map((s) => `${s.type}:${s.op ?? "add"}`));
  expect(ops).toEqual([["rect:add", "ellipse:subtract"], ["lasso:add", "ellipse:intersect"]]);
  expect(JSON.stringify(job.regions)).not.toContain("uid"); // client-side ids are not sent
  const mask = images[job.mask_image];
  expect(await maskAt(page, mask, 350, 250)).toBe(255); // inside the rectangle (moved 1 px left)
  expect(await maskAt(page, mask, 500, 400)).toBe(0); // the hole
  expect(await maskAt(page, mask, 980, 680)).toBe(255); // inside polygon and intersect
  expect(await maskAt(page, mask, 820, 510)).toBe(0); // in the polygon, outside the intersecting ellipse
});

test("the wheel scrolls, Shift or Ctrl + wheel scrolls sideways, Alt + wheel and a pinch zoom, as in Photoshop", async ({ page }) => {
  await setUp(page);
  await saveKey(page);
  await importPhoto(page);
  const vp = (await page.locator(".viewport").boundingBox())!;
  const [cx, cy] = [vp.x + vp.width / 2, vp.y + vp.height / 2 - 5];
  const zoom = page.locator(".toolbar .zoom");
  const percent = async () => parseFloat((await zoom.textContent())!);
  // where the pointer is on the image, from the status bar
  const at = async (): Promise<[number, number]> => {
    await page.mouse.move(cx + 1, cy);
    await page.mouse.move(cx, cy);
    const items = await page.locator(".status .item").allTextContents();
    const x = items.find((t) => /^x \d/.test(t));
    const y = items.find((t) => /^y \d/.test(t));
    return [parseInt(x!.slice(2)), parseInt(y!.slice(2))];
  };
  const fit = await percent();
  const s = fit / 100;
  const [x0, y0] = await at();

  await page.mouse.wheel(0, 100);
  let [x, y] = await at();
  expect(await percent()).toBe(fit);
  expect(Math.abs(y - y0 - 100 / s)).toBeLessThan(2);
  expect(x).toBe(x0);

  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Shift");
  [x, y] = await at();
  expect(Math.abs(x - x0 - 100 / s)).toBeLessThan(2);

  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  [x] = await at();
  expect(await percent()).toBe(fit); // a real Ctrl + wheel scrolls sideways, it doesn't zoom
  expect(Math.abs(x - x0)).toBeLessThan(2);

  const before = await at();
  await page.keyboard.down("Alt");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Alt");
  expect(await percent()).toBeGreaterThan(fit * 1.1);
  const after = await at();
  // the zoom is about the pointer: the same image point stays under it
  expect(Math.abs(after[0] - before[0])).toBeLessThan(2);
  expect(Math.abs(after[1] - before[1])).toBeLessThan(2);

  // a trackpad pinch: ctrlKey set with no Ctrl key down
  const zoomed = await percent();
  await page.locator(".viewport").dispatchEvent("wheel", { deltaY: -30, ctrlKey: true, clientX: cx, clientY: cy });
  expect(await percent()).toBeGreaterThan(zoomed * 1.2);

  // the zoom keys step through Photoshop's levels; 1 is 100%, 0 fits
  await page.keyboard.press("1");
  await expect(zoom).toHaveText("100%");
  await page.keyboard.press("ControlOrMeta+Equal");
  await expect(zoom).toHaveText("200%");
  await page.keyboard.press("-");
  await page.keyboard.press("-");
  await expect(zoom).toHaveText("66.7%");
  await page.keyboard.press("0");
  await expect(zoom).toHaveText(`${fit}%`);

  // scrolling stops with an edge at the middle: some of the image always stays in sight
  for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 200);
  [, y] = await at();
  expect(y).toBeGreaterThan(780);
  expect(y).toBeLessThan(800);
  await page.keyboard.press("Home");
  [x, y] = await at();
  expect(Math.abs(x - (vp.width / 2) / s)).toBeLessThan(3);

  // "Zoom with scroll wheel" swaps the two, as Photoshop's preference does
  await page.keyboard.press("0");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Zoom with scroll wheel").check();
  await page.keyboard.press("Escape");
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -100);
  expect(await percent()).toBeGreaterThan(fit * 1.1);
});

/** the regions of the draft being edited, from the page's own state as saved */
const draftRegions = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 400)); // drafts are saved 300 ms after a change
    const key = Object.keys(localStorage).find((k) => k.startsWith("brushgraft.drafts."))!;
    const drafts = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, { regions: { shapes: Record<string, unknown>[] }[] }>;
    return Object.values(drafts).flatMap((d) => d.regions);
  });

test("details as in Photoshop: Esc cancels a drag, the eraser takes only what it touches, keys after the slider", async ({ page }) => {
  await setUp(page);
  await saveKey(page);
  await importPhoto(page);
  const P = await imageToPage(page, [1200, 800]);
  const regions = page.locator(".regions textarea");
  await page.keyboard.press("m");
  await drag(page, [P(100, 100), P(300, 300)]);
  await page.keyboard.press("Escape"); // deselect
  await drag(page, [P(700, 100), P(900, 300)]);
  await expect(regions).toHaveCount(2);

  // Esc during a drag drops it: nothing is drawn, nothing is subtracted
  await page.mouse.move(...P(500, 500));
  await page.mouse.down();
  await page.mouse.move(...P(650, 650), { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(regions).toHaveCount(2);
  // ... and a move dragged with V goes back where it was
  await page.keyboard.press("v");
  await page.mouse.move(...P(200, 200));
  await page.mouse.down();
  await page.mouse.move(...P(260, 230), { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  let saved = await draftRegions(page);
  expect(saved[0].shapes[0]).toMatchObject({ x: 100, y: 100 });

  // Shift while moving keeps the move straight
  await page.mouse.move(...P(200, 200));
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(...P(300, 215), { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  saved = await draftRegions(page);
  expect(saved[0].shapes[0]).toMatchObject({ y: 100 });
  expect((saved[0].shapes[0].x as number) - 100).toBeGreaterThan(90);

  // the eraser with nothing selected takes only from the regions it touches
  await page.keyboard.press("Escape");
  await page.keyboard.press("e");
  await drag(page, [P(800, 200), P(820, 220)]);
  saved = await draftRegions(page);
  expect(saved.map((r) => r.shapes.length)).toEqual([1, 2]);
  // a stroke that touches nothing changes nothing, and leaves no undo step
  await drag(page, [P(500, 600), P(520, 620)]);
  saved = await draftRegions(page);
  expect(saved.map((r) => r.shapes.length)).toEqual([1, 2]);

  // a brush stroke past the image's edge keeps its shape (the mask is cut there)
  await page.keyboard.press("b");
  await drag(page, [P(1150, 400), P(1250, 450)]);
  saved = await draftRegions(page);
  const stroke = saved.at(-1)!.shapes[0] as { points: [number, number][] };
  expect(Math.max(...stroke.points.map((q) => q[0]))).toBeGreaterThan(1200);

  // keys still work after the brush slider was used
  const slider = page.locator(".toolbar input[type=range]");
  await slider.focus();
  await page.keyboard.press("ArrowRight"); // the slider's own key
  await page.keyboard.press("Control+z");
  await expect(regions).toHaveCount(2);
  await page.keyboard.press("v");
  await expect(page.getByRole("button", { name: "Move" })).toHaveAttribute("aria-pressed", "true");

  // ⌘A twice selects the same whole-image region
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+a");
  await expect(regions).toHaveCount(3);
});

test("on a phone the selection modes and the brush size are menus, without keyboard hints", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setUp(page);
  await saveKey(page);
  await page.locator("input[type=file][accept*='image']").first().setInputFiles({ name: "room.png", mimeType: "image/png", buffer: photo() });
  await page.keyboard.press("m");
  await page.locator(".mode-pick").click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitemradio")).toHaveCount(4);
  await menu.getByRole("menuitemradio", { name: "Subtract from region" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  // the brush size sits behind a picker, as Photoshop's brush preset picker
  await page.keyboard.press("b");
  await expect(page.locator(".toolbar input[type=range]")).toHaveCount(0);
  await page.locator(".size-pick").click();
  const sizes = page.getByRole("dialog", { name: "Brush size" });
  // a log scale from 2 to 1000 px: the middle of the slider is about 45 px
  await sizes.locator("input[type=range]").fill("500");
  await expect(page.locator(".size-pick")).toHaveAttribute("aria-label", "Brush size: 45");
  await page.keyboard.press("Escape");
  await expect(sizes).toHaveCount(0);
  const overflow = await page.locator(".toolbar").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.locator(".toolbar")).not.toHaveClass(/wrap/);
});

test("on a phone nothing overflows and the sheet opens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setUp(page);
  await saveKey(page);
  // the version tree is a drawer on a phone: the photo goes in from the canvas, and the bottom bar offers to edit it
  await page.locator("input[type=file][accept*='image']").first().setInputFiles({ name: "room.png", mimeType: "image/png", buffer: photo() });
  await expect(page.locator(".peek .primary")).toHaveText("Edit");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.locator(".peek .primary").click();
  await expect(page.getByRole("dialog", { name: "Edit" })).toBeVisible();
});

test("a result that lands while a new image is being written leaves the writer where they are", async ({ page }) => {
  await setUp(page, "slow");
  await saveKey(page);
  await importPhoto(page);
  await markRegion(page, [400, 250, 800, 600]);
  await page.locator(".regions textarea").first().fill("leather chair");
  await page.keyboard.press("Control+Enter");
  await page.getByRole("tab", { name: "New image" }).click();
  await page.locator("#prompt").fill("a lighthouse at dusk");
  await expect(page.locator(".tree .row")).toHaveCount(2, { timeout: 20_000 });
  await page.waitForTimeout(300);
  await expect(page.getByRole("tab", { name: "New image" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#prompt")).toHaveValue("a lighthouse at dusk");
});

test("small things: Starred only, a custom size, undo keeps the region selected, the selection outlives another version", async ({ page }) => {
  await setUp(page);
  await saveKey(page);
  await importPhoto(page);
  const rows = page.locator(".tree .row");
  const starredOnly = page.getByRole("button", { name: "Starred only" });
  // the last star gone, the whole tree is back, and a new star doesn't filter it again
  await page.locator(".caption-actions").getByRole("button", { name: "Star" }).click();
  await starredOnly.click();
  await expect(page.locator(".tree .flat-row")).toHaveCount(1);
  await page.locator(".caption-actions").getByRole("button", { name: "Unstar" }).click();
  await expect(starredOnly).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await page.locator(".caption-actions").getByRole("button", { name: "Star" }).click();
  await expect(page.locator(".tree .flat-row")).toHaveCount(0);
  await expect(rows).toHaveCount(1);

  // Custom… opens a field to type the size in
  await page.getByRole("tab", { name: "New image" }).click();
  await page.locator("#size").selectOption({ label: "Custom…" });
  await expect(page.locator("#custom-size")).toBeVisible();
  await page.locator("#custom-size").fill("1000x1000");
  await expect(page.locator("#size")).toHaveValue("__custom__");

  // regions A, B, C (C selected); remove A, undo: C is still the one selected, so Delete takes C
  await page.getByRole("tab", { name: "Edit this version" }).click();
  for (const [k, box] of [[400, 100, 500, 200], [600, 100, 700, 200], [800, 100, 900, 200]].entries()) {
    await markRegion(page, box);
    await page.locator(".regions textarea").nth(k).fill("ABC"[k]);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // R is a shortcut again
  }
  await page.locator(".regions li").nth(0).locator("button.remove").click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+z");
  await expect(page.locator(".regions textarea")).toHaveCount(3);
  await page.keyboard.press("Delete");
  await expect(page.locator(".regions textarea")).toHaveCount(2);
  expect(await page.locator(".regions textarea").evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value))).toEqual(["A", "B"]);

  // Ctrl+Enter while a polygon is still open doesn't send the regions without it
  const sent = (await apiLog()).length;
  const P = await imageToPage(page, [1200, 800]);
  await page.keyboard.press("l");
  await page.keyboard.press("Shift+L");
  for (const p of [P(300, 500), P(500, 500), P(500, 700)]) await page.mouse.click(...p);
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(800);
  expect((await apiLog()).length).toBe(sent);
  await page.keyboard.press("Escape");

  // a second picture: deleting the first one keeps the second selected
  await page.locator("input[type=file][accept*='image']").first().setInputFiles({ name: "second.png", mimeType: "image/png", buffer: photo() });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).locator("button.select")).toHaveAttribute("aria-current", "true");
  await rows.nth(0).hover();
  await rows.nth(0).locator("button.trash").click();
  await page.locator("dialog[open] button[type=submit]").click();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0).locator("button.select")).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("tab", { name: "Edit this version" })).toHaveAttribute("aria-selected", "true");

  // Space presses a button reached with Tab (and pans the canvas otherwise)
  const row = rows.nth(0);
  await row.locator("button.select").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(row.locator("button.star")).toBeFocused();
  await page.keyboard.press(" ");
  await expect(row.locator("button.star")).toHaveAttribute("aria-pressed", "true");
});

test("a job still generating opens from the tree: the original with its regions, and what it asked for", async ({ page }) => {
  await setUp(page, "slow");
  await saveKey(page);
  await importPhoto(page);
  await markRegion(page, [400, 250, 800, 600]);
  await page.locator(".regions textarea").first().fill("leather chair");
  await page.keyboard.press("Control+Enter");

  // while it generates: the original with the job's region, and the job's details beside it
  await page.locator(".tree li.pending button.select").click();
  const panel = page.getByRole("complementary", { name: "Job" });
  await expect(panel.locator(".state")).toHaveText(/Queued|Generating/);
  await expect(panel.locator(".made")).toContainText("leather chair");
  await expect(panel.locator("dl")).toContainText("slow");
  await expect(page.locator(".caption .job-state")).toHaveText(/Queued|Generating/);
  await expect(page.locator(".tip")).toContainText("regions of this edit");
  await expect(page.getByRole("button", { name: "Rectangle" })).toBeDisabled(); // nothing is edited here
  await expect(page.locator(".tree .row").first().locator("button.select")).toHaveAttribute("aria-current", "false");
  // when it's done, its result shows
  await expect(page.locator(".tree .row")).toHaveCount(2, { timeout: 20_000 });
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".tree .row").nth(1).locator("button.select")).toHaveAttribute("aria-current", "true");

  // a new image has no original to show: the canvas says what is coming
  await page.getByRole("tab", { name: "New image" }).click();
  await page.locator("#prompt").fill("a lighthouse at dusk");
  await page.keyboard.press("Control+Enter");
  await page.locator(".tree li.pending button.select").click();
  await expect(page.locator(".welcome .lead")).toHaveText("Generating new image…");
  await expect(page.locator(".welcome .job-prompt")).toHaveText("a lighthouse at dusk");
  await expect(panel.locator(".made")).toContainText("a lighthouse at dusk");
  await expect(page.locator(".tree .row")).toHaveCount(3, { timeout: 20_000 });
  await expect(page.locator(".tree .row").nth(2).locator("button.select")).toHaveAttribute("aria-current", "true");
});

test("a failed job opens from the tree: the whole explanation, the service's answer and the log", async ({ page }) => {
  await setUp(page, "fail-451");
  await saveKey(page);
  await importPhoto(page);
  await page.locator("#prompt").fill("make it nicer");
  await page.keyboard.press("Control+Enter");
  const panel = page.getByRole("complementary", { name: "Job" });
  const failed = page.locator(".tree li.pending.failed");
  await expect(failed).toContainText("Blocked by content moderation (HTTP 451)", { timeout: 20_000 });
  await expect(failed).not.toContainText("Revise"); // one line: what went wrong; the rest is a click away
  await failed.locator("button.select").click();
  await expect(panel.locator(".state")).toHaveText("Failed");
  await expect(panel.locator(".errors")).toContainText("Revise the prompt");
  await panel.locator(".raw summary").click();
  await expect(panel.locator(".raw code")).toContainText("HTTP 451");
  await expect(panel.locator(".log")).toContainText("HTTP 451");
  await expect(panel.locator(".log li").first()).toContainText("Requesting fail-451");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await failed.locator("button.select").click();
  await panel.getByRole("button", { name: "Remove" }).click();
  await expect(failed).toHaveCount(0);
  await expect(panel).toHaveCount(0);
});

test("the version tree's column is as wide as its edge is dragged", async ({ page }) => {
  await setUp(page);
  await saveKey(page);
  const side = page.locator(".side");
  const before = (await side.boundingBox())!.width;
  const grip = page.getByRole("separator", { name: "Resize version tree" });
  const box = (await grip.boundingBox())!;
  await drag(page, [[box.x + 4, box.y + 200], [box.x + 124, box.y + 200]]);
  await expect.poll(async () => Math.round((await side.boundingBox())!.width)).toBe(Math.round(before + 120));
  await grip.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => Math.round((await side.boundingBox())!.width)).toBe(Math.round(before + 100));
  await page.reload();
  await expect.poll(async () => Math.round((await page.locator(".side").boundingBox())!.width)).toBe(Math.round(before + 100));
});

test("watching one job, another finishing under the same version doesn't take the view away", async ({ page }) => {
  await setUp(page, "slow");
  await saveKey(page);
  await importPhoto(page);
  await page.locator("#prompt").fill("make it warmer");
  await page.keyboard.press("Control+Enter"); // slow: 2 s
  await page.locator("#custom-model").fill("quick");
  await page.locator("#prompt").fill("make it cooler");
  await page.keyboard.press("Control+Enter"); // 0.3 s
  await page.locator(".tree li.pending button.select", { hasText: "make it warmer" }).click();
  const panel = page.getByRole("complementary", { name: "Job" });
  await expect(panel.locator(".made")).toContainText("make it warmer");
  await expect(page.locator(".tree .row")).toHaveCount(2, { timeout: 20_000 }); // the quick one is done
  await expect(panel.locator(".made")).toContainText("make it warmer"); // still watching the slow one
  await expect(page.locator(".tree .row")).toHaveCount(3, { timeout: 20_000 });
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".caption .text")).toHaveText("make it warmer"); // and its result shows
});

test("a small edit of a large image goes as a close-up, and its result lands where the region is", async ({ page }) => {
  await setUp(page);
  await saveKey(page);
  const [W, H] = [3000, 2000];
  const big = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n = Math.sin(x * 0.05) * Math.cos(y * 0.04) * 40 + ((x * 7 + y * 13) % 11) * 2;
      big.data.set([Math.min(255, 110 + x * 0.04 + n), Math.min(255, 130 + y * 0.05 - n), Math.min(255, 90 + n * 0.5), 255], (y * W + x) * 4);
    }
  }
  await page.locator("input[type=file][accept*='image']").first().setInputFiles({ name: "big.png", mimeType: "image/png", buffer: PNG.sync.write(big) });
  await expect(page.locator(".tree .row")).toHaveCount(1);
  const P = await imageToPage(page, [W, H]);
  await page.keyboard.press("r");
  await drag(page, [P(2300, 500), P(2420, 590)]);
  await page.locator(".regions textarea").first().fill("a red lamp");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".tree .row")).toHaveCount(2, { timeout: 30_000 });
  const edit = (await apiLog()).filter((l) => l.op === "edit").at(-1) as unknown as { size: [number, number] };
  // the close-up: the area around the region, far less than the image
  expect(edit.size[0] * edit.size[1]).toBeGreaterThanOrEqual(768 * 768);
  expect(edit.size[0]).toBeLessThan(W / 2);
  // the model's blob (centred on the region it was shown) is in the version, where the region is
  const pixel = await page.evaluate(
    ([x, y]) =>
      new Promise<number[]>((resolve) => {
        const open = indexedDB.open("brushgraft");
        open.onsuccess = () => {
          const tx = open.result.transaction(["nodes", "images"]);
          const all = tx.objectStore("nodes").getAll();
          all.onsuccess = () => {
            const node = (all.result as { parent_id: string | null; image: string }[]).find((n) => n.parent_id)!;
            const img = tx.objectStore("images").get(node.image);
            img.onsuccess = async () => {
              const bitmap = await createImageBitmap(new Blob([img.result.data]));
              const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
              const ctx = canvas.getContext("2d")!;
              ctx.drawImage(bitmap, 0, 0);
              resolve([bitmap.width, bitmap.height, ...Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3))]);
            };
          };
        };
      }),
    [2360, 545],
  );
  expect(pixel.slice(0, 2)).toEqual([W, H]);
  expect(pixel[2]).toBeGreaterThan(150); // the blob's red
  expect(pixel[3]).toBeLessThan(90);
});
