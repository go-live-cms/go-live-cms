// @ts-check

import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import path from "path";
import { defineConfig } from "astro/config";

import react from "@astrojs/react";

import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  site: "https://example.com",
  integrations: [mdx(), sitemap(), react()],
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve("./src"),
        "@gl-admin": path.resolve("./gl-admin"),
      },
    },
    server: {
      proxy: {
        // Proxy uploads to Go API - use the Docker service name
        "/uploads": {
          target: "http://api:8080", // Use Docker service name instead of localhost
          changeOrigin: true,
          secure: false,
        },
        // Proxy API calls to Go API
        "/api": {
          target: "http://api:8080", // Use Docker service name instead of localhost
          changeOrigin: true,
          secure: false,
        },
      },
      watch: {
        usePolling: true,
      },
    },
  },
  output: "server",
});
