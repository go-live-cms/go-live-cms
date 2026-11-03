// @vitest-environment node
import { describe, it, expect } from "vitest"
import * as esbuild from "esbuild"
import { promises as fs, readdirSync, existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { importMetaGlob } from "../../../collab-server/importMetaGlob.mjs"
import { manifestText, themeBlockManifest } from "../blocks-spec/themeBlocks"
import { installedThemeBlocks, installedThemeBlockSpecs } from "./installed"
import { installedThemeBlockEditors } from "./editorBlocks"
import { blockRegistry } from "../../../src/components/blocks/registry"

// #376: fails if a bundled theme has a block the production build can't load. Every
// production consumer resolves theme blocks when its image is built: the admin and SSR
// server through Vite's import.meta.glob (as vitest does here), the collab server through
// esbuild (the same plugin as collab-server/build.mjs), and the API through
// themes/blocks.manifest.json. Nothing may import a theme module by URL at runtime: the
// production web server can't serve TypeScript (#271).

const webRoot = path.resolve(__dirname, "../../..")
const themesDir = path.join(webRoot, "themes")

const blockDirs = (): string[] =>
  readdirSync(themesDir, { withFileTypes: true })
    .filter((theme) => theme.isDirectory() && existsSync(path.join(themesDir, theme.name, "blocks")))
    .flatMap((theme) =>
      readdirSync(path.join(themesDir, theme.name, "blocks"), { withFileTypes: true })
        .filter((block) => block.isDirectory())
        .map((block) => `${theme.name}/${block.name}`),
    )
    .sort()

/** `<slug>/<Name>` → its directory on disk. */
const blockPath = (dir: string, file: string) => {
  const [slug, name] = dir.split("/")
  return path.join(themesDir, slug, "blocks", name, file)
}

describe("bundled theme blocks are loadable in production (#376)", () => {
  it("the example theme has a block, so this test checks something", () => {
    expect(blockDirs()).toContain("example/Alert")
  })

  it("every themes/<slug>/blocks/<Name>/ has index.ts, editor.ts and render.tsx", () => {
    for (const dir of blockDirs()) {
      for (const file of ["index.ts", "editor.ts", "render.tsx"]) {
        expect(existsSync(blockPath(dir, file)), `${dir} ${file}`).toBe(true)
      }
    }
  })

  it("the build resolves every block directory: definition, editor and public renderer", () => {
    expect(installedThemeBlocks.map((block) => block.dir).sort()).toEqual(blockDirs())
    const types = installedThemeBlocks.map((block) => block.type)
    expect(installedThemeBlockEditors.map((editor) => editor.type)).toEqual(types)
    for (const type of types) expect(blockRegistry.has(type), `${type} public renderer`).toBe(true)
  })

  it("no theme declares blocks for a runtime import (theme.config.ts `blocks` / `modulePath`)", () => {
    for (const theme of readdirSync(themesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const configPath = path.join(themesDir, theme.name, "theme.config.ts")
      if (!existsSync(configPath)) continue
      const config = readFileSync(configPath, "utf8").replace(/\/\/.*$/gm, "")
      expect(config, `themes/${theme.name}/theme.config.ts`).not.toMatch(/\bmodulePath\b|^\s*blocks\??\s*:/m)
    }
  })

  it("no admin or SSR code imports a module by URL at runtime (@vite-ignore)", async () => {
    const offenders: string[] = []
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (/\.(ts|tsx|astro)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if ((await fs.readFile(full, "utf8")).includes("@vite-ignore")) offenders.push(path.relative(webRoot, full))
        }
      }
    }
    for (const dir of ["src", "gl-admin", "themes"]) await walk(path.join(webRoot, dir))
    expect(offenders).toEqual([])
  })

  it("the collab server's esbuild bundle loads the same blocks, headless (no React), in plain Node", async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), "gl-theme-blocks-"))
    try {
      const outfile = path.join(out, "blocks.mjs")
      const result = await esbuild.build({
        stdin: {
          contents: `
            import { installedThemeBlocks } from "@gl-admin/lib/theme-blocks/installed"
            import { getInstalledCollabSchema } from "@gl-admin/lib/theme-blocks/collabSchema"
            export const types = installedThemeBlocks.map((block) => block.type)
            export const nodes = Object.keys(getInstalledCollabSchema().nodes)
          `,
          resolveDir: webRoot,
          loader: "ts",
        },
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        metafile: true,
        alias: { "@gl-admin": path.join(webRoot, "gl-admin"), "@": path.join(webRoot, "src"), "@themes": themesDir },
        plugins: [importMetaGlob],
        logLevel: "silent",
      })
      const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll("\\", "/"))
      expect(inputs.filter((input) => /node_modules\/(react|react-dom|@tiptap\/react)\//.test(input))).toEqual([])
      expect(inputs.filter((input) => /themes\/[^/]+\/blocks\/.+\/(editor|render)\./.test(input))).toEqual([])

      const bundled = await import(pathToFileURL(outfile).href)
      const types = installedThemeBlocks.map((block) => block.type)
      expect(bundled.types).toEqual(types)
      for (const type of types) expect(bundled.nodes).toContain(type)
    } finally {
      await fs.rm(out, { recursive: true, force: true })
    }
  }, 60_000)

  it("themes/blocks.manifest.json (the API's copy) is up to date: run `npm run themes:manifest`", () => {
    const manifest = readFileSync(path.join(themesDir, "blocks.manifest.json"), "utf8")
    expect(manifest).toBe(manifestText(themeBlockManifest(installedThemeBlockSpecs())))
  })
})
