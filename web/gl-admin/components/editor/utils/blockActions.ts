import { Extension, type Editor } from "@tiptap/core"
import type { Node as PMNode } from "prosemirror-model"
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import { blockAnchorId, normalizeBlockColor, type BlockColor } from "@gl-admin/lib/blocks-spec"
import {
  deleteBlockTr,
  editorBlockAtSelection,
  holderAccepts,
  holderHasRoom,
  planBlockMove,
  refOfBlock,
  resolveEditorBlock,
  type BlockRef,
  type EditorBlock,
} from "./blockTree"
import { applyBlockMove } from "./blockMoveSync"

// The block menu's actions (#356, "Editor menus & states" › Block menu). Each one is a
// single ProseMirror transaction on the block, so ySyncPlugin sends it as one Yjs
// transaction: collaborators see one duplicate, one move, one colour change. None of them
// is an appendTransaction or filterTransaction, so rule 7 (lib/collaboration/CLAUDE.md)
// doesn't apply: they run only when this user acts.
//
// Since #417 they act on a block at any depth (a block inside a group as well as the group;
// `blockTree.ts`), the one the gutter or the caret is on.
//
// Blocks are found by their block id (`data-block-id`) when the action runs, not by the
// position the menu opened at: a collaborator's edit in between moves positions, never ids.
// Block ids are never copied: Duplicate strips every id in the copy and BlockIdExtension
// stamps fresh ones on the same transaction (#238), and Move keeps the block's own id.

export type { BlockRef } from "./blockTree"

export type TopLevelBlock = { node: PMNode; pos: number; index: number }

const BLOCK_ID = "data-block-id"

/** The top-level block whose range holds `pos` (its start included). */
export function topLevelBlockAt(doc: PMNode, pos: number): TopLevelBlock | null {
  let found: TopLevelBlock | null = null
  doc.forEach((node, offset, index) => {
    if (!found && pos >= offset && pos < offset + node.nodeSize) found = { node, pos: offset, index }
  })
  return found
}

/** The top-level block with this id. */
export function topLevelBlockById(doc: PMNode, id: string): TopLevelBlock | null {
  let found: TopLevelBlock | null = null
  doc.forEach((node, offset, index) => {
    if (!found && node.attrs[BLOCK_ID] === id) found = { node, pos: offset, index }
  })
  return found
}

/** The top-level block the selection is in (a selected block, or the one holding the cursor). */
export function topLevelBlockAtSelection(state: EditorState): TopLevelBlock | null {
  const { selection } = state
  if (selection instanceof NodeSelection && selection.$from.depth === 0) return topLevelBlockAt(state.doc, selection.from)
  const $from = selection.$from
  if ($from.depth === 0) return topLevelBlockAt(state.doc, $from.pos)
  return topLevelBlockAt(state.doc, $from.before(1))
}

export function refOf(block: { node: PMNode; pos: number }): BlockRef {
  return refOfBlock(block)
}

/** The block a ref names now, at any depth: by id, else the block at its position. */
export function resolveBlock(doc: PMNode, ref: BlockRef): EditorBlock | null {
  return resolveEditorBlock(doc, ref)
}

/** Node JSON with every block id removed, at any depth (list items, nested lists). */
export function withoutBlockIds(json: any): any {
  if (!json || typeof json !== "object") return json
  const out = { ...json }
  if (out.attrs && typeof out.attrs === "object") {
    const { [BLOCK_ID]: _id, ...attrs } = out.attrs
    out.attrs = attrs
    // A copy of a custom HTML block (#428) starts empty: two blocks on one snippet would
    // change together, and the markup is only an admin's to make.
    if (out.type === "html") out.attrs = { ...attrs, snippetId: null }
  }
  if (Array.isArray(out.content)) out.content = out.content.map(withoutBlockIds)
  return out
}

function placeCursorIn(tr: Transaction, blockPos: number): Transaction {
  const $inside = tr.doc.resolve(Math.min(blockPos + 1, tr.doc.content.size))
  const node = tr.doc.nodeAt(blockPos)
  // An atom (image, divider) is selected whole; anything else gets a cursor at its start.
  const selection =
    node && (node.isAtom || node.isLeaf) && NodeSelection.isSelectable(node)
      ? NodeSelection.create(tr.doc, blockPos)
      : (Selection.findFrom($inside, 1, true) ?? TextSelection.near($inside))
  return tr.setSelection(selection).scrollIntoView()
}

/**
 * Duplicate (Ctrl D): a copy of the block right below it, nested children included, with
 * no block ids, so BlockIdExtension stamps new ones (top-level block and every list item)
 * in this same transaction. Returns the copy's position, or null when there's no block.
 */
export function duplicateBlock(editor: Editor, ref: BlockRef): number | null {
  const { state } = editor
  const block = resolveBlock(state.doc, ref)
  if (!block) return null
  const copy = state.schema.nodeFromJSON(withoutBlockIds(block.node.toJSON()))
  // A container that is full (the table's maximum) takes no copy.
  if (!holderHasRoom(block.holder) || !block.holder.canReplaceWith(block.index + 1, block.index + 1, copy.type)) return null
  const at = block.pos + block.node.nodeSize
  const tr = placeCursorIn(state.tr.insert(at, copy), at)
  editor.view.dispatch(tr)
  return at
}

export type HeadingTarget = { id: string | null; pos: number; level: number; text: string }

/** The post's top-level headings, in order: the Move to picker's choices. */
export function listHeadings(doc: PMNode): HeadingTarget[] {
  const headings: HeadingTarget[] = []
  doc.forEach((node, offset) => {
    if (node.type.name !== "heading") return
    const id = node.attrs[BLOCK_ID]
    headings.push({
      id: typeof id === "string" && id ? id : null,
      pos: offset,
      level: Number(node.attrs.level) || 1,
      text: node.textContent.replace(/\s+/g, " ").trim(),
    })
  })
  return headings
}

/**
 * Move to (Ctrl Shift P): the block, with everything in it, goes right under the heading,
 * as the first block of its section. One transaction (delete + insert), so collaborators
 * see one move; the block keeps its id (it's the same block). False when either is gone,
 * or the block is the heading itself.
 */
export function moveBlockUnder(editor: Editor, ref: BlockRef, headingRef: BlockRef): boolean {
  const { state } = editor
  const block = resolveBlock(state.doc, ref)
  const heading = resolveBlock(state.doc, headingRef)
  if (!block || !heading || heading.node.type.name !== "heading" || block.pos === heading.pos) return false
  // The headings are top-level blocks; a block inside a group moves out of it (with the
  // group, when it was the group's only block: blockTree's removalRange).
  if (heading.holderPos !== -1 || !holderAccepts(state.doc, block.node)) return false
  const target = { pos: heading.pos + heading.node.nodeSize, holderPos: -1, index: heading.index + 1 }
  if (target.pos === block.pos) {
    // Already there: nothing to send.
    editor.view.dispatch(placeCursorIn(state.tr, block.pos))
    return true
  }
  const move = planBlockMove(state, block, target)
  if (!move) return false
  const at = move.tr.mapping.slice(1).map(target.pos, -1)
  applyBlockMove(editor.view, { ...move, tr: placeCursorIn(move.tr, at) })
  return true
}

/** Whether the block takes a colour (BlockColor.ts). */
export function canColor(node: PMNode): boolean {
  return "blockColor" in (node.type.spec.attrs ?? {}) || "blockColor" in node.attrs
}

/** Colour › a palette token, or null for the theme's colours. One attribute change. */
export function setBlockColor(editor: Editor, ref: BlockRef, color: BlockColor | null): boolean {
  const { state } = editor
  const block = resolveBlock(state.doc, ref)
  if (!block || !canColor(block.node)) return false
  const value = color === null ? null : normalizeBlockColor(color)
  if (color !== null && value === null) return false
  if ((block.node.attrs.blockColor ?? null) === value) return true
  editor.view.dispatch(state.tr.setNodeAttribute(block.pos, "blockColor", value))
  return true
}

/**
 * Delete (and ⌫ on a selected block, #417): the block, with its container when it was the
 * container's only block. The post's last block becomes an empty line.
 */
export function deleteBlock(editor: Editor, ref: BlockRef): boolean {
  const { state } = editor
  const block = resolveBlock(state.doc, ref)
  if (!block) return false
  const tr = deleteBlockTr(state, block)
  if (!tr) return false
  editor.view.dispatch(tr)
  return true
}

/**
 * Copy link to block: the public post URL with `#b-<block id>`, where the public renderer
 * puts the block's element id. Null without a post URL (a post not created yet) or a
 * usable block id.
 */
export function blockLink(postUrl: string | null | undefined, blockId: string | null | undefined): string | null {
  const anchor = blockAnchorId(blockId)
  if (!postUrl || !anchor) return null
  return `${postUrl.replace(/#.*$/, "")}#${anchor}`
}

type BlockActionsStorage = {
  /** Set by the editor's block menu: opens Move to for that block (Ctrl Shift P). */
  openMoveTo: ((ref: BlockRef) => void) | null
  /** Set by the editor when the post has comments (#192): opens a new thread on that block (Ctrl M). */
  openComment: ((ref: BlockRef) => void) | null
}

/**
 * The block menu's keyboard shortcuts, for the block holding the cursor: Ctrl D
 * duplicates it, Ctrl Shift P opens Move to, Ctrl M comments on it (#192). Editable
 * editors only (a view-only reader comments from the block's hover button). No schema.
 */
export const BlockActions = Extension.create<Record<string, never>, BlockActionsStorage>({
  name: "blockActions",

  addStorage() {
    return { openMoveTo: null, openComment: null }
  },

  addKeyboardShortcuts() {
    return {
      "Mod-d": () => {
        if (!this.editor.isEditable) return false
        const block = editorBlockAtSelection(this.editor.state)
        if (!block) return false
        duplicateBlock(this.editor, refOf(block))
        // Never the browser's bookmark dialog from inside the editor.
        return true
      },
      "Mod-m": () => {
        const open = this.storage.openComment
        if (!this.editor.isEditable || !open) return false
        const block = editorBlockAtSelection(this.editor.state)
        if (!block || !refOf(block).id) return false
        open(refOf(block))
        return true
      },
      "Mod-Shift-p": () => {
        const open = this.storage.openMoveTo
        if (!this.editor.isEditable || !open) return false
        const block = editorBlockAtSelection(this.editor.state)
        if (!block) return false
        open(refOf(block))
        return true
      },
    }
  },
})
