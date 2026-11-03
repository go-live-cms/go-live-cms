// @vitest-environment node
import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import { blockDocToPMWithReport, pmToBlockDoc } from "./blockBridge"
import { EDITOR_FRAGMENT, fragmentToBlockDoc, seedFragment, stampFragmentBlockIds } from "./fragmentBridge"
import { getCoreSchema } from "./schema"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import { validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { themeBlockLookup } from "../blocks-spec/themeBlocks"
import alert from "../../../themes/example/blocks/Alert/index"

// Theme blocks through the bridge (#376), on the collab server's own schema (plain Node,
// like the server): Block Spec ⇄ ProseMirror ⇄ the Yjs fragment.

const schema = getInstalledCollabSchema()
const PARA = "blk-para-00000001"
const ALERT = "blk-alert-0000001"
const GONE = "blk-gone-00000001"

const alertNode = (variant: string, text: string) =>
  schema.nodeFromJSON({
    type: alert.type,
    attrs: { variant, "data-block-id": ALERT },
    content: [{ type: "text", text: "Mind ", marks: [{ type: "bold" }] }, { type: "text", text }],
  })

describe("theme block ⇄ Block Spec", () => {
  it("stores declared attrs on the block, content in pm, and round-trips to the same node", () => {
    const pmDoc = schema.topNodeType.create(null, [alertNode("warning", "the gap")])
    const doc = pmToBlockDoc(pmDoc)
    expect(doc.blocks[ALERT]).toEqual({
      id: ALERT,
      type: "theme:example/alert",
      version: 1,
      attrs: {
        variant: "warning",
        pm: {
          type: "theme:example/alert",
          content: [{ type: "text", text: "Mind ", marks: [{ type: "bold" }] }, { type: "text", text: "the gap" }],
        },
        text: "Mind the gap",
      },
    })
    expect(() => validateBlockDoc(doc, { themeBlocks: themeBlockLookup(schema) })).not.toThrow()

    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(dropped).toEqual([])
    node.check()
    expect(node.toJSON()).toEqual(pmDoc.toJSON())
    expect(pmToBlockDoc(node)).toEqual(doc)
  })

  it("the block's attrs win: attrs inside a stored pm are ignored", () => {
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [ALERT],
      blocks: {
        [ALERT]: {
          id: ALERT,
          type: alert.type,
          version: 1,
          attrs: { pm: { type: alert.type, attrs: { variant: "error", extra: "x" }, content: [{ type: "text", text: "a" }] } },
        },
      },
    }
    const { node } = blockDocToPMWithReport(doc, schema)
    expect(node.firstChild!.attrs).toEqual({ variant: "info", "data-block-id": ALERT })
  })

  it("a stored value its spec no longer allows loads as the default, so the post stays storable", () => {
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [ALERT],
      blocks: { [ALERT]: { id: ALERT, type: alert.type, version: 1, attrs: { variant: "purple", text: "a" } } },
    }
    const { node } = blockDocToPMWithReport(doc, schema)
    expect(node.firstChild!.attrs.variant).toBe("info")
    expect(() => validateBlockDoc(pmToBlockDoc(node), { themeBlocks: themeBlockLookup(schema) })).not.toThrow()
  })

  it("builds from text alone, and a leaf-free alert with no content stores no content", () => {
    const fromText: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [ALERT],
      blocks: { [ALERT]: { id: ALERT, type: alert.type, version: 1, attrs: { variant: "success", text: "Done" } } },
    }
    expect(blockDocToPMWithReport(fromText, schema).node.firstChild!.textContent).toBe("Done")

    const empty = pmToBlockDoc(schema.topNodeType.create(null, [schema.nodes[alert.type].create({ "data-block-id": ALERT })]))
    expect(empty.blocks[ALERT].attrs).toEqual({ variant: "info", pm: { type: alert.type }, text: undefined })
  })

  it("a version newer than this build reads is dropped (hidden and kept), not misread", () => {
    const newer: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [ALERT],
      blocks: { [ALERT]: { id: ALERT, type: alert.type, version: 2, attrs: { text: "x" } } },
    }
    expect(blockDocToPMWithReport(newer, schema).dropped.map((d) => d.id)).toEqual([ALERT])
  })
})

describe("theme blocks through the collab server's fragment bridge", () => {
  // A post with an installed theme block, and a block of a theme that isn't in this build
  // (removed since): `widget` has a version and attrs only its own theme knows.
  const stored: BlockDocV1 = {
    doc_version: 1,
    blocks_order: [PARA, GONE, ALERT],
    blocks: {
      [PARA]: { id: PARA, type: "paragraph", version: 1, attrs: { text: "Intro" } },
      [GONE]: {
        id: GONE,
        type: "theme:gone/widget",
        version: 3,
        attrs: { size: 4, pm: { type: "theme:gone/widget", content: [{ type: "text", text: "kept" }] }, text: "kept" },
      },
      [ALERT]: {
        id: ALERT,
        type: alert.type,
        version: 1,
        attrs: { variant: "error", pm: { type: alert.type, content: [{ type: "text", text: "Careful" }] }, text: "Careful" },
      },
    },
  }

  it("seeds the installed block into the fragment and keeps the uninstalled one out, then stores both", () => {
    const ydoc = new Y.Doc()
    const fragment = ydoc.getXmlFragment(EDITOR_FRAGMENT)
    const dropped = seedFragment(stored, fragment, schema)

    expect(dropped.entries).toEqual([{ id: GONE, parentId: null, afterId: PARA }])
    expect(dropped.blocks[GONE]).toEqual(stored.blocks[GONE])
    const names = fragment.toArray().map((child) => (child as Y.XmlElement).nodeName)
    expect(names).toEqual(["paragraph", alert.type])
    expect((fragment.get(1) as Y.XmlElement).getAttribute("variant")).toBe("error")

    // The store puts the uninstalled block back, byte for byte, at its place.
    stampFragmentBlockIds(fragment)
    const derived = fragmentToBlockDoc(fragment, schema, { dropped })
    expect(derived.blocks_order).toEqual(stored.blocks_order)
    expect(derived.blocks[GONE]).toEqual(stored.blocks[GONE])
    expect(derived.blocks[ALERT]).toEqual(stored.blocks[ALERT])
    expect(() => validateBlockDoc(derived, { themeBlocks: themeBlockLookup(schema) })).not.toThrow()
  })

  it("a server without the theme installed keeps the block too (core schema only)", () => {
    const ydoc = new Y.Doc()
    const fragment = ydoc.getXmlFragment(EDITOR_FRAGMENT)
    const core = getCoreSchema()
    const dropped = seedFragment(stored, fragment, core)
    expect(dropped.entries.map((entry) => entry.id)).toEqual([GONE, ALERT])
    const derived = fragmentToBlockDoc(fragment, core, { dropped })
    expect(derived.blocks_order).toEqual(stored.blocks_order)
    expect(derived.blocks[GONE]).toEqual(stored.blocks[GONE])
    expect(derived.blocks[ALERT]).toEqual(stored.blocks[ALERT])
  })
})
