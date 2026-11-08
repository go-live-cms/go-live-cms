import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import type { Node as PMNode } from "@tiptap/pm/model"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { isBlockNode, validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { BlockNodeViews } from "./BlockNodeViews"
import { DetailsKeyboard } from "./DetailsBlock"
import { PasteSanitizer } from "./PasteSanitizer"
import { duplicateBlock } from "../utils/blockActions"

// Two users in one details on the real collab server (#421): typing in one summary merges
// per character (it's a child node, not an attribute), "Open by default" is one attribute
// (last writer wins) that doesn't cost anyone's typing, every block keeps a unique id on
// both peers, and the stored block_doc is valid, with the summary as runs and the blocks
// as children. A third user and a restarted server load the same doc.

const editors: Editor[] = []
let relay: Relay

function makeEditor(doc: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: true })),
      BlockNodeViews,
      DetailsKeyboard,
      PasteSanitizer,
      Collaboration.configure({ document: doc }),
    ],
  })
  editors.push(editor)
  return editor
}

const DETAILS = "blk-0421-details-0001"
const ONE = "blk-0421-para-0000001"
const AFTER = "blk-0421-after-000001"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [DETAILS, AFTER],
  blocks: {
    [DETAILS]: { id: DETAILS, type: "details", version: 1, attrs: { summary: [{ type: "text", text: "Who publishes" }], text: "Who publishes" }, children: [ONE] },
    [ONE]: { id: ONE, type: "paragraph", version: 1, attrs: { text: "An editor." } },
    [AFTER]: { id: AFTER, type: "paragraph", version: 1, attrs: { text: "after" } },
  },
}

function blockIds(doc: PMNode): unknown[] {
  const ids: unknown[] = []
  const walk = (node: PMNode, parentName: string | null) =>
    node.forEach((child) => {
      if (isBlockNode(child.type.name, parentName)) ids.push(child.attrs["data-block-id"])
      if (!child.isTextblock) walk(child, child.type.name)
    })
  walk(doc, null)
  return ids
}

const unique = (ids: unknown[]) => ids.every((id) => typeof id === "string" && id.length >= 10) && new Set(ids).size === ids.length

/** The position at the end of the text of the block with this id. */
function endOf(editor: Editor, id: string): number {
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.attrs["data-block-id"] === id) at = pos + node.nodeSize - 1
  })
  if (at === -1) throw new Error(`no ${id}`)
  return at
}

/** The summary's text start and end in the first details. */
const summaryStart = 2
const summaryEnd = (editor: Editor) => summaryStart + editor.state.doc.child(0).child(0).content.size

const same = (a: Editor, b: Editor) => JSON.stringify(a.state.doc.toJSON()) === JSON.stringify(b.state.doc.toJSON())
const summaryText = (editor: Editor) => editor.state.doc.child(0).child(0).textContent

describe("Details with two users on the relay (#421)", () => {
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    relay = await startRelay({ blockDoc: canonical(seed), revision: 2 })
  })
  afterEach(async () => {
    while (editors.length) {
      const editor = editors.pop()!
      const element = editor.options.element as HTMLElement
      editor.destroy()
      element.remove()
    }
    await relay.destroy()
    vi.restoreAllMocks()
  })

  it("two users typing in one summary merge per character; Open by default and new blocks merge too", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("An editor."), { what: "b to load" })
    expect(a.state.doc.child(0).type.name).toBe("details")

    // At the same time, in the same summary: A at its start, B at its end, B bold.
    a.chain().setTextSelection(summaryStart).insertContent("Q: ").run()
    b.chain().setTextSelection(summaryEnd(b)).insertContent({ type: "text", text: "?", marks: [{ type: "bold" }] }).run()
    // A turns Open by default on while B adds a block from the summary (↵) and types in it.
    a.commands.setTextSelection(endOf(a, ONE))
    a.commands.setDetailsOpen(true)
    b.commands.setTextSelection(endOf(b, ONE))
    b.commands.splitBlock()
    b.commands.insertContent("A second answer from B")

    await waitFor(() => same(a, b) && summaryText(a) === "Q: Who publishes?" && a.getText().includes("A second answer from B"), {
      what: "convergence",
    })
    const details = a.state.doc.child(0)
    expect(details.attrs).toMatchObject({ open: true, "data-block-id": DETAILS })
    expect(details.child(0).type.name).toBe("detailsSummary")
    expect(details.childCount).toBe(3)
    expect(details.child(1).attrs["data-block-id"]).toBe(ONE)
    expect(unique(blockIds(a.state.doc))).toBe(true)
    expect(blockIds(a.state.doc)).toEqual(blockIds(b.state.doc))

    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(() => (stored().blocks[DETAILS]?.children?.length ?? 0) === 2 && (stored().blocks[DETAILS]?.attrs as any)?.open === true, {
      what: "the store",
    })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(doc.blocks_order).toEqual([DETAILS, AFTER])
    expect(doc.blocks[DETAILS].attrs).toEqual({
      summary: [
        { type: "text", text: "Q: Who publishes" },
        { type: "text", text: "?", marks: [{ type: "bold" }] },
      ],
      text: "Q: Who publishes?",
      open: true,
    })
    const [first, second] = doc.blocks[DETAILS].children!
    expect(first).toBe(ONE)
    expect((doc.blocks[second].attrs as any).text).toBe("A second answer from B")
    // The summary is never a block of its own.
    expect(Object.values(doc.blocks).map((block) => block.type).sort()).toEqual(["details", "paragraph", "paragraph", "paragraph"])

    // A third user opening the post later, and a restarted server, give the same doc.
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.getText().includes("A second answer from B"), { what: "c to load" })
    expect(c.state.doc.toJSON()).toEqual(a.state.doc.toJSON())
    const before = c.state.doc.toJSON()
    await relay.restart()
    const pd = relay.client("2")
    await pd.whenSynced()
    const d = makeEditor(pd.doc)
    await waitFor(() => d.getText().includes("A second answer from B"), { what: "d to load after the restart" })
    expect(d.state.doc.toJSON()).toEqual(before)
  })

  it("a duplicated details gets fresh ids on both peers, and the store keeps them apart", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("An editor."), { what: "b to load" })

    duplicateBlock(a, { id: DETAILS, pos: 0 })
    const count = (editor: Editor) => {
      let n = 0
      editor.state.doc.forEach((node) => (n += node.type.name === "details" ? 1 : 0))
      return n
    }
    await waitFor(() => same(a, b) && count(b) === 2, { what: "convergence" })
    expect(unique(blockIds(a.state.doc))).toBe(true)
    expect(unique(blockIds(b.state.doc))).toBe(true)

    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(() => stored().blocks_order.filter((id) => stored().blocks[id]?.type === "details").length === 2, { what: "the store" })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    const all = doc.blocks_order.filter((id) => doc.blocks[id].type === "details")
    expect(all.map((id) => (doc.blocks[id].attrs as any).text)).toEqual(["Who publishes", "Who publishes"])
    const childIds = all.flatMap((id) => doc.blocks[id].children!)
    expect(new Set(childIds).size).toBe(2)
    expect(childIds).toContain(ONE)
  })
})
