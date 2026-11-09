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
import { setColumnCount } from "../utils/columnActions"

// Columns, buttons and the spacer on the real collab server (#426): the canvas's "tinted
// group holding three columns, with four people in it", two people changing the layout
// while others type, adding a column at once (over the limit: the server repairs it, no
// loss), a removed column's blocks surviving, and the stored block_doc valid throughout.

const editors: Editor[] = []
let relay: Relay

function makeEditor(doc: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [...Object.values(schemaExtensions({ collaborating: true })), BlockNodeViews, Collaboration.configure({ document: doc })],
  })
  editors.push(editor)
  return editor
}

const G = "blk-0426-group-000001"
const COLS = "blk-0426-columns-00001"
const C1 = "blk-0426-column-00001"
const C2 = "blk-0426-column-00002"
const C3 = "blk-0426-column-00003"
const P1 = "blk-0426-para-0000001"
const P2 = "blk-0426-para-0000002"
const P3 = "blk-0426-para-0000003"
const BTN = "blk-0426-buttons-00001"
const SPC = "blk-0426-spacer-00001"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [G, BTN, SPC],
  blocks: {
    [G]: { id: G, type: "group", version: 1, attrs: { style: "tinted" }, children: [COLS] },
    [COLS]: { id: COLS, type: "columns", version: 1, attrs: {}, children: [C1, C2, C3] },
    [C1]: { id: C1, type: "column", version: 1, attrs: {}, children: [P1] },
    [C2]: { id: C2, type: "column", version: 1, attrs: {}, children: [P2] },
    [C3]: { id: C3, type: "column", version: 1, attrs: {}, children: [P3] },
    [P1]: { id: P1, type: "paragraph", version: 1, attrs: { text: "alpha" } },
    [P2]: { id: P2, type: "paragraph", version: 1, attrs: { text: "beta" } },
    [P3]: { id: P3, type: "paragraph", version: 1, attrs: { text: "gamma" } },
    [BTN]: { id: BTN, type: "buttons", version: 1, attrs: { pm: { type: "buttons", content: [{ type: "button", attrs: { href: "/one" }, content: [{ type: "text", text: "One" }] }] }, text: "One" } },
    [SPC]: { id: SPC, type: "spacer", version: 1, attrs: { size: "7" } },
  },
} as BlockDocV1

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

function endOf(editor: Editor, id: string): number {
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.attrs["data-block-id"] === id) at = pos + node.nodeSize - 1
  })
  if (at === -1) throw new Error(`no ${id}`)
  return at
}

const same = (a: Editor, b: Editor) => JSON.stringify(a.state.doc.toJSON()) === JSON.stringify(b.state.doc.toJSON())
const stored = () => relay.api.posts.get("12")!.block_doc!

async function clients(count: number): Promise<Editor[]> {
  const providers = Array.from({ length: count }, (_, i) => relay.client(String(i + 1)))
  await Promise.all(providers.map((p) => p.whenSynced()))
  const out = providers.map((p) => makeEditor(p.doc))
  await waitFor(() => out.every((e) => e.getText().includes("alpha")), { what: "everyone to load" })
  return out
}

/** The columns node (in the group). */
const columnsOf = (editor: Editor) => editor.state.doc.child(0).child(0)

describe("Layout blocks with several users on the relay (#426)", () => {
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    relay = await startRelay({ blockDoc: canonical(seed), revision: 2 })
    // Four people who can write (the relay only knows users 1 to 3, 3 a contributor).
    for (const id of ["3", "4", "5"]) relay.api.users.set(id, { role: "editor" })
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

  it("four users in a tinted group of three columns: every edit merges, ids stay unique, the store is valid", async () => {
    const [a, b, c, d] = await clients(4)
    expect(a.state.doc.child(0).attrs.style).toBe("tinted")
    expect(columnsOf(a).childCount).toBe(3)

    // At the same time: one types in each column, and the fourth widens the row and adds a
    // block to the middle column.
    a.commands.setTextSelection(endOf(a, P1))
    a.commands.insertContent(" from A")
    b.commands.setTextSelection(endOf(b, P2))
    b.commands.insertContent(" from B")
    c.commands.setTextSelection(endOf(c, P3))
    c.commands.insertContent(" from C")
    d.commands.setTextSelection(endOf(d, P2))
    d.commands.setColumnsAttrs({ align: "wide" })
    d.commands.splitBlock()
    d.commands.insertContent("D's new line")

    await waitFor(() => same(a, b) && same(b, c) && same(c, d) && a.getText().includes("from A") && a.getText().includes("from B") && a.getText().includes("from C") && a.getText().includes("D's new line"), {
      what: "four users to converge",
    })
    expect(columnsOf(a).childCount).toBe(3)
    expect(columnsOf(a).attrs.align).toBe("wide")
    expect(columnsOf(a).child(1).childCount).toBe(2)
    expect(unique(blockIds(a.state.doc))).toBe(true)
    expect(blockIds(a.state.doc)).toEqual(blockIds(d.state.doc))

    await waitFor(() => (stored().blocks[C2]?.children?.length ?? 0) === 2, { what: "the store" })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(doc.blocks[COLS].attrs).toEqual({ align: "wide" })
    expect(doc.blocks[COLS].children).toEqual([C1, C2, C3])
    expect((doc.blocks[P1].attrs as any).text).toBe("alpha from A")

    // A fifth user opening the post later, and a restarted server, give the same doc.
    const before = a.state.doc.toJSON()
    await relay.restart()
    const pe = relay.client("5")
    await pe.whenSynced()
    const e = makeEditor(pe.doc)
    await waitFor(() => e.getText().includes("D's new line"), { what: "e to load after the restart" })
    expect(e.state.doc.toJSON()).toEqual(before)
  }, 30_000)

  it("removing a column keeps its blocks: the others see them moved, with their ids, in one update", async () => {
    const [a, b] = await clients(2)
    // One Yjs update, as a move is: a delete and an insert in one transaction (design 2.12).
    let updates = 0
    const sent = () => updates++
    const providerDoc = (a.options.extensions.find((e) => e.name === "collaboration") as any).options.document as Y.Doc
    providerDoc.on("update", sent)

    expect(setColumnCount(a, { id: COLS, pos: 1 }, 2)).toBe(true)
    providerDoc.off("update", sent)
    expect(updates).toBe(1)
    await waitFor(() => columnsOf(b).childCount === 2, { what: "the removal to arrive" })

    const last = columnsOf(b).child(1)
    expect(last.childCount).toBe(2)
    expect(last.child(1).textContent).toBe("gamma")
    expect(last.child(1).attrs["data-block-id"]).toBe(P3)
    await waitFor(() => stored().blocks[COLS]?.children?.length === 2, { what: "the store" })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(doc.blocks[C2].children).toEqual([P2, P3])
    expect(doc.blocks[C3]).toBeUndefined()
  })

  it("two people removing the same column get two copies of its blocks, never a loss", async () => {
    const [a, b] = await clients(2)
    setColumnCount(a, { id: COLS, pos: 1 }, 2)
    setColumnCount(b, { id: COLS, pos: 1 }, 2)
    await waitFor(() => same(a, b) && columnsOf(a).childCount === 2, { what: "convergence" })
    const text = columnsOf(a).textContent
    expect(text).toContain("alpha")
    expect(text).toContain("beta")
    expect(text).toContain("gamma")
    await waitFor(() => unique(blockIds(a.state.doc)) && stored().blocks[COLS]?.children?.length === 2, { what: "the store" })
    expect(() => validateBlockDoc(stored())).not.toThrow()
  })

  it("two people adding a fourth column at once: the server repairs five back to four, and nobody can break typing", async () => {
    const [a, b] = await clients(2)
    setColumnCount(a, { id: COLS, pos: 1 }, 4)
    setColumnCount(b, { id: COLS, pos: 1 }, 4)

    // The store repairs the count; everyone gets it, ids stay unique, the doc is valid again.
    await waitFor(() => same(a, b) && columnsOf(a).childCount === 4 && stored().blocks[COLS]?.children?.length === 4, { what: "the repair" })
    expect(unique(blockIds(a.state.doc))).toBe(true)
    expect(() => validateBlockDoc(stored())).not.toThrow()
    expect(columnsOf(a).textContent).toContain("gamma")

    // And the columns are editable afterwards (ProseMirror throws on a count the schema refuses).
    a.commands.setTextSelection(endOf(a, P1))
    expect(() => a.commands.insertContent(" still typing")).not.toThrow()
    await waitFor(() => b.getText().includes("still typing"), { what: "b to see it" })
  }, 30_000)

  it("one user changes the buttons and the spacer while another types a label: both land", async () => {
    const [a, b] = await clients(2)
    const buttonEnd = endOf(a, BTN) - 1
    a.commands.setTextSelection(buttonEnd)
    a.commands.insertContent(" more")
    b.commands.setTextSelection(endOf(b, BTN) - 1)
    b.commands.setButtonLink("https://example.com/next")
    b.commands.setButtonsAlign("center")
    let spacerPos = -1
    b.state.doc.descendants((node, pos) => {
      if (node.type.name === "spacer") spacerPos = pos
    })
    b.commands.setSpacerSize(spacerPos, "9")

    await waitFor(() => same(a, b) && a.getText().includes("One more"), { what: "convergence" })
    await waitFor(() => (stored().blocks[SPC]?.attrs as any)?.size === "9" && (stored().blocks[BTN]?.attrs as any)?.align === "center", { what: "the store" })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect((doc.blocks[BTN].attrs as any).pm.content[0]).toEqual({ type: "button", attrs: { href: "https://example.com/next" }, content: [{ type: "text", text: "One more" }] })
    expect((doc.blocks[BTN].attrs as any).text).toBe("One more")
  })

  it("a peer writing a javascript: href straight into Yjs never gets it stored", async () => {
    const [a, b] = await clients(2)
    const fragment = (b.options.extensions.find((e) => e.name === "collaboration") as any)?.options.document.getXmlFragment("default") as Y.XmlFragment
    const buttons = fragment.toArray().find((node) => (node as Y.XmlElement).nodeName === "buttons") as Y.XmlElement
    const button = buttons.get(0) as Y.XmlElement
    button.setAttribute("href", "javascript:alert(1)")
    a.commands.setTextSelection(endOf(a, P1))
    a.commands.insertContent("!")
    await waitFor(() => (stored().blocks[P1]?.attrs as any)?.text === "alpha!", { what: "the store" })
    const doc = stored()
    expect(JSON.stringify(doc)).not.toContain("javascript")
    expect(() => validateBlockDoc(doc)).not.toThrow()
  })
})
