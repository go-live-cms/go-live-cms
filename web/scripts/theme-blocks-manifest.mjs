// The API's theme block manifest (#376): themes/blocks.manifest.json, every installed
// theme block's type, version and attrs, generated from the blocks' index.ts. The API is
// Go and can't run them, so it reads this file (api/theme_blocks.go) to validate theme
// blocks in a stored block_doc. The API image ships web/themes, and this file with it.
//
//   node scripts/theme-blocks-manifest.mjs           (from web/; `npm run themes:manifest`)
//   node scripts/theme-blocks-manifest.mjs --check   (fails if the file is stale; `npm run build` runs it)
//
// Commit the file: the API image is built without Node. themeBlocks.loadable.test.ts
// fails on a stale one too.
import * as esbuild from "esbuild"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { importMetaGlob } from "../collab-server/importMetaGlob.mjs"

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const manifestPath = path.join(webRoot, "themes/blocks.manifest.json")
const check = process.argv.includes("--check")

const entry = `
import { installedThemeBlockSpecs } from "@gl-admin/lib/theme-blocks/installed"
import { manifestText, themeBlockManifest } from "@gl-admin/lib/blocks-spec/themeBlocks"
export const text = manifestText(themeBlockManifest(installedThemeBlockSpecs()))
`

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gl-theme-manifest-"))
try {
  const outfile = path.join(dir, "manifest.mjs")
  await esbuild.build({
    stdin: { contents: entry, resolveDir: webRoot, loader: "ts" },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    alias: {
      "@": path.join(webRoot, "src"),
      "@gl-admin": path.join(webRoot, "gl-admin"),
      "@themes": path.join(webRoot, "themes"),
    },
    plugins: [importMetaGlob],
    logLevel: "warning",
  })
  const { text } = await import(pathToFileURL(outfile).href)
  const current = await fs.readFile(manifestPath, "utf8").catch(() => null)
  if (check) {
    if (current !== text) {
      console.error(`${path.relative(webRoot, manifestPath)} is out of date: run \`npm run themes:manifest\` and commit it`)
      process.exit(1)
    }
    console.log(`${path.relative(webRoot, manifestPath)} is up to date`)
  } else if (current !== text) {
    await fs.writeFile(manifestPath, text)
    console.log(`wrote ${path.relative(webRoot, manifestPath)}`)
  } else {
    console.log(`${path.relative(webRoot, manifestPath)} is up to date`)
  }
} finally {
  await fs.rm(dir, { recursive: true, force: true })
}
