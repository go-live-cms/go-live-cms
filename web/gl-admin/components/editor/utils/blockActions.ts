import { Extension, type Editor } from "@tiptap/core"
import type { Node as PMNode } from "prosemirror-model"
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import { blockAnchorId, normalizeBlockColor, type BlockColor } from "@gl-admin/lib/blocks-spec"

// The block menu's actions (#356, "Editor menus & states" › Block menu). Each one is a
// single ProseMirror transaction on the top-level block, so ySyncPlugin sends it as one Yjs
// transaction: collaborators see one duplicate, one move, one colour change. None of them
// is an appendTransaction or filterTransaction, so rule 7 (lib/collaboration/CLAUDE.md)
// doesn't apply: they run only when this user acts.
//
// Blocks are found by their block id (`data-block-id`) when the action runs, not by the
// position the menu opened at: a collaborator's edit in between moves positions, never ids.
// Block ids are never copied: Duplicate strips every id in the copy and BlockIdExtension
// stamps fresh ones on the same transaction (#238), and Move keeps the block's own id.

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

/** What the menu acts on: the block's id when it has one (it should), else its position. */
export type BlockRef = { id: string | null; pos: number }

export function refOf(block: TopLevelBlock): BlockRef {
  const id = block.node.attrs[BLOCK_ID]
  return { id: typeof id === "string" && id ? id : null, pos: block.pos }
}

export function resolveBlock(doc: PMNode, ref: BlockRef): TopLevelBlock | null {
  if (ref.id) return topLevelBlockById(doc, ref.id)
  return topLevelBlockAt(doc, ref.pos)
}

/** Node JSON with every block id removed, at any depth (list items, nested lists). */
export function withoutBlockIds(json: any): any {
  if (!json || typeof json !== "object") return json
  const out = { ...json }
  if (out.attrs && typeof out.attrs === "object") {
    const { [BLOCK_ID]: _id, ...attrs } = out.attrs
    out.attrs = attrs
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
  const target = heading.pos + heading.node.nodeSize
  if (target === block.pos) {
    // Already there: nothing to send.
    editor.view.dispatch(placeCursorIn(state.tr, block.pos))
    return true
  }
  const tr = state.tr.delete(block.pos, block.pos + block.node.nodeSize)
  const at = tr.mapping.map(target)
  tr.insert(at, block.node)
  editor.view.dispatch(placeCursorIn(tr, at))
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

export function deleteBlock(editor: Editor, ref: BlockRef): boolean {
  const { state } = editor
  const block = resolveBlock(state.doc, ref)
  if (!block) return false
  editor.view.dispatch(state.tr.delete(block.pos, block.pos + block.node.nodeSize).scrollIntoView())
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
}

/**
 * The block menu's keyboard shortcuts, for the block holding the cursor: Ctrl D
 * duplicates it, Ctrl Shift P opens Move to. Editable editors only. No schema.
 */
export const BlockActions = Extension.create<Record<string, never>, BlockActionsStorage>({
  name: "blockActions",

  addStorage() {
    return { openMoveTo: null }
  },

  addKeyboardShortcuts() {
    return {
      "Mod-d": () => {
        if (!this.editor.isEditable) return false
        const block = topLevelBlockAtSelection(this.editor.state)
        if (!block) return false
        duplicateBlock(this.editor, refOf(block))
        // Never the browser's bookmark dialog from inside the editor.
        return true
      },
      "Mod-Shift-p": () => {
        const open = this.storage.openMoveTo
        if (!this.editor.isEditable || !open) return false
        const block = topLevelBlockAtSelection(this.editor.state)
        if (!block) return false
        open(refOf(block))
        return true
      },
    }
  },
})
