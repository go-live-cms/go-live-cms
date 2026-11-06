import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import type { Node as PMNode } from "@tiptap/pm/model"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { BlockNodeViews } from "./BlockNodeViews"
import { TableKeyboard } from "./TableBlock"

// Two users in one table on the real collab server (#420): typing in different cells
// merges, the stored block_doc is valid with both edits, and prosemirror-tables'
// `fixTables` never runs on a sync (rule 7): a table two people reshaped at once is padded
// only by a later local edit, once, instead of by every peer on its own.

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
      TableKeyboard,
      Collaboration.configure({ document: doc }),
    ],
  })
  editors.push(editor)
  return editor
}

const TABLE = "blk-0420-table-000001"
const AFTER = "blk-0420-after-000001"

const row = (...texts: string[]) => ({
  type: "tableRow",
  content: texts.map((text) => ({ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text }] }] })),
})

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [TABLE, AFTER],
  blocks: {
    [TABLE]: {
      id: TABLE,
      type: "table",
      version: 1,
      attrs: {
        pm: { type: "table", content: [row("Role", "Write", "Publish"), row("Admin", "Yes", "Yes"), row("Editor", "Yes", "No")] },
        headerRow: true,
        caption: [{ type: "text", text: "Who can do what" }],
      },
    },
    [AFTER]: { id: AFTER, type: "paragraph", version: 1, attrs: { text: "after" } },
  },
}

/** The position at the end of the first paragraph (or caption) whose text is `text`. */
function endOfText(editor: Editor, text: string): number {
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isTextblock && node.textContent === text) at = pos + node.nodeSize - 1
    return at === -1
  })
  if (at === -1) throw new Error(`no "${text}"`)
  return at
}

const grid = (editor: Editor): PMNode => editor.state.doc.child(0).child(0)
const rowLengths = (editor: Editor) => Array.from({ length: grid(editor).childCount }, (_, i) => grid(editor).child(i).childCount)
const json = (editor: Editor) => JSON.stringify(editor.state.doc.toJSON())
const same = (a: Editor, b: Editor) => json(a) === json(b)
const stored = () => relay.api.posts.get("12")!.block_doc!
const storedRows = () => (stored().blocks[TABLE]?.attrs as any)?.pm?.content as any[] | undefined
const cellTexts = (rows: any[] | undefined) =>
  (rows ?? []).map((r) => r.content.map((c: any) => c.content.map((p: any) => (p.content ?? []).map((t: any) => t.text).join("")).join(" ")))

/** Both docs stay as they are for `ms` (nothing keeps rewriting them). */
async function quiet(a: Editor, b: Editor, ms = 400) {
  const before = [json(a), json(b)]
  await new Promise((resolve) => setTimeout(resolve, ms))
  expect([json(a), json(b)]).toEqual(before)
}

describe("Table with two users on the relay (#420)", () => {
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

  it("two users typing in different cells (and the caption) both keep their edits, on every peer and in the store", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("Editor"), { what: "b to load" })
    expect(a.state.doc.child(0).type.name).toBe("tableBlock")
    expect(grid(a).attrs.headerRow).toBe(true)

    // At the same time: A in the Admin row, B in the Editor row and in the caption.
    a.chain().setTextSelection(endOfText(a, "Admin")).insertContent(" (all)").run()
    b.chain().setTextSelection(endOfText(b, "No")).insertContent(", ask an editor").run()
    b.chain().setTextSelection(endOfText(b, "Who can do what")).insertContent(" in GoLive").run()

    await waitFor(() => same(a, b) && a.getText().includes("ask an editor") && b.getText().includes("Admin (all)"), {
      what: "convergence",
    })
    expect(a.state.doc.child(0).attrs["data-block-id"]).toBe(TABLE)
    expect(rowLengths(a)).toEqual([3, 3, 3])
    await quiet(a, b)

    await waitFor(() => JSON.stringify(cellTexts(storedRows())).includes("ask an editor") && JSON.stringify(cellTexts(storedRows())).includes("Admin (all)"), {
      what: "the store",
    })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(doc.blocks_order).toEqual([TABLE, AFTER])
    expect(cellTexts(storedRows())).toEqual([
      ["Role", "Write", "Publish"],
      ["Admin (all)", "Yes", "Yes"],
      ["Editor", "Yes", "No, ask an editor"],
    ])
    expect(doc.blocks[TABLE].attrs).toMatchObject({ headerRow: true, caption: [{ type: "text", text: "Who can do what in GoLive" }] })
    expect(doc.blocks[TABLE].children).toBeUndefined()

    // A third user opening the post later gets the same doc from the server.
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.getText().includes("ask an editor"), { what: "c to load" })
    expect(c.state.doc.toJSON()).toEqual(a.state.doc.toJSON())
  })

  it("turning the header row off while someone types in a header cell keeps their typing (#420)", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("Editor"), { what: "b to load" })

    // At the same time: A types in the header cell "Publish", B turns the header row off.
    a.chain().setTextSelection(endOfText(a, "Publish")).insertContent(" now").run()
    b.chain().setTextSelection(endOfText(b, "Editor")).toggleTableHeaderRow().run()

    await waitFor(() => same(a, b) && b.getText().includes("Publish now") && grid(a).attrs.headerRow === false, { what: "convergence" })
    await waitFor(() => (stored().blocks[TABLE]?.attrs as any)?.headerRow === undefined && JSON.stringify(cellTexts(storedRows())).includes("Publish now"), {
      what: "the store",
    })
    expect(cellTexts(storedRows())[0]).toEqual(["Role", "Write", "Publish now"])
  })

  it("a column and a row added at once merge without any peer padding the table on a sync (rule 7)", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("Editor"), { what: "b to load" })

    // Both before either sees the other's: A adds a column, B a row (of the old width).
    a.chain().setTextSelection(endOfText(a, "Admin")).addTableColumn("after").run()
    b.chain().setTextSelection(endOfText(b, "Editor")).addTableRow("after").run()

    await waitFor(() => same(a, b) && rowLengths(a).length === 4 && rowLengths(a)[0] === 4, { what: "convergence" })
    // The merge leaves B's new row one cell short. Without the guard each peer's fixTables
    // would pad it on receiving the other's change, and both paddings would sync.
    expect(rowLengths(a)).toEqual([4, 4, 4, 3])
    await quiet(a, b)
    expect(rowLengths(b)).toEqual([4, 4, 4, 3])

    // A local edit in that table fixes it, on the client that made it, once.
    a.chain().setTextSelection(endOfText(a, "Editor")).insertContent("s").run()
    await waitFor(() => same(a, b) && b.getText().includes("Editors"), { what: "the fix to sync" })
    expect(rowLengths(a)).toEqual([4, 4, 4, 4])
    await quiet(a, b)
    expect(rowLengths(b)).toEqual([4, 4, 4, 4])

    await waitFor(() => (storedRows() ?? []).length === 4 && storedRows()!.every((r) => r.content.length === 4), { what: "the store" })
    expect(() => validateBlockDoc(stored())).not.toThrow()
  })
})
