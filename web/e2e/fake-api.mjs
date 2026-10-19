// A fake OpenAI-compatible image API with CORS, for the browser tests: no network, no cost.
// The model name picks the behaviour: fail-451 (moderation), fail-413 (prompt too long), urls-only (the image comes as a url this
// server hosts), slow (answers after 2 s), anything else answers with b64_json. Edits paint a blob where image 2 has boxes.
import { createServer } from "node:http";
import { PNG } from "pngjs";

const port = Number(process.argv[2] ?? 4174);
const store = new Map();
const log = [];

const png = (w, h, fn) => {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p.data.set([...fn(x, y), 255], (y * w + x) * 4);
  return PNG.sync.write(p);
};
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
const json = (res, status, body) => {
  res.writeHead(status, { ...cors, "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const answer = (res, model, data) => {
  if (model === "fail-451") return json(res, 451, { error: "blocked" });
  if (model === "fail-413") return json(res, 413, { error: { message: "input_too_large" } });
  if (model === "urls-only") {
    const key = `i${store.size}.png`;
    store.set(key, data);
    return json(res, 200, { data: [{ url: `http://127.0.0.1:${port}/img/${key}` }], usage: { total_tokens: 9 } });
  }
  return json(res, 200, { data: [{ b64_json: data.toString("base64") }], usage: { total_tokens: 9 } });
};
const body = async (req) => Buffer.concat(await req.toArray());

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  if (url.pathname === "/log") return json(res, 200, log);
  if (url.pathname.startsWith("/img/")) {
    res.writeHead(200, { ...cors, "Content-Type": "image/png" });
    return res.end(store.get(url.pathname.slice(5)));
  }
  if (url.pathname === "/v1/models") {
    return req.headers.authorization === "Bearer test-key" ? json(res, 200, { data: [{ id: "m" }] }) : json(res, 401, { error: "bad key" });
  }
  if (url.pathname === "/v1/images/generations") {
    const b = JSON.parse((await body(req)).toString());
    log.push({ op: "generate", model: b.model, prompt: b.prompt, auth: req.headers.authorization });
    await new Promise((r) => setTimeout(r, b.model === "slow" ? 2000 : 300));
    return answer(res, b.model, png(256, 192, (x, y) => [(60 + x * 0.6) % 256, (90 + y) % 256, 140]));
  }
  if (url.pathname === "/v1/images/edits") {
    const form = await new Request("http://x", { method: "POST", headers: req.headers, body: await body(req), duplex: "half" }).formData();
    const files = form.getAll("image[]");
    const a = PNG.sync.read(Buffer.from(await files[0].arrayBuffer()));
    log.push({ op: "edit", model: form.get("model"), prompt: form.get("prompt"), images: files.length, size: [a.width, a.height], auth: req.headers.authorization });
    await new Promise((r) => setTimeout(r, form.get("model") === "slow" ? 2000 : 300));
    const out = new PNG({ width: a.width, height: a.height });
    // a little brighter everywhere, as real models drift
    for (let i = 0; i < a.data.length; i += 4) out.data.set([Math.min(255, a.data[i] + 6), Math.min(255, a.data[i + 1] + 6), Math.min(255, a.data[i + 2] + 6), 255], i);
    if (files.length > 1) {
      const b = PNG.sync.read(Buffer.from(await files[1].arrayBuffer()));
      let [x0, y0, x1, y1] = [a.width, a.height, -1, -1];
      for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 4;
        if (Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])) > 48) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
      }
      const [cx, cy, rx, ry] = [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 4, (y1 - y0) / 4];
      for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) out.data.set([190, 40, 60, 255], (y * a.width + x) * 4);
      }
    }
    return answer(res, form.get("model"), PNG.sync.write(out));
  }
  json(res, 404, { error: "no such route" });
}).listen(port, "127.0.0.1");
