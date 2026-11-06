import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { DOMSerializer, type Node as PMNode } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { isBlockNode, validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { BlockNodeViews } from "./BlockNodeViews"
import { PasteSanitizer } from "./PasteSanitizer"
import { duplicateBlock } from "../utils/blockActions"

// Two users editing inside one group on the real collab server (#414): their edits
// merge, every block keeps a unique id on both peers, and the stored block_doc is valid
// with the group's children in order.

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
      PasteSanitizer,
      Collaboration.configure({ document: doc }),
    ],
  })
  editors.push(editor)
  return editor
}

const GROUP = "blk-0414-group-000001"
const ONE = "blk-0414-para-0000001"
const TWO = "blk-0414-para-0000002"
const AFTER = "blk-0414-after-000001"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [GROUP, AFTER],
  blocks: {
    [GROUP]: { id: GROUP, type: "group", version: 1, attrs: { style: "tinted" }, children: [ONE, TWO] },
    [ONE]: { id: ONE, type: "paragraph", version: 1, attrs: { text: "first" } },
    [TWO]: { id: TWO, type: "paragraph", version: 1, attrs: { text: "second" } },
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

/** The position at the end of the text of the paragraph with this id. */
function endOf(editor: Editor, id: string): number {
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.attrs["data-block-id"] === id) at = pos + node.nodeSize - 1
  })
  if (at === -1) throw new Error(`no ${id}`)
  return at
}

const same = (a: Editor, b: Editor) => JSON.stringify(a.state.doc.toJSON()) === JSON.stringify(b.state.doc.toJSON())

describe("Group with two users on the relay (#414)", () => {
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

  it("edits inside one group merge, ids stay unique, and the stored block_doc is valid", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("second"), { what: "b to load" })
    expect(a.state.doc.child(0).type.name).toBe("group")

    // At the same time: A types in the first paragraph, B in the second and splits it.
    a.chain().setTextSelection(endOf(a, ONE)).insertContent(" from A").run()
    b.chain().setTextSelection(endOf(b, TWO)).insertContent(" from B").run()
    b.commands.setTextSelection(endOf(b, TWO))
    b.commands.splitBlock()
    b.commands.insertContent("third from B")
    // A changes the group's width while B types.
    a.commands.setTextSelection(endOf(a, ONE))
    a.commands.setGroupAttrs({ align: "full" })

    await waitFor(() => same(a, b) && a.getText().includes("third from B") && b.getText().includes("first from A"), { what: "convergence" })
    const group = a.state.doc.child(0)
    expect(group.type.name).toBe("group")
    expect(group.attrs).toMatchObject({ style: "tinted", align: "full", "data-block-id": GROUP })
    expect(group.childCount).toBe(3)
    expect(group.child(0).attrs["data-block-id"]).toBe(ONE)
    expect(group.child(1).attrs["data-block-id"]).toBe(TWO)
    expect(unique(blockIds(a.state.doc))).toBe(true)
    expect(blockIds(a.state.doc)).toEqual(blockIds(b.state.doc))

    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(() => (stored().blocks[GROUP]?.children?.length ?? 0) === 3 && (stored().blocks[GROUP]?.attrs as any)?.align === "full", {
      what: "the store",
    })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(doc.blocks_order).toEqual([GROUP, AFTER])
    const children = doc.blocks[GROUP].children!
    expect(children.slice(0, 2)).toEqual([ONE, TWO])
    expect((doc.blocks[ONE].attrs as any).text).toBe("first from A")
    expect((doc.blocks[TWO].attrs as any).text).toBe("second from B")
    expect((doc.blocks[children[2]].attrs as any).text).toBe("third from B")
    expect(doc.blocks[GROUP].attrs).toEqual({ style: "tinted", align: "full" })

    // A third user opening the post later gets the same doc from the server.
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.getText().includes("third from B"), { what: "c to load" })
    expect(c.state.doc.toJSON()).toEqual(a.state.doc.toJSON())
  })

  it("a duplicated and a pasted group get fresh ids on both peers, and the store keeps them apart", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("second"), { what: "b to load" })

    // A duplicates the group (#356); B pastes a copy of it from the clipboard.
    duplicateBlock(a, { id: GROUP, pos: 0 })
    const groupEnd = b.state.doc.child(0).nodeSize
    const wrap = document.createElement("div")
    wrap.append(DOMSerializer.fromSchema(b.schema).serializeFragment(b.state.doc.slice(0, groupEnd).content))
    ;(wrap.firstElementChild as HTMLElement).setAttribute("data-pm-slice", "0 0 []")
    b.view.dispatch(b.state.tr.setSelection(TextSelection.create(b.state.doc, endOf(b, AFTER))))
    b.view.pasteHTML(wrap.innerHTML, new Event("paste") as ClipboardEvent)

    const groups = (editor: Editor) => {
      let n = 0
      editor.state.doc.forEach((node) => (n += node.type.name === "group" ? 1 : 0))
      return n
    }
    await waitFor(() => same(a, b) && groups(a) === 3, { what: "convergence" })
    expect(unique(blockIds(a.state.doc))).toBe(true)
    expect(unique(blockIds(b.state.doc))).toBe(true)

    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(() => stored().blocks_order.filter((id) => stored().blocks[id]?.type === "group").length === 3, { what: "the store" })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    const groupIds = doc.blocks_order.filter((id) => doc.blocks[id].type === "group")
    const childIds = groupIds.flatMap((id) => doc.blocks[id].children!)
    expect(new Set(childIds).size).toBe(childIds.length)
    expect(childIds.filter((id) => id === ONE || id === TWO)).toHaveLength(2)
  })
})
