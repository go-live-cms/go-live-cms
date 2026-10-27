import { describe, it, expect, afterEach } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { ySyncPluginKey } from "@tiptap/y-tiptap"
import type { Node as PMNode } from "prosemirror-model"
import { BlockIdExtension } from "./BlockIdExtension"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"

// Headless editor (no DOM mount) running the real BlockIdExtension plugin, so the
// tests exercise appendTransaction exactly as the admin editor does (#238).

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function makeEditor(content: object): Editor {
  editor = new Editor({ extensions: [StarterKit, BlockIdExtension], content })
  return editor
}

const ITEM_A = "item-aaaa-0000000000"
const LIST_ID = "list-aaaa-0000000000"

/** A one-item bullet list whose item and list already carry valid ids. */
function listDoc(text: string) {
  return {
    type: "doc",
    content: [
      {
        type: "bulletList",
        attrs: { "data-block-id": LIST_ID },
        content: [
          {
            type: "listItem",
            attrs: { "data-block-id": ITEM_A },
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          },
        ],
      },
      // StarterKit's TrailingNode appends a paragraph (in a transaction of its own,
      // without the sync meta) to a doc that ends in a list; end with one already.
      { type: "paragraph", attrs: { "data-block-id": "para-aaaa-0000000000" } },
    ],
  }
}

/** data-block-id of every listItem in the doc, in document order. */
function listItemIds(doc: PMNode): unknown[] {
  const ids: unknown[] = []
  doc.descendants((node) => {
    if (node.type.name === "listItem") ids.push(node.attrs["data-block-id"])
  })
  return ids
}

const isValidId = (id: unknown) => typeof id === "string" && id.length >= 10

describe("BlockIdExtension — list items (#238)", () => {
  it("gives a split list item a fresh, unique id and keeps the original's", () => {
    const ed = makeEditor(listDoc("hello"))
    // doc > bulletList(0) > listItem(1) > paragraph(2) > "hello" at 3..8
    ed.commands.setTextSelection(8)
    expect(ed.commands.splitListItem("listItem")).toBe(true)

    const ids = listItemIds(ed.state.doc)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ITEM_A)
    expect(isValidId(ids[1])).toBe(true)
    expect(ids[1]).not.toBe(ITEM_A)
    // The list itself keeps its id.
    expect(ed.state.doc.child(0).attrs["data-block-id"]).toBe(LIST_ID)
  })

  it("stamps items created by toggling a paragraph into a list", () => {
    const ed = makeEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }],
    })
    ed.commands.setTextSelection(2)
    expect(ed.commands.toggleBulletList()).toBe(true)

    const ids = listItemIds(ed.state.doc)
    expect(ids).toHaveLength(1)
    expect(isValidId(ids[0])).toBe(true)
  })

  it("stamps pasted items, including nested ones, with unique ids", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "paragraph" }] })
    ed.commands.insertContent("<ul><li>a</li><li>b<ol><li>c</li></ol></li></ul>")

    const ids = listItemIds(ed.state.doc)
    expect(ids).toHaveLength(3)
    expect(ids.every(isValidId)).toBe(true)
    expect(new Set(ids).size).toBe(3)
  })

  it("does not touch list items in a collaboration-sync transaction (rule 7)", () => {
    const ed = makeEditor(listDoc("hello"))
    const { state } = ed
    const item = state.schema.nodes.listItem.create(null, state.schema.nodes.paragraph.create())
    // End of the first listItem = inside the bulletList, after item A.
    const tr = state.tr.insert(state.doc.child(0).nodeSize - 1, item)
    tr.setMeta(ySyncPluginKey, { isChangeOrigin: true })
    ed.view.dispatch(tr)

    expect(listItemIds(ed.state.doc)).toEqual([ITEM_A, null])
  })

  it("makes repeated conversions of an edited list identical, so the store sees no change", () => {
    const ed = makeEditor(listDoc("hello"))
    ed.commands.setTextSelection(8)
    ed.commands.splitListItem("listItem")
    ed.commands.insertContent("world")

    const first = pmToBlockDoc(ed.state.doc)
    const second = pmToBlockDoc(ed.state.doc)
    expect(second).toEqual(first)
    // The block ids are the editor's own, not minted by pmToBlockDoc.
    expect(first.blocks[LIST_ID].children).toEqual(listItemIds(ed.state.doc))
  })
})
