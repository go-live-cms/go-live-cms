import { Extension, mergeAttributes, Node, type Editor } from "@tiptap/core"
import { Table, TableCell, TableRow } from "@tiptap/extension-table"
import { isChangeOrigin } from "@tiptap/extension-collaboration"
import { Fragment, Slice, type Node as PMNode, type Schema } from "@tiptap/pm/model"
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

/** The table's icon (the canvas's, 24×24 stroke): the catalog's entry and the size picker. */
export const TABLE_ICON = "M3 5h18v14H3zM3 10h18M3 15h18M9 5v14"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tableBlock: {
      /**
       * Insert a table (#420) for the line the selection is on: an empty paragraph is
       * replaced, anything else gets the table after its block (after a selected block).
       * The caret lands in the first cell. `rows` counts the header row.
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
 * Whether a pasted `<table>` has a header row: its own first row holds only `<th>`s (a
 * `<thead>` row, or a first `<tbody>` row of `<th>`s), or it's the editor's own clipboard
 * (`data-header-row`). Any other `<th>` (a header column, a stray one) is a plain cell:
 * Block Spec has a header row and nothing else (`headerRow`).
 */
export function hasHeaderRowHTML(table: HTMLElement): boolean {
  if (table.getAttribute("data-header-row") === "true") return true
  const row = table.querySelector("tr")
  if (!row || row.closest("table") !== table || row.children.length === 0) return false
  return Array.from(row.children).every((cell) => cell.tagName === "TH")
}

/**
 * A table's cells (#420): **paragraphs only** (`paragraph+`), so the table is one flow
 * block and never a container: no list, heading or image in a cell. The spans are the
 * only attrs (no `colwidth`: there is no column resizing, and the API keeps nothing
 * else). There is no header cell node: the header row is the grid's `headerRow`, so
 * turning it on or off changes one attribute, never the cells (a cell whose node type
 * changed would be a new Yjs element, and a peer typing in it would lose those keys).
 */
export const GlTableCell = TableCell.extend({
  content: "paragraph+",
  addAttributes() {
    return SPAN_ATTRS
  },
  parseHTML() {
    return [{ tag: "td" }, { tag: "th" }]
  },
})

// Cells only (TipTap's names `tableHeader` too). May be empty: a row every cell of which
// is covered by a rowspan from above has no cells of its own.
export const GlTableRow = TableRow.extend({ content: "tableCell*" })

/**
 * TipTap's `table` (prosemirror-tables' roles and commands), as the grid inside the table
 * block. **Not in any group**: only `tableBlock` holds it, so the caption has a place
 * (prosemirror-tables reads every child of `table` as a row). `headerRow`: its first row
 * is a header row (Block Spec's `attrs.headerRow`; the editor styles that row, the public
 * page renders it as `<thead>`).
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
  addAttributes() {
    return {
      headerRow: {
        default: false,
        parseHTML: (element) => hasHeaderRowHTML(element),
        renderHTML: (attributes) => (attributes.headerRow === true ? { "data-header-row": "true" } : {}),
      },
    }
  },
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

/** Whether the grid's first row is a header row. */
export function hasHeaderRow(table: PMNode): boolean {
  return table.attrs.headerRow === true
}

/** A new table block: `rows` × `cols` empty cells, the first row a header row when `headerRow`, and an empty caption. */
export function createTableBlock(schema: Schema, rows: number, cols: number, headerRow: boolean): PMNode {
  const { tableBlock, table, tableRow, tableCell, tableCaption, paragraph } = schema.nodes
  const rowNodes = Array.from({ length: rows }, () =>
    tableRow.create(null, Array.from({ length: cols }, () => tableCell.create(null, paragraph.create()))),
  )
  return tableBlock.create(null, [table.create({ headerRow }, rowNodes), tableCaption.create()])
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

/** Whether `parent` holds table blocks: the doc, or a container whose nesting rule takes a table. */
function holdsTables(parent: PMNode): boolean {
  if (parent.type.name === "doc") return true
  const container = containerOfNode(parent.type.name)
  return !!container && acceptsChild(container.type, "table")
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

/** A prosemirror-tables command, only for a caret (or cell selection) in a table block's grid. */
function tableCommand(command: PMCommand) {
  return ({ state, dispatch }: { state: EditorState; dispatch?: (tr: Transaction) => void }) =>
    isInTable(state) && findTableBlock(state) !== null && command(state, dispatch)
}

/**
 * The table block (#420, Block Spec `table`): the figure holding the grid (`table`) and
 * its caption (`tableCaption`). This node is the block (it has the `data-block-id`);
 * Block Spec keeps the grid's rows in the block's `attrs.pm` (`blockBridge.ts`).
 *
 * **Not in the `block` group** (`STANDALONE_FLOW_NODE_NAMES`): a table can be a block of
 * the doc or of a group, never part of a quote, a list item or a theme block. Schema
 * plus commands, no DOM code: the collab server builds it too. The editor's view and
 * toolbar are in `BlockNodeViews.ts`, the keys and paste in `TableKeyboard`.
 */
export const TableBlock = Node.create({
  name: "tableBlock",
  content: "table tableCaption",
  isolating: true,
  defining: true,

  addExtensions() {
    return [GlTable, GlTableRow, GlTableCell, TableCaption]
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
          const { selection } = state
          let at: number
          let replace: { from: number; to: number } | null = null
          if (selection instanceof NodeSelection && holdsTables(selection.$from.parent)) {
            // A selected block (an image, a table): the table goes after it.
            at = selection.to
          } else {
            // The block the caret is in, or the nearest one around it whose parent (the doc
            // or a container that holds flow) may hold a table: never inside a quote, a
            // list item or another table.
            const { $from } = selection
            let depth = $from.depth
            while (depth > 0 && !holdsTables($from.node(depth - 1))) depth--
            if (depth === 0) return false
            const target = $from.node(depth)
            const from = $from.before(depth)
            if (target.type.name === "paragraph" && target.content.size === 0) replace = { from, to: from + target.nodeSize }
            at = replace ? from : $from.after(depth)
          }
          if (dispatch) {
            if (replace) tr.replaceWith(replace.from, replace.to, node)
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
          // One attribute (last writer wins), never the cells.
          if (dispatch) tr.setNodeAttribute(table.pos, "headerRow", !hasHeaderRow(table.node))
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
    const isCell = node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell"
    if (isCell) cells++
    return !isCell
  })
  return cells === selection.ranges.length
}

/**
 * A pasted table block, while the caret is in a cell, as its grid alone: prosemirror-tables
 * then pastes its cells into the table (from the caret's cell, growing the table as
 * needed) instead of a table block being fitted into the cell, which would split the table.
 */
export function pastedIntoCell(slice: Slice, state: EditorState): Slice {
  const only = slice.content.childCount === 1 ? slice.content.firstChild : null
  if (!only || only.type.name !== "tableBlock" || !inTableCell(state) || only.firstChild?.type.name !== "table") return slice
  return new Slice(Fragment.from(only.firstChild), 0, 0)
}

/**
 * The table's keys (#420, the canvas's "Keyboard" board: Tab / ⇧Tab move between cells),
 * editor only. **Only while the caret is in a table cell** (`inTableCell`): anywhere else
 * these return false and the other keymaps (lists, the gutter's Tab, #417's nested
 * editing) run as before. Tab in the last cell adds a row; ⇧Tab in the first cell stays
 * there. Backspace/Delete with every cell selected delete the whole table block. Also
 * `pastedIntoCell` for a table pasted into a table (`transformPasted`, local pastes only;
 * no appendTransaction).
 *
 * Priority above the gutter's (50) and the lists' (100) Tab, so it wins inside a cell.
 */
export const TableKeyboard = Extension.create({
  name: "tableKeyboard",
  priority: 200,

  addProseMirrorPlugins() {
    return [new Plugin({ props: { transformPasted: (slice, view) => pastedIntoCell(slice, view.state) } })]
  },

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
