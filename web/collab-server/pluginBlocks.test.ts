// A seed whose block_doc holds a plugin block the build doesn't have (#452): the server
// keeps it in meta.dropped and puts it back on every store, as for a removed theme's block.
import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import type { BlockDocV1 } from "../gl-admin/lib/blocks-spec"
import { EDITOR_FRAGMENT } from "../gl-admin/lib/collaboration/fragmentBridge"
import { getInstalledCollabSchema } from "../gl-admin/lib/theme-blocks/collabSchema"
import { loadIntoDoc, readMeta } from "./load"
import { prepareStore } from "./store"
import { appendParagraph } from "./testkit"

const schema = getInstalledCollabSchema()
const PARA = "blk-para-00000001"
const GONE = "blk-plugin-gone01"

const gone = {
  id: GONE,
  type: "plugin:gone/widget",
  version: 3,
  attrs: { size: 4, pm: { type: "plugin:gone/widget", content: [{ type: "text", text: "kept" }] }, text: "kept" },
}
const blockDoc: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [PARA, GONE],
  blocks: { [PARA]: { id: PARA, type: "paragraph", version: 1, attrs: { text: "Intro" } }, [GONE]: gone },
}

describe("a seed with an uninstalled plugin block", () => {
  it("drops it into meta.dropped, keeps it out of the fragment, and stores it back", () => {
    const doc = new Y.Doc()
    const outcome = loadIntoDoc(doc, { block_doc: blockDoc, block_revision: 1, ydoc_state: null, epoch: null }, schema, () => "epoch-1")
    expect(outcome).toMatchObject({ kind: "seeded", dropped: 1 })

    const fragment = doc.getXmlFragment(EDITOR_FRAGMENT)
    expect(fragment.toArray().map((child) => (child as Y.XmlElement).nodeName)).toEqual(["paragraph"])

    // Across a restart: the record is in the Yjs state.
    const restarted = new Y.Doc()
    Y.applyUpdate(restarted, Y.encodeStateAsUpdate(doc))
    const dropped = readMeta(restarted).dropped
    expect(dropped?.entries).toEqual([{ id: GONE, parentId: null, afterId: PARA }])
    expect(dropped?.blocks[GONE]).toEqual(gone)

    // An edit, then a store: the block is back at its place, byte for byte.
    appendParagraph(restarted, "More")
    const { decision } = prepareStore(restarted, schema, { previous: blockDoc, clientEdited: true, lastEditorId: "1" })
    if (!decision.write) throw new Error(`expected a write, got ${decision.reason}`)
    expect(decision.blockDoc.blocks_order.slice(0, 2)).toEqual([PARA, GONE])
    expect(decision.blockDoc.blocks[GONE]).toEqual(gone)
  })
})

// #456: the example plugin's block is installed in this build (its block.json), so the
// server seeds it into the fragment and stores it validated from its spec, enabled or not:
// the collab server never reads the enabled list.
describe("an installed plugin block", () => {
  const ESTIMATE = "blk-estimate-00001"
  const estimateDoc = (attrs: Record<string, unknown>): BlockDocV1 => ({
    doc_version: 1,
    blocks_order: [PARA, ESTIMATE],
    blocks: {
      [PARA]: { id: PARA, type: "paragraph", version: 1, attrs: { text: "Intro" } },
      [ESTIMATE]: { id: ESTIMATE, type: "plugin:reading-time/estimate", version: 1, attrs },
    },
  })

  it("is in the schema with its spec", () => {
    expect(schema.nodes["plugin:reading-time/estimate"]).toBeDefined()
  })

  it("seeds into the fragment and stores back with its declared attrs", () => {
    const doc = new Y.Doc()
    const outcome = loadIntoDoc(doc, { block_doc: estimateDoc({ label: "minutes" }), block_revision: 1, ydoc_state: null, epoch: null }, schema, () => "epoch-1")
    expect(outcome).toMatchObject({ kind: "seeded", dropped: 0 })
    const nodes = doc.getXmlFragment(EDITOR_FRAGMENT).toArray() as Y.XmlElement[]
    expect(nodes.map((child) => child.nodeName)).toEqual(["paragraph", "plugin:reading-time/estimate"])
    expect(nodes[1].getAttribute("label")).toBe("minutes")

    appendParagraph(doc, "More")
    const { decision } = prepareStore(doc, schema, { previous: estimateDoc({ label: "minutes" }), clientEdited: true, lastEditorId: "1" })
    if (!decision.write) throw new Error(`expected a write, got ${decision.reason}`)
    expect(decision.blockDoc.blocks[ESTIMATE]).toMatchObject({ type: "plugin:reading-time/estimate", version: 1, attrs: { label: "minutes" } })
  })

  it("a value its spec doesn't allow costs the attr (the default applies), never the store", () => {
    const doc = new Y.Doc()
    loadIntoDoc(doc, { block_doc: estimateDoc({ label: "x".repeat(41) }), block_revision: 1, ydoc_state: null, epoch: null }, schema, () => "epoch-1")
    appendParagraph(doc, "More")
    const { decision } = prepareStore(doc, schema, { previous: estimateDoc({}), clientEdited: true, lastEditorId: "1" })
    if (!decision.write) throw new Error(`expected a write, got ${decision.reason}`)
    expect((decision.blockDoc.blocks[ESTIMATE].attrs as { label?: unknown }).label).not.toBe("x".repeat(41))
  })
})
