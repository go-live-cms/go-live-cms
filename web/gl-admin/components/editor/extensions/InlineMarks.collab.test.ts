import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { PasteSanitizer } from "./PasteSanitizer"

// Highlight, superscript and subscript with two users on the real collab server (#418):
// a doc seeded from a block_doc that has them shows them, marks set by each user reach the
// other, the stored block_doc keeps them as Block Spec runs (no attrs), a later user and
// a reseed after a restart load the same marks, and superscript and subscript never end
// up on one run, even when two people set them on it at once.

const editors: Editor[] = []
let relay: Relay

function makeEditor(doc: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [...Object.values(schemaExtensions({ collaborating: true })), PasteSanitizer, Collaboration.configure({ document: doc })],
  })
  editors.push(editor)
  return editor
}

const FORMULA = "blk-0418-formula-0001"
const PLAIN = "blk-0418-plain-000001"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [FORMULA, PLAIN],
  blocks: {
    [FORMULA]: {
      id: FORMULA,
      type: "paragraph",
      version: 1,
      attrs: {
        text: "H2O and x2 matter",
        pm: {
          type: "paragraph",
          content: [
            { type: "text", text: "H" },
            { type: "text", text: "2", marks: [{ type: "subscript" }] },
            { type: "text", text: "O and x" },
            { type: "text", text: "2", marks: [{ type: "superscript" }] },
            { type: "text", text: " " },
            { type: "text", text: "matter", marks: [{ type: "highlight" }] },
          ],
        },
      },
    },
    [PLAIN]: { id: PLAIN, type: "paragraph", version: 1, attrs: { text: "alpha beta gamma" } },
  },
}

/** The marks on each text run of the paragraph with this id, as `[text, marks]`. */
function runs(editor: Editor, id: string): [string, string[]][] {
  let out: [string, string[]][] = []
  editor.state.doc.descendants((node) => {
    if (node.attrs["data-block-id"] !== id) return
    out = []
    node.forEach((child) => out.push([child.text ?? "", child.marks.map((mark) => mark.type.name)]))
    return false
  })
  return out
}

/** The document positions of `text` inside the paragraph with this id. */
function rangeOf(editor: Editor, id: string, text: string): { from: number; to: number } {
  let range: { from: number; to: number } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (range || node.attrs["data-block-id"] !== id) return
    const at = node.textContent.indexOf(text)
    if (at >= 0) range = { from: pos + 1 + at, to: pos + 1 + at + text.length }
    return false
  })
  if (!range) throw new Error(`no "${text}" in ${id}`)
  return range
}

const same = (a: Editor, b: Editor) => JSON.stringify(a.state.doc.toJSON()) === JSON.stringify(b.state.doc.toJSON())

/** The stored runs of a paragraph block: `[text, mark JSON]`. */
function storedRuns(doc: BlockDocV1, id: string): [string, unknown][] {
  const content = ((doc.blocks[id]?.attrs as any)?.pm?.content ?? []) as { text: string; marks?: unknown }[]
  return content.map((run) => [run.text, run.marks ?? null])
}

describe("inline marks with two users on the relay (#418)", () => {
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

  it("shows the seeded marks, merges each user's, and stores them as Block Spec runs", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("gamma"), { what: "b to load" })
    expect(runs(a, FORMULA)).toEqual([
      ["H", []],
      ["2", ["subscript"]],
      ["O and x", []],
      ["2", ["superscript"]],
      [" ", []],
      ["matter", ["highlight"]],
    ])

    // At the same time: A highlights "alpha" and makes "beta" superscript; B makes "gamma"
    // subscript, with its shortcut-less command, and unhighlights "matter".
    a.chain().setTextSelection(rangeOf(a, PLAIN, "alpha")).toggleHighlight().run()
    a.chain().setTextSelection(rangeOf(a, PLAIN, "beta")).toggleSuperscript().run()
    b.chain().setTextSelection(rangeOf(b, PLAIN, "gamma")).toggleSubscript().run()
    b.chain().setTextSelection(rangeOf(b, FORMULA, "matter")).unsetHighlight().run()

    await waitFor(() => same(a, b) && runs(a, PLAIN).length === 5 && runs(a, FORMULA).length === 5, { what: "convergence" })
    expect(runs(b, PLAIN)).toEqual([
      ["alpha", ["highlight"]],
      [" ", []],
      ["beta", ["superscript"]],
      [" ", []],
      ["gamma", ["subscript"]],
    ])
    expect(runs(a, FORMULA).at(-1)).toEqual([" matter", []])

    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(() => storedRuns(stored(), PLAIN).length === 5 && storedRuns(stored(), FORMULA).length === 5, { what: "the store" })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(storedRuns(doc, PLAIN)).toEqual([
      ["alpha", [{ type: "highlight" }]],
      [" ", null],
      ["beta", [{ type: "superscript" }]],
      [" ", null],
      ["gamma", [{ type: "subscript" }]],
    ])
    expect(storedRuns(doc, FORMULA).slice(0, 4)).toEqual([
      ["H", null],
      ["2", [{ type: "subscript" }]],
      ["O and x", null],
      ["2", [{ type: "superscript" }]],
    ])

    // A third user opening the post later gets the same marks from the server.
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.getText().includes("gamma"), { what: "c to load" })
    expect(c.state.doc.toJSON()).toEqual(a.state.doc.toJSON())
  })

  it("never leaves superscript and subscript on one run, even when set by two users at once", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("gamma"), { what: "b to load" })

    // One user: turning subscript on replaces superscript.
    a.chain().setTextSelection(rangeOf(a, PLAIN, "alpha")).toggleSuperscript().toggleSubscript().run()
    expect(runs(a, PLAIN)[0]).toEqual(["alpha", ["subscript"]])

    // Two users at once on the same word: Yjs keeps both formatting attributes and
    // y-tiptap builds that run without a check, so the editors may show both (and agree).
    // The store resolves it as ProseMirror's excludes would (subscript, the later mark),
    // so the stored doc is valid and seeds the block instead of hiding it (#213).
    a.chain().setTextSelection(rangeOf(a, PLAIN, "beta")).toggleSuperscript().run()
    b.chain().setTextSelection(rangeOf(b, PLAIN, "beta")).toggleSubscript().run()
    await waitFor(() => same(a, b) && runs(a, PLAIN).length === 4 && runs(b, PLAIN)[0]?.[1][0] === "subscript", { what: "convergence" })
    expect(runs(a, PLAIN)[2][0]).toBe("beta")

    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(() => storedRuns(stored(), PLAIN).length === 4, { what: "the store" })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(storedRuns(doc, PLAIN)).toEqual([
      ["alpha", [{ type: "subscript" }]],
      [" ", null],
      ["beta", [{ type: "subscript" }]],
      [" gamma", null],
    ])
  })

  it("seeds a stored run that has both (from before the store resolved them) without hiding its block", async () => {
    await relay.destroy()
    // Canonical first, then the bad set, so the server's own seed is what meets it.
    const both = canonical(seed)
    ;(both.blocks[FORMULA].attrs as any).pm.content[1].marks = [{ type: "superscript" }, { type: "subscript" }, { type: "highlight" }]
    relay = await startRelay({ blockDoc: both, revision: 2 })
    const pa = relay.client("1")
    await pa.whenSynced()
    const a = makeEditor(pa.doc)
    await waitFor(() => a.getText().includes("gamma"), { what: "a to load" })
    expect(runs(a, FORMULA)[1]).toEqual(["2", ["highlight", "subscript"]])
    expect(relay.api.posts.get("12")!.block_doc!.blocks_order).toEqual([FORMULA, PLAIN])
  })

  it("survives a collab server restart: the reseeded doc has the same marks", async () => {
    const pa = relay.client("1")
    await pa.whenSynced()
    const a = makeEditor(pa.doc)
    await waitFor(() => a.getText().includes("gamma"), { what: "a to load" })
    a.chain().setTextSelection(rangeOf(a, PLAIN, "beta")).toggleHighlight().toggleSubscript().run()
    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(() => storedRuns(stored(), PLAIN).length === 3, { what: "the store" })
    expect(storedRuns(stored(), PLAIN)[1]).toEqual(["beta", [{ type: "highlight" }, { type: "subscript" }]])

    await relay.restart()
    const pb = relay.client("2")
    await pb.whenSynced()
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("gamma"), { what: "b to load after the restart" })
    expect(runs(b, PLAIN)).toEqual([
      ["alpha ", []],
      ["beta", ["highlight", "subscript"]],
      [" gamma", []],
    ])
    expect(runs(b, FORMULA)[1]).toEqual(["2", ["subscript"]])
  })
})
