import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import vectors from "./pluginBlockVectors.json"
import { pluginBlockTypeFor, validatePluginBlockJson } from "./blockJson"
import { collectPluginBlocks, installedPluginBlocks, pluginBlockSpec } from "./blocks"
import { THEME_BLOCK_CONTENT_NAMES } from "../theme-blocks/installed"

type VectorCase = {
  name: string
  valid: boolean
  field?: string
  dir?: string
  set?: Record<string, unknown>
  null_set?: string[]
  replace?: unknown
}

// The case's block.json: `replace`, or the base with `set`'s top-level keys merged over it
// (null deletes, `null_set` sets JSON null). The Go side (TestPluginBlockVectors) builds it
// the same way.
function caseBlock(tc: VectorCase): unknown {
  if (tc.replace !== undefined) return tc.replace
  const block: Record<string, unknown> = structuredClone(vectors.base)
  for (const [key, value] of Object.entries(tc.set ?? {})) {
    if (value === null) delete block[key]
    else block[key] = value
  }
  for (const key of tc.null_set ?? []) block[key] = null
  return block
}

describe("plugin block.json vectors (shared with api/plugin_blocks.go)", () => {
  const cases = vectors.cases as VectorCase[]

  it("has cases both ways", () => {
    expect(cases.some((tc) => tc.valid)).toBe(true)
    expect(cases.some((tc) => !tc.valid)).toBe(true)
  })

  for (const tc of cases) {
    it(tc.name, () => {
      const result = validatePluginBlockJson(caseBlock(tc), vectors.slug, tc.dir ?? vectors.dir)
      if (tc.valid) expect(result).toEqual(expect.objectContaining({ ok: true }))
      else expect(result).toEqual(expect.objectContaining({ ok: false, field: tc.field }))
    })
  }
})

describe("block.json rules", () => {
  it("derives the type from the plugin and the directory", () => {
    expect(pluginBlockTypeFor("reading-time", "Estimate")).toBe("plugin:reading-time/estimate")
  })

  it("the content names match the Go list", () => {
    const go = fs.readFileSync(path.resolve("../api/plugin_blocks.go"), "utf8")
    const list = /extensionBlockContentNames = \[\]string\{([^}]*)\}/.exec(go)?.[1]
    expect(list?.split(",").map((name) => name.trim().replaceAll('"', ""))).toEqual([...THEME_BLOCK_CONTENT_NAMES])
  })
})

const manifest = (slug: string, blocks: string[], extra: Record<string, unknown> = {}) => ({
  [`../../../plugins/${slug}/plugin.json`]: {
    default: { manifest_version: 1, id: slug, name: slug, version: "1.0.0", plugin_api: 1, blocks, ...extra },
  },
})
const blockFile = (slug: string, dir: string, json: Record<string, unknown> = {}) => ({
  [`../../../plugins/${slug}/blocks/${dir}/block.json`]: {
    default: { type: pluginBlockTypeFor(slug, dir), version: 1, title: dir, ...json },
  },
})

describe("collectPluginBlocks", () => {
  it("builds every declared block, sorted by type, with its spec on the node", () => {
    const blocks = collectPluginBlocks(
      { ...manifest("zeta", ["One"]), ...manifest("alpha", ["Two", "One"]) },
      { ...blockFile("zeta", "One"), ...blockFile("alpha", "Two"), ...blockFile("alpha", "One", { content: "", attrs: { n: { type: "number", default: 1 } } }) },
    )
    expect(blocks.map((block) => block.type)).toEqual(["plugin:alpha/one", "plugin:alpha/two", "plugin:zeta/one"])
    expect(blocks[0]).toMatchObject({ plugin: "alpha", dir: "alpha/One", version: 1, attrs: { n: { type: "number", default: 1 } } })
    expect(blocks[0].node.name).toBe("plugin:alpha/one")
  })

  it("leaves out a plugin whose plugin_api core doesn't implement, block.json unread", () => {
    expect(collectPluginBlocks({ ...manifest("later", ["One"], { plugin_api: 2 }) }, { ...blockFile("later", "One", { format: 2 }) })).toEqual([])
  })

  it("refuses a manifest the validator refuses", () => {
    expect(() => collectPluginBlocks({ ...manifest("bad", [], { id: "other" }) }, {})).toThrow(/plugin bad: plugin\.json id/)
  })

  it("refuses a declared block without block.json, and a block.json the manifest doesn't declare", () => {
    expect(() => collectPluginBlocks(manifest("p", ["One"]), {})).toThrow(/declared in plugin\.json but has no blocks\/One\/block\.json/)
    expect(() => collectPluginBlocks(manifest("p", []), blockFile("p", "One"))).toThrow(/doesn't list One/)
    expect(() => collectPluginBlocks({}, blockFile("p", "One"))).toThrow(/has no plugin\.json/)
  })

  it("refuses a block.json the validator refuses, with its field", () => {
    expect(() => collectPluginBlocks(manifest("p", ["One"]), blockFile("p", "One", { content: "block+" }))).toThrow(/block\.json content/)
  })

  it("keeps a text-block content expression as given", () => {
    expect(collectPluginBlocks(manifest("p", ["One"]), blockFile("p", "One", { content: "paragraph+" }))[0].content).toBe("paragraph+")
  })
})

describe("the repository's plugin blocks", () => {
  it("the example plugin's block is installed", () => {
    expect(installedPluginBlocks.map((block) => block.type)).toContain("plugin:reading-time/estimate")
  })

  it("pluginBlockSpec reads an installed block's spec, and an empty one otherwise", () => {
    const estimate = installedPluginBlocks.find((block) => block.type === "plugin:reading-time/estimate")!
    expect(pluginBlockSpec({ type: estimate.type })).toEqual({ type: estimate.type, version: estimate.version, attrs: estimate.attrs })
    expect(pluginBlockSpec({ type: "plugin:gone/widget" })).toEqual({ type: "plugin:gone/widget", version: 1, attrs: {} })
  })

})
