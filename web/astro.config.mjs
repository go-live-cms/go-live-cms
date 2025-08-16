// @ts-check

import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import path from 'path';
import { defineConfig } from "astro/config";

import react from "@astrojs/react";

// import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  site: "https://example.com",
  integrations: [mdx(), sitemap(), react()],
  vite: {
    // plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve('./src'),
        '@assets': path.resolve('./src/assets')
      },
    },
    server: {
      watch: {
        usePolling: true,
      },
    },
  },
});
