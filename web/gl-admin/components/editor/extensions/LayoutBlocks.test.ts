import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { DOMSerializer, type Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { validateBlockDoc } from "@gl-admin/lib/blocks-spec"
import { BlockNodeViews } from "./BlockNodeViews"
import { ButtonsKeyboard, findButtons } from "./ButtonsBlock"
import { BlockNavigationKeys, BlockSelectionKeys } from "./BlockNavigation"
import { PasteSanitizer, sanitizePastedHTML } from "./PasteSanitizer"
import { blockSpecTypeOf, deleteBlockTr, dropTargetFor, editorBlockById, moveBlockTr, removalRange, selectedBlock } from "../utils/blockTree"
import { setColumnCount } from "../utils/columnActions"
import { duplicateBlock } from "../utils/blockActions"
import { CORE_BLOCKS, menuEntries, slotAcceptsAt } from "../blocks/catalog"
import { COLUMNS_PICKER_LAYOUTS, currentColumnsPicker, openColumnsPicker } from "../ui/ColumnsPicker"
import { gutterAccepts, insertFromGutter } from "../utils/blockGutter"

// Columns, buttons and the spacer in the editor (#426): the schema and its limits, the
// commands, adding and removing a column without losing what's in it, the keys and views,
// and paste.

stubJsdomRangeLayout()

let editor: Editor | null = null

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  currentColumnsPicker()?.close({ refocus: false })
  editor?.destroy()
  editor = null
  document.body.innerHTML = ""
  vi.restoreAllMocks()
})

const COLS = "columns-aaaa-00000000"
const C1 = "column-a-aaaa-0000001"
const C2 = "column-b-aaaa-0000002"
const C3 = "column-c-aaaa-0000003"
const P1 = "para-aaaa-0000000001"
const P2 = "para-bbbb-0000000002"
const P3 = "para-cccc-0000000003"
const P4 = "para-dddd-0000000004"
const BTNS = "buttons-aaaa-00000000"
const SPACER = "spacer-aaaa-000000000"
const AFTER = "after-aaaa-0000000000"

function makeEditor(content: object | string): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  editor = new Editor({
    element,
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: false })),
      BlockNodeViews,
      ButtonsKeyboard,
      BlockSelectionKeys,
      BlockNavigationKeys,
      PasteSanitizer,
    ],
    content,
  })
  return editor
}

const para = (id: string, text?: string) => ({ type: "paragraph", attrs: { "data-block-id": id }, ...(text ? { content: [{ type: "text", text }] } : {}) })
const column = (id: string, ...content: object[]) => ({ type: "column", attrs: { "data-block-id": id }, content })

function threeColumns() {
  return {
    type: "doc",
    content: [
      { type: "columns", attrs: { "data-block-id": COLS }, content: [column(C1, para(P1, "one")), column(C2, para(P2, "two")), column(C3, para(P3, "three"), para(P4, "four"))] },
      para(AFTER, "after"),
    ],
  }
}

function buttonsDoc() {
  return {
    type: "doc",
    content: [
      {
        type: "buttons",
        attrs: { "data-block-id": BTNS },
        content: [
          { type: "button", attrs: { href: "/guide" }, content: [{ type: "text", text: "Read" }] },
          { type: "button", attrs: { variant: "secondary" }, content: [{ type: "text", text: "Log" }] },
        ],
      },
      para(AFTER, "after"),
    ],
  }
}

/** The caret at the start of the text of the block with this id, or at the start of a button. */
function caretIn(ed: Editor, id: string) {
  let at = -1
  ed.state.doc.descendants((node, pos) => {
    if (node.attrs["data-block-id"] === id) at = pos + 1
  })
  ed.commands.setTextSelection(at)
}

const startOfButton = (ed: Editor, index: number) => {
  let at = 2
  const row = ed.state.doc.child(0)
  for (let i = 0; i < index; i++) at += row.child(i).nodeSize
  return at
}

// jsdom has no ClipboardEvent; nothing on the paste path needs its clipboardData.
const pasteEvent = () => new Event("paste") as ClipboardEvent

const keydown = (ed: Editor, key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  ed.view.someProp("handleKeyDown", (f) => f(ed.view, event))
}

const columnTexts = (node: PMNode) => {
  const out: string[][] = []
  node.forEach((col) => {
    const row: string[] = []
    col.forEach((child) => row.push(child.textContent))
    out.push(row)
  })
  return out
}

describe("the schema", () => {
  it("columns hold columns; a column flow and details, never a group", () => {
    const { nodes } = makeEditor({ type: "doc", content: [{ type: "paragraph" }] }).schema
    // The count is the table's, not the schema's (y-tiptap deletes an element that fails a content check).
    expect(nodes.columns.spec.content).toBe("column+")
    expect(nodes.doc.contentMatch.matchType(nodes.columns)).toBeTruthy()
    expect(nodes.doc.contentMatch.matchType(nodes.column)).toBeNull()
    expect(nodes.group.contentMatch.matchType(nodes.columns)).toBeTruthy()
    expect(nodes.column.contentMatch.matchType(nodes.group)).toBeNull()
    expect(nodes.column.contentMatch.matchType(nodes.details)).toBeTruthy()
    expect(nodes.column.contentMatch.matchType(nodes.columns)).toBeNull()
    expect(nodes.blockquote.contentMatch.matchType(nodes.buttons)).toBeNull()
    expect(nodes.listItem.contentMatch.matchType(nodes.paragraph)!.matchType(nodes.spacer)).toBeNull()
  })

  it("a button takes no marks and no block id", () => {
    const ed = makeEditor(buttonsDoc())
    expect(ed.schema.nodes.button.spec.marks).toBe("")
    expect(ed.state.doc.child(0).child(0).attrs["data-block-id"]).toBeUndefined()
  })

  it("every container and flow block gets an id, and the doc stores as valid", () => {
    const ed = makeEditor('<div data-type="columns"><div data-type="column"><p>a</p></div><div data-type="column"><p>b</p></div></div>')
    const doc = pmToBlockDoc(ed.state.doc)
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(Object.values(doc.blocks).map((b) => b.type).sort()).toEqual(["column", "column", "columns", "paragraph", "paragraph"])
  })
})

describe("inserting (the menus)", () => {
  it("the picker's first layout makes 50 / 50 columns with the caret in the first", () => {
    const ed = makeEditor({ type: "doc", content: [para(P1, "first"), { type: "paragraph" }] })
    ed.commands.setTextSelection(ed.state.doc.child(0).nodeSize + 1)
    const picker = openColumnsPicker(ed)!
    expect(picker.element.querySelectorAll('[role="radio"]')).toHaveLength(4)
    picker.pick(0)
    expect(currentColumnsPicker()).toBeNull()
    const columns = ed.state.doc.child(1)
    expect(columns.type.name).toBe("columns")
    expect(columns.childCount).toBe(2)
    expect(columns.attrs.layout).toBe("50-50")
    expect(ed.state.selection.$from.node(ed.state.selection.$from.depth - 1).type.name).toBe("column")
  })

  it("each layout gives its count and split", () => {
    expect(COLUMNS_PICKER_LAYOUTS.map((l) => [l.label, l.count, l.layout])).toEqual([
      ["50 / 50", 2, "50-50"],
      ["33 / 33 / 33", 3, "equal"],
      ["33 / 67", 2, "33-67"],
      ["67 / 33", 2, "67-33"],
    ])
  })

  it("Esc in the picker inserts nothing", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "paragraph" }] })
    const before = ed.state.doc.toJSON()
    const picker = openColumnsPicker(ed)!
    picker.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(currentColumnsPicker()).toBeNull()
    expect(ed.state.doc.toJSON()).toEqual(before)
  })

  it("arrows walk the layouts", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "paragraph" }] })
    const picker = openColumnsPicker(ed)!
    const radios = Array.from(picker.element.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
    expect(document.activeElement).toBe(radios[0])
    picker.element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    expect(document.activeElement).toBe(radios[1])
    picker.element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
    expect(document.activeElement).toBe(radios[0])
  })

  it("the slash menu offers columns at the top and in a group, not in a column or a details", () => {
    const entries = (ed: Editor) => menuEntries({ role: "admin", accepts: slotAcceptsAt(ed) }).map((e) => e.id)
    const ed = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph" },
        { type: "group", content: [{ type: "paragraph" }] },
        { type: "columns", content: [{ type: "column", content: [{ type: "paragraph" }] }, { type: "column", content: [{ type: "paragraph" }] }] },
        { type: "details", content: [{ type: "detailsSummary" }, { type: "paragraph" }] },
      ],
    })
    ed.commands.setTextSelection(1)
    expect(entries(ed)).toEqual(expect.arrayContaining(["columns", "buttons", "spacer"]))
    ed.commands.setTextSelection(4)
    expect(entries(ed)).toContain("columns")
    expect(entries(ed)).not.toContain("group")
    // In the first column: flow and details, no group, no columns.
    ed.commands.setTextSelection(9)
    expect(ed.state.selection.$from.node(-1).type.name).toBe("column")
    expect(entries(ed)).toEqual(expect.arrayContaining(["buttons", "spacer", "details"]))
    expect(entries(ed)).not.toContain("group")
    expect(entries(ed)).not.toContain("columns")
  })

  it("the catalog's Buttons replace the line, with the caret on the new label", () => {
    const ed = makeEditor({ type: "doc", content: [para(P1, "first"), { type: "paragraph", content: [{ type: "text", text: "/but" }] }] })
    const from = ed.state.doc.child(0).nodeSize + 1
    CORE_BLOCKS.find((e) => e.id === "buttons")!.insert(ed, { from, to: from + 4 })
    expect(ed.state.doc.child(1).type.name).toBe("buttons")
    expect(ed.state.selection.$from.parent.type.name).toBe("button")
    expect(ed.state.doc.textContent).toBe("first")
  })

  it("the gutter's + on a column adds to the end of that column", () => {
    const ed = makeEditor(threeColumns())
    const ref = { id: C1, pos: 1 }
    const accepts = gutterAccepts(ed, ref)
    const spacer = CORE_BLOCKS.find((e) => e.id === "spacer")!
    const group = CORE_BLOCKS.find((e) => e.id === "group")!
    expect(accepts(spacer)).toBe(true)
    expect(accepts(group)).toBe(false)
    expect(insertFromGutter(ed, ref, spacer)).toBe(true)
    const first = ed.state.doc.child(0).child(0)
    expect(first.lastChild!.type.name).toBe("spacer")
    expect(first.firstChild!.textContent).toBe("one")
  })
})

describe("adding and removing a column", () => {
  const ref = { id: COLS, pos: 0 }

  it("adding gives an empty column and, past two, equal widths", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "columns", attrs: { layout: "33-67", "data-block-id": COLS }, content: [column(C1, para(P1, "one")), column(C2, para(P2, "two"))] }] })
    expect(setColumnCount(ed, ref, 3)).toBe(true)
    const node = ed.state.doc.child(0)
    expect(node.childCount).toBe(3)
    expect(node.attrs.layout).toBe("equal")
    expect(columnTexts(node)).toEqual([["one"], ["two"], [""]])
  })

  it("stops at the table's limits", () => {
    const ed = makeEditor(threeColumns())
    setColumnCount(ed, ref, 9)
    expect(ed.state.doc.child(0).childCount).toBe(4)
    setColumnCount(ed, ref, 1)
    expect(ed.state.doc.child(0).childCount).toBe(2)
  })

  it("removing moves the column's blocks to the last column that stays, in order, keeping their ids", () => {
    const ed = makeEditor(threeColumns())
    expect(setColumnCount(ed, ref, 2)).toBe(true)
    const node = ed.state.doc.child(0)
    expect(columnTexts(node)).toEqual([["one"], ["two", "three", "four"]])
    expect(editorBlockById(ed.state.doc, P3)).not.toBeNull()
    expect(editorBlockById(ed.state.doc, P4)).not.toBeNull()
    expect(() => ed.state.doc.check()).not.toThrow()
    expect(ed.state.doc.textContent).toBe("onetwothreefourafter")
  })

  it("is one undo step's worth of transaction, with nothing typed lost", () => {
    const ed = makeEditor(threeColumns())
    const steps: number[] = []
    ed.on("transaction", ({ transaction }) => transaction.docChanged && steps.push(1))
    setColumnCount(ed, ref, 2)
    expect(steps).toEqual([1])
  })

  it("an empty column just goes, and an empty last column gives way to the moved blocks", () => {
    const ed = makeEditor({
      type: "doc",
      content: [{ type: "columns", attrs: { "data-block-id": COLS }, content: [column(C1, para(P1, "one")), column(C2, para(P2)), column(C3, para(P3, "three"), para(P4))] }],
    })
    setColumnCount(ed, ref, 2)
    // The empty line of column 2 is replaced by column 3's text; column 3's empty line isn't carried.
    expect(columnTexts(ed.state.doc.child(0))).toEqual([["one"], ["three"]])
  })

  it("the caret leaving with the column ends up in the last one that stays", () => {
    const ed = makeEditor(threeColumns())
    caretIn(ed, P3)
    setColumnCount(ed, ref, 2)
    expect(ed.state.selection).toBeInstanceOf(TextSelection)
    expect(ed.state.selection.$from.node(ed.state.selection.$from.depth - 1).attrs["data-block-id"]).toBe(C2)
  })

  it("a selected columns block stays selected", () => {
    const ed = makeEditor(threeColumns())
    ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, 0)))
    setColumnCount(ed, ref, 2)
    expect(selectedBlock(ed.state)?.node.type.name).toBe("columns")
  })

  it("does nothing in a read-only editor", () => {
    const ed = makeEditor(threeColumns())
    ed.setEditable(false)
    expect(setColumnCount(ed, ref, 2)).toBe(false)
    expect(ed.state.doc.child(0).childCount).toBe(3)
  })
})

describe("nesting limits (moves and deletes)", () => {
  const doc = () => ({
    type: "doc",
    content: [
      { type: "columns", attrs: { "data-block-id": COLS }, content: [column(C1, para(P1, "one")), column(C2, para(P2, "two"))] },
      { type: "group", attrs: { "data-block-id": "group-aaaa-0000000000" }, content: [para("in-group-aaaa-000000", "in group")] },
      para(AFTER, "after"),
    ],
  })

  it("deleting the last block of a column leaves an empty line, the column stays", () => {
    const ed = makeEditor(doc())
    const block = editorBlockById(ed.state.doc, P1)!
    expect(removalRange(ed.state.doc, block)).toMatchObject({ fill: true })
    ed.view.dispatch(deleteBlockTr(ed.state, block)!)
    expect(columnTexts(ed.state.doc.child(0))).toEqual([[""], ["two"]])
    expect(() => ed.state.doc.check()).not.toThrow()
  })

  it("moving the last block out of a column leaves an empty line", () => {
    const ed = makeEditor(doc())
    const block = editorBlockById(ed.state.doc, P1)!
    const over = editorBlockById(ed.state.doc, P2)!
    const target = dropTargetFor(ed.state.doc, block, over, "before")!
    ed.view.dispatch(moveBlockTr(ed.state, block, target)!)
    expect(columnTexts(ed.state.doc.child(0))).toEqual([[""], ["one", "two"]])
    expect(() => ed.state.doc.check()).not.toThrow()
  })

  it("a column can't go with only two left: selected, ⌫ does nothing", () => {
    const ed = makeEditor(doc())
    const block = editorBlockById(ed.state.doc, C1)!
    expect(removalRange(ed.state.doc, block)).toBeNull()
    expect(deleteBlockTr(ed.state, block)).toBeNull()
  })

  it("a group can't be dropped into a column: it lands beside the columns", () => {
    const ed = makeEditor(doc())
    const group = editorBlockById(ed.state.doc, "group-aaaa-0000000000")!
    const over = editorBlockById(ed.state.doc, P1)!
    const target = dropTargetFor(ed.state.doc, group, over, "before")!
    expect(target.holderPos).toBe(-1)
  })

  it("a column can't be dragged out of its columns", () => {
    const ed = makeEditor(doc())
    const col = editorBlockById(ed.state.doc, C1)!
    const over = editorBlockById(ed.state.doc, AFTER)!
    expect(dropTargetFor(ed.state.doc, col, over, "before")).toBeNull()
  })

  it("duplicating a column stops at four", () => {
    const ed = makeEditor({
      type: "doc",
      content: [{ type: "columns", attrs: { "data-block-id": COLS }, content: [column(C1, para(P1, "a")), column(C2, para(P2, "b")), column(C3, para(P3, "c")), column("column-d-aaaa-0000004", para(P4, "d"))] }],
    })
    expect(duplicateBlock(ed, { id: C1, pos: 1 })).toBeNull()
    expect(ed.state.doc.child(0).childCount).toBe(4)
  })

  it("the Block Spec type names map both ways", () => {
    expect(blockSpecTypeOf("columns")).toBe("columns")
    expect(blockSpecTypeOf("buttons")).toBe("buttons")
    expect(blockSpecTypeOf("spacer")).toBe("spacer")
  })
})

describe("buttons", () => {
  it("↵ leaves the row for a new line under it", () => {
    const ed = makeEditor(buttonsDoc())
    ed.commands.setTextSelection(startOfButton(ed, 0) + 2)
    keydown(ed, "Enter")
    expect(ed.state.doc.child(1).type.name).toBe("paragraph")
    expect(ed.state.doc.child(0).childCount).toBe(2)
    expect(ed.state.selection.$from.parent).toBe(ed.state.doc.child(1))
  })

  it("⌫ at the start of a label never joins two buttons", () => {
    const ed = makeEditor(buttonsDoc())
    ed.commands.setTextSelection(startOfButton(ed, 1))
    keydown(ed, "Backspace")
    expect(ed.state.doc.child(0).childCount).toBe(2)
    expect(ed.state.selection.from).toBe(startOfButton(ed, 0) + "Read".length)
  })

  it("⌫ in an empty button removes it; in the only button it makes the row an empty line", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "buttons", content: [{ type: "button", content: [{ type: "text", text: "Keep" }] }, { type: "button" }] }, para(AFTER, "after")] })
    ed.commands.setTextSelection(startOfButton(ed, 1))
    keydown(ed, "Backspace")
    expect(ed.state.doc.child(0).childCount).toBe(1)
    const one = makeEditor({ type: "doc", content: [{ type: "buttons", content: [{ type: "button" }] }, para(AFTER, "after")] })
    one.commands.setTextSelection(startOfButton(one, 0))
    keydown(one, "Backspace")
    expect(one.state.doc.child(0).type.name).toBe("paragraph")
  })

  it("setButtonLink stores a safe href and refuses anything else", () => {
    const ed = makeEditor(buttonsDoc())
    ed.commands.setTextSelection(startOfButton(ed, 0) + 1)
    expect(ed.commands.setButtonLink("https://example.com/x")).toBe(true)
    expect(ed.state.doc.child(0).child(0).attrs.href).toBe("https://example.com/x")
    ed.commands.setButtonLink("javascript:alert(1)")
    expect(ed.state.doc.child(0).child(0).attrs.href).toBeNull()
  })

  it("the Link field checks what's typed and says why", () => {
    const ed = makeEditor(buttonsDoc())
    ed.commands.setTextSelection(startOfButton(ed, 0) + 1)
    const row = ed.view.dom.querySelector<HTMLElement>('[data-type="buttons"]')!
    ;(row.querySelector('[aria-label="Link"]') as HTMLButtonElement).click()
    const input = row.querySelector<HTMLInputElement>(".editor-buttons__link input")!
    expect(input.value).toBe("/guide")
    input.value = "javascript:alert(1)"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(row.querySelector('[role="alert"]')!.textContent).toContain("web address")
    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect(ed.state.doc.child(0).child(0).attrs.href).toBe("/guide")
    input.value = "example.com"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(ed.state.doc.child(0).child(0).attrs.href).toBe("https://example.com")
    expect(row.querySelector(".editor-buttons__link")).toBeNull()
  })

  it("Remove link clears only that button's link", () => {
    const ed = makeEditor(buttonsDoc())
    ed.commands.setTextSelection(startOfButton(ed, 0) + 1)
    const row = ed.view.dom.querySelector<HTMLElement>('[data-type="buttons"]')!
    ;(row.querySelector('[aria-label="Link"]') as HTMLButtonElement).click()
    ;(row.querySelector(".editor-buttons__link-remove") as HTMLButtonElement).click()
    expect(ed.state.doc.child(0).child(0).attrs.href).toBeNull()
    expect(ed.state.doc.child(0).child(0).textContent).toBe("Read")
  })

  it("the toolbar sets the style of the button the caret is in, and the row's alignment", () => {
    const ed = makeEditor(buttonsDoc())
    ed.commands.setTextSelection(startOfButton(ed, 1) + 1)
    const row = ed.view.dom.querySelector<HTMLElement>('[data-type="buttons"]')!
    ;(row.querySelector('[data-value="primary"]') as HTMLButtonElement).click()
    expect(ed.state.doc.child(0).child(1).attrs.variant).toBe("primary")
    expect(ed.state.doc.child(0).child(0).attrs.variant).toBe("primary")
    ;(row.querySelector('[data-value="center"]') as HTMLButtonElement).click()
    expect(ed.state.doc.child(0).attrs.align).toBe("center")
    expect(row.dataset.align).toBe("center")
  })

  it("the toolbar follows the caret between buttons, and an open Link field closes", () => {
    const ed = makeEditor(buttonsDoc())
    ed.commands.setTextSelection(startOfButton(ed, 0) + 1)
    const row = ed.view.dom.querySelector<HTMLElement>('[data-type="buttons"]')!
    const pressed = () => row.querySelector('[aria-label="Button style"] [aria-pressed="true"]')!.textContent
    expect(pressed()).toBe("Primary")
    ;(row.querySelector('[aria-label="Link"]') as HTMLButtonElement).click()
    expect(row.querySelector(".editor-buttons__link")).not.toBeNull()
    ed.commands.setTextSelection(startOfButton(ed, 1) + 1)
    expect(pressed()).toBe("Secondary")
    expect(row.querySelector(".editor-buttons__link")).toBeNull()
  })

  it("Add button adds a secondary one after the current one, with the caret in it", () => {
    const ed = makeEditor(buttonsDoc())
    ed.commands.setTextSelection(startOfButton(ed, 0) + 1)
    ed.commands.addButton()
    const row = ed.state.doc.child(0)
    expect(row.childCount).toBe(3)
    expect(row.child(1).attrs.variant).toBe("secondary")
    expect(ed.state.selection.$from.parent).toBe(row.child(1))
  })

  it("the toolbar acts on the first button when the row is selected, and the row stays selected", () => {
    const ed = makeEditor(buttonsDoc())
    ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, 0)))
    ed.commands.setButtonVariant("secondary")
    expect(ed.state.doc.child(0).child(0).attrs.variant).toBe("secondary")
    expect(findButtons(ed.state)?.pos).toBe(0)
    expect(ed.state.selection).toBeInstanceOf(NodeSelection)
  })

  it("the DOM never has a live link, and a bad href in the doc never reaches it", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "buttons", content: [{ type: "button", attrs: { href: "javascript:alert(1)" }, content: [{ type: "text", text: "X" }] }] }] })
    expect(ed.view.dom.querySelector("a")).toBeNull()
    expect(ed.view.dom.innerHTML).not.toContain("javascript")
    const serialized = DOMSerializer.fromSchema(ed.schema).serializeFragment(ed.state.doc.content)
    const holder = document.createElement("div")
    holder.append(serialized)
    expect(holder.innerHTML).not.toContain("javascript")
  })
})

describe("the spacer", () => {
  const spacerDoc = (size = "7") => ({ type: "doc", content: [para(P1, "above"), { type: "spacer", attrs: { "data-block-id": SPACER, size } }, para(AFTER, "below")] })
  const dom = (ed: Editor) => ed.view.dom.querySelector<HTMLElement>('[data-type="spacer"]')!
  const handle = (ed: Editor) => dom(ed).querySelector<HTMLButtonElement>(".editor-spacer__handle")!

  it("shows the theme step's height and says so on its handle", () => {
    const ed = makeEditor(spacerDoc("8"))
    expect(dom(ed).style.height).toBe("64px")
    expect(dom(ed).querySelector(".editor-spacer__label")!.textContent).toBe("64 px")
    expect(handle(ed).getAttribute("aria-label")).toBe("Spacer height: 64 px. Up and down arrows change it")
  })

  it("↑ ↓ on the handle change one step and stop at the ends", () => {
    const ed = makeEditor(spacerDoc("8"))
    const press = (key: string) => handle(ed).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
    press("ArrowUp")
    expect(ed.state.doc.child(1).attrs.size).toBe("9")
    press("ArrowUp")
    expect(ed.state.doc.child(1).attrs.size).toBe("9")
    press("ArrowDown")
    press("ArrowDown")
    press("ArrowDown")
    expect(ed.state.doc.child(1).attrs.size).toBe("5")
    press("ArrowDown")
    expect(ed.state.doc.child(1).attrs.size).toBe("5")
  })

  it("does nothing in a read-only editor", () => {
    const ed = makeEditor(spacerDoc())
    ed.setEditable(false)
    handle(ed).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }))
    expect(ed.state.doc.child(1).attrs.size).toBe("7")
  })

  it("is selected on Tab's way to the handle: its toolbar is the handle", () => {
    const ed = makeEditor(spacerDoc())
    const toolbar = dom(ed).querySelector("[data-block-toolbar]")!
    expect(toolbar.querySelector("button")).toBe(handle(ed))
  })

  it("is one setNodeMarkup per step, and stores the step, not px", () => {
    const ed = makeEditor(spacerDoc("5"))
    ed.commands.setSpacerSize(ed.state.doc.child(0).nodeSize, "9")
    expect(pmToBlockDoc(ed.state.doc).blocks[SPACER].attrs).toEqual({ size: "9" })
    expect(ed.commands.setSpacerSize(0, "9")).toBe(false)
  })
})

describe("the columns' toolbar", () => {
  it("shows the column count and hides Layout unless there are two", () => {
    const ed = makeEditor(threeColumns())
    const root = ed.view.dom.querySelector<HTMLElement>('[data-type="columns"]')!
    expect(root.querySelector('[data-value="3"]')!.getAttribute("aria-pressed")).toBe("true")
    const layoutField = root.querySelector<HTMLElement>('[aria-label="Columns layout"]')!
    expect(layoutField.hidden).toBe(true)
    ;(root.querySelector('[data-value="2"]') as HTMLButtonElement).click()
    expect(ed.state.doc.child(0).childCount).toBe(2)
    expect(layoutField.hidden).toBe(false)
    ;(root.querySelector('[data-value="33-67"]') as HTMLButtonElement).click()
    expect(ed.state.doc.child(0).attrs.layout).toBe("33-67")
    expect(root.dataset.layout).toBe("33-67")
    ;(root.querySelector('[data-value="full"]') as HTMLButtonElement).click()
    expect(ed.state.doc.child(0).attrs.align).toBe("full")
  })

  it("does nothing when read-only", () => {
    const ed = makeEditor(threeColumns())
    ed.setEditable(false)
    ;(ed.view.dom.querySelector('[data-value="2"]') as HTMLButtonElement).click()
    expect(ed.state.doc.child(0).childCount).toBe(3)
  })

  it("Tab reaches the toolbar's first control through data-block-toolbar", () => {
    const ed = makeEditor(threeColumns())
    const root = ed.view.dom.querySelector<HTMLElement>('[data-type="columns"]')!
    expect(Array.from(root.children).some((child) => child.hasAttribute("data-block-toolbar"))).toBe(true)
  })

  it("Esc inside columns selects the column, then the columns, then stops", () => {
    const ed = makeEditor(threeColumns())
    caretIn(ed, P1)
    const esc = () => ed.view.someProp("handleKeyDown", (f) => f(ed.view, new KeyboardEvent("keydown", { key: "Escape" })))
    esc()
    expect(selectedBlock(ed.state)?.node.attrs["data-block-id"]).toBe(P1)
    esc()
    expect(selectedBlock(ed.state)?.node.attrs["data-block-id"]).toBe(C1)
    esc()
    expect(selectedBlock(ed.state)?.node.attrs["data-block-id"]).toBe(COLS)
  })
})

describe("paste", () => {
  it("keeps columns, buttons and a spacer from the editor's own clipboard, with valid values only", () => {
    const out = sanitizePastedHTML(
      '<div data-type="columns" data-layout="33-67" data-align="wide" data-block-id="x"><div data-type="column"><p>a</p></div></div>' +
        '<div data-type="buttons" data-align="center"><div data-type="button" data-href="/ok" data-variant="secondary">Go</div></div>' +
        '<div data-type="spacer" data-size="9"></div>',
    )
    expect(out).toContain('data-layout="33-67"')
    expect(out).toContain('data-align="wide"')
    expect(out).toContain('data-href="/ok"')
    expect(out).toContain('data-variant="secondary"')
    expect(out).toContain('data-size="9"')
    expect(out).not.toContain("data-block-id")
  })

  it("drops an unsafe href, and values on the wrong element", () => {
    const out = sanitizePastedHTML(
      '<div data-type="button" data-href="javascript:alert(1)" data-variant="huge">Go</div><div data-layout="33-67" data-size="9" data-href="/x">t</div><div data-type="columns" data-layout="nope" data-align="center"></div>',
    )
    expect(out).not.toContain("javascript")
    expect(out).not.toContain("data-variant")
    expect(out).not.toContain("data-layout")
    expect(out).not.toContain("data-size")
    expect(out).not.toContain("data-href")
    expect(out).not.toContain("data-align")
  })

  it("a pasted row of columns is columns again, with fresh ids", () => {
    const ed = makeEditor({ type: "doc", content: [para(P1, "first"), para(AFTER, "after")] })
    ed.commands.setTextSelection(ed.state.doc.child(0).nodeSize + 1)
    ed.view.pasteHTML(
      `<div data-type="columns" data-layout="33-67" data-block-id="${COLS}"><div data-type="column" data-block-id="${C1}"><p data-block-id="${P1}">x</p></div><div data-type="column"><p>y</p></div></div>`,
      pasteEvent(),
    )
    const pasted = ed.state.doc.child(1)
    expect(pasted.type.name).toBe("columns")
    expect(pasted.attrs.layout).toBe("33-67")
    expect(pasted.attrs["data-block-id"]).not.toBe(COLS)
    expect(pasted.child(0).attrs["data-block-id"]).not.toBe(C1)
    expect(() => ed.state.doc.check()).not.toThrow()
  })

  it("a lone column has nothing to be a column of", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "paragraph" }] })
    ed.view.pasteHTML('<div data-type="column"><p>x</p></div>', pasteEvent())
    expect(ed.state.doc.textContent).toBe("x")
    let columns = 0
    ed.state.doc.descendants((node) => {
      if (node.type.name === "column") columns++
    })
    expect(columns).toBe(0)
  })
})
