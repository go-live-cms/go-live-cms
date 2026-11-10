import { Extension, type Editor } from "@tiptap/core"
import type { CatalogEntry } from "../blocks/catalog"
import { refOf, resolveBlock, type BlockRef } from "./blockActions"
import { editorBlockAtSelection, holderAcceptsType } from "./blockTree"

// The gutter's + (#415, "+ in the margin"): the "Add block" button beside the drag handle
// (ui/DragHandle.tsx) opens the block catalog with its own search field (ui/AddBlockMenu.tsx).

type BlockGutterStorage = {
  /** Set by the gutter: shows it at `ref`'s block and focuses its +. False when it can't. */
  focusAddButton: ((ref: BlockRef) => boolean) | null
}

/**
 * Tab in the text, or on a selected block (#417, Esc selects it), reaches the block's +
 * (then the drag handle, then the block's toolbar if it has one, then on out of the
 * editor): "Keyboard" › "Tab: reach its + and drag handle, then its toolbar". The block is
 * the innermost one, at any depth (blockTree.ts). Lists keep Tab for indenting (their
 * keymap runs first and wins when it can sink the item), and code blocks keep the
 * browser's Tab. The gutter is hidden until hovered (gutterPlugin.ts), so the keyboard
 * needs this way in. No document change.
 */
export const BlockGutterKeys = Extension.create<Record<string, never>, BlockGutterStorage>({
  name: "blockGutter",
  // After every keymap that uses Tab (lists' sink, default priority 100).
  priority: 50,

  addStorage() {
    return { focusAddButton: null }
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const focus = this.storage.focusAddButton
        if (!this.editor.isEditable || !focus) return false
        const { state } = this.editor
        if (state.selection.$from.parent.type.spec.code) return false
        const block = editorBlockAtSelection(state)
        return block ? focus(refOf(block)) : false
      },
    }
  },
})

/**
 * What the + of `ref`'s block may insert (#414's nesting table, as the slash menu's
 * `slotAcceptsAt`): the new block goes beside it, in the same holder, so a + inside a group
 * offers no group.
 */
export function gutterAccepts(editor: Editor, ref: BlockRef): (entry: CatalogEntry) => boolean {
  const block = resolveBlock(editor.state.doc, ref)
  // A column's + adds to the column (#426): nothing the menus offer can go beside it.
  const holder = block?.node.type.name === "column" ? "column" : (block?.holder.type.name ?? "doc")
  return (entry) => !!entry.inline || holderAcceptsType(holder, entry.type)
}

/**
 * Inserts `entry` from the + of `ref`'s block: into that line when it's an empty
 * paragraph, else on a new line after the block. False when the block is gone (deleted by
 * someone else while the menu was open). The entry's own `insert` makes the block, as from
 * the slash menu, with an empty range.
 */
export function insertFromGutter(editor: Editor, ref: BlockRef, entry: CatalogEntry): boolean {
  const block = resolveBlock(editor.state.doc, ref)
  // A gallery holds images only, added through its Add images: no line can go between them (#424).
  if (!block || block.holder.type.name === "gallery") return false
  const { node, pos } = block
  let at: number
  if (node.type.name === "paragraph" && node.content.size === 0) {
    at = pos + 1
    editor.chain().focus().setTextSelection(at).run()
  } else {
    // A new line after the block, or at the end of a column (#426).
    const after = pos + node.nodeSize - (node.type.name === "column" ? 1 : 0)
    editor.chain().focus().insertContentAt(after, { type: "paragraph" }).setTextSelection(after + 1).run()
    at = after + 1
  }
  entry.insert(editor, { from: at, to: at })
  return true
}
