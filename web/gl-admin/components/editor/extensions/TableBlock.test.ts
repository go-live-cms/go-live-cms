import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import { CellSelection } from "@tiptap/pm/tables"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { TABLE_MAX_COLUMNS, validateBlockDoc } from "@gl-admin/lib/blocks-spec"
import { BlockNodeViews } from "./BlockNodeViews"
import { PasteSanitizer, sanitizePastedHTML } from "./PasteSanitizer"
import { hasHeaderRowHTML, TableKeyboard } from "./TableBlock"
import { CORE_BLOCKS, slotAcceptsAt } from "../blocks/catalog"
import { currentTableSizePicker, openTableSizePicker, parseTableSize } from "../ui/TableSizePicker"

// The table block in the editor (#420): insert with the size picker, rows and columns,
// the header row, Tab / ⇧Tab between cells (only in a cell), the toolbar, where the schema
// lets a table go, and paste from a web page or Google Docs into a table with paragraph
// cells.

stubJsdomRangeLayout()

let editor: Editor | null = null

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  currentTableSizePicker()?.close({ refocus: false })
  editor?.destroy()
  editor = null
  vi.restoreAllMocks()
})

function makeEditor(content: string | object): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  editor = new Editor({
    element,
    extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockNodeViews, PasteSanitizer, TableKeyboard],
    content,
  })
  return editor
}

const types = (ed: Editor) => {
  const out: string[] = []
  ed.state.doc.forEach((node) => out.push(node.type.name))
  return out
}

/** The first table block's grid as cell types (`th`/`td`) and as cell texts. */
const gridOf = (ed: Editor): PMNode => {
  let grid: PMNode | null = null
  ed.state.doc.descendants((node) => {
    if (!grid && node.type.name === "table") grid = node
    return !grid
  })
  if (!grid) throw new Error("no table")
  return grid
}
const rowsOf = (grid: PMNode) => Array.from({ length: grid.childCount }, (_, r) => grid.child(r))
/** "th" for a cell of the header row (the grid's `headerRow`), "td" for the others; every cell node is a tableCell. */
const cellTypes = (ed: Editor) => {
  const grid = gridOf(ed)
  return rowsOf(grid).map((row, r) =>
    Array.from({ length: row.childCount }, (_, c) => {
      expect(row.child(c).type.name).toBe("tableCell")
      return r === 0 && grid.attrs.headerRow === true ? "th" : "td"
    }),
  )
}
const cellTexts = (ed: Editor) => rowsOf(gridOf(ed)).map((row) => Array.from({ length: row.childCount }, (_, c) => row.child(c).textContent))

/** The position inside the first paragraph (or caption) whose text is `text`, at its end. */
function endOfText(ed: Editor, text: string): number {
  let at = -1
  ed.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isTextblock && node.textContent === text) at = pos + node.nodeSize - 1
    return at === -1
  })
  if (at === -1) throw new Error(`no "${text}"`)
  return at
}

/**
 * A real keydown on the editor (ProseMirror's keymaps), whether a handler took it. Not
 * TipTap's keyboardShortcut command: it replays only a handler's steps (so a caret move is
 * lost) and always answers true.
 */
function press(ed: Editor, key: string, modifiers: { shiftKey?: boolean; altKey?: boolean } = {}): boolean {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers })
  ed.view.dom.dispatchEvent(event)
  return event.defaultPrevented
}

/** The text of the textblock the caret is in. */
const caretText = (ed: Editor) => ed.state.selection.$from.parent.textContent

const TABLE_HTML =
  "<figure><table><tbody>" +
  "<tr><th><p>Role</p></th><th><p>Write</p></th><th><p>Publish</p></th></tr>" +
  "<tr><td><p>Admin</p></td><td><p>Yes</p></td><td><p>Yes</p></td></tr>" +
  "<tr><td><p>Editor</p></td><td><p>Yes</p></td><td><p>No</p></td></tr>" +
  "</tbody></table><figcaption>Who can do what</figcaption></figure><p>after</p>"

describe("the schema (#420)", () => {
  it("puts a table only in the doc or a container, never in a quote, a list item or a cell", () => {
    const ed = makeEditor("<p>x</p>")
    const { tableBlock, doc, group, blockquote, listItem, tableCell, tableHeader } = ed.schema.nodes
    // The header row is the grid's attr: there is no header cell node to change into.
    expect(tableHeader).toBeUndefined()
    expect(ed.schema.nodes.table.spec.attrs).toHaveProperty("headerRow")
    expect(doc.contentMatch.matchType(tableBlock)).not.toBeNull()
    expect(group.contentMatch.matchType(tableBlock)).not.toBeNull()
    expect(blockquote.contentMatch.matchType(tableBlock)).toBeNull()
    expect(listItem.contentMatch.matchType(ed.schema.nodes.paragraph)?.matchType(tableBlock)).toBeNull()
    expect(tableCell.contentMatch.matchType(tableBlock)).toBeNull()
    // Cells hold paragraphs and nothing else.
    expect(tableCell.contentMatch.matchType(ed.schema.nodes.heading)).toBeNull()
    expect(tableCell.contentMatch.matchType(ed.schema.nodes.bulletList)).toBeNull()
    // A cell's only attrs are its spans.
    expect(Object.keys(tableCell.spec.attrs ?? {}).sort()).toEqual(["colspan", "rowspan"])
  })

  it("loads the editor's own HTML back (copy within the editor): header row, caption, block id", () => {
    const ed = makeEditor(TABLE_HTML)
    expect(types(ed)).toEqual(["tableBlock", "paragraph"])
    expect(cellTypes(ed)).toEqual([["th", "th", "th"], ["td", "td", "td"], ["td", "td", "td"]])
    expect(ed.state.doc.child(0).child(1).textContent).toBe("Who can do what")
    const doc = pmToBlockDoc(ed.state.doc)
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(doc.blocks[doc.blocks_order[0]].attrs).toMatchObject({ headerRow: true, caption: [{ type: "text", text: "Who can do what" }] })
  })
})

describe("insert, rows, columns and the header row (#420)", () => {
  it("insertTableBlock replaces an empty line, puts the caret in the first cell, header row on", () => {
    const ed = makeEditor("<p>first</p><p></p><p>last</p>")
    ed.commands.setTextSelection(endOfText(ed, "first") + 2)
    expect(ed.commands.insertTableBlock({ rows: 3, cols: 2 })).toBe(true)
    expect(types(ed)).toEqual(["paragraph", "tableBlock", "paragraph"])
    expect(cellTypes(ed)).toEqual([["th", "th"], ["td", "td"], ["td", "td"]])
    expect(gridOf(ed).attrs.headerRow).toBe(true)
    expect(gridOf(ed).child(0).child(0).eq(ed.state.selection.$from.node(-1))).toBe(true)
  })

  it("adds the table after a line that has text, and inside the group the caret is in", () => {
    const ed = makeEditor("<p>keep</p><div data-type=\"group\"><p>in a group</p></div>")
    ed.commands.setTextSelection(endOfText(ed, "keep"))
    ed.commands.insertTableBlock()
    // StarterKit's TrailingNode keeps a paragraph after a final non-paragraph block.
    expect(types(ed)).toEqual(["paragraph", "tableBlock", "group", "paragraph"])
    ed.commands.setTextSelection(endOfText(ed, "in a group"))
    ed.commands.insertTableBlock({ headerRow: false })
    const group = ed.state.doc.child(2)
    expect(group.child(1).type.name).toBe("tableBlock")
    expect(group.child(1).child(0).attrs.headerRow).toBe(false)
  })

  it("never puts the table inside a quote or a list item: it goes after that block", () => {
    const ed = makeEditor("<blockquote><p>quoted</p></blockquote><ul><li><p>item</p></li></ul>")
    ed.commands.setTextSelection(endOfText(ed, "quoted"))
    ed.commands.insertTableBlock()
    ed.commands.setTextSelection(endOfText(ed, "item"))
    ed.commands.insertTableBlock()
    expect(types(ed)).toEqual(["blockquote", "tableBlock", "bulletList", "tableBlock", "paragraph"])
    ed.state.doc.check()
  })

  it("adds and deletes rows and columns at the caret's cell, never the last one", () => {
    const ed = makeEditor(TABLE_HTML)
    ed.commands.setTextSelection(endOfText(ed, "Admin"))
    expect(ed.commands.addTableRow("after")).toBe(true)
    expect(ed.commands.addTableColumn("before")).toBe(true)
    expect(cellTexts(ed)).toEqual([
      ["", "Role", "Write", "Publish"],
      ["", "Admin", "Yes", "Yes"],
      ["", "", "", ""],
      ["", "Editor", "Yes", "No"],
    ])
    // The new column's first cell is a header cell like the rest of the header row; no
    // header cell anywhere else.
    expect(cellTypes(ed)).toEqual([["th", "th", "th", "th"], ["td", "td", "td", "td"], ["td", "td", "td", "td"], ["td", "td", "td", "td"]])
    ed.commands.setTextSelection(endOfText(ed, "Admin"))
    expect(ed.commands.deleteTableRow()).toBe(true)
    ed.commands.setTextSelection(endOfText(ed, "Editor"))
    expect(ed.commands.deleteTableColumn()).toBe(true)
    expect(cellTexts(ed)).toEqual([["", "Write", "Publish"], ["", "", ""], ["", "Yes", "No"]])

    const one = makeEditor("<table><tr><td><p>only</p></td></tr></table>")
    one.commands.setTextSelection(endOfText(one, "only"))
    expect(one.can().deleteTableRow()).toBe(false)
    expect(one.can().deleteTableColumn()).toBe(false)
  })

  it("a row inserted above the header row is a header row; the old header row becomes a body row", () => {
    const ed = makeEditor(TABLE_HTML)
    ed.commands.setTextSelection(endOfText(ed, "Role"))
    ed.commands.addTableRow("before")
    expect(cellTypes(ed)).toEqual([["th", "th", "th"], ["td", "td", "td"], ["td", "td", "td"], ["td", "td", "td"]])
    expect(cellTexts(ed)[1]).toEqual(["Role", "Write", "Publish"])
  })

  it("toggles the header row as one attribute, from a cell or the caption, never changing the cells", () => {
    const ed = makeEditor(TABLE_HTML)
    ed.commands.setTextSelection(endOfText(ed, "Who can do what"))
    const before = JSON.stringify(gridOf(ed).toJSON())
    const cells = rowsOf(gridOf(ed))[0]
    expect(ed.commands.toggleTableHeaderRow()).toBe(true)
    // The same cell nodes (a changed node type would be a new Yjs element, #420).
    expect(rowsOf(gridOf(ed))[0].child(0).eq(cells.child(0))).toBe(true)
    expect(cellTypes(ed)[0]).toEqual(["td", "td", "td"])
    expect(cellTexts(ed)[0]).toEqual(["Role", "Write", "Publish"])
    ed.commands.toggleTableHeaderRow()
    expect(cellTypes(ed)[0]).toEqual(["th", "th", "th"])
    expect(JSON.stringify(gridOf(ed).toJSON())).toBe(before)
  })

  it("Backspace with every cell selected deletes the whole table block, caption and all", () => {
    const ed = makeEditor(TABLE_HTML)
    const cellPositions = () => {
      const cells: number[] = []
      ed.state.doc.descendants((node, pos) => {
        if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") cells.push(pos)
      })
      return cells
    }
    let cells = cellPositions()
    // Not every cell: Backspace clears the selected cells, as prosemirror-tables does.
    ed.view.dispatch(ed.state.tr.setSelection(CellSelection.create(ed.state.doc, cells[0], cells[1])))
    press(ed, "Backspace")
    expect(types(ed)).toEqual(["tableBlock", "paragraph"])
    expect(cellTexts(ed)[0]).toEqual(["", "", "Publish"])
    cells = cellPositions()
    ed.view.dispatch(ed.state.tr.setSelection(CellSelection.create(ed.state.doc, cells[0], cells[cells.length - 1])))
    expect(press(ed, "Backspace")).toBe(true)
    expect(types(ed)).toEqual(["paragraph"])
    expect(ed.state.doc.textContent).toBe("after")
  })
})

describe("Tab and ⇧Tab (#420, the canvas's Keyboard board)", () => {
  it("move to the next and previous cell; Tab in the last cell adds a row", () => {
    const ed = makeEditor(TABLE_HTML)
    ed.commands.setTextSelection(endOfText(ed, "Role"))
    expect(press(ed, "Tab")).toBe(true)
    expect(caretText(ed)).toBe("Write")
    press(ed, "Tab", { shiftKey: true })
    expect(caretText(ed)).toBe("Role")
    // ⇧Tab in the first cell stays in it.
    expect(press(ed, "Tab", { shiftKey: true })).toBe(true)
    expect(caretText(ed)).toBe("Role")

    ed.commands.setTextSelection(endOfText(ed, "No"))
    expect(press(ed, "Tab")).toBe(true)
    expect(cellTexts(ed)).toHaveLength(4)
    expect(cellTexts(ed)[3]).toEqual(["", "", ""])
    expect(ed.state.selection.$from.node(-2).eq(gridOf(ed).child(3))).toBe(true)
    expect(cellTypes(ed)[3]).toEqual(["td", "td", "td"])
  })

  it("are left to the other keymaps outside a cell: the caption, a list, a paragraph", () => {
    const ed = makeEditor(TABLE_HTML + "<ul><li><p>one</p></li><li><p>two</p></li></ul>")
    ed.commands.setTextSelection(endOfText(ed, "Who can do what"))
    const doc = ed.state.doc
    expect(press(ed, "Tab")).toBe(false)
    expect(ed.state.doc.eq(doc)).toBe(true)
    expect(cellTexts(ed)).toHaveLength(3)
    // A list item still sinks (the lists' Tab runs: the table's isn't in the way).
    ed.commands.setTextSelection(endOfText(ed, "two"))
    expect(press(ed, "Tab")).toBe(true)
    const list = ed.state.doc.child(ed.state.doc.childCount - 2)
    expect(list.type.name).toBe("bulletList")
    expect(list.childCount).toBe(1)
    expect(list.child(0).childCount).toBe(2)
  })
})

describe("the size picker (#420)", () => {
  it("opens from the catalog's Table, with Columns 3 and Rows 2, and Create table inserts it", () => {
    const ed = makeEditor("<p>first</p><p>/tab</p>")
    const from = ed.state.doc.firstChild!.nodeSize + 1
    ed.commands.setTextSelection(from + 4)
    CORE_BLOCKS.find((entry) => entry.id === "table")!.insert(ed, { from, to: from + 4 })
    expect(ed.state.doc.textContent).toBe("first")
    expect(types(ed)).toEqual(["paragraph", "paragraph"])
    const picker = currentTableSizePicker()!
    expect(picker.element.getAttribute("role")).toBe("dialog")
    const inputs = picker.element.querySelectorAll("input")
    const labels = Array.from(picker.element.querySelectorAll("label")).map((l) => [l.textContent, (l as HTMLLabelElement).htmlFor])
    expect(labels).toEqual([
      ["Columns", inputs[0].id],
      ["Rows", inputs[1].id],
    ])
    expect([inputs[0].value, inputs[1].value]).toEqual(["3", "2"])
    expect(document.activeElement).toBe(inputs[0])
    inputs[0].value = "4"
    inputs[1].value = "3"
    picker.element.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }))
    expect(currentTableSizePicker()).toBeNull()
    expect(types(ed)).toEqual(["paragraph", "tableBlock", "paragraph"])
    expect(cellTypes(ed)).toEqual([["th", "th", "th", "th"], ["td", "td", "td", "td"], ["td", "td", "td", "td"]])
    expect(ed.state.selection.$from.node(-2).eq(gridOf(ed).child(0))).toBe(true)
  })

  it("keeps focus in its first field after the editor's deferred focus (a focus() run just before)", async () => {
    const ed = makeEditor("<p>first</p><p>/tab</p>")
    const from = ed.state.doc.firstChild!.nodeSize + 1
    // The slash menu's own chain focuses the editor a frame later, like TipTap's focus().
    ed.chain().focus().setTextSelection(from + 4).run()
    CORE_BLOCKS.find((entry) => entry.id === "table")!.insert(ed, { from, to: from + 4 })
    const input = currentTableSizePicker()!.element.querySelector("input")!
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.activeElement).toBe(input)
  })

  it("Create table with a block selected puts the table after it", () => {
    const ed = makeEditor("<p>first</p><hr><p>last</p>")
    ed.commands.setNodeSelection(ed.state.doc.firstChild!.nodeSize)
    expect(ed.commands.insertTableBlock()).toBe(true)
    expect(types(ed)).toEqual(["paragraph", "horizontalRule", "tableBlock", "paragraph"])
  })

  it("Esc closes it without inserting anything; sizes are clamped", () => {
    const ed = makeEditor("<p></p>")
    const picker = openTableSizePicker(ed)!
    picker.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(currentTableSizePicker()).toBeNull()
    expect(document.body.contains(picker.element)).toBe(false)
    expect(types(ed)).toEqual(["paragraph"])

    const again = openTableSizePicker(ed)!
    const [cols, rows] = Array.from(again.element.querySelectorAll("input"))
    cols.value = "99"
    rows.value = "zero"
    again.submit()
    expect(cellTypes(ed)[0]).toHaveLength(TABLE_MAX_COLUMNS)
    expect(cellTypes(ed)).toHaveLength(2)
    expect([parseTableSize(" 5 ", 10, 3), parseTableSize("0", 10, 3), parseTableSize("", 10, 3), parseTableSize("-2", 10, 3)]).toEqual([5, 1, 3, 3])
  })

  it("isn't offered where a table can't go (a quote, a list item, a table cell)", () => {
    const table = CORE_BLOCKS.find((entry) => entry.id === "table")!
    const ed = makeEditor("<p>top</p><blockquote><p>quoted</p></blockquote><ul><li><p>item</p></li></ul><div data-type=\"group\"><p>grouped</p></div>" + TABLE_HTML)
    const offered = (text: string) => {
      ed.commands.setTextSelection(endOfText(ed, text))
      return slotAcceptsAt(ed)(table)
    }
    expect([offered("top"), offered("grouped"), offered("quoted"), offered("item"), offered("Admin")]).toEqual([true, true, false, false, false])
  })
})

describe("the toolbar (#420)", () => {
  const toolbarOf = (ed: Editor) => (ed.view.nodeDOM(0) as HTMLElement).querySelector<HTMLElement>(".editor-table__toolbar")!

  it("shows Row, Column and the Header row switch, which reflects and toggles the header row", () => {
    const ed = makeEditor(TABLE_HTML)
    const toolbar = toolbarOf(ed)
    expect(toolbar.getAttribute("role")).toBe("toolbar")
    const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>(":scope > button"))
    expect(buttons.map((b) => b.textContent)).toEqual(["Row", "Column", "Header row"])
    const header = buttons[2]
    expect(header.getAttribute("role")).toBe("switch")
    expect(header.getAttribute("aria-checked")).toBe("true")
    header.click()
    expect(cellTypes(ed)[0]).toEqual(["td", "td", "td"])
    expect(toolbarOf(ed).querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("false")
  })

  it("Row ▾ acts on the caret's cell; its items are disabled in the caption", () => {
    const ed = makeEditor(TABLE_HTML)
    ed.commands.setTextSelection(endOfText(ed, "Editor"))
    const rowButton = toolbarOf(ed).querySelector<HTMLButtonElement>(":scope > button")!
    rowButton.click()
    expect(rowButton.getAttribute("aria-expanded")).toBe("true")
    const items = Array.from(toolbarOf(ed).querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    expect(items.map((i) => [i.textContent, i.disabled])).toEqual([
      ["Insert row above", false],
      ["Insert row below", false],
      ["Delete row", false],
    ])
    items[1].click()
    expect(cellTexts(ed)).toHaveLength(4)
    expect(cellTexts(ed)[3]).toEqual(["", "", ""])
    expect(toolbarOf(ed).querySelector('[role="menu"]')).toBeNull()

    ed.commands.setTextSelection(endOfText(ed, "Who can do what"))
    toolbarOf(ed).querySelector<HTMLButtonElement>(":scope > button")!.click()
    const disabled = Array.from(toolbarOf(ed).querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).map((i) => i.disabled)
    expect(disabled).toEqual([true, true, true])
  })

  it("a menu closes on a click outside it, and opens under its own button", () => {
    const ed = makeEditor(TABLE_HTML)
    ed.commands.setTextSelection(endOfText(ed, "Admin"))
    const columnButton = toolbarOf(ed).querySelectorAll<HTMLButtonElement>(":scope > button")[1]
    columnButton.click()
    const menu = toolbarOf(ed).querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.style.left).toBe(`${columnButton.offsetLeft}px`)
    ed.view.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    expect(toolbarOf(ed).querySelector('[role="menu"]')).toBeNull()
    expect(columnButton.getAttribute("aria-expanded")).toBe("false")
  })

  it("⌥F10 in a cell focuses the toolbar; ← → move between its buttons, Esc goes back to the text", () => {
    const ed = makeEditor(TABLE_HTML)
    ed.commands.setTextSelection(endOfText(ed, "Admin"))
    expect(press(ed, "F10", { altKey: true })).toBe(true)
    const buttons = Array.from(toolbarOf(ed).querySelectorAll<HTMLButtonElement>(":scope > button"))
    expect(document.activeElement).toBe(buttons[0])
    buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    expect(document.activeElement).toBe(buttons[1])
    buttons[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    expect(document.activeElement?.textContent).toBe("Insert column left")
    ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(document.activeElement).toBe(buttons[1])
    buttons[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(caretText(ed)).toBe("Admin")
  })
})

describe("paste (#420)", () => {
  const paste = (ed: Editor, html: string) => ed.view.pasteHTML(html, new Event("paste") as ClipboardEvent)

  it("a web page's table becomes a table block: header row from <thead>, caption, spans, paragraph cells", () => {
    const ed = makeEditor("<p></p>")
    paste(
      ed,
      "<table class=\"pricing\" style=\"width:600px\"><caption>Plans <b>2026</b></caption>" +
        "<thead><tr><th style=\"color:red\">Plan</th><th>Price</th><th>Seats</th></tr></thead>" +
        "<tbody><tr><th scope=\"row\">Basic</th><td colspan=\"2\" onclick=\"x()\">$5 for <a href=\"https://example.com\">one</a></td></tr>" +
        "<tr><td>Team</td><td>$20</td><td rowspan=\"999\">10</td></tr></tbody></table>",
    )
    const block = ed.state.doc.child(0)
    expect(block.type.name).toBe("tableBlock")
    ed.state.doc.check()
    expect(cellTypes(ed)).toEqual([["th", "th", "th"], ["td", "td"], ["td", "td", "td"]])
    expect(cellTexts(ed)).toEqual([["Plan", "Price", "Seats"], ["Basic", "$5 for one"], ["Team", "$20", "10"]])
    expect(gridOf(ed).child(1).child(1).attrs.colspan).toBe(2)
    // Clamped to 64 by the sanitizer, then fitted to the table (the last row) by
    // prosemirror-tables' fixTables on the paste, a local change.
    expect(gridOf(ed).child(2).child(2).attrs.rowspan).toBe(1)
    expect(block.child(1).textContent).toBe("Plans 2026")
    const doc = pmToBlockDoc(ed.state.doc)
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(doc.blocks[doc.blocks_order[0]].attrs).toMatchObject({ headerRow: true })
  })

  it("a Google Docs table (no header cells, a list and a heading in cells) keeps its rows, with paragraphs in every cell", () => {
    const ed = makeEditor("<p></p>")
    const span = (text: string, weight = 400) =>
      `<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;font-weight:${weight};font-style:normal;">${text}</span>`
    const cellStyle = "border-left:solid #000000 1pt;border-right:solid #000000 1pt;vertical-align:top;padding:5pt 5pt 5pt 5pt;"
    paste(
      ed,
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b3c4d">' +
        '<div dir="ltr" style="margin-left:0pt;" align="left"><table style="border:none;border-collapse:collapse;">' +
        '<colgroup><col width="200" /><col width="200" /></colgroup><tbody>' +
        `<tr style="height:0pt"><td style="${cellStyle}"><p dir="ltr" style="line-height:1.38;margin-top:0pt;">${span("Plan", 700)}</p></td>` +
        `<td style="${cellStyle}"><p dir="ltr">${span("Includes")}</p></td></tr>` +
        `<tr style="height:0pt"><td style="${cellStyle}"><h3 dir="ltr">${span("Team")}</h3></td>` +
        `<td style="${cellStyle}"><ul><li dir="ltr"><p dir="ltr">${span("Comments")}</p></li><li dir="ltr"><p dir="ltr">${span("History")}</p></li></ul></td></tr>` +
        "</tbody></table></div><br /></b>",
    )
    ed.state.doc.check()
    expect(ed.state.doc.child(0).type.name).toBe("tableBlock")
    expect(cellTypes(ed)).toEqual([["td", "td"], ["td", "td"]])
    expect(cellTexts(ed)).toEqual([["Plan", "Includes"], ["Team", "CommentsHistory"]])
    const listCell = gridOf(ed).child(1).child(1)
    expect(Array.from({ length: listCell.childCount }, (_, i) => [listCell.child(i).type.name, listCell.child(i).textContent])).toEqual([
      ["paragraph", "Comments"],
      ["paragraph", "History"],
    ])
    expect(gridOf(ed).child(0).child(0).firstChild!.firstChild!.marks.map((m) => m.type.name)).toEqual(["bold"])
    const doc = pmToBlockDoc(ed.state.doc)
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect("headerRow" in doc.blocks[doc.blocks_order[0]].attrs).toBe(false)
  })

  it("keeps cells, spans and the caption through the sanitizer, nothing else", () => {
    const out = sanitizePastedHTML('<table data-x="1"><caption>Cap</caption><tr><td colspan="3" style="x" width="9">a<h2>b</h2></td><td colspan="1">c</td></tr></table>')
    expect(out).toBe('<figure><table><tbody><tr><td colspan="3"><p>a</p><p>b</p></td><td><p>c</p></td></tr></tbody></table><figcaption>Cap</figcaption></figure>')
  })

  it("reads a header row only from a first row of <th>s (or the editor's own data-header-row)", () => {
    const doc = new DOMParser().parseFromString(
      "<table><tr><th>a</th><th>b</th></tr><tr><th>c</th><td>d</td></tr></table>" +
        "<table><tr><th>e</th><td>f</td></tr></table>" +
        '<table data-header-row="true"><tr><td>g</td></tr></table>' +
        "<table><tr><td><table><tr><th>nested</th></tr></table></td></tr></table>",
      "text/html",
    )
    const tables = Array.from(doc.querySelectorAll("body > table")) as HTMLElement[]
    expect(tables.map(hasHeaderRowHTML)).toEqual([true, false, true, false])
  })

  it("a table pasted while the caret is in a cell fills cells from there instead of splitting the table", () => {
    const ed = makeEditor(TABLE_HTML)
    ed.commands.setTextSelection(endOfText(ed, "Admin"))
    paste(ed, "<table><tr><td>Owner</td><td>Always</td></tr></table>")
    expect(types(ed)).toEqual(["tableBlock", "paragraph"])
    expect(cellTexts(ed)).toEqual([
      ["Role", "Write", "Publish"],
      ["Owner", "Always", "Yes"],
      ["Editor", "Yes", "No"],
    ])
    ed.state.doc.check()
  })

  it("keeps both captions when a pasted figure has a caption and its table one too", () => {
    expect(sanitizePastedHTML("<figure><table><caption>Plans</caption><tr><td>a</td></tr></table><figcaption>Source: X</figcaption></figure>")).toBe(
      "<figure><table><tbody><tr><td><p>a</p></td></tr></tbody></table><figcaption>Plans Source: X</figcaption></figure>",
    )
  })
})
