// @vitest-environment node
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// #193: TipTap expects every @tiptap/* package on one version, and its packages
// depend on each other with caret ranges, so a transitive package missing from
// `overrides` would silently resolve to the newest 3.x. Check the resolved tree.
// @tiptap/y-tiptap has its own release line.
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"))
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

describe("TipTap version pin", () => {
  it("resolves every @tiptap/* package to the pinned @tiptap/core version", () => {
    const pinned = pkg.dependencies["@tiptap/core"]
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/)

    const offPin = Object.entries(lock.packages as Record<string, { version: string }>)
      .filter(([path]) => /(^|\/)node_modules\/@tiptap\//.test(path) && !path.endsWith("/@tiptap/y-tiptap"))
      .filter(([, entry]) => entry.version !== pinned)
      .map(([path, entry]) => `${path}@${entry.version}`)

    expect(offPin).toEqual([])
  })
})
