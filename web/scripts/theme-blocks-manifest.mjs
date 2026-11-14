// The API's theme block manifest (#376): themes/blocks.manifest.json, every installed
// theme block's type, version and attrs, generated from the blocks' index.ts. The API is
// Go and can't run them, so it reads this file (api/theme_blocks.go) to validate theme
// blocks in a stored block_doc. The API image ships web/themes, and this file with it.
//
// It also writes themes/tokens.manifest.json (#485): every theme's declared tokens and
// font options, from its theme.config.ts, which the API validates global styles against
// (api/global_styles.go, src/lib/installedThemeTokens.ts).
//
//   node scripts/theme-blocks-manifest.mjs           (from web/; `npm run themes:manifest`)
//   node scripts/theme-blocks-manifest.mjs --check   (fails if a file is stale; `npm run build` runs it)
//
// Commit both files: the API image is built without Node. themeBlocks.loadable.test.ts
// and installedThemeTokens.test.ts fail on a stale one too.
import * as esbuild from "esbuild"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { importMetaGlob } from "../collab-server/importMetaGlob.mjs"

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const manifests = {
  blocks: path.join(webRoot, "themes/blocks.manifest.json"),
  tokens: path.join(webRoot, "themes/tokens.manifest.json"),
}
const check = process.argv.includes("--check")

const entry = `
import { installedThemeBlockSpecs } from "@gl-admin/lib/theme-blocks/installed"
import { manifestText, themeBlockManifest } from "@gl-admin/lib/blocks-spec/themeBlocks"
import { installedThemeTokenManifest } from "@/lib/installedThemeTokens"
import { tokenManifestText } from "@/lib/globalStyles"
export const blocks = manifestText(themeBlockManifest(installedThemeBlockSpecs()))
export const tokens = tokenManifestText(installedThemeTokenManifest())
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
  const texts = await import(pathToFileURL(outfile).href)
  let stale = false
  for (const [name, manifestPath] of Object.entries(manifests)) {
    const text = texts[name]
    const relative = path.relative(webRoot, manifestPath)
    const current = await fs.readFile(manifestPath, "utf8").catch(() => null)
    if (current === text) {
      console.log(`${relative} is up to date`)
    } else if (check) {
      console.error(`${relative} is out of date: run \`npm run themes:manifest\` and commit it`)
      stale = true
    } else {
      await fs.writeFile(manifestPath, text)
      console.log(`wrote ${relative}`)
    }
  }
  if (stale) process.exitCode = 1
} finally {
  await fs.rm(dir, { recursive: true, force: true })
}
