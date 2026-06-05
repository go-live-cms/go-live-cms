import { defineConfig } from "vitest/config"
import path from "node:path"

// Standalone Vitest config for the headless editor/collaboration logic tests.
// Aliases mirror astro.config.mjs + tsconfig.json so test imports resolve the
// same `@gl-admin/*` / `@/*` / `@themes` paths the app uses. Resolved relative to
// the web/ directory (where `npm run test` runs), matching astro.config.mjs.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve("./src"),
      "@gl-admin": path.resolve("./gl-admin"),
      "@themes": path.resolve("./themes"),
    },
  },
  test: {
    globals: true,
    // jsdom (not node) because some TipTap extensions touch `window`/`document`
    // at import time when we build a schema via getSchema(extensions).
    environment: "jsdom",
    include: [
      "gl-admin/**/*.{test,spec}.{ts,tsx}",
      "src/**/*.{test,spec}.{ts,tsx}",
    ],
    // Keep test runs from scanning node_modules / build output.
    exclude: ["node_modules/**", "dist/**", ".astro/**"],
  },
})
