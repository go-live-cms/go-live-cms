import { Extension, mergeAttributes, Node } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, Selection, TextSelection, type EditorState } from "@tiptap/pm/state"
import {
  DEFAULT_BUTTON_VARIANT,
  DEFAULT_BUTTONS_ALIGN,
  isButtonsAlign,
  isButtonVariant,
  normalizeButtonHref,
  type ButtonsAlign,
  type ButtonVariant,
} from "@gl-admin/lib/blocks-spec"
import { editorBlockAtSelection, holderAcceptsType, replaceLineOrInsertAfter } from "../utils/blockTree"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    buttons: {
      /** One empty button for the caret's line (the menus' Buttons), with the caret in it. */
      insertButtons: () => ReturnType
      /** The link of the button the caret is in (the first when the block is selected). A value that isn't safe clears it. */
      setButtonLink: (href: string | null) => ReturnType
      setButtonVariant: (variant: ButtonVariant) => ReturnType
      setButtonsAlign: (align: ButtonsAlign) => ReturnType
      /** A new button after the current one, with the caret in it. */
      addButton: () => ReturnType
    }
  }
}

/** The buttons block the selection is on (a NodeSelection) or in. */
export function findButtons(state: EditorState): { pos: number; node: PMNode } | null {
  const { selection } = state
  if (selection instanceof NodeSelection && selection.node.type.name === "buttons") {
    return { pos: selection.from, node: selection.node }
  }
  const { $from } = selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === "buttons") return { pos: $from.before(depth), node }
  }
  return null
}

/** The button the caret is in, or the block's first (what the toolbar and the panel act on). */
export function currentButton(state: EditorState, buttons: { pos: number; node: PMNode }): { pos: number; node: PMNode; index: number } | null {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === "button" && $from.before(depth - 1) === buttons.pos) {
      return { pos: $from.before(depth), node: $from.node(depth), index: $from.index(depth - 1) }
    }
  }
  const first = buttons.node.firstChild
  return first?.type.name === "button" ? { pos: buttons.pos + 1, node: first, index: 0 } : null
}

/**
 * One button of a row (#426): the label is its text (`text*`, no marks), its `href` a node
 * attr (a safe one or none: `normalizeButtonHref`, also when parsing and rendering, so a
 * peer's bad update never reaches the DOM) and its `variant` primary or secondary. A part of
 * the buttons block, not a block: no id (`isBlockNode`), and kept in the block's `pm`. A div
 * in the editor (no live link in the text), and on the public page an `<a>`.
 *
 * `isolating`: Backspace never joins two buttons. Not selectable: Esc selects the row.
 */
export const Button = Node.create({
  name: "button",
  content: "text*",
  marks: "",
  defining: true,
  isolating: true,
  selectable: false,

  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (element) => normalizeButtonHref(element.getAttribute("data-href")),
        renderHTML: (attributes) => {
          const href = normalizeButtonHref(attributes.href)
          return href ? { "data-href": href } : {}
        },
      },
      variant: {
        default: DEFAULT_BUTTON_VARIANT,
        parseHTML: (element) => {
          const value = element.getAttribute("data-variant")
          return isButtonVariant(value) ? value : DEFAULT_BUTTON_VARIANT
        },
        renderHTML: (attributes) => ({ "data-variant": isButtonVariant(attributes.variant) ? attributes.variant : DEFAULT_BUTTON_VARIANT }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="button"]', context: "buttons/" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "button", class: "editor-button" }, HTMLAttributes), 0]
  },
})

/**
 * Buttons (#426, Block Spec `buttons`): a row of `button`s, kept in the block's `pm`, aligned
 * left or centred. Flow, not a container, and outside the `block` group (like the table): a
 * quote's or list item's content is rendered as text, where a button would be lost.
 *
 * Schema and commands only (no DOM): the collab server builds it too. The view is
 * `LayoutBlockViews.ts`, the keys `ButtonsKeyboard` below.
 */
export const Buttons = Node.create({
  name: "buttons",
  content: "button+",
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      align: {
        default: DEFAULT_BUTTONS_ALIGN,
        parseHTML: (element) => {
          const value = element.getAttribute("data-align")
          return isButtonsAlign(value) ? value : DEFAULT_BUTTONS_ALIGN
        },
        renderHTML: (attributes) => ({ "data-align": isButtonsAlign(attributes.align) ? attributes.align : DEFAULT_BUTTONS_ALIGN }),
      },
    }
  },

  addExtensions() {
    return [Button]
  },

  parseHTML() {
    return [{ tag: 'div[data-type="buttons"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "buttons", class: "editor-buttons" }, HTMLAttributes), 0]
  },

  addCommands() {
    const onCurrent = (patch: (attrs: Record<string, unknown>) => Record<string, unknown>) =>
      (({ state, tr, dispatch }: { state: EditorState; tr: any; dispatch: unknown }) => {
        const buttons = findButtons(state)
        const button = buttons && currentButton(state, buttons)
        if (!button) return false
        if (dispatch) {
          tr.setNodeMarkup(button.pos, undefined, patch(button.node.attrs))
          if (state.selection instanceof NodeSelection && buttons && state.selection.from === buttons.pos) {
            tr.setSelection(NodeSelection.create(tr.doc, buttons.pos))
          }
        }
        return true
      }) as never

    return {
      insertButtons:
        () =>
        ({ state, tr, dispatch }) => {
          const block = editorBlockAtSelection(state)
          if (!holderAcceptsType(block?.holder.type.name ?? "doc", "buttons")) return false
          const { buttons, button } = state.schema.nodes
          const node = buttons.create(null, button.create())
          if (dispatch) {
            const at = replaceLineOrInsertAfter(tr, block, node)
            tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView()
          }
          return true
        },
      setButtonLink: (href) => onCurrent((attrs) => ({ ...attrs, href: normalizeButtonHref(href) })),
      setButtonVariant: (variant) => onCurrent((attrs) => (isButtonVariant(variant) ? { ...attrs, variant } : attrs)),
      setButtonsAlign:
        (align) =>
        ({ state, tr, dispatch }) => {
          const found = findButtons(state)
          if (!found || !isButtonsAlign(align)) return false
          if (dispatch) {
            tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, align })
            if (state.selection instanceof NodeSelection && state.selection.from === found.pos) {
              tr.setSelection(NodeSelection.create(tr.doc, found.pos))
            }
          }
          return true
        },
      addButton:
        () =>
        ({ state, tr, dispatch }) => {
          const buttons = findButtons(state)
          const button = buttons && currentButton(state, buttons)
          if (!button) return false
          if (dispatch) {
            const at = button.pos + button.node.nodeSize
            // The canvas's second button is secondary: one primary action to a row.
            tr.insert(at, state.schema.nodes.button.create({ variant: "secondary" }))
            tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView()
          }
          return true
        },
    }
  },
})

/**
 * The buttons' keys (#426). Editor only (no schema), before the text keymaps (priority 200),
 * and only while the caret is in a button; anywhere else they return false. No
 * appendTransaction (rule 7).
 *
 * - **↵** leaves the row for a new paragraph under it (a label is one line, and **Add
 *   button** makes another).
 * - **⌫ at the start of a label** never joins two buttons. In an empty button it removes that
 *   button (the caret goes to the end of the one before), and in the row's only button
 *   it turns the row into an empty line.
 */
export const ButtonsKeyboard = Extension.create({
  name: "buttonsKeyboard",
  priority: 200,

  addKeyboardShortcuts() {
    const inButton = () => this.editor.isEditable && this.editor.state.selection.$from.parent.type.name === "button"

    const enter = () => {
      if (!inButton()) return false
      const { state, view } = this.editor
      const { $from } = state.selection
      const after = $from.after($from.depth - 1)
      const tr = state.tr.insert(after, state.schema.nodes.paragraph.create())
      view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView())
      return true
    }

    const backspace = () => {
      if (!inButton()) return false
      const { state, view } = this.editor
      const { $from, empty } = state.selection
      if (!empty || $from.parentOffset !== 0) return false
      const buttons = $from.node($from.depth - 1)
      const index = $from.index($from.depth - 1)
      const pos = $from.before()
      if ($from.parent.content.size > 0) {
        if (index > 0) view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(pos), -1)).scrollIntoView())
        return true
      }
      if (buttons.childCount === 1) {
        const rowPos = $from.before($from.depth - 1)
        const tr = state.tr.replaceWith(rowPos, rowPos + buttons.nodeSize, state.schema.nodes.paragraph.create())
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, rowPos + 1)).scrollIntoView())
        return true
      }
      const tr = state.tr.delete(pos, pos + $from.parent.nodeSize)
      view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size)), index > 0 ? -1 : 1)).scrollIntoView())
      return true
    }

    return { Enter: enter, Backspace: backspace }
  },
})
