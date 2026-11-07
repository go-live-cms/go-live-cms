import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { DOMSerializer, type Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { isBlockNode, TEXT_PART_NODE_NAMES, validateBlockDoc } from "@gl-admin/lib/blocks-spec"
import { BlockNodeViews } from "./BlockNodeViews"
import { DetailsKeyboard } from "./DetailsBlock"
import { BlockNavigationKeys, BlockSelectionKeys } from "./BlockNavigation"
import { PasteSanitizer, sanitizePastedHTML } from "./PasteSanitizer"
import { duplicateBlock } from "../utils/blockActions"
import { childBlocks, editorBlockAtSelection, removalRange } from "../utils/blockTree"
import { CORE_BLOCKS, menuEntries, slotAcceptsAt } from "../blocks/catalog"

// The Details block in the editor (#421): the schema (the summary is a part, the blocks
// are blocks), its commands and keys (↵ from the summary into the content, ⌫ never deletes
// the summary on its own, #417's keys inside it), its view (Open by default), paste, and
// fresh unique ids for every nested block after a split, a duplicate and a paste.

let editor: Editor | null = null

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  editor?.destroy()
  editor = null
  document.body.innerHTML = ""
  vi.restoreAllMocks()
})

const DETAILS = "details-aaaa-00000000"
const INNER = "inner-aaaa-0000000000"
const SECOND = "secnd-aaaa-0000000000"
const AFTER = "after-aaaa-0000000000"

function makeEditor(content: object): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  editor = new Editor({
    element,
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: false })),
      BlockNodeViews,
      DetailsKeyboard,
      BlockSelectionKeys,
      BlockNavigationKeys,
      PasteSanitizer,
    ],
    content,
  })
  return editor
}

function detailsDoc(open = false) {
  return {
    type: "doc",
    content: [
      {
        type: "details",
        attrs: { "data-block-id": DETAILS, open },
        content: [
          { type: "detailsSummary", content: [{ type: "text", text: "Can contributors publish?" }] },
          { type: "paragraph", attrs: { "data-block-id": INNER }, content: [{ type: "text", text: "No." }] },
          { type: "paragraph", attrs: { "data-block-id": SECOND }, content: [{ type: "text", text: "An editor does." }] },
        ],
      },
      { type: "paragraph", attrs: { "data-block-id": AFTER }, content: [{ type: "text", text: "after" }] },
    ],
  }
}

/** Positions in detailsDoc(): the summary's text starts at 2, the first block at its end + 2. */
const SUMMARY_START = 2
const SUMMARY_END = SUMMARY_START + "Can contributors publish?".length
const FIRST_BLOCK_START = SUMMARY_END + 2

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

function expectUniqueValidIds(doc: PMNode) {
  const ids = blockIds(doc)
  for (const id of ids) expect(typeof id === "string" && id.length >= 10, String(id)).toBe(true)
  expect(new Set(ids).size).toBe(ids.length)
  expect(() => validateBlockDoc(pmToBlockDoc(doc))).not.toThrow()
}

/** A real keydown on the editor (ProseMirror's keymaps), whether a handler took it. */
function press(ed: Editor, key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  ed.view.dom.dispatchEvent(event)
  return event.defaultPrevented
}

const caretParent = (ed: Editor) => ed.state.selection.$from.parent

const pasteEvent = () => new Event("paste") as ClipboardEvent

describe("Details in the schema (#421)", () => {
  it("is a container the doc and a group hold; its first child is the summary, then flow blocks", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "paragraph" }] })
    const { nodes } = ed.schema
    expect(nodes.details.spec.content).toBe("detailsSummary (block | tableBlock)+")
    expect(nodes.details.spec.group).toBeUndefined()
    expect(nodes.doc.contentMatch.matchType(nodes.details)).toBeTruthy()
    expect(nodes.group.contentMatch.matchType(nodes.details)).toBeTruthy()
    expect(nodes.blockquote.contentMatch.matchType(nodes.details)).toBeNull()
    expect(nodes.listItem.contentMatch.matchType(nodes.paragraph)!.matchType(nodes.details)).toBeNull()
    // No details or group inside a details (the table is acyclic).
    const afterSummary = nodes.details.contentMatch.matchType(nodes.detailsSummary)!
    expect(afterSummary.matchType(nodes.details)).toBeNull()
    expect(afterSummary.matchType(nodes.group)).toBeNull()
    expect(afterSummary.matchType(nodes.tableBlock)).toBeTruthy()
    expect(afterSummary.matchType(nodes.image)).toBeTruthy()
    // The summary can't be left out, or come second.
    expect(nodes.details.contentMatch.matchType(nodes.paragraph)).toBeNull()
    expect(nodes.details.spec.isolating).toBe(true)
    // The summary: rich text with the caption marks, a part (never a block, never an id).
    expect(nodes.detailsSummary.spec.marks).toBe("bold italic link")
    expect(nodes.detailsSummary.spec.selectable).toBe(false)
    expect(isBlockNode("detailsSummary", "details")).toBe(false)
    expect(isBlockNode("paragraph", "details")).toBe(true)
    expect(TEXT_PART_NODE_NAMES.has("detailsSummary")).toBe(true)
    expect("data-block-id" in (nodes.detailsSummary.spec.attrs ?? {})).toBe(false)
    expect(nodes.details.spec.attrs).toHaveProperty("open")
  })

  it("open defaults to false, and only a stored true is open", () => {
    const ed = makeEditor(detailsDoc())
    expect(ed.state.doc.child(0).attrs.open).toBe(false)
    const open = makeEditor(detailsDoc(true))
    expect(open.state.doc.child(0).attrs.open).toBe(true)
  })
})

describe("Details commands", () => {
  it("setDetails turns an empty line into a details with an empty summary and paragraph, caret in the summary", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "paragraph" }] })
    ed.commands.setTextSelection(1)
    expect(ed.commands.setDetails()).toBe(true)
    const details = ed.state.doc.child(0)
    expect(details.type.name).toBe("details")
    expect(details.childCount).toBe(2)
    expect(details.child(0).type.name).toBe("detailsSummary")
    expect(details.child(1).type.name).toBe("paragraph")
    expect(caretParent(ed).type.name).toBe("detailsSummary")
    expectUniqueValidIds(ed.state.doc)
  })

  it("setDetails makes the line the details' first block, keeping its text and id", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "paragraph", attrs: { "data-block-id": INNER }, content: [{ type: "text", text: "hello" }] }] })
    ed.commands.setTextSelection(3)
    expect(ed.commands.setDetails()).toBe(true)
    const details = ed.state.doc.child(0)
    expect(details.child(1).textContent).toBe("hello")
    expect(details.child(1).attrs["data-block-id"]).toBe(INNER)
    expect(caretParent(ed).type.name).toBe("detailsSummary")
    expectUniqueValidIds(ed.state.doc)
  })

  it("setDetails works inside a group, refuses inside a details, and wraps a whole quote (not its paragraph)", () => {
    const grouped = makeEditor({ type: "doc", content: [{ type: "group", content: [{ type: "paragraph", content: [{ type: "text", text: "in" }] }] }] })
    grouped.commands.setTextSelection(3)
    expect(grouped.commands.setDetails()).toBe(true)
    expect(grouped.state.doc.child(0).child(0).type.name).toBe("details")
    const nested = makeEditor(detailsDoc())
    nested.commands.setTextSelection(FIRST_BLOCK_START + 1)
    expect(nested.can().setDetails()).toBe(false)
    const quote = makeEditor({ type: "doc", content: [{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "q" }] }] }] })
    quote.commands.setTextSelection(2)
    expect(quote.commands.setDetails()).toBe(true)
    expect(quote.state.doc.child(0).child(1).type.name).toBe("blockquote")
    // The menus don't offer it in the quote's own content, though (slotAcceptsAt).
    const q2 = makeEditor({ type: "doc", content: [{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "q" }] }] }] })
    q2.commands.setTextSelection(2)
    expect(menuEntries({ role: "admin" }).filter(slotAcceptsAt(q2)).map((e) => e.id)).not.toContain("details")
  })

  it("setDetailsOpen sets Open by default from the summary, a nested block or the selected details", () => {
    const ed = makeEditor(detailsDoc())
    ed.commands.setTextSelection(SUMMARY_START + 1)
    expect(ed.commands.setDetailsOpen(true)).toBe(true)
    expect(ed.state.doc.child(0).attrs.open).toBe(true)
    ed.commands.setTextSelection(FIRST_BLOCK_START + 1)
    ed.commands.setDetailsOpen(false)
    expect(ed.state.doc.child(0).attrs.open).toBe(false)
    ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, 0)))
    ed.commands.setDetailsOpen(true)
    expect(ed.state.doc.child(0).attrs.open).toBe(true)
    // A selected details stays selected.
    expect(ed.state.selection).toBeInstanceOf(NodeSelection)
    ed.commands.setTextSelection(ed.state.doc.content.size - 2)
    expect(ed.can().setDetailsOpen(true)).toBe(false)
  })

  it("the catalog's Details is a Text entry the slash menu offers where a details can go", () => {
    const entry = CORE_BLOCKS.find((e) => e.id === "details")!
    expect(entry).toMatchObject({ type: "details", name: "Details", group: "text" })
    const ed = makeEditor(detailsDoc())
    // Inside a details: no details (and no group) offered.
    ed.commands.setTextSelection(FIRST_BLOCK_START + 1)
    const inside = menuEntries({ role: "admin" }).filter(slotAcceptsAt(ed))
    expect(inside.map((e) => e.id)).not.toContain("details")
    expect(inside.map((e) => e.id)).not.toContain("group")
    expect(inside.map((e) => e.id)).toContain("table")
    // At the top level it is.
    ed.commands.setTextSelection(ed.state.doc.content.size - 2)
    expect(menuEntries({ role: "admin" }).filter(slotAcceptsAt(ed)).map((e) => e.id)).toContain("details")
  })

  it("the catalog's insert replaces the typed /query on an empty line", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "/det" }] }] })
    CORE_BLOCKS.find((e) => e.id === "details")!.insert(ed, { from: 1, to: 5 })
    expect(ed.state.doc.child(0).type.name).toBe("details")
    expect(ed.state.doc.child(0).textContent).toBe("")
  })
})

describe("Details keys (#421, the canvas's Keyboard)", () => {
  it("↵ at the end of the summary moves into the content; the summary never splits", () => {
    const ed = makeEditor(detailsDoc())
    ed.commands.setTextSelection(SUMMARY_END)
    expect(press(ed, "Enter")).toBe(true)
    expect(caretParent(ed).attrs["data-block-id"]).toBe(INNER)
    expect(ed.state.selection.$from.parentOffset).toBe(0)
    expect(ed.state.doc.child(0).child(0).textContent).toBe("Can contributors publish?")
    // In the middle too: never two summaries.
    ed.commands.setTextSelection(SUMMARY_START + 3)
    press(ed, "Enter")
    expect(ed.state.doc.child(0).childCount).toBe(3)
    expect(ed.state.doc.child(0).child(0).textContent).toBe("Can contributors publish?")
  })

  it("↵ over a selection in the summary replaces it, then moves into the content", () => {
    const ed = makeEditor(detailsDoc())
    // "contributors " selected.
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, SUMMARY_START + 4, SUMMARY_START + 17)))
    expect(press(ed, "Enter")).toBe(true)
    expect(ed.state.doc.child(0).child(0).textContent).toBe("Can publish?")
    expect(caretParent(ed).attrs["data-block-id"]).toBe(INNER)
    expect(ed.state.selection.$from.parentOffset).toBe(0)
  })

  it("↵ in the summary adds an empty paragraph when the first block isn't text", () => {
    const ed = makeEditor({
      type: "doc",
      content: [
        {
          type: "details",
          content: [
            { type: "detailsSummary", content: [{ type: "text", text: "Q" }] },
            { type: "horizontalRule" },
          ],
        },
      ],
    })
    ed.commands.setTextSelection(3)
    expect(press(ed, "Enter")).toBe(true)
    const details = ed.state.doc.child(0)
    expect(details.child(1).type.name).toBe("paragraph")
    expect(details.child(2).type.name).toBe("horizontalRule")
    expect(caretParent(ed).type.name).toBe("paragraph")
    expectUniqueValidIds(ed.state.doc)
  })

  it("⌫ at the start of the summary deletes nothing; at the start of the first block it goes back to the summary", () => {
    const ed = makeEditor(detailsDoc())
    const before = ed.state.doc
    ed.commands.setTextSelection(SUMMARY_START)
    expect(press(ed, "Backspace")).toBe(true)
    expect(ed.state.doc.eq(before)).toBe(true)
    ed.commands.setTextSelection(FIRST_BLOCK_START)
    expect(press(ed, "Backspace")).toBe(true)
    expect(ed.state.doc.eq(before)).toBe(true)
    expect(caretParent(ed).type.name).toBe("detailsSummary")
    expect(ed.state.selection.from).toBe(SUMMARY_END)
  })

  it("⌫ in an empty first block removes it (not the only one) and goes to the summary", () => {
    const ed = makeEditor({
      type: "doc",
      content: [
        {
          type: "details",
          content: [
            { type: "detailsSummary", content: [{ type: "text", text: "Q" }] },
            { type: "paragraph" },
            { type: "paragraph", content: [{ type: "text", text: "A" }] },
          ],
        },
      ],
    })
    ed.commands.setTextSelection(5)
    press(ed, "Backspace")
    expect(ed.state.doc.child(0).childCount).toBe(2)
    expect(ed.state.doc.child(0).child(1).textContent).toBe("A")
    expect(caretParent(ed).type.name).toBe("detailsSummary")
  })

  it("⌫ in the empty summary of an empty details removes the whole details", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "paragraph" }] })
    ed.commands.setTextSelection(1)
    ed.commands.setDetails()
    expect(press(ed, "Backspace")).toBe(true)
    const names: string[] = []
    ed.state.doc.forEach((node) => names.push(node.type.name))
    expect(names.every((name) => name === "paragraph")).toBe(true)
    expect(caretParent(ed).type.name).toBe("paragraph")
  })

  it("selecting across the summary and deleting keeps a summary (the schema requires it)", () => {
    const ed = makeEditor(detailsDoc())
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, SUMMARY_START, FIRST_BLOCK_START + 2)))
    press(ed, "Backspace")
    const details = ed.state.doc.child(0)
    expect(details.type.name).toBe("details")
    expect(details.child(0).type.name).toBe("detailsSummary")
    expect(() => details.check()).not.toThrow()
  })

  it("#417's keys work inside it: Esc in the summary selects the details, ↵ steps into its first block, ↑↓ move", () => {
    const ed = makeEditor(detailsDoc())
    ed.commands.setTextSelection(SUMMARY_START + 1)
    expect(editorBlockAtSelection(ed.state)?.node.type.name).toBe("details")
    press(ed, "Escape")
    expect(ed.state.selection).toBeInstanceOf(NodeSelection)
    expect((ed.state.selection as NodeSelection).node.type.name).toBe("details")
    press(ed, "Enter")
    expect((ed.state.selection as NodeSelection).node.attrs["data-block-id"]).toBe(INNER)
    press(ed, "ArrowDown")
    expect((ed.state.selection as NodeSelection).node.attrs["data-block-id"]).toBe(SECOND)
    // The summary is never one of its blocks.
    const details = editorBlockAtSelection(ed.state.apply(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, 0))))!
    expect(childBlocks(ed.state.doc, details).map((b) => b.node.attrs["data-block-id"])).toEqual([INNER, SECOND])
  })

  it("deleting its last block removes the details with it", () => {
    const ed = makeEditor({
      type: "doc",
      content: [
        { type: "details", content: [{ type: "detailsSummary" }, { type: "paragraph", content: [{ type: "text", text: "only" }] }] },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    })
    ed.commands.setTextSelection(4)
    const block = editorBlockAtSelection(ed.state)!
    expect(removalRange(ed.state.doc, block)).toEqual({ from: 0, to: ed.state.doc.child(0).nodeSize })
  })
})

describe("Details ids (#238)", () => {
  it("BlockIdExtension stamps the details and every block in it, never the summary", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "paragraph" }] })
    ed.commands.setTextSelection(1)
    ed.commands.setDetails()
    const details = ed.state.doc.child(0)
    expect(typeof details.attrs["data-block-id"]).toBe("string")
    expect(details.child(1).attrs["data-block-id"]).toEqual(expect.any(String))
    expect(details.child(0).attrs["data-block-id"]).toBeUndefined()
    expectUniqueValidIds(ed.state.doc)
  })

  it("a split inside a details gives the new block a fresh id", () => {
    const ed = makeEditor(detailsDoc())
    ed.commands.setTextSelection(FIRST_BLOCK_START + 2)
    ed.commands.splitBlock()
    expect(ed.state.doc.child(0).childCount).toBe(4)
    expect(ed.state.doc.child(0).child(1).attrs["data-block-id"]).toBe(INNER)
    expectUniqueValidIds(ed.state.doc)
  })

  it("Duplicate (#356) copies the details with fresh ids for it and every block in it", () => {
    const ed = makeEditor(detailsDoc(true))
    expect(duplicateBlock(ed, { id: DETAILS, pos: 0 })).toBeTruthy()
    expect(ed.state.doc.child(1).type.name).toBe("details")
    expect(ed.state.doc.child(1).attrs.open).toBe(true)
    expect(ed.state.doc.child(1).child(0).textContent).toBe("Can contributors publish?")
    expectUniqueValidIds(ed.state.doc)
  })

  it("pasting a whole details (the editor's own clipboard) keeps the summary, open and the blocks, with fresh ids", () => {
    const ed = makeEditor(detailsDoc(true))
    const end = ed.state.doc.child(0).nodeSize
    const wrap = document.createElement("div")
    wrap.append(DOMSerializer.fromSchema(ed.schema).serializeFragment(ed.state.doc.slice(0, end).content))
    ;(wrap.firstElementChild as HTMLElement).setAttribute("data-pm-slice", "0 0 []")
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, ed.state.doc.content.size - 1)))
    ed.view.pasteHTML(wrap.innerHTML, pasteEvent())
    const all: PMNode[] = []
    ed.state.doc.forEach((node) => node.type.name === "details" && all.push(node))
    expect(all).toHaveLength(2)
    expect(all[1].attrs.open).toBe(true)
    expect(all[1].child(0).textContent).toBe("Can contributors publish?")
    expect(all[1].attrs["data-block-id"]).not.toBe(DETAILS)
    expectUniqueValidIds(ed.state.doc)
  })

  it("pasting a slice copied from inside a details recreates a valid details (a summary filled in) with no copied ids", () => {
    const ed = makeEditor(detailsDoc(true))
    // The first block, as ProseMirror copies it: the details is its slice context.
    const context = JSON.stringify(["details", { open: true, "data-block-id": DETAILS }])
    const html = `<p data-pm-slice='1 1 ${context}' data-block-id="${INNER}">No.</p>`
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, ed.state.doc.content.size - 1)))
    ed.view.pasteHTML(html, pasteEvent())
    expect(() => ed.state.doc.check()).not.toThrow()
    ed.state.doc.forEach((node) => {
      if (node.type.name === "details") expect(node.child(0).type.name).toBe("detailsSummary")
    })
    expectUniqueValidIds(ed.state.doc)
    expect(blockIds(ed.state.doc).filter((id) => id === INNER || id === DETAILS)).toHaveLength(2)
  })

  it("pasting a page's <details open><summary> makes a details", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "paragraph" }] })
    ed.commands.setTextSelection(1)
    ed.view.pasteHTML("<details open><p>Answer</p><summary>Question <b>here</b></summary></details>", pasteEvent())
    let details: PMNode | null = null
    ed.state.doc.forEach((node) => {
      if (node.type.name === "details") details = node
    })
    expect(details).not.toBeNull()
    const found = details as unknown as PMNode
    expect(found.attrs.open).toBe(true)
    expect(found.child(0).textContent).toBe("Question here")
    expect(found.child(0).child(1).marks.map((m) => m.type.name)).toEqual(["bold"])
    expect(found.child(1).textContent).toBe("Answer")
    expectUniqueValidIds(ed.state.doc)
  })
})

describe("paste sanitizer and details (#128)", () => {
  const out = (html: string) => sanitizePastedHTML(html)

  it("turns <details>/<summary> into the editor's markup, open as data-open", () => {
    expect(out("<details open><summary>Q</summary><p>A</p></details>")).toBe(
      '<div data-type="details" data-open="true"><div data-type="details-summary">Q</div><p>A</p></div>',
    )
    expect(out("<details><p>A</p></details>")).toBe('<div data-type="details"><p>A</p></div>')
    // A stray <summary> is a plain div.
    expect(out("<summary>alone</summary>")).toBe("<div>alone</div>")
  })

  it("keeps data-open only as true on a details div, and details as a slice context with attrs reset", () => {
    expect(out('<div data-type="details" data-open="yes"><p>a</p></div>')).toBe('<div data-type="details"><p>a</p></div>')
    expect(out('<p data-open="true">a</p>')).toBe("<p>a</p>")
    const ctx = JSON.stringify(["details", { open: true, "data-block-id": DETAILS }])
    const slice = new DOMParser().parseFromString(out(`<p data-pm-slice='1 1 ${ctx}'>a</p>`), "text/html").body.firstElementChild!
    expect(slice.getAttribute("data-pm-slice")).toBe('1 1 ["details",null]')
  })
})

describe("the details' view (#421)", () => {
  it("its Open by default switch sets the attr and shows it; the toolbar shows while the cursor is in it", () => {
    const ed = makeEditor(detailsDoc())
    const dom = ed.view.dom.querySelector<HTMLElement>(".editor-details")!
    expect(dom.dataset.open).toBe("false")
    expect(dom.getAttribute("data-block-id")).toBe(DETAILS)
    const toggle = dom.querySelector<HTMLButtonElement>(".editor-details__switch")!
    expect(toggle.getAttribute("role")).toBe("switch")
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(toggle.closest("[data-block-toolbar]")).not.toBeNull()
    ed.commands.setTextSelection(FIRST_BLOCK_START + 1)
    expect(dom.classList.contains("has-selection")).toBe(true)
    toggle.click()
    expect(ed.state.doc.child(0).attrs.open).toBe(true)
    expect(dom.dataset.open).toBe("true")
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    // The editor always shows the blocks.
    expect(dom.querySelector(".editor-details__content")!.textContent).toContain("No.")
  })

  it("the switch does nothing when the editor isn't editable", () => {
    const ed = makeEditor(detailsDoc())
    ed.setEditable(false)
    ed.view.dom.querySelector<HTMLButtonElement>(".editor-details__switch")!.click()
    expect(ed.state.doc.child(0).attrs.open).toBe(false)
  })

  it("Esc on the toolbar selects the details", () => {
    const ed = makeEditor(detailsDoc())
    const toggle = ed.view.dom.querySelector<HTMLButtonElement>(".editor-details__switch")!
    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(ed.state.selection).toBeInstanceOf(NodeSelection)
    expect((ed.state.selection as NodeSelection).from).toBe(0)
  })
})
