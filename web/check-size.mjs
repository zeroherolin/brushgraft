// Fails when a built file outgrows its budget (gzip), so a heavy dependency can't slip in unnoticed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dir = join(process.cwd(), process.argv[2] ?? "dist/assets");
const budgets = [
  [/^index-.*\.js$/, 100, "the page's script"],
  [/^archive-.*\.js$/, 20, "project files and asset packs, loaded when used"],
  [/^worker-.*\.js$/, 30, "the image worker"],
  [/^index-.*\.css$/, 12, "the stylesheet"],
];
let failed = false;
for (const name of readdirSync(dir)) {
  const budget = budgets.find(([re]) => re.test(name));
  if (!budget) continue;
  const kb = gzipSync(readFileSync(join(dir, name))).length / 1024;
  const ok = kb <= budget[1];
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${kb.toFixed(1)} KB gzip (budget ${budget[1]} KB, ${budget[2]})`);
}
if (failed) process.exit(1);
