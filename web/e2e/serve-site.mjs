// Serves a built site the way production does: strict headers, no fallback to index.html for missing files.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const [root, port, csp] = [process.argv[2], Number(process.argv[3]), process.argv[4] ?? ""];
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

createServer((req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (path.endsWith("/")) path += "index.html";
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end();
  res.writeHead(200, {
    "Content-Type": types[extname(file)] ?? "application/octet-stream",
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
  });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1");
