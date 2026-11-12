// Bundles the collab server into one ESM file: dist/collab-server/server.mjs (#206).
//
//   node collab-server/build.mjs            (from web/; `npm run build:collab`)
//
// Why a bundle: the 2026-06 data-loss saga was yjs evaluated TWICE in one process (an
// ESM `import "yjs"` → yjs.mjs and a dependency's CJS `require("yjs")` → yjs.cjs), two
// class registries, and cross-instance updates that corrupted live docs. Here every
// import AND require of yjs, lib0 and y-protocols is resolved as an ESM import, so the
// bundle contains exactly one copy of each; `onlyOneYjs` fails the build if a second
// yjs file ever ends up in it. The image runs this file with no node_modules at all.
import * as esbuild from "esbuild"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { singleYjsInstance } from "./singleYjsInstance.mjs"
import { importMetaGlob } from "./importMetaGlob.mjs"
import { clientOnlyInputs, pluginBlockInputs, pluginCodeInputs, themeBlockInputs } from "./bundleChecks.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, "..")
const outfile = path.resolve(process.argv[2] ?? path.join(webRoot, "dist/collab-server/server.mjs"))

const result = await esbuild.build({
  entryPoints: [path.join(here, "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  metafile: true,
  legalComments: "none",
  // Same aliases as tsconfig.json / vitest.config.ts.
  alias: {
    "@": path.join(webRoot, "src"),
    "@gl-admin": path.join(webRoot, "gl-admin"),
    "@themes": path.join(webRoot, "themes"),
  },
  // Bundled CJS dependencies call require() for Node builtins.
  banner: {
    js: 'import { createRequire as __glCreateRequire } from "node:module"; const require = __glCreateRequire(import.meta.url);',
  },
  // importMetaGlob: the installed theme blocks' headless index.ts files (#376) and the
  // plugins' plugin.json and block.json (#456), the same globs Vite resolves for the admin
  // and the SSR server.
  plugins: [singleYjsInstance, importMetaGlob],
  logLevel: "warning",
})

const yjsFiles = Object.keys(result.metafile.inputs).filter((input) => /node_modules\/yjs\//.test(input.replaceAll("\\", "/")))
if (yjsFiles.length !== 1) {
  console.error(`collab-server bundle must contain exactly one yjs build, found ${yjsFiles.length}: ${yjsFiles.join(", ")}`)
  process.exit(1)
}
// Theme and plugin blocks (#376, #452): only their headless definitions belong here
// (bundleChecks.mjs says what leaked in).
const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll("\\", "/"))
const clientOnly = clientOnlyInputs(inputs)
if (clientOnly.length > 0) {
  console.error(`collab-server bundle must not contain client-only modules, found: ${clientOnly.join(", ")}`)
  process.exit(1)
}
// The image ships collab-server/, gl-admin/, themes/ and plugins/ only (its Dockerfile): a module from
// web/src (the public site) would build here and then fail in the Docker build (#320).
const srcRoot = path.join(webRoot, "src") + path.sep
const fromSrc = inputs.filter((input) => path.resolve(webRoot, input).startsWith(srcRoot))
if (fromSrc.length > 0) {
  console.error(`collab-server bundle must not import web/src (the image doesn't ship it), found: ${fromSrc.join(", ")}`)
  process.exit(1)
}
// Plugins (#456, rule 13): block.json and plugin.json only, never a plugin's code.
const webRelative = inputs.map((input) => path.relative(webRoot, path.resolve(input)).replaceAll("\\", "/"))
const pluginCode = pluginCodeInputs(webRelative)
if (pluginCode.length > 0) {
  console.error(`collab-server bundle must not contain plugin code (block.json only), found: ${pluginCode.join(", ")}`)
  process.exit(1)
}
const themeBlocks = themeBlockInputs(inputs)
const pluginBlocks = pluginBlockInputs(webRelative)
console.log(
  `collab-server bundle: ${path.relative(webRoot, outfile)} (yjs: ${yjsFiles[0]}; theme blocks: ${themeBlocks.length}; plugin blocks: ${pluginBlocks.length})`,
)
