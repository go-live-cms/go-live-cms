// @ts-check

import mdx from "@astrojs/mdx"
import node from "@astrojs/node"
import sitemap from "@astrojs/sitemap"
import path from "path"
import { defineConfig } from "astro/config"

import react from "@astrojs/react"

import tailwindcss from "@tailwindcss/vite"

const serverApiUrl = (process.env.SERVER_API_URL || "http://api:8080/api/v1").replace(/\/api\/v1\/?$/, "")

// https://astro.build/config
export default defineConfig({
  site: "https://example.com",
  integrations: [mdx(), sitemap(), react()],
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
        // Proxy API calls to Go API
        "/api": {
          target: serverApiUrl,
          changeOrigin: true,
          secure: false,
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
})
// TODO: for production we need to change the output and adaptor.
