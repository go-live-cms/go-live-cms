// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest"
import * as Y from "yjs"
import { blockDocToPMWithReport, pmToBlockDoc } from "./blockBridge"
import { EDITOR_FRAGMENT, fragmentToBlockDoc, seedFragment, stampFragmentBlockIds } from "./fragmentBridge"
import { getCollabSchema, getCoreSchema } from "./schema"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import { defineThemeBlock } from "../theme-blocks/define"
import { installedThemeBlocks } from "../theme-blocks/installed"
import { validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { themeBlockLookup } from "../blocks-spec/themeBlocks"

// Plugin blocks (#452, docs/design/plugin-system.md 5.1) through the bridge: a
// `plugin:<slug>/<block>` type is a namespaced extension block exactly like a theme block.
// Installed, it is built from its spec; not installed, it is dropped at seed and kept in
// `meta.dropped` (#213), never given a stand-in (which would put it in the fragment, where
// an editor without the plugin can't build it, rule 10).

const PARA = "blk-para-00000001"
const GONE = "blk-plugin-gone01"
const EST = "blk-plugin-est001"
const GROUP = "blk-group-0000001"
const ALERT = "blk-alert-0000001"

// No plugin is in the build yet (S6 adds block.json). One defined the way a theme block is,
// for the schema an installed plugin block will give.
const estimate = defineThemeBlock({
  type: "plugin:reading-time/estimate",
  version: 1,
  title: "Reading time",
  content: "",
  attrs: { label: { type: "string", default: "min read", maxLength: 40 } },
})
const withPlugin = getCollabSchema([estimate.node])

/** A block of a plugin that isn't in this build, with a version and attrs only it knows. */
const gonePlugin = (id: string) => ({
  id,
  type: "plugin:gone/widget",
  version: 3,
  attrs: { size: 4, pm: { type: "plugin:gone/widget", content: [{ type: "text", text: "kept" }] }, text: "kept" },
})

const stored: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [PARA, GONE],
  blocks: {
    [PARA]: { id: PARA, type: "paragraph", version: 1, attrs: { text: "Intro" } },
    [GONE]: gonePlugin(GONE),
  },
}

afterEach(() => vi.restoreAllMocks())

describe("a plugin block that isn't installed", () => {
  for (const [name, schema] of [
    ["the installed collab schema", getInstalledCollabSchema()],
    ["the core schema", getCoreSchema()],
  ] as const) {
    it(`is dropped at seed and kept, not given a stand-in (${name})`, () => {
      const ydoc = new Y.Doc()
      const fragment = ydoc.getXmlFragment(EDITOR_FRAGMENT)
      const dropped = seedFragment(stored, fragment, schema)

      // Dropped, with its place, and kept byte for byte for meta.dropped.
      expect(dropped.entries).toEqual([{ id: GONE, parentId: null, afterId: PARA }])
      expect(dropped.blocks[GONE]).toEqual(stored.blocks[GONE])
      // Not in the fragment: no stand-in element an editor would have to build.
      expect(fragment.toArray().map((child) => (child as Y.XmlElement).nodeName)).toEqual(["paragraph"])

      // Every store puts it back at its place, and the doc stays valid.
      stampFragmentBlockIds(fragment)
      const derived = fragmentToBlockDoc(fragment, schema, { dropped })
      expect(derived.blocks_order).toEqual(stored.blocks_order)
      expect(derived.blocks[GONE]).toEqual(stored.blocks[GONE])
      expect(() => validateBlockDoc(derived, { themeBlocks: themeBlockLookup(schema) })).not.toThrow()
    })
  }

  it("without a stored pm is dropped as an extension block, not as a custom block without PM data", () => {
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [GONE],
      blocks: { [GONE]: { id: GONE, type: "plugin:gone/widget", version: 1, attrs: { text: "kept" } } },
    }
    // The pre-#376 custom-block path would warn and drop it for want of a pm; the
    // extension path drops it because its plugin isn't installed, with no warning.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { dropped } = blockDocToPMWithReport(doc, getInstalledCollabSchema())
    expect(dropped).toEqual([{ id: GONE, parentId: null, afterId: null }])
    expect(warn.mock.calls.flat().join(" ")).not.toContain("Unknown block type without PM data")
  })

  it("inside a group is dropped on its own, with its container, and comes back on the store", () => {
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [GROUP],
      blocks: {
        [GROUP]: { id: GROUP, type: "group", version: 1, attrs: {}, children: [PARA, GONE] },
        [PARA]: { id: PARA, type: "paragraph", version: 1, attrs: { text: "Intro" } },
        [GONE]: gonePlugin(GONE),
      },
    }
    const schema = getInstalledCollabSchema()
    const ydoc = new Y.Doc()
    const fragment = ydoc.getXmlFragment(EDITOR_FRAGMENT)
    const dropped = seedFragment(doc, fragment, schema)
    expect(dropped.entries).toEqual([{ id: GONE, parentId: GROUP, afterId: PARA }])
    const group = fragment.get(0) as Y.XmlElement
    expect(group.toArray().map((child) => (child as Y.XmlElement).nodeName)).toEqual(["paragraph"])
    const derived = fragmentToBlockDoc(fragment, schema, { dropped })
    expect(derived.blocks[GROUP].children).toEqual([PARA, GONE])
    expect(derived.blocks[GONE]).toEqual(doc.blocks[GONE])
  })

  it("a type outside both namespaces still gets a stand-in, as before #376", () => {
    // Pre-#376 custom data (e.g. `sidenote`) has no extension to come back with: a stand-in
    // keeps it in the fragment. Only theme: and plugin: types are dropped instead.
    const legacy: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [GONE],
      blocks: { [GONE]: { id: GONE, type: "sidenote", version: 1, attrs: { pm: { type: "sidenote", content: [{ type: "text", text: "x" }] } } } },
    }
    const fragment = new Y.Doc().getXmlFragment(EDITOR_FRAGMENT)
    expect(seedFragment(legacy, fragment, getCoreSchema()).entries).toEqual([])
    expect((fragment.get(0) as Y.XmlElement).nodeName).toBe("sidenote")
  })
})

describe("an installed plugin block", () => {
  const doc = (attrs: Record<string, unknown>, version = 1): BlockDocV1 => ({
    doc_version: 1,
    blocks_order: [PARA, EST],
    blocks: {
      [PARA]: { id: PARA, type: "paragraph", version: 1, attrs: { text: "Intro" } },
      [EST]: { id: EST, type: estimate.type, version, attrs },
    },
  })

  it("seeds into the fragment and stores with its declared attrs on the block", () => {
    const fragment = new Y.Doc().getXmlFragment(EDITOR_FRAGMENT)
    const dropped = seedFragment(doc({ label: "minutes", pm: { type: estimate.type } }), fragment, withPlugin)
    expect(dropped.entries).toEqual([])
    expect((fragment.get(1) as Y.XmlElement).nodeName).toBe(estimate.type)
    expect((fragment.get(1) as Y.XmlElement).getAttribute("label")).toBe("minutes")
    const derived = fragmentToBlockDoc(fragment, withPlugin)
    expect(derived.blocks[EST]).toEqual({ id: EST, type: estimate.type, version: 1, attrs: { label: "minutes", pm: { type: estimate.type } } })
    expect(() => validateBlockDoc(derived, { themeBlocks: themeBlockLookup(withPlugin) })).not.toThrow()
  })

  it("is checked against its spec by the store's validation", () => {
    const lookup = themeBlockLookup(withPlugin)
    expect(() => validateBlockDoc(doc({ label: "x".repeat(41) }), { themeBlocks: lookup })).toThrow(/label at most 40/)
    // Newer than this build reads: not checked, dropped at seed (hidden, kept), like a theme block's.
    expect(() => validateBlockDoc(doc({ label: "x".repeat(41) }, 2), { themeBlocks: lookup })).not.toThrow()
    expect(blockDocToPMWithReport(doc({}, 2), withPlugin).dropped.map((entry) => entry.id)).toEqual([EST])
  })

  it("a value its spec doesn't allow loads as the default, never refusing the post's store", () => {
    const { node } = blockDocToPMWithReport(doc({ label: "x".repeat(41) }), withPlugin)
    expect(node.lastChild!.attrs.label).toBe("min read")
    const storedAgain = pmToBlockDoc(node)
    expect((storedAgain.blocks[EST].attrs as { label?: unknown }).label).toBe("min read")
    expect(() => validateBlockDoc(storedAgain, { themeBlocks: themeBlockLookup(withPlugin) })).not.toThrow()
  })

  it("sits beside an installed theme block in one schema, each dropped only without its extension", () => {
    const mixed: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [ALERT, EST],
      blocks: {
        [ALERT]: { id: ALERT, type: "theme:example/alert", version: 1, attrs: { variant: "warning", text: "Heads up" } },
        [EST]: { id: EST, type: estimate.type, version: 1, attrs: {} },
      },
    }
    const dropsWith = (schema: ReturnType<typeof getCollabSchema>) => blockDocToPMWithReport(mixed, schema).dropped.map((entry) => entry.id)
    expect(dropsWith(getCollabSchema([...installedThemeBlocks.map((block) => block.node), estimate.node]))).toEqual([])
    expect(dropsWith(withPlugin)).toEqual([ALERT])
    expect(dropsWith(getInstalledCollabSchema())).toEqual([EST])
  })
})
