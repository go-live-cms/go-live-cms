// @ts-check

import mdx from "@astrojs/mdx"
import node from "@astrojs/node"
import path from "path"
import { defineConfig } from "astro/config"

import react from "@astrojs/react"

import tailwindcss from "@tailwindcss/vite"

const serverApiUrl = (process.env.SERVER_API_URL || "http://api:8080/api/v1").replace(/\/api\/v1\/?$/, "")

// https://astro.build/config
export default defineConfig({
  // Public origin for Astro.site. Pages use resolveSiteUrl (src/lib/seo.ts), which
  // reads SITE_URL at runtime. /sitemap.xml and /robots.txt are server routes, so
  // there is no @astrojs/sitemap (it only lists prebuilt pages, not SSR posts).
  site: process.env.SITE_URL || "http://localhost:4321",
  integrations: [mdx(), react()],
  publicDir: "public",
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve("./src"),
        "@gl-admin": path.resolve("./gl-admin"),
        "@themes": path.resolve("./themes"),
      },
    },
    server: {
      proxy: {
        // Proxy uploads to Go API - use the Docker service name
        "/uploads": {
          target: serverApiUrl,
          changeOrigin: true,
          secure: false,
        },
        // Proxy API calls to Go API. xfwd sends the browser's IP as
        // X-Forwarded-For, which the API trusts in dev (TRUSTED_PROXIES in
        // compose.dev.yaml), so its rate limits key on the browser, not on us.
        "/api": {
          target: serverApiUrl,
          changeOrigin: true,
          secure: false,
          xfwd: true,
        },
      },
      watch: {
        usePolling: true,
      },
      fs: {
        // Allow serving files from themes directory
        allow: [".", "../themes"],
      },
    },
  },
  output: "server",
  // SSR needs an adapter for `astro build`; the production image runs the
  // standalone Node server it emits (dist/server/entry.mjs, see web/Dockerfile).
  adapter: node({ mode: "standalone" }),
})
