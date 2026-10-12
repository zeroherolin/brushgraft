// Shared by the browser-build and server tests: drawing on the canvas in image pixels.
import type { Page } from "@playwright/test";

/** a function mapping image pixels to page coordinates, for an image of ``size`` fitted in the viewport */
export async function imageToPage(page: Page, size: [number, number], pad = 28) {
  const vp = (await page.locator(".viewport").boundingBox())!;
  const s = Math.min((vp.width - pad * 2) / size[0], (vp.height - pad * 2) / size[1], 4);
  const [ox, oy] = [vp.x + (vp.width - size[0] * s) / 2, vp.y + (vp.height - size[1] * s) / 2];
  return (x: number, y: number): [number, number] => [ox + x * s, oy + y * s];
}

export async function drag(page: Page, points: [number, number][], steps = 5) {
  await page.mouse.move(...points[0]);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...p, { steps });
  await page.mouse.up();
}
