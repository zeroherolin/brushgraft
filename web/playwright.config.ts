import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

// Python with brushgraft installed, for the server-mode tests (the project's .venv by default)
const python = process.env.BG_PYTHON ?? "../.venv/bin/python";

// The browser tests run against the built static site, served with the Content-Security-Policy
// the deployment uses (read from deploy/install.py), so a change that the policy would block fails here.
const csp = execFileSync("python3", ["-c", "import runpy; print(runpy.run_path('../deploy/install.py')['CSP'])"], { encoding: "utf8" }).trim();

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { baseURL: "http://127.0.0.1:4173", viewport: { width: 1440, height: 900 }, acceptDownloads: true, channel: process.env.PW_CHANNEL || undefined },
  webServer: [
    { command: `node e2e/serve-site.mjs dist 4173 "${csp}"`, url: "http://127.0.0.1:4173/index.html", reuseExistingServer: !process.env.CI },
    { command: "node e2e/fake-api.mjs 4174", url: "http://127.0.0.1:4174/log", reuseExistingServer: !process.env.CI },
    // server mode: the local server serves the build in ../src/brushgraft/static (npm run build)
    { command: `${python} e2e/fake_server.py 4175`, url: "http://127.0.0.1:4175/", reuseExistingServer: false },
  ],
});
