import { mergeAttributes, Node } from "@tiptap/core"
import type { Node as PMNode, Schema } from "@tiptap/pm/model"
import { NodeSelection, TextSelection, type EditorState } from "@tiptap/pm/state"
import {
  COLUMNS_MAX,
  COLUMNS_MIN,
  containerContent,
  DEFAULT_COLUMNS_LAYOUT,
  isColumnsLayout,
  isGroupAlign,
  type ColumnsLayout,
  type GroupAlign,
} from "@gl-admin/lib/blocks-spec"
import { editorBlockAtSelection, holderAcceptsType, replaceLineOrInsertAfter } from "../utils/blockTree"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    columns: {
      /**
       * Columns for the caret's line (it replaces an empty line, else it goes right after the
       * block the caret is in), with the caret in the first one: the layout picker's choice.
       */
      insertColumns: (options: { count: number; layout: ColumnsLayout }) => ReturnType
      /** The layout or width of the columns the selection is on or in. */
      setColumnsAttrs: (attrs: { layout?: ColumnsLayout; align?: GroupAlign }) => ReturnType
    }
  }
}

/** The columns block the selection is on (a NodeSelection) or in. */
export function findColumns(state: EditorState): { pos: number; node: PMNode } | null {
  const { selection } = state
  if (selection instanceof NodeSelection && selection.node.type.name === "columns") {
    return { pos: selection.from, node: selection.node }
  }
  const { $from } = selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === "columns") return { pos: $from.before(depth), node }
  }
  return null
}

/** A column count the table allows. */
export function clampColumnCount(count: number): number {
  return Math.min(COLUMNS_MAX, Math.max(COLUMNS_MIN, Math.floor(count)))
}

/** An empty `column` (one empty paragraph). */
export function emptyColumn(schema: Schema): PMNode {
  return schema.nodes.column.create(null, schema.nodes.paragraph.create())
}

/**
 * One column (#426): its blocks, flow and details (the nesting table), stored by id in the
 * column block's `children`. It only exists inside `columns`, so it is in no group and not
 * at the top level. `data-collab-bounds`: remote carets' name labels flip at its edge (#417).
 */
export const Column = Node.create({
  name: "column",
  content: containerContent("column"),
  defining: true,
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-type="column"]', context: "columns/" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "column", class: "editor-column", "data-collab-bounds": "" }, HTMLAttributes), 0]
  },
})

/**
 * Columns (#426, Block Spec `columns`): 2–4 `column`s side by side (on phones they stack in
 * order), with a `layout` (how two columns share the width) and an `align` (content, wide or
 * full, as a group). Its content is `column+`, not `column{2,4}`: y-tiptap deletes an element
 * whose children fail the content check, so a count two people break at once would cost the
 * whole row. The 2–4 limit lives in the table: every local change respects it
 * (`blockTree.ts`), the validators refuse anything else, and the collab server repairs a
 * merged count before a store (`repairColumnsFragment`).
 *
 * Schema and commands only (no DOM): the collab server builds it too. The view is
 * `LayoutBlockViews.ts`, adding and removing a column `utils/columnActions.ts` (a removed
 * column's blocks move, as a move, so they aren't a schema concern).
 */
export const Columns = Node.create({
  name: "columns",
  content: containerContent("columns"),
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      layout: {
        default: DEFAULT_COLUMNS_LAYOUT,
        parseHTML: (element) => {
          const value = element.getAttribute("data-layout")
          return isColumnsLayout(value) ? value : DEFAULT_COLUMNS_LAYOUT
        },
        renderHTML: (attributes) => ({ "data-layout": isColumnsLayout(attributes.layout) ? attributes.layout : DEFAULT_COLUMNS_LAYOUT }),
      },
      align: {
        default: "content",
        parseHTML: (element) => {
          const value = element.getAttribute("data-align")
          return isGroupAlign(value) ? value : "content"
        },
        renderHTML: (attributes) => ({ "data-align": isGroupAlign(attributes.align) ? attributes.align : "content" }),
      },
    }
  },

  addExtensions() {
    return [Column]
  },

  parseHTML() {
    return [{ tag: 'div[data-type="columns"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "columns", class: "editor-columns" }, HTMLAttributes), 0]
  },

  addCommands() {
    return {
      insertColumns:
        ({ count, layout }) =>
        ({ state, tr, dispatch }) => {
          const block = editorBlockAtSelection(state)
          if (!holderAcceptsType(block?.holder.type.name ?? "doc", "columns")) return false
          const columns = clampColumnCount(count)
          const node = state.schema.nodes.columns.create(
            { layout: columns === 2 ? layout : DEFAULT_COLUMNS_LAYOUT },
            Array.from({ length: columns }, () => emptyColumn(state.schema)),
          )
          if (dispatch) {
            const at = replaceLineOrInsertAfter(tr, block, node)
            // columns › column › paragraph.
            tr.setSelection(TextSelection.create(tr.doc, at + 3)).scrollIntoView()
          }
          return true
        },
      setColumnsAttrs:
        (attrs) =>
        ({ state, tr, dispatch }) => {
          const found = findColumns(state)
          if (!found) return false
          const next = { ...found.node.attrs }
          if (attrs.layout !== undefined) {
            if (!isColumnsLayout(attrs.layout)) return false
            next.layout = attrs.layout
          }
          if (attrs.align !== undefined) {
            if (!isGroupAlign(attrs.align)) return false
            next.align = attrs.align
          }
          if (dispatch) {
            tr.setNodeMarkup(found.pos, undefined, next)
            if (state.selection instanceof NodeSelection && state.selection.from === found.pos) {
              tr.setSelection(NodeSelection.create(tr.doc, found.pos))
            }
          }
          return true
        },
    }
  },
})
