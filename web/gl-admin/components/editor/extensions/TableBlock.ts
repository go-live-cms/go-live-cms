import { Extension, mergeAttributes, Node, type Editor } from "@tiptap/core"
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table"
import { isChangeOrigin } from "@tiptap/extension-collaboration"
import type { Node as PMNode, NodeType, Schema } from "@tiptap/pm/model"
import { NodeSelection, Plugin, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state"
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  CellSelection,
  deleteColumn,
  deleteRow,
  goToNextCell,
  isInTable,
  selectedRect,
} from "@tiptap/pm/tables"
import { acceptsChild, CAPTION_MARKS, clampTableSpan, containerOfNode, TABLE_MAX_COLUMNS, TABLE_MAX_ROWS } from "@gl-admin/lib/blocks-spec"

/** Rows and columns the size picker starts with, as on the canvas ("Columns 3, Rows 2"). */
export const DEFAULT_TABLE_SIZE = { rows: 2, cols: 3 } as const

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tableBlock: {
      /**
       * Insert a table (#420) for the line the selection is on: an empty paragraph is
       * replaced, anything else gets the table after its block. The caret lands in the
       * first cell. `rows` counts the header row.
       */
      insertTableBlock: (options?: { rows?: number; cols?: number; headerRow?: boolean }) => ReturnType
      /** Delete the table the selection is in (or on), caption and all. */
      deleteTableBlock: () => ReturnType
      /** Turn the first row into a header row, or back into a body row. */
      toggleTableHeaderRow: () => ReturnType
      /** Add a row above or below the cell the caret is in. */
      addTableRow: (side: "before" | "after") => ReturnType
      /** Add a column left or right of the cell the caret is in. */
      addTableColumn: (side: "before" | "after") => ReturnType
      /** Delete the row (or column) of the cell the caret is in; never the last one. */
      deleteTableRow: () => ReturnType
      deleteTableColumn: () => ReturnType
    }
  }
}

const SPAN_ATTRS = {
  colspan: {
    default: 1,
    parseHTML: (element: HTMLElement) => clampTableSpan(element.getAttribute("colspan")),
    renderHTML: (attributes: Record<string, unknown>) => (attributes.colspan !== 1 ? { colspan: attributes.colspan } : {}),
  },
  rowspan: {
    default: 1,
    parseHTML: (element: HTMLElement) => clampTableSpan(element.getAttribute("rowspan")),
    renderHTML: (attributes: Record<string, unknown>) => (attributes.rowspan !== 1 ? { rowspan: attributes.rowspan } : {}),
  },
}

/**
 * Whether a pasted `<th>` is in a header row: its row is the first of its table and every
 * cell of that row is a `<th>`. Only that row becomes header cells; any other `<th>` (a
 * header column, a stray one) is pasted as a plain cell, since Block Spec has a header
 * row and nothing else (`headerRow`).
 */
export function isHeaderRowCell(element: HTMLElement): boolean {
  const row = element.closest("tr")
  const table = row?.closest("table")
  if (!row || !table || table.querySelector("tr") !== row) return false
  return Array.from(row.children).every((cell) => cell.tagName === "TH")
}

/**
 * A table's cells (#420): **paragraphs only** (`paragraph+`), so the table is one flow
 * block and never a container: no list, heading or image in a cell. The spans are the
 * only attrs (no `colwidth`: there is no column resizing, and the API keeps nothing
 * else).
 */
export const GlTableCell = TableCell.extend({
  content: "paragraph+",
  addAttributes() {
    return SPAN_ATTRS
  },
  parseHTML() {
    // A <th> outside a header row is a plain cell (GlTableHeader takes the others first).
    return [{ tag: "td" }, { tag: "th" }]
  },
})

export const GlTableHeader = TableHeader.extend({
  content: "paragraph+",
  addAttributes() {
    return SPAN_ATTRS
  },
  parseHTML() {
    return [{ tag: "th", priority: 60, getAttrs: (element) => (isHeaderRowCell(element as HTMLElement) ? null : false) }]
  },
})

export const GlTableRow = TableRow

/**
 * TipTap's `table` (prosemirror-tables' roles and commands), as the grid inside the table
 * block. **Not in any group**: only `tableBlock` holds it, so the caption has a place
 * (prosemirror-tables reads every child of `table` as a row).
 *
 * **Rule 7:** prosemirror-tables' `tableEditing` plugin has an `appendTransaction`
 * (`fixTables`, which pads short rows with new cells, plus a selection fix). Run on a
 * collaboration-sync transaction, every peer would pad the same row on its own and each
 * padding would sync, so a row two people changed at once would gain a cell per peer. It
 * is wrapped to ignore those transactions (`isChangeOrigin`); only the client that makes a
 * local change to a table fixes it, and that fix syncs like any edit.
 *
 * The keys (Tab, ⇧Tab) are `TableKeyboard`'s, editor only; the TipTap ones are off.
 */
export const GlTable = Table.extend({
  group: "",
  addKeyboardShortcuts() {
    return {}
  },
  addProseMirrorPlugins() {
    return (this.parent?.() ?? []).map((plugin) => {
      const append = plugin.spec.appendTransaction
      if (!append) return plugin
      return new Plugin({
        ...plugin.spec,
        appendTransaction: (transactions, oldState, newState) =>
          transactions.some((tr) => isChangeOrigin(tr)) ? null : append.call(plugin, transactions, oldState, newState),
      })
    })
  },
})

/**
 * A table's caption (#420): text runs with the caption marks (bold, italic, link), like
 * an image's (`imageCaption`). Its own node so two people typing in it merge per character.
 * Always there (empty = no caption in Block Spec), edited under the table.
 */
export const TableCaption = Node.create({
  name: "tableCaption",
  content: "text*",
  marks: CAPTION_MARKS.join(" "),
  defining: true,
  // Backspace at its start never joins it into the last cell.
  isolating: true,

  parseHTML() {
    return [{ tag: "figcaption", context: "tableBlock/" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["figcaption", mergeAttributes(HTMLAttributes, { class: "editor-table__caption" }), 0]
  },

  addKeyboardShortcuts() {
    const inCaption = () => this.editor.state.selection.$from.parent.type.name === this.name
    return {
      // Enter leaves the caption for a new paragraph under the table (a caption is one line).
      Enter: () => {
        if (!inCaption()) return false
        const { state, view } = this.editor
        const { $from } = state.selection
        const after = $from.after($from.depth - 1)
        const tr = state.tr.insert(after, state.schema.nodes.paragraph.create())
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView())
        return true
      },
    }
  },
})

/** The table block the selection is in (or on), with its position. */
export function findTableBlock(state: EditorState): { pos: number; node: PMNode } | null {
  const { selection } = state
  if (selection instanceof NodeSelection && selection.node.type.name === "tableBlock") {
    return { pos: selection.from, node: selection.node }
  }
  const { $from } = selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === "tableBlock") return { pos: $from.before(depth), node }
  }
  return null
}

/** Whether the first row of `table` is a header row (every one of its cells is a header cell). */
export function hasHeaderRow(table: PMNode): boolean {
  const first = table.firstChild
  return !!first && first.childCount > 0 && Array.from({ length: first.childCount }, (_, i) => first.child(i)).every((cell) => cell.type.name === "tableHeader")
}

/**
 * Makes the cell types of the table at `tablePos` in `tr.doc` say what Block Spec stores:
 * the first row's cells are header cells when `headerRow`, plain cells otherwise, and
 * every other row's cells are plain. prosemirror-tables copies a neighbour's type into a
 * new row or column, which can put header cells anywhere; this keeps the editor showing
 * what a reload would.
 */
export function normalizeHeaderCells(tr: Transaction, tablePos: number, headerRow: boolean): Transaction {
  const table = tr.doc.nodeAt(tablePos)
  if (!table || table.type.name !== "table") return tr
  const { tableCell, tableHeader } = tr.doc.type.schema.nodes
  table.forEach((row, rowOffset, rowIndex) => {
    row.forEach((cell, cellOffset) => {
      const want = rowIndex === 0 && headerRow ? tableHeader : tableCell
      if (cell.type !== want) tr.setNodeMarkup(tablePos + 1 + rowOffset + 1 + cellOffset, want, cell.attrs)
    })
  })
  return tr
}

/** A new table block: `rows` × `cols` empty cells (the first row header cells when `headerRow`) and an empty caption. */
export function createTableBlock(schema: Schema, rows: number, cols: number, headerRow: boolean): PMNode {
  const { tableBlock, table, tableRow, tableCell, tableHeader, tableCaption, paragraph } = schema.nodes
  const cell = (type: NodeType) => type.create(null, paragraph.create())
  const rowNodes = Array.from({ length: rows }, (_, index) =>
    tableRow.create(null, Array.from({ length: cols }, () => cell(index === 0 && headerRow ? tableHeader : tableCell))),
  )
  return tableBlock.create(null, [table.create(null, rowNodes), tableCaption.create()])
}

const clampSize = (value: unknown, max: number, fallback: number) => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(1, n))
}

/** The table node inside the table block at `blockPos`, and its position. */
function tableIn(doc: PMNode, blockPos: number): { pos: number; node: PMNode } | null {
  const block = doc.nodeAt(blockPos)
  const table = block?.firstChild
  return block?.type.name === "tableBlock" && table?.type.name === "table" ? { pos: blockPos + 1, node: table } : null
}

type PMCommand = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean

/** `command`, refused when the selected cells cover every row (or every column). */
function unlessAll(axis: "rows" | "columns", command: PMCommand): PMCommand {
  return (state, dispatch) => {
    const rect = selectedRect(state)
    const all = axis === "rows" ? rect.top === 0 && rect.bottom === rect.map.height : rect.left === 0 && rect.right === rect.map.width
    return !all && command(state, dispatch)
  }
}

/**
 * Runs a prosemirror-tables command and puts the cell types back in order
 * (`normalizeHeaderCells`) in the same transaction, so a row or column change is one
 * Yjs update.
 */
function tableCommand(command: PMCommand) {
  return ({ state, dispatch }: { state: EditorState; dispatch?: (tr: Transaction) => void }) => {
    const block = findTableBlock(state)
    const table = block && tableIn(state.doc, block.pos)
    if (!block || !table || !isInTable(state)) return false
    if (!dispatch) return command(state)
    // In a chain `state.tr` is the chain's transaction, which may already have steps:
    // `table.pos` is a position after them, so only this command's steps map it.
    const start = state.tr.steps.length
    let result: Transaction | null = null
    const ok = command(state, (tr) => (result = tr))
    if (!ok || !result) return false
    const tr = result as Transaction
    dispatch(normalizeHeaderCells(tr, tr.mapping.slice(start).map(table.pos), hasHeaderRow(table.node)))
    return true
  }
}

/**
 * The table block (#420, Block Spec `table`): the figure holding the grid (`table`) and
 * its caption (`tableCaption`). This node is the block (it has the `data-block-id`);
 * Block Spec keeps the grid's rows in the block's `attrs.pm` (`blockBridge.ts`).
 *
 * **Not in the `block` group** (`STANDALONE_FLOW_NODE_NAMES`): a table can be a block of
 * the doc or of a group, never part of a quote, a list item or a theme block. Schema
 * plus commands, no DOM code: the collab server builds it too. The editor's view and
 * toolbar are in `BlockNodeViews.ts`, the keys in `TableKeyboard`.
 */
export const TableBlock = Node.create({
  name: "tableBlock",
  content: "table tableCaption",
  isolating: true,
  defining: true,

  addExtensions() {
    return [GlTable, GlTableRow, GlTableHeader, GlTableCell, TableCaption]
  },

  parseHTML() {
    // The editor's own clipboard, and the public site's markup: a figure holding a table
    // (the image's figure rule takes a figure with an image first). A bare <table> is
    // wrapped in a table block by the parser (the doc's content names this node).
    return [{ tag: "figure", getAttrs: (element) => ((element as HTMLElement).querySelector("table") ? null : false) }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["figure", mergeAttributes({ "data-type": "table", class: "editor-table" }, HTMLAttributes), 0]
  },

  addCommands() {
    return {
      insertTableBlock:
        ({ rows, cols, headerRow = true } = {}) =>
        ({ state, tr, dispatch }) => {
          const node = createTableBlock(
            state.schema,
            clampSize(rows, TABLE_MAX_ROWS, DEFAULT_TABLE_SIZE.rows),
            clampSize(cols, TABLE_MAX_COLUMNS, DEFAULT_TABLE_SIZE.cols),
            headerRow,
          )
          // The block the caret is in, or the nearest one around it whose parent (the doc
          // or a container that holds flow) may hold a table: never inside a quote, a
          // list item or another table.
          const { $from } = state.selection
          let depth = $from.depth
          while (depth > 0 && !holdsTables($from.node(depth - 1))) depth--
          if (depth === 0) return false
          const target = $from.node(depth)
          const replace = target.type.name === "paragraph" && target.content.size === 0
          const from = $from.before(depth)
          const at = replace ? from : $from.after(depth)
          if (dispatch) {
            if (replace) tr.replaceWith(from, from + target.nodeSize, node)
            else tr.insert(at, node)
            // tableBlock › table › row › cell › paragraph
            tr.setSelection(TextSelection.create(tr.doc, at + 5)).scrollIntoView()
          }
          return true
        },
      deleteTableBlock:
        () =>
        ({ state, tr, dispatch }) => {
          const block = findTableBlock(state)
          if (!block) return false
          if (dispatch) {
            tr.delete(block.pos, block.pos + block.node.nodeSize)
            tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(block.pos, tr.doc.content.size))))
          }
          return true
        },
      toggleTableHeaderRow:
        () =>
        ({ state, tr, dispatch }) => {
          const block = findTableBlock(state)
          const table = block && tableIn(state.doc, block.pos)
          if (!table) return false
          if (dispatch) normalizeHeaderCells(tr, table.pos, !hasHeaderRow(table.node))
          return true
        },
      addTableRow: (side) => tableCommand(side === "before" ? addRowBefore : addRowAfter),
      addTableColumn: (side) => tableCommand(side === "before" ? addColumnBefore : addColumnAfter),
      // prosemirror-tables refuses to delete every row (column) only when dispatching, so
      // `can()` would say yes: check first, and the menu disables the item.
      deleteTableRow: () => tableCommand(unlessAll("rows", deleteRow)),
      deleteTableColumn: () => tableCommand(unlessAll("columns", deleteColumn)),
    }
  },
})

/** Whether `parent` holds table blocks: the doc, or a container whose nesting rule takes a table. */
function holdsTables(parent: PMNode): boolean {
  if (parent.type.name === "doc") return true
  const container = containerOfNode(parent.type.name)
  return !!container && acceptsChild(container.type, "table")
}

/** Whether the selection is in a table cell (not the caption). */
export function inTableCell(state: EditorState): boolean {
  return state.selection instanceof CellSelection || (isInTable(state) && findTableBlock(state) !== null)
}

/** Every cell of the table is selected (a CellSelection over the whole grid). */
function allCellsSelected(state: EditorState): boolean {
  const { selection } = state
  if (!(selection instanceof CellSelection)) return false
  let cells = 0
  selection.$anchorCell.node(-1).descendants((node) => {
    if (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") cells++
    return node.type.spec.tableRole !== "cell" && node.type.spec.tableRole !== "header_cell"
  })
  return cells === selection.ranges.length
}

/**
 * The table's keys (#420, the canvas's "Keyboard" board: Tab / ⇧Tab move between cells),
 * editor only. **Only while the caret is in a table cell** (`inTableCell`): anywhere else
 * these return false and the other keymaps (lists, the gutter's Tab, #417's nested
 * editing) run as before. Tab in the last cell adds a row; ⇧Tab in the first cell stays
 * there. Backspace/Delete with every cell selected delete the whole table block.
 *
 * Priority above the gutter's (50) and the lists' (100) Tab, so it wins inside a cell.
 */
export const TableKeyboard = Extension.create({
  name: "tableKeyboard",
  priority: 200,

  addKeyboardShortcuts() {
    const editor = this.editor as Editor
    const deleteAll = () => allCellsSelected(editor.state) && editor.commands.deleteTableBlock()
    return {
      Tab: () => {
        if (!inTableCell(editor.state)) return false
        if (goToNextCell(1)(editor.state, editor.view.dispatch)) return true
        return editor.chain().addTableRow("after").command(({ state, dispatch }) => goToNextCell(1)(state, dispatch)).run()
      },
      "Shift-Tab": () => {
        if (!inTableCell(editor.state)) return false
        goToNextCell(-1)(editor.state, editor.view.dispatch)
        return true
      },
      Backspace: deleteAll,
      "Mod-Backspace": deleteAll,
      Delete: deleteAll,
      "Mod-Delete": deleteAll,
      // The canvas's "⌥ F10: move focus to the block toolbar" (BlockNodeViews' TableBlockView).
      "Alt-F10": () => {
        const block = findTableBlock(editor.state)
        if (!block) return false
        const dom = editor.view.nodeDOM(block.pos) as HTMLElement | null
        const button = dom?.querySelector?.<HTMLButtonElement>(".editor-table__toolbar button")
        if (!button) return false
        button.focus()
        return true
      },
    }
  },
})
