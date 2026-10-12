/// <reference types="vitest/config" />
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// Two builds from one source:
//   vite build                  the web UI that `brushgraft` (the local server) serves
//   vite build --mode browser   the static site: data stays in the visitor's browser
// `npm run dev` forwards API calls to a local brushgraft (port 7788 by default).
export default defineConfig(({ mode }) => {
  const browser = mode === "browser";
  return {
    plugins: [svelte()],
    define: { __BROWSER__: JSON.stringify(browser) },
    build: {
      outDir: browser ? "dist" : "../src/brushgraft/static",
      emptyOutDir: true,
    },
    worker: { format: "es" as const },
    server: {
      proxy: {
        "/api": { target: "http://127.0.0.1:7788", changeOrigin: true },
      },
    },
    test: {
      include: ["src/**/*.test.ts"],
      environment: "node",
    },
  };
});
