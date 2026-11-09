import type { Editor } from "@tiptap/core"
import type { Node as PMNode } from "prosemirror-model"
import { NodeSelection, Selection } from "prosemirror-state"
import { DEFAULT_COLUMNS_LAYOUT } from "@gl-admin/lib/blocks-spec"
import { clampColumnCount, emptyColumn } from "../extensions/ColumnsBlock"
import { resolveEditorBlock, type BlockRef } from "./blockTree"
import { applyBlockMove } from "./blockMoveSync"

// Adding and removing a column (#426), the Columns field of the block's toolbar and the
// settings panel. One transaction, so one Yjs transaction and one undo step, by this user
// only: no appendTransaction (rule 7).
//
// **Removing a column never deletes what's in it.** The blocks of the columns that go move to
// the end of the last column that stays, in order, keeping their ids (comments, "Last
// edited by" and block links follow them). Only empty paragraphs aren't carried over, and
// the last column's own empty line is replaced rather than left above them. It reaches Yjs
// through `applyBlockMove` like any other move, so two people removing the same column at
// once get two copies of its blocks, never a loss (design 2.12).

const isEmptyParagraph = (node: PMNode) => node.type.name === "paragraph" && node.content.size === 0

const childrenOf = (node: PMNode): PMNode[] => {
  const out: PMNode[] = []
  node.forEach((child) => out.push(child))
  return out
}

/** Sets the columns block `ref` names to `count` columns. False when it isn't one, or the post is read-only. */
export function setColumnCount(editor: Editor, ref: BlockRef, count: number): boolean {
  if (!editor.isEditable) return false
  const { state } = editor
  const block = resolveEditorBlock(state.doc, ref)
  if (!block || block.node.type.name !== "columns") return false
  const target = clampColumnCount(count)
  const have = block.node.childCount
  if (target === have) return true

  const keepSelected = (tr: typeof state.tr) => {
    if (state.selection instanceof NodeSelection && state.selection.from === block.pos) {
      tr.setSelection(NodeSelection.create(tr.doc, block.pos))
    }
    return tr.scrollIntoView()
  }

  if (target > have) {
    const end = block.pos + block.node.nodeSize - 1
    const added = Array.from({ length: target - have }, () => emptyColumn(state.schema))
    const tr = state.tr.insert(end, added)
    // The two-column splits have no meaning with three or four.
    if (target > 2 && block.node.attrs.layout !== DEFAULT_COLUMNS_LAYOUT) {
      tr.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, layout: DEFAULT_COLUMNS_LAYOUT })
    }
    editor.view.dispatch(keepSelected(tr))
    return true
  }

  const columns = childrenOf(block.node)
  const kept = columns[target - 1]
  const moved = columns.slice(target).flatMap((column) => childrenOf(column).filter((child) => !isEmptyParagraph(child)))
  // The range of the columns that go: from the end of the last kept one to the block's end.
  let firstRemoved = block.pos + 1
  for (let index = 0; index < target; index++) firstRemoved += columns[index].nodeSize
  const removedEnd = block.pos + block.node.nodeSize - 1
  const removedDoc = state.tr.delete(firstRemoved, removedEnd).doc

  const tr = state.tr
  const keptEnd = firstRemoved - 1
  if (moved.length > 0) {
    if (kept.childCount === 1 && isEmptyParagraph(kept.child(0))) tr.replaceWith(keptEnd - kept.child(0).nodeSize, keptEnd, moved)
    else tr.insert(keptEnd, moved)
  }
  const caretLeaves = state.selection.from >= firstRemoved && state.selection.from <= removedEnd
  tr.delete(tr.mapping.map(firstRemoved), tr.mapping.map(removedEnd))
  if (caretLeaves) tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(keptEnd, -1)), -1))
  applyBlockMove(editor.view, { tr: keepSelected(tr), removedDoc })
  return true
}
