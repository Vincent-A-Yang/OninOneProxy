import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Minimal vitest config — resolves the same path aliases that jsconfig.json
// declares for the Next.js bundler (@/* → ./src/*, open-sse → ./open-sse).
//
// Without this config vitest cannot resolve `@/` imports, which breaks every
// test that exercises app routes or lib helpers (e.g.
// tests/unit/compatible-provider-connections.test.js,
// tests/unit/provider-name-conflict.test.js).
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "open-sse": resolve(__dirname, "open-sse"),
    },
  },
  test: {
    // Run tests in node environment by default — most unit tests are pure
    // logic and don't need a DOM. Tests that need jsdom can opt-in per-file
    // via the `// @vitest-environment jsdom` comment.
    environment: "node",
  },
});
