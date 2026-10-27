// esbuild plugin for every bundle that runs collab code in Node (today the collab server,
// build.mjs).
//
// The 2026-06 data-loss saga was yjs evaluated TWICE in one process (an ESM
// `import "yjs"` → yjs.mjs and a dependency's CJS `require("yjs")` → yjs.cjs), two class
// registries, and cross-instance updates that corrupted live docs. This resolves every
// require() of yjs, lib0 and y-protocols like an import, i.e. to the ESM build, so a
// bundle contains exactly one copy of each.

const PINNED = /^(yjs|lib0|y-protocols)(\/.*)?$/

export const singleYjsInstance = {
  name: "single-yjs-instance",
  setup(build) {
    build.onResolve({ filter: PINNED }, async (args) => {
      if (args.kind === "import-statement" || args.kind === "dynamic-import" || args.pluginData?.pinned) return undefined
      const result = await build.resolve(args.path, {
        kind: "import-statement",
        resolveDir: args.resolveDir,
        importer: args.importer,
        pluginData: { pinned: true },
      })
      if (result.errors.length > 0) return { errors: result.errors }
      return { path: result.path, external: result.external, sideEffects: result.sideEffects }
    })
  },
}
