import { Extension, mergeAttributes, Node } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, Selection, TextSelection, type EditorState } from "@tiptap/pm/state"
import { CAPTION_MARKS, containerContent } from "@gl-admin/lib/blocks-spec"
import { editorBlockAtSelection, holderAcceptsType } from "../utils/blockTree"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    details: {
      /**
       * The menus' Details: the block the caret is in becomes the details' first block
       * (an empty line becomes an empty paragraph), and the caret goes to the summary.
       */
      setDetails: () => ReturnType
      /** "Open by default" of the details the selection is on or in. */
      setDetailsOpen: (open: boolean) => ReturnType
    }
  }
}

/** The details block the selection is on (a NodeSelection) or in. */
export function findDetails(state: EditorState): { pos: number; node: PMNode } | null {
  const { selection } = state
  if (selection instanceof NodeSelection && selection.node.type.name === "details") {
    return { pos: selection.from, node: selection.node }
  }
  const { $from } = selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === "details") return { pos: $from.before(depth), node }
  }
  return null
}

/**
 * A details' summary (#421): the details node's first child, always there (an empty one
 * is an empty summary). A part of the block, not a block: no id (`isBlockNode`), and in
 * Block Spec its runs are the details' `attrs.summary`. Its own node, not an attribute, so
 * two people typing in one summary merge per character (Yjs), as in a caption: text runs
 * with bold, italic and link only (`CAPTION_MARKS`).
 *
 * `isolating`: Backspace at the start of the first block never joins that block into the
 * summary, and nothing joins the summary into the block before the details. Not
 * selectable, so it can't be selected and deleted on its own (the schema requires it
 * anyway). The editor's keys are `DetailsKeyboard`.
 */
export const DetailsSummary = Node.create({
  name: "detailsSummary",
  content: "text*",
  marks: CAPTION_MARKS.join(" "),
  // No group: it can only be the details' first child.
  defining: true,
  isolating: true,
  selectable: false,

  parseHTML() {
    // Only inside a details: a pasted <summary> on its own stays text.
    return [
      { tag: 'div[data-type="details-summary"]', context: "details/" },
      { tag: "summary", context: "details/" },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    // A div, not <summary>, in the editor: the browser's own toggle stays out of the
    // editable text. The public page renders <summary> (`src/components/blocks/details`).
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "details-summary", class: "editor-details__summary" }), 0]
  },
})

/**
 * Details (#421, Block Spec `details`), the second container (`nesting.ts`): a summary
 * readers open to see the blocks under it. Its content is `detailsSummary` then flow blocks
 * (`containerContent`), each a block with its own id, stored by id in the block's
 * `children`. `open` ("Open by default") is a node attribute, last writer wins; the editor
 * always shows the blocks, whatever it says.
 *
 * Our own node, not TipTap's Details extension: TipTap's wraps the blocks in an id-less
 * `detailsContent` and toggles them with its own view, and nothing it adds is needed here.
 *
 * Not in the `block` group (like Group): a quote, a list item or a theme block can't hold
 * it, so its blocks never hide in another block's `pm`. Schema only (no DOM code): the
 * collab server builds it too. The editor's view is `BlockNodeViews.ts`, its keys
 * `DetailsKeyboard` below.
 */
export const Details = Node.create({
  name: "details",
  content: containerContent("details"),
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      open: {
        default: false,
        parseHTML: (element) => element.hasAttribute("open") || element.getAttribute("data-open") === "true",
        renderHTML: (attributes) => (attributes.open === true ? { "data-open": "true" } : {}),
      },
    }
  },

  addExtensions() {
    return [DetailsSummary]
  },

  parseHTML() {
    return [{ tag: 'div[data-type="details"]' }, { tag: "details" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "details", class: "editor-details" }, HTMLAttributes), 0]
  },

  addCommands() {
    return {
      setDetails:
        () =>
        ({ state, tr, dispatch }) => {
          const block = editorBlockAtSelection(state)
          if (!block || !holderAcceptsType(block.holder.type.name, "details")) return false
          const { details, detailsSummary, paragraph } = state.schema.nodes
          const emptyLine = block.node.type === paragraph && block.node.content.size === 0
          const inner = emptyLine ? paragraph.create() : block.node
          let node: PMNode
          try {
            node = details.createChecked(null, [detailsSummary.create(), inner])
          } catch {
            return false
          }
          if (dispatch) {
            tr.replaceWith(block.pos, block.pos + block.node.nodeSize, node)
            // Into the summary: the details opens at block.pos, its summary at + 1.
            tr.setSelection(TextSelection.create(tr.doc, block.pos + 2)).scrollIntoView()
          }
          return true
        },
      setDetailsOpen:
        (open) =>
        ({ state, tr, dispatch }) => {
          const found = findDetails(state)
          if (!found) return false
          if (dispatch && found.node.attrs.open !== open) {
            tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, open })
            if (state.selection instanceof NodeSelection && state.selection.from === found.pos) {
              tr.setSelection(NodeSelection.create(tr.doc, found.pos))
            }
          }
          return true
        },
    }
  },
})

/** True when `node` holds nothing but empty paragraphs (a details nobody wrote in). */
function onlyEmptyParagraphs(details: PMNode): boolean {
  let empty = true
  details.forEach((child, _offset, index) => {
    if (index === 0) return
    if (child.type.name !== "paragraph" || child.content.size > 0) empty = false
  })
  return empty
}

/**
 * The details' keys (#421, the canvas's "Keyboard", "Inside blocks"). Editor only (no
 * schema), before the text keymaps (priority 200, like `TableKeyboard`), and only while the
 * caret is in a details' summary or at the start of its first block; anywhere else they
 * return false, so #417's keys and the lists' run as before. No appendTransaction (rule 7).
 *
 * - **↵ in the summary** moves into the content: to the start of the first block when it
 *   is text, else into a new empty paragraph above it. The summary is one line: it never
 *   splits.
 * - **⌫ at the start of the summary** does nothing: the summary can't be deleted on its own
 *   (and TipTap's own Backspace would try to turn it into a paragraph). In an empty summary
 *   of a details whose blocks are all empty, it removes the whole details instead.
 * - **⌫ at the start of the first block** goes back to the end of the summary (an empty
 *   first block that isn't the only one is removed), never joining the two.
 */
export const DetailsKeyboard = Extension.create({
  name: "detailsKeyboard",
  priority: 200,

  addKeyboardShortcuts() {
    const editable = () => this.editor.isEditable

    const enter = () => {
      const { state, view } = this.editor
      const { $from } = state.selection
      if (!editable() || $from.parent.type.name !== "detailsSummary") return false
      const detailsPos = $from.before($from.depth - 1)
      const details = $from.node($from.depth - 1)
      const summary = details.firstChild as PMNode
      const contentStart = detailsPos + 1 + summary.nodeSize
      const first = details.childCount > 1 ? details.child(1) : null
      const tr = state.tr
      if (first?.isTextblock) {
        tr.setSelection(TextSelection.create(tr.doc, contentStart + 1))
      } else {
        tr.insert(contentStart, state.schema.nodes.paragraph.create())
        tr.setSelection(TextSelection.create(tr.doc, contentStart + 1))
      }
      view.dispatch(tr.scrollIntoView())
      return true
    }

    const backspace = () => {
      const { state, view } = this.editor
      const { $from, empty } = state.selection
      if (!editable() || !empty || $from.parentOffset !== 0) return false

      if ($from.parent.type.name === "detailsSummary") {
        const details = $from.node($from.depth - 1)
        if ($from.parent.content.size > 0 || !onlyEmptyParagraphs(details)) return true
        const detailsPos = $from.before($from.depth - 1)
        const tr = state.tr.replaceWith(detailsPos, detailsPos + details.nodeSize, state.schema.nodes.paragraph.create())
        tr.setSelection(TextSelection.create(tr.doc, detailsPos + 1))
        view.dispatch(tr.scrollIntoView())
        return true
      }

      // The caret at the start of a textblock that is the details' first block.
      const depth = $from.depth
      if (depth < 2 || !$from.parent.isTextblock) return false
      const holder = $from.node(depth - 1)
      if (holder.type.name !== "details" || $from.index(depth - 1) !== 1) return false
      const summaryEnd = $from.before(depth) - 1
      const tr = state.tr
      if ($from.parent.content.size === 0 && holder.childCount > 2) tr.delete($from.before(depth), $from.after(depth))
      tr.setSelection(Selection.near(tr.doc.resolve(summaryEnd), -1))
      view.dispatch(tr.scrollIntoView())
      return true
    }

    return { Enter: enter, Backspace: backspace }
  },
})
