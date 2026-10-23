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
  plugins: [singleYjsInstance],
  logLevel: "warning",
})

const yjsFiles = Object.keys(result.metafile.inputs).filter((input) => /node_modules\/yjs\//.test(input.replaceAll("\\", "/")))
if (yjsFiles.length !== 1) {
  console.error(`collab-server bundle must contain exactly one yjs build, found ${yjsFiles.length}: ${yjsFiles.join(", ")}`)
  process.exit(1)
}
console.log(`collab-server bundle: ${path.relative(webRoot, outfile)} (yjs: ${yjsFiles[0]})`)
