import { describe, it, expect } from "vitest"
import { validateBlockDoc, type BlockDocV1 } from "./index"
import {
  isExtensionBlockType,
  isThemeBlockType,
  PLUGIN_BLOCK_TYPE,
  pluginOfBlockType,
  themeBlockSpecProblem,
  themeOfBlockType,
  type ThemeBlockSpec,
} from "./themeBlocks"
import { BLOCK_NODE_NAMES } from "./nesting"

// Namespaced extension blocks beyond `theme:` (#452, docs/design/plugin-system.md 5.1):
// a `plugin:<slug>/<block>` type is the same kind of block as a theme block.

describe("extension block types", () => {
  it("theme: and plugin: types are extension blocks; core and pre-#376 types aren't", () => {
    for (const type of ["theme:example/alert", "plugin:reading-time/estimate"]) expect(isExtensionBlockType(type), type).toBe(true)
    for (const type of ["paragraph", "alert", "sidenote", "", "themes:x/y", "plugins:x/y", "Plugin:x/y", "x:plugin:y"]) {
      expect(isExtensionBlockType(type), type).toBe(false)
    }
  })

  it("no core type or node name is namespaced", () => {
    for (const type of [...Object.keys(BLOCK_NODE_NAMES), ...Object.values(BLOCK_NODE_NAMES)]) {
      expect(type.includes(":"), type).toBe(false)
      expect(isExtensionBlockType(type), type).toBe(false)
    }
  })

  it("plugin types are plugin:<slug>/<block>, and are not theme types", () => {
    for (const good of ["plugin:reading-time/estimate", "plugin:my_plugin/card", "plugin:Seo2/meta-box"]) {
      expect(PLUGIN_BLOCK_TYPE.test(good), good).toBe(true)
    }
    for (const bad of ["plugin:/x", "plugin:-x/y", "plugin:x/Y", "plugin:x/a/b", "plugin:x", "plugin:x y/z", "theme:x/y"]) {
      expect(PLUGIN_BLOCK_TYPE.test(bad), bad).toBe(false)
    }
    expect(pluginOfBlockType("plugin:reading-time/estimate")).toBe("reading-time")
    expect(pluginOfBlockType("theme:example/alert")).toBeNull()
    expect(themeOfBlockType("plugin:reading-time/estimate")).toBeNull()
    expect(isThemeBlockType("plugin:reading-time/estimate")).toBe(false)
  })

  it("a plugin block's spec follows a theme block's rules", () => {
    const base = { type: "plugin:reading-time/estimate", version: 1 }
    expect(themeBlockSpecProblem({ ...base, attrs: { label: { type: "string", default: "min read" } } })).toBeNull()
    expect(themeBlockSpecProblem({ ...base, attrs: { pm: { type: "string", default: "" } } })).not.toBeNull()
    expect(themeBlockSpecProblem({ ...base, version: 0, attrs: {} })).not.toBeNull()
    expect(themeBlockSpecProblem({ type: "plugin:x/Bad", version: 1, attrs: {} })).not.toBeNull()
    expect(themeBlockSpecProblem({ type: "estimate", version: 1, attrs: {} })).not.toBeNull()
  })
})

describe("validateBlockDoc with plugin blocks", () => {
  const spec: ThemeBlockSpec = {
    type: "plugin:reading-time/estimate",
    version: 1,
    attrs: { label: { type: "string", default: "min read", maxLength: 10 } },
  }
  const doc = (type: string, block: Record<string, unknown>): BlockDocV1 =>
    ({ doc_version: 1, blocks_order: ["blk-plugin-00001"], blocks: { "blk-plugin-00001": { id: "blk-plugin-00001", type, ...block } } }) as unknown as BlockDocV1
  const lookup = (type: string) => (type === spec.type ? spec : undefined)

  it("checks an installed plugin block against its spec", () => {
    expect(() => validateBlockDoc(doc(spec.type, { version: 1, attrs: { label: "far too long" } }), { themeBlocks: lookup })).toThrow(/label at most 10/)
    expect(() => validateBlockDoc(doc(spec.type, { version: 1, attrs: { label: "minutes" } }), { themeBlocks: lookup })).not.toThrow()
  })

  it("leaves a plugin block that isn't installed to the catch-all, so it still stores", () => {
    expect(() => validateBlockDoc(doc("plugin:gone/widget", { version: 7, attrs: { anything: 1 } }), { themeBlocks: lookup })).not.toThrow()
    expect(() => validateBlockDoc(doc("plugin:gone/widget", { version: 0, attrs: {} }), { themeBlocks: lookup })).toThrow()
  })

  it("a lookup that answers for a core type is never asked about one", () => {
    // Only namespaced types are looked up: a core block is checked by its own schema.
    const everything = () => spec
    expect(() =>
      validateBlockDoc(doc("paragraph", { version: 1, attrs: { text: "Hi", label: "far too long" } }), { themeBlocks: everything }),
    ).not.toThrow()
  })
})
