import { Fragment, type Node as PMNode } from "prosemirror-model"
import { NodeSelection, Selection, TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import {
  acceptsChild,
  BLOCK_NODE_NAMES,
  containerOfNode,
  containerRule,
  isBlockNode,
  isContainerType,
} from "@gl-admin/lib/blocks-spec/nesting"

// The blocks the editor works on at any depth (#417, design `docs/design/block-library.md`
// 3.5): what the keyboard model selects, what the gutter's + and drag handle act on, and
// what a drag moves. Pure ProseMirror: no DOM, no Yjs, so the rules are tested headlessly.
//
// An **editor block** is a node whose parent holds blocks: the doc, a container, or a
// container's slot (the nesting table, `blocks-spec/nesting.ts`). That is `isBlockNode`
// without list items: a list is one block here, its items are its own business (as the
// block menu always treated them), so Esc in a list item selects the whole list.
//
// Moves are by id and Yjs has no move (design 2.12): a move is one transaction that
// inserts the node (the same node: its id and every descendant's id come along) and then
// deletes the original, so collaborators get one Yjs transaction and one undo step.

export type EditorBlock = {
  node: PMNode
  /** Position before the node. */
  pos: number
  /** Index in its holder. */
  index: number
  /** The node holding it: the doc, a container or a container's slot. */
  holder: PMNode
  /** Position before the holder, or -1 for the doc. */
  holderPos: number
}

const BLOCK_ID = "data-block-id"

/** Block Spec type for a ProseMirror node name (theme blocks: the same string). */
const SPEC_TYPE_BY_NODE = new Map(Object.entries(BLOCK_NODE_NAMES).map(([type, node]) => [node, type]))
export function blockSpecTypeOf(nodeName: string): string {
  return SPEC_TYPE_BY_NODE.get(nodeName) ?? nodeName
}

/**
 * Whether a node of this name holds blocks (the doc, a container, a container's slot).
 * Read from the shared predicate: a paragraph is a block exactly under those.
 */
export function holdsBlocks(nodeName: string): boolean {
  return isBlockNode("paragraph", nodeName)
}

/** Whether `node`, a child of `parent`, is an editor block (a block, not a list item). */
export function isEditorBlock(node: PMNode, parent: PMNode): boolean {
  return node.type.name !== "listItem" && isBlockNode(node.type.name, parent.type.name)
}

function blockAtResolved(doc: PMNode, pos: number): EditorBlock | null {
  const $pos = doc.resolve(pos)
  const node = doc.nodeAt(pos)
  if (!node || !isEditorBlock(node, $pos.parent)) return null
  return { node, pos, index: $pos.index(), holder: $pos.parent, holderPos: $pos.depth === 0 ? -1 : $pos.before() }
}

/**
 * The innermost editor block whose range holds `pos` (its start included): the block
 * that starts there, else the deepest one around it.
 */
export function editorBlockAt(doc: PMNode, pos: number): EditorBlock | null {
  if (pos < 0 || pos > doc.content.size) return null
  const $pos = doc.resolve(pos)
  const after = $pos.nodeAfter
  if (after && !after.isInline && isEditorBlock(after, $pos.parent)) return blockAtResolved(doc, pos)
  for (let depth = $pos.depth; depth > 0; depth--) {
    if (isEditorBlock($pos.node(depth), $pos.node(depth - 1))) return blockAtResolved(doc, $pos.before(depth))
  }
  return null
}

/** The editor block with this id, at any depth. */
export function editorBlockById(doc: PMNode, id: string): EditorBlock | null {
  let found: EditorBlock | null = null
  doc.descendants((node, pos, parent) => {
    if (found) return false
    if (parent && node.attrs[BLOCK_ID] === id && isEditorBlock(node, parent)) {
      found = blockAtResolved(doc, pos)
      return false
    }
    return !node.isTextblock
  })
  return found
}

/** The block the selection is on (a selected block) or in (the one holding the caret). */
export function editorBlockAtSelection(state: EditorState): EditorBlock | null {
  const { selection, doc } = state
  if (selection instanceof NodeSelection) {
    const selected = blockAtResolved(doc, selection.from)
    if (selected) return selected
  }
  const $from = selection.$from
  for (let depth = $from.depth; depth > 0; depth--) {
    if (isEditorBlock($from.node(depth), $from.node(depth - 1))) return blockAtResolved(doc, $from.before(depth))
  }
  return editorBlockAt(doc, $from.pos)
}

/** The selection is a block selection (a NodeSelection on an editor block). */
export function selectedBlock(state: EditorState): EditorBlock | null {
  const { selection } = state
  return selection instanceof NodeSelection ? blockAtResolved(state.doc, selection.from) : null
}

/** The container block holding `block` (null at the top level). */
export function containerBlockOf(doc: PMNode, block: EditorBlock): EditorBlock | null {
  if (block.holderPos < 0) return null
  const $holder = doc.resolve(block.holderPos)
  // The holder is a container (an editor block itself) or a container's slot.
  const holderBlock = blockAtResolved(doc, block.holderPos)
  if (holderBlock) return holderBlock
  for (let depth = $holder.depth; depth > 0; depth--) {
    if (isEditorBlock($holder.node(depth), $holder.node(depth - 1))) return blockAtResolved(doc, $holder.before(depth))
  }
  return null
}

/** The editor blocks around `block`, outermost first (the Block tab's path). */
export function ancestorBlocks(doc: PMNode, block: EditorBlock): EditorBlock[] {
  const out: EditorBlock[] = []
  for (let at = containerBlockOf(doc, block); at; at = containerBlockOf(doc, at)) out.unshift(at)
  return out
}

/** The child blocks of a container block, in order (through its slot, if it has one). */
export function childBlocks(doc: PMNode, block: EditorBlock): EditorBlock[] {
  const out: EditorBlock[] = []
  const walk = (holder: PMNode, start: number) => {
    holder.forEach((child, offset) => {
      const pos = start + offset
      if (isEditorBlock(child, holder)) {
        const found = blockAtResolved(doc, pos)
        if (found) out.push(found)
      } else if (holdsBlocks(child.type.name)) walk(child, pos + 1)
    })
  }
  if (holdsBlocks(block.node.type.name) || containerOfNode(block.node.type.name)) walk(block.node, block.pos + 1)
  return out
}

/** Whether `block` holds blocks (a container). */
export function isContainerBlock(block: EditorBlock): boolean {
  return !!containerOfNode(block.node.type.name)
}

/** The previous (-1) or next (1) editor block in the same holder. */
export function siblingBlock(doc: PMNode, block: EditorBlock, dir: -1 | 1): EditorBlock | null {
  let index = block.index + dir
  let pos = dir < 0 ? block.pos : block.pos + block.node.nodeSize
  while (index >= 0 && index < block.holder.childCount) {
    const child = block.holder.child(index)
    if (dir < 0) pos -= child.nodeSize
    if (isEditorBlock(child, block.holder)) return blockAtResolved(doc, pos)
    if (dir > 0) pos += child.nodeSize
    index += dir
  }
  return null
}

/** What a menu or a key acts on: the block's id when it has one (it should), else its position. */
export type BlockRef = { id: string | null; pos: number }

export function refOfBlock(block: { node: PMNode; pos: number }): BlockRef {
  const id = block.node.attrs[BLOCK_ID]
  return { id: typeof id === "string" && id ? id : null, pos: block.pos }
}

/** The block a ref names now: by id, else the block at its position. */
export function resolveEditorBlock(doc: PMNode, ref: BlockRef): EditorBlock | null {
  if (ref.id) return editorBlockById(doc, ref.id)
  return editorBlockAt(doc, ref.pos)
}

// ── The nesting table, at a position ───────────────────────────────────────────────────

/**
 * Whether `holder` may hold a `child` node (the nesting table, `nesting.ts`): flow and the
 * top-level containers at the top, what a container accepts inside it (no group in a
 * group). A holder that is neither (a slot) is left to the schema, which the table generates.
 */
export function holderAccepts(holder: PMNode, child: PMNode): boolean {
  const type = blockSpecTypeOf(child.type.name)
  const holderName = holder.type.name
  if (holderName === "doc") return !isContainerType(type) || !!containerRule(type)?.topLevel
  const container = containerOfNode(holderName)
  if (container) return acceptsChild(container.type, type)
  return holdsBlocks(holderName)
}

function withChildren(holder: PMNode, children: PMNode[]): boolean {
  return holder.type.validContent(Fragment.fromArray(children))
}

function childrenOf(node: PMNode): PMNode[] {
  const out: PMNode[] = []
  node.forEach((child) => out.push(child))
  return out
}

/**
 * The range a move or a delete of `block` removes: the block itself, or, when it is the
 * only block of its container, that container too (a container may not be empty), and so
 * on up. Null when removing it would leave its holder invalid in another way (fewer
 * columns than the table's minimum), so the caller refuses.
 */
export function removalRange(doc: PMNode, block: EditorBlock): { from: number; to: number } | null {
  let at: EditorBlock = block
  for (;;) {
    const remaining = childrenOf(at.holder).filter((_, index) => index !== at.index)
    if (withChildren(at.holder, remaining)) return { from: at.pos, to: at.pos + at.node.nodeSize }
    if (remaining.some((child) => isEditorBlock(child, at.holder))) return null
    // The doc itself: the caller replaces the last block with an empty paragraph.
    if (at.holderPos < 0) return { from: at.pos, to: at.pos + at.node.nodeSize }
    const container = containerBlockOf(doc, at)
    if (!container) return null
    at = container
  }
}

/** A place a block can go: between the holder's children at `index`, i.e. at `pos`. */
export type DropTarget = { pos: number; holderPos: number; index: number }

/**
 * Where `dragged` lands when it's dropped `side` of `over` (the block under the pointer):
 * there if that holder accepts it, else beside the container around it, and so on up to
 * the top (the "nearest allowed place", so a drop never does something the nesting table
 * forbids). Never inside the dragged block itself. Null when nothing accepts it.
 */
export function dropTargetFor(doc: PMNode, dragged: EditorBlock, over: EditorBlock, side: "before" | "after"): DropTarget | null {
  const draggedEnd = dragged.pos + dragged.node.nodeSize
  for (let at: EditorBlock | null = over; at; at = containerBlockOf(doc, at)) {
    const pos = side === "before" ? at.pos : at.pos + at.node.nodeSize
    if (pos > dragged.pos && pos < draggedEnd) continue
    const index = side === "before" ? at.index : at.index + 1
    if (!holderAccepts(at.holder, dragged.node)) continue
    const children = childrenOf(at.holder)
    const sameHolder = at.holderPos === dragged.holderPos
    if (sameHolder) {
      children.splice(dragged.index, 1)
      children.splice(index > dragged.index ? index - 1 : index, 0, dragged.node)
    } else children.splice(index, 0, dragged.node)
    if (!withChildren(at.holder, children)) continue
    return { pos, holderPos: at.holderPos, index }
  }
  return null
}

/** Whether moving `block` to `target` changes nothing (dropped right before or after itself). */
export function isNoOpMove(block: EditorBlock, target: DropTarget): boolean {
  return target.pos === block.pos || target.pos === block.pos + block.node.nodeSize
}

/**
 * A move, ready to apply: the transaction, and the doc with only the removal done, which
 * `applyBlockMove` (blockMoveSync.ts) sends to Yjs first so the move reaches it as a delete
 * and an insert, not as a rewrite of the blocks in between.
 */
export type BlockMove = { tr: Transaction; removedDoc: PMNode }

/**
 * One transaction that moves `block` to `target`: the node (same id, same content) is
 * inserted there, then the original removed (with a container it leaves empty). The moved
 * block is selected, or, when the caret was in it, keeps the caret where it was in it.
 * Null when the move is a no-op or not allowed. Apply it with `applyBlockMove`.
 */
export function planBlockMove(state: EditorState, block: EditorBlock, target: DropTarget): BlockMove | null {
  if (isNoOpMove(block, target)) return null
  const range = removalRange(state.doc, block)
  if (!range) return null
  if (target.pos > range.from && target.pos < range.to) return null
  const removedDoc = state.tr.delete(range.from, range.to).doc
  const tr = moveTr(state, block, target, range)
  return { tr, removedDoc }
}

/** `planBlockMove`'s transaction alone (tests, and editors without Yjs). */
export function moveBlockTr(state: EditorState, block: EditorBlock, target: DropTarget): Transaction | null {
  return planBlockMove(state, block, target)?.tr ?? null
}

function moveTr(state: EditorState, block: EditorBlock, target: DropTarget, range: { from: number; to: number }): Transaction {
  const { selection } = state
  const caretInside =
    selection instanceof TextSelection && selection.from > block.pos && selection.to < block.pos + block.node.nodeSize
  const tr = state.tr.insert(target.pos, block.node)
  const from = tr.mapping.map(range.from, 1)
  const to = tr.mapping.map(range.to, -1)
  tr.delete(from, to)
  const at = tr.mapping.slice(1).map(target.pos, -1)
  if (caretInside) {
    tr.setSelection(TextSelection.create(tr.doc, at + (selection.anchor - block.pos), at + (selection.head - block.pos)))
  } else {
    tr.setSelection(NodeSelection.create(tr.doc, at))
  }
  return tr.scrollIntoView()
}

/** ⌘⇧↑ / ⌘⇧↓: the place before the previous sibling or after the next one, in the same holder. */
export function siblingTarget(doc: PMNode, block: EditorBlock, dir: -1 | 1): DropTarget | null {
  const sibling = siblingBlock(doc, block, dir)
  if (!sibling) return null
  return dropTargetFor(doc, block, sibling, dir < 0 ? "before" : "after")
}

/**
 * One transaction that deletes `block` (with a container it leaves empty). The last block
 * of the post becomes an empty paragraph (the doc needs one). The caret goes where the
 * block was. Null when deleting it isn't allowed (it would leave a container invalid).
 */
export function deleteBlockTr(state: EditorState, block: EditorBlock): Transaction | null {
  const range = removalRange(state.doc, block)
  if (!range) return null
  const tr = state.tr
  if (range.from === 0 && range.to === state.doc.content.size) {
    tr.replaceWith(0, state.doc.content.size, state.schema.nodes.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, 1))
  } else {
    tr.delete(range.from, range.to)
    const $at = tr.doc.resolve(Math.min(range.from, tr.doc.content.size))
    tr.setSelection(Selection.near($at, $at.pos > 0 ? -1 : 1))
  }
  return tr.scrollIntoView()
}
