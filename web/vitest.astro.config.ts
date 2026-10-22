/// <reference types="vitest/config" />
import { getViteConfig } from "astro/config"
import path from "node:path"

// Vitest project for tests that import .astro components and render them with
// the Container API (`*.astro.test.ts`, e.g. src/components/SeoHead.astro.test.ts).
// getViteConfig adds Astro's Vite plugins (and loads astro.config.mjs), which
// the other tests don't need; see vitest.config.ts.
export default getViteConfig({
  resolve: {
    alias: {
      "@": path.resolve("./src"),
      "@gl-admin": path.resolve("./gl-admin"),
      "@themes": path.resolve("./themes"),
    },
  },
  test: {
    name: "astro",
    globals: true,
    environment: "node",
    include: ["src/**/*.astro.test.ts", "themes/**/*.astro.test.ts"],
    exclude: ["node_modules/**", "dist/**", ".astro/**"],
  },
})
