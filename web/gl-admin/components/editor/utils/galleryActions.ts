import type { Editor } from "@tiptap/core"
import { Fragment, type Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, type EditorState, type Transaction } from "@tiptap/pm/state"
import { deleteBlockTr, keepBlockSelected, planBlockMove, resolveEditorBlock, siblingTarget, type BlockRef, type EditorBlock } from "./blockTree"
import { applyBlockMove } from "./blockMoveSync"

// What the gallery's keys, its image tiles and the settings panel do to one image (#424).
// Each is one transaction this user makes; a move goes through `applyBlockMove`, so it is one
// Yjs transaction and one undo step and the image keeps its id (#417). None is an
// appendTransaction (rule 7). Images are found by id when the action runs: a collaborator's
// edit moves positions, never ids.

/** The image block `ref` names, when it's in a gallery. */
export function galleryImageBlock(doc: PMNode, ref: BlockRef): EditorBlock | null {
  const block = resolveEditorBlock(doc, ref)
  return block && block.node.type.name === "image" && block.holder.type.name === "gallery" ? block : null
}

/** Moves the image one place earlier (-1) or later (1). False at the end of the gallery. */
export function moveGalleryImage(editor: Editor, ref: BlockRef, dir: -1 | 1): boolean {
  if (!editor.isEditable) return false
  const block = galleryImageBlock(editor.state.doc, ref)
  if (!block) return false
  const target = siblingTarget(editor.state.doc, block, dir)
  const move = target ? planBlockMove(editor.state, block, target) : null
  if (!move) return false
  applyBlockMove(editor.view, move)
  return true
}

/** Removes the image; the gallery stays, even with none left (its empty state). */
export function removeGalleryImage(editor: Editor, ref: BlockRef): boolean {
  if (!editor.isEditable) return false
  const block = galleryImageBlock(editor.state.doc, ref)
  const tr = block ? deleteBlockTr(editor.state, block) : null
  if (!tr) return false
  editor.view.dispatch(tr)
  return true
}

/** Selects the image in the editor (a row of the panel's list). */
export function selectGalleryImage(editor: Editor, ref: BlockRef): boolean {
  const block = galleryImageBlock(editor.state.doc, ref)
  if (!block) return false
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, block.pos)).scrollIntoView())
  return true
}

/** The image's alt text, as typed (one attribute, last writer wins). */
export function setGalleryImageAlt(editor: Editor, ref: BlockRef, alt: string): boolean {
  if (!editor.isEditable) return false
  const block = galleryImageBlock(editor.state.doc, ref)
  if (!block || (block.node.attrs.alt ?? "") === alt) return false
  const { state } = editor
  editor.view.dispatch(keepBlockSelected(state, block.pos, state.tr.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, alt })))
  return true
}

/** The part of `next` that differs from `current`, as code unit offsets, never inside a surrogate pair. */
function changedRange(current: string, next: string): { start: number; currentEnd: number; nextEnd: number } {
  let start = 0
  const limit = Math.min(current.length, next.length)
  while (start < limit && current[start] === next[start]) start++
  if (start > 0 && /[\uD800-\uDBFF]/.test(current[start - 1])) start--
  let currentEnd = current.length
  let nextEnd = next.length
  while (currentEnd > start && nextEnd > start && current[currentEnd - 1] === next[nextEnd - 1]) {
    currentEnd--
    nextEnd--
  }
  if (currentEnd < current.length && /[\uDC00-\uDFFF]/.test(current[currentEnd])) {
    currentEnd++
    nextEnd++
  }
  return { start, currentEnd, nextEnd }
}

/**
 * The transaction that makes the image's caption read `text`, or null when it already does.
 * The caption is the image's child node, so only the characters that changed are touched:
 * two people editing one caption merge per character, as anywhere else in the post, and the
 * bold or link on the rest of it stays. An empty field removes the node (no caption = no child).
 */
export function imageCaptionTr(state: EditorState, block: EditorBlock, text: string): Transaction | null {
  const { imageCaption } = state.schema.nodes
  const caption = block.node.firstChild?.type === imageCaption ? block.node.firstChild : null
  const current = caption?.textContent ?? ""
  if (text === current) return null
  const tr = state.tr
  const captionPos = block.pos + 1
  if (!caption) tr.insert(captionPos, imageCaption.create(null, Fragment.from(state.schema.text(text))))
  else if (text === "") tr.delete(captionPos, captionPos + caption.nodeSize)
  else {
    const { start, currentEnd, nextEnd } = changedRange(current, text)
    const from = captionPos + 1 + start
    const to = captionPos + 1 + currentEnd
    const inserted = text.slice(start, nextEnd)
    if (inserted === "") tr.delete(from, to)
    else {
      const $from = tr.doc.resolve(from)
      const marks = from === to ? $from.marks() : ($from.marksAcross(tr.doc.resolve(to)) ?? [])
      tr.replaceWith(from, to, state.schema.text(inserted, marks))
    }
  }
  return keepBlockSelected(state, block.pos, tr)
}

/** The image's caption, as typed in the panel. */
export function setGalleryImageCaption(editor: Editor, ref: BlockRef, text: string): boolean {
  if (!editor.isEditable) return false
  const block = galleryImageBlock(editor.state.doc, ref)
  const tr = block ? imageCaptionTr(editor.state, block, text) : null
  if (!tr) return false
  editor.view.dispatch(tr)
  return true
}

// ↵ on a selected image opens the panel with focus in its alt text. The panel may not be
// mounted yet, so the image waits here (one per editor, memory only) until its row takes it.
const altFocus = new WeakMap<Editor, string>()
const listeners = new WeakMap<Editor, Set<() => void>>()

export function requestGalleryAltFocus(editor: Editor, id: string) {
  altFocus.set(editor, id)
  listeners.get(editor)?.forEach((listener) => listener())
}

/** True once, for the row whose image asked for focus. */
export function takeGalleryAltFocus(editor: Editor, id: string): boolean {
  if (altFocus.get(editor) !== id) return false
  altFocus.delete(editor)
  return true
}

export function onGalleryAltFocus(editor: Editor, listener: () => void): () => void {
  const set = listeners.get(editor) ?? new Set<() => void>()
  listeners.set(editor, set)
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}
