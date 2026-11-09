import { Extension } from "@tiptap/core"
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state"
import {
  childBlocks,
  containerBlockOf,
  deleteBlockTr,
  editorBlockAtSelection,
  isContainerBlock,
  planBlockMove,
  selectedBlock,
  siblingBlock,
  siblingTarget,
  type EditorBlock,
} from "../utils/blockTree"
import { applyBlockMove } from "../utils/blockMoveSync"

// The keyboard model for blocks at any depth (#417; the canvas's "Keyboard" › "Moving
// between blocks" and "Toolbar and settings"; design `docs/design/block-library.md` 3.5):
//
//   Esc          the text → the block around the caret; a selected block → its container,
//                up to the top
//   ↵            a selected container → its first block; any other block → edit it (caret
//                at its end)
//   ↑ ↓          a selected block → the previous / next block beside it
//   ⌘⇧↑ ⌘⇧↓      move the block (selected, or holding the caret) up or down in its container
//   ⌫ Del        a selected block → delete it (with its container when it was the only one)
//   Tab          a selected block → its + and drag handle, then its toolbar (blockGutter.ts)
//
// Selecting is a NodeSelection on the block, so the selection is the editor's own (the
// outline is `.ProseMirror-selectednode`) and collaborators see it as a range. Each key is
// one transaction this user makes; none is an appendTransaction (rule 7 in
// lib/collaboration/CLAUDE.md), and a move or delete is one Yjs transaction and one undo step.

function selectBlock(state: EditorState, block: EditorBlock): Transaction {
  return state.tr.setSelection(NodeSelection.create(state.doc, block.pos)).scrollIntoView()
}

/** ↵ on a selected block that isn't a container: the caret at the end of its last text. */
function editBlockTr(state: EditorState, block: EditorBlock): Transaction | null {
  const { node, pos } = block
  if (node.isAtom || node.type.name === "image") return null
  const end = pos + node.nodeSize - 1
  const inside = Selection.findFrom(state.doc.resolve(end), -1, true)
  if (!inside || inside.from <= pos || inside.to >= pos + node.nodeSize) return null
  return state.tr.setSelection(inside instanceof TextSelection ? inside : TextSelection.near(inside.$from, -1)).scrollIntoView()
}

/**
 * The keys that act on a selected block. Before the text keymaps (StarterKit's Enter would
 * add a paragraph after a selected block): they only act on a block selection, so they
 * never change typing.
 */
export const BlockSelectionKeys = Extension.create({
  name: "blockSelectionKeys",
  priority: 1000,

  addKeyboardShortcuts() {
    const editable = () => this.editor.isEditable
    const run = (tr: Transaction | null) => {
      if (tr) this.editor.view.dispatch(tr)
      return true
    }
    const arrow = (dir: -1 | 1) => () => {
      const block = selectedBlock(this.editor.state)
      if (!block) return false
      const sibling = siblingBlock(this.editor.state.doc, block, dir)
      // At the first or last block of a container the selection stays.
      return run(sibling ? selectBlock(this.editor.state, sibling) : null)
    }
    const remove = () => {
      if (!editable()) return false
      const block = selectedBlock(this.editor.state)
      if (!block) return false
      return run(deleteBlockTr(this.editor.state, block))
    }
    return {
      Enter: () => {
        const { state } = this.editor
        const block = selectedBlock(state)
        if (!block) return false
        if (isContainerBlock(block)) {
          const [first] = childBlocks(state.doc, block)
          return first ? run(selectBlock(state, first)) : false
        }
        const tr = editBlockTr(state, block)
        return tr ? run(tr) : false
      },
      ArrowUp: arrow(-1),
      ArrowDown: arrow(1),
      Backspace: remove,
      Delete: remove,
    }
  },
})

/**
 * Esc and ⌘⇧↑/↓. After every other keymap and plugin (the slash menu's Esc closes the
 * menu first, a list keeps its own keys).
 */
export const BlockNavigationKeys = Extension.create<
  Record<string, never>,
  { toggleBlockSettings: (() => void) | null; openBlockSettings: (() => void) | null }
>({
  name: "blockNavigationKeys",
  priority: 20,

  addStorage() {
    // Set by the editor when a settings panel can show the Block tab: ⌘⇧, toggles it, and
    // openBlockSettings only opens it (↵ on a gallery image, #424).
    return { toggleBlockSettings: null, openBlockSettings: null }
  },

  addKeyboardShortcuts() {
    const move = (dir: -1 | 1) => () => {
      if (!this.editor.isEditable) return false
      const { state } = this.editor
      const block = editorBlockAtSelection(state)
      if (!block) return false
      const target = siblingTarget(state.doc, block, dir)
      const move = target ? planBlockMove(state, block, target) : null
      if (move) applyBlockMove(this.editor.view, move)
      // Never the browser's "select to the start" at the first block.
      return true
    }
    return {
      Escape: () => {
        const { state } = this.editor
        const selected = selectedBlock(state)
        if (selected) {
          const container = containerBlockOf(state.doc, selected)
          if (!container) return false
          this.editor.view.dispatch(selectBlock(state, container))
          return true
        }
        const block = editorBlockAtSelection(state)
        if (!block) return false
        this.editor.view.dispatch(selectBlock(state, block))
        return true
      },
      "Mod-Shift-ArrowUp": move(-1),
      "Mod-Shift-ArrowDown": move(1),
      // "Toolbar and settings": open or close the settings panel on the Block tab.
      "Mod-Shift-,": () => {
        const toggle = this.storage.toggleBlockSettings
        if (!toggle) return false
        toggle()
        return true
      },
    }
  },
})
