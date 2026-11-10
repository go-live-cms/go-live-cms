import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { CollabSaveStatus } from "@gl-admin/lib/collaboration/CollabSaveStatus"
import { restoreVersionLive } from "@gl-admin/lib/collaboration/liveRestore"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { FootnoteEditing } from "./FootnoteEditing"
import { findFootnotesList, footnoteUses } from "./FootnotesBlock"
import { duplicateBlock, refOf, topLevelBlockAt } from "../utils/blockActions"

// Footnotes with two users on the real collab server (#422): numbers follow the references
// live for both, two people adding the first note at once end with one list, and the stored
// doc is always one the API accepts.

const editors: Editor[] = []
let relay: Relay

function makeEditor(doc: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [...Object.values(schemaExtensions({ collaborating: true })), FootnoteEditing, Collaboration.configure({ document: doc })],
  })
  editors.push(editor)
  return editor
}

const P1 = "blk-0422-paragrph-0001"
const P2 = "blk-0422-paragrph-0002"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [P1, P2],
  blocks: {
    [P1]: { id: P1, type: "paragraph", version: 1, attrs: { text: "First" } },
    [P2]: { id: P2, type: "paragraph", version: 1, attrs: { text: "Second" } },
  },
}

const endOf = (ed: Editor, index: number) => {
  let pos = 0
  for (let i = 0; i <= index; i++) pos += ed.state.doc.child(i).nodeSize
  return pos - 1
}
const numbers = (ed: Editor) => Array.from(ed.view.dom.querySelectorAll<HTMLElement>('[data-type="footnote-ref"]')).map((el) => el.dataset.footnoteNumber ?? "?")
const json = (ed: Editor) => JSON.stringify(ed.state.doc.toJSON())
const stored = () => relay.api.posts.get("12")!.block_doc as BlockDocV1
const types = (doc: BlockDocV1) => doc.blocks_order.map((id) => doc.blocks[id].type)
const lists = (ed: Editor) => {
  let count = 0
  ed.state.doc.forEach((node) => {
    if (node.type.name === "footnotes") count++
  })
  return count
}

async function peers() {
  const pa = relay.client("1")
  const pb = relay.client("2")
  await Promise.all([pa.whenSynced(), pb.whenSynced()])
  const a = makeEditor(pa.doc)
  const b = makeEditor(pb.doc)
  await waitFor(() => json(a) === json(b) && b.getText().includes("Second"), { what: "both to load" })
  return { a, b, pa, pb }
}

const insertAtEnd = (ed: Editor, index: number) => {
  ed.commands.setTextSelection(endOf(ed, index))
  expect(ed.commands.insertFootnote()).toBe(true)
}

describe("footnotes with two users on the relay (#422)", () => {
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

  it("renumbers live for both when a reference is added before another", async () => {
    const { a, b } = await peers()
    insertAtEnd(a, 1)
    await waitFor(() => numbers(b).join() === "1", { what: "b to see the first number" })

    insertAtEnd(b, 0)
    await waitFor(() => numbers(a).join() === "1,2" && numbers(b).join() === "1,2", { what: "both to renumber" })
    // The later reference is A's, and it is now 2 for both: nothing was rewritten to say so.
    await waitFor(() => json(a) === json(b), { what: "convergence" })
    expect(json(a)).not.toMatch(/"number"/)
    const list = findFootnotesList(a.state.doc)!.node
    expect(list.childCount).toBe(2)
  })

  it("two people adding the first footnote at once end with one list, both notes, last", async () => {
    const { a, b } = await peers()
    // Same tick: neither has seen the other's list.
    insertAtEnd(a, 0)
    insertAtEnd(b, 1)
    a.commands.insertContent("from a")
    b.commands.insertContent("from b")

    await waitFor(() => lists(a) === 1 && lists(b) === 1 && json(a) === json(b), { what: "the store to merge the lists" })
    const list = findFootnotesList(a.state.doc)!.node
    expect(list.childCount).toBe(2)
    expect(list.textContent).toContain("from a")
    expect(list.textContent).toContain("from b")
    expect(a.state.doc.lastChild!.type.name).toBe("footnotes")
    // Every reference still has its note: the merge kept their ids.
    const ids: string[] = []
    list.forEach((note) => ids.push(note.attrs["data-block-id"]))
    for (const id of ids) expect(footnoteUses(a.state.doc).get(id)).toHaveLength(1)
    expect(numbers(a)).toEqual(["1", "2"])

    await waitFor(() => types(stored()).filter((type) => type === "footnotes").length === 1 && (stored().blocks[stored().blocks_order.at(-1)!].children ?? []).length === 2, { what: "the stored doc" })
    expect(() => validateBlockDoc(stored())).not.toThrow()
    expect(types(stored()).at(-1)).toBe("footnotes")
  })

  it("a block added after the list at the same moment ends before it", async () => {
    const { a, b } = await peers()
    insertAtEnd(a, 1)
    b.commands.insertContentAt(b.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: "late line" }] })

    await waitFor(() => a.state.doc.textContent.includes("late line") && json(a) === json(b) && a.state.doc.lastChild!.type.name === "footnotes", { what: "the list to end up last" })
    await waitFor(() => types(stored()).at(-1) === "footnotes", { what: "the stored doc" })
    expect(() => validateBlockDoc(stored())).not.toThrow()
  })

  it("a reference deleted by one user keeps its note for both, flagged; the store keeps it", async () => {
    const { a, b } = await peers()
    insertAtEnd(a, 0)
    a.commands.insertContent("the note")
    await waitFor(() => b.state.doc.textContent.includes("the note"), { what: "b to see the note" })

    const end = b.state.doc.child(0).content.size
    b.commands.deleteRange({ from: end, to: end + 1 })
    await waitFor(() => a.view.dom.querySelector(".editor-footnote.is-unreferenced") !== null, { what: "a to flag the note" })
    expect(findFootnotesList(b.state.doc)!.node.textContent).toBe("the note")
    await waitFor(() => JSON.stringify(stored()).includes("the note") && !JSON.stringify(stored()).includes("footnoteRef"), { what: "the store" })
    expect(() => validateBlockDoc(stored())).not.toThrow()
  })

  it("a note deleted by one user leaves the other's reference flagged, and stores", async () => {
    const { a, b } = await peers()
    insertAtEnd(a, 0)
    await waitFor(() => findFootnotesList(b.state.doc) !== null, { what: "b to see the list" })
    const list = findFootnotesList(b.state.doc)!
    b.view.dispatch(b.state.tr.delete(list.pos, list.pos + list.node.nodeSize))
    await waitFor(() => numbers(a).join() === "?", { what: "a's reference to show as missing" })
    await waitFor(() => JSON.stringify(stored()).includes("footnoteRef") && !JSON.stringify(stored()).includes('"footnotes"'), { what: "the store" })
    expect(() => validateBlockDoc(stored())).not.toThrow()
  })

  it("duplicating a block with a reference shares the note, one Yjs transaction, quiet afterwards", async () => {
    const { a, b, pa } = await peers()
    insertAtEnd(a, 0)
    await waitFor(() => json(a) === json(b), { what: "convergence" })
    let updates = 0
    pa.doc.on("update", () => updates++)
    duplicateBlock(a, refOf(topLevelBlockAt(a.state.doc, 0)!))
    await waitFor(() => numbers(b).join() === "1,1", { what: "b to see both references" })
    expect(updates).toBeGreaterThan(0)
    await waitFor(() => json(a) === json(b), { what: "convergence" })
    await waitFor(() => Object.values(stored().blocks).filter((block) => JSON.stringify(block).includes("footnoteRef")).length === 2, { what: "the store" })
    expect(() => validateBlockDoc(stored())).not.toThrow()
  })

  it("survive a restart, with their numbers", async () => {
    const pa = relay.client("1")
    await pa.whenSynced()
    const a = makeEditor(pa.doc)
    await waitFor(() => a.getText().includes("Second"), { what: "a to load" })
    insertAtEnd(a, 0)
    await waitFor(() => JSON.stringify(stored()).includes("footnoteRef"), { what: "the store" })

    await relay.restart()
    const pb = relay.client("2")
    await pb.whenSynced()
    const b = makeEditor(pb.doc)
    await waitFor(() => numbers(b).join() === "1", { what: "b after the restart" })
    expect(b.state.doc.lastChild!.type.name).toBe("footnotes")
  })

  it("restoring a version brings its references and notes back together, and stores valid", async () => {
    const pa = relay.client("1")
    await pa.whenSynced()
    const a = makeEditor(pa.doc)
    await waitFor(() => a.getText().includes("Second"), { what: "a to load" })
    insertAtEnd(a, 0)
    await waitFor(() => JSON.stringify(stored()).includes("footnoteRef"), { what: "the store" })

    const NOTE = "blk-0422-version-note"
    const LIST = "blk-0422-version-list"
    const version: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [P1, LIST],
      blocks: {
        [P1]: { id: P1, type: "paragraph", version: 1, attrs: { pm: { type: "paragraph", content: [{ type: "text", text: "Old" }, { type: "footnoteRef", attrs: { footnoteId: NOTE } }] }, text: "Old" } },
        [LIST]: { id: LIST, type: "footnotes", version: 1, attrs: {}, children: [NOTE] },
        [NOTE]: { id: NOTE, type: "footnote", version: 1, attrs: { pm: { type: "footnote", content: [{ type: "text", text: "old note" }] }, text: "old note" } },
      },
    } as BlockDocV1

    const status = new CollabSaveStatus(pa)
    const result = await restoreVersionLive(a, canonical(version), pa.doc, status)
    expect(result.saved).toBe(true)
    status.destroy()
    expect(numbers(a)).toEqual(["1"])
    expect(a.state.doc.lastChild!.textContent).toBe("old note")
    expect(types(stored())).toEqual(["paragraph", "footnotes"])
    expect(stored().blocks[LIST].children).toEqual([NOTE])
    expect(() => validateBlockDoc(stored())).not.toThrow()
  })
})
