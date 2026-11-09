import { computePosition, type ComputePositionConfig } from "@floating-ui/dom"
import type { Node as PMNode } from "prosemirror-model"
import { NodeSelection, Plugin, PluginKey } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import {
  childBlocks,
  dropTargetFor,
  editorBlockAt,
  isContainerBlock,
  isNoOpMove,
  planBlockMove,
  refOfBlock,
  resolveEditorBlock,
  type BlockRef,
  type DropTarget,
  type EditorBlock,
} from "./blockTree"
import { applyBlockMove } from "./blockMoveSync"

// The gutter beside the hovered block, at any depth (#417). TipTap's drag-handle plugin
// (3.4.2) only ever finds top-level blocks, so this one replaces it: it follows the pointer
// to the innermost block under it (a block inside a group, or the group when the pointer is
// in the group's own margin), places the gutter (+ and the drag handle, ui/DragHandle.tsx)
// beside that block, and runs the drag: the drop lands where the nesting table allows
// (`dropTargetFor`), shown by a line, and is one transaction (`planBlockMove`), sent to Yjs
// as a delete and an insert in one Yjs transaction (`applyBlockMove`): one change for
// collaborators, one undo step, the block keeping its id.
//
// It changes the document only on a drop this user makes (no appendTransaction, rule 7);
// the lock below is a meta-only transaction. Positions are re-read from the block's id after
// every doc change (a collaborator's edit moves positions, never ids).

export type Rect = { top: number; bottom: number; left: number; right: number }

/** The blocks directly in the doc, in order. */
function topLevelBlocks(doc: PMNode): EditorBlock[] {
  const out: EditorBlock[] = []
  doc.forEach((_node, offset) => {
    const block = editorBlockAt(doc, offset)
    if (block && block.pos === offset) out.push(block)
  })
  return out
}

const gap = (value: number, start: number, end: number) => (value < start ? start - value : value > end ? value - end : 0)

/**
 * The block of `blocks` whose rect spans `y`, else the nearest one (y in a gap or padding).
 * Of blocks side by side at that height (columns), the one under or nearest to `x`.
 */
function nearestAt(blocks: EditorBlock[], rectOf: (pos: number) => Rect | null, x: number, y: number) {
  let best: { block: EditorBlock; rect: Rect; dy: number; dx: number } | null = null
  for (const block of blocks) {
    const rect = rectOf(block.pos)
    if (!rect) continue
    const dy = gap(y, rect.top, rect.bottom)
    const dx = gap(x, rect.left, rect.right)
    if (!best || dy < best.dy || (dy === best.dy && dx < best.dx)) best = { block, rect, dy, dx }
    if (dy === 0 && dx === 0) break
  }
  return best
}

/**
 * The block the pointer at (x, y) is on: level by level from the top, the block at that
 * height; inside a container (x past its left edge) one of its blocks, in the container's
 * own left margin the container itself. `rectOf` gives a block's box (the DOM's, or a
 * test's).
 */
export function pickBlock(doc: PMNode, rectOf: (pos: number) => Rect | null, x: number, y: number): { block: EditorBlock; rect: Rect } | null {
  let level = topLevelBlocks(doc)
  let chosen: { block: EditorBlock; rect: Rect } | null = null
  for (;;) {
    const hit = nearestAt(level, rectOf, x, y)
    if (!hit) return chosen
    chosen = { block: hit.block, rect: hit.rect }
    if (!isContainerBlock(hit.block) || x < hit.rect.left) return chosen
    const children = childBlocks(doc, hit.block)
    if (children.length === 0) return chosen
    // Below a gallery's images (its caption, #424): the gallery, not the nearest image.
    if (hit.block.node.type.name === "gallery" && !children.some((child) => spansY(rectOf(child.pos), y))) return chosen
    level = children
  }
}

const spansY = (rect: Rect | null, y: number) => !!rect && y >= rect.top && y <= rect.bottom

/** A gallery's images sit side by side (#424): a drop among them is left or right of an image, not above or below it. */
const inGrid = (block: EditorBlock) => block.holder.type.name === "gallery"

/** Where a block dragged over (x, y) lands: before or after the block there, by the table. */
export function dropTargetAt(
  doc: PMNode,
  dragged: EditorBlock,
  rectOf: (pos: number) => Rect | null,
  x: number,
  y: number,
): DropTarget | null {
  const hit = pickBlock(doc, rectOf, x, y)
  if (!hit) return null
  const before = inGrid(hit.block) ? x < (hit.rect.left + hit.rect.right) / 2 : y < (hit.rect.top + hit.rect.bottom) / 2
  return dropTargetFor(doc, dragged, hit.block, before ? "before" : "after")
}

/**
 * The line a drop target is drawn as: the top of the block after it, or the bottom of the one
 * before. Among a gallery's images (#424) it is an upright line: the left edge of the image
 * after it, or the right edge of the one before (`height` set).
 */
export function dropLine(
  doc: PMNode,
  target: DropTarget,
  rectOf: (pos: number) => Rect | null,
): { y: number; left: number; right: number; height?: number } | null {
  const holder = target.holderPos < 0 ? doc : doc.nodeAt(target.holderPos)
  if (!holder) return null
  if (holder.type.name === "gallery") {
    const next = target.index < holder.childCount ? holder.child(target.index) : null
    const previous = target.index > 0 ? holder.child(target.index - 1) : null
    const after = next?.type.name === "image" ? rectOf(target.pos) : null
    const rect = after ?? (previous ? rectOf(target.pos - previous.nodeSize) : null)
    if (!rect) return null
    const x = after ? rect.left : rect.right
    return { y: rect.top, left: x, right: x, height: rect.bottom - rect.top }
  }
  if (target.index < holder.childCount) {
    const rect = rectOf(target.pos)
    if (rect) return { y: rect.top, left: rect.left, right: rect.right }
  }
  if (target.index > 0) {
    const before = holder.child(target.index - 1)
    const rect = rectOf(target.pos - before.nodeSize)
    if (rect) return { y: rect.bottom, left: rect.left, right: rect.right }
  }
  return null
}

export const gutterPluginKey = new PluginKey<{ locked: boolean }>("blockGutterHover")

export type GutterPluginOptions = {
  /** The gutter (+ and the drag handle). The plugin moves it into the editor's DOM. */
  element: HTMLElement
  /** The element the drag starts from (the handle; the whole gutter when absent). */
  dragSource?: () => HTMLElement | null
  computePositionConfig?: ComputePositionConfig
  /** The hovered block changed (null: none, the gutter is hidden). */
  onBlockChange: (block: EditorBlock | null) => void
}

function domRect(view: EditorView, pos: number): Rect | null {
  const dom = view.nodeDOM(pos)
  if (!(dom instanceof HTMLElement)) return null
  const { top, bottom, left, right } = dom.getBoundingClientRect()
  return { top, bottom, left, right }
}

/**
 * The gutter plugin. `place(ref)` shows the gutter at a block (Tab from the text,
 * blockGutter.ts); `hide()` hides it.
 */
export function createGutterPlugin(options: GutterPluginOptions) {
  const { element, onBlockChange } = options
  const wrapper = document.createElement("div")
  wrapper.className = "editor-gutter-layer"
  wrapper.style.cssText = "position:absolute; top:0; left:0; pointer-events:none;"
  const line = document.createElement("div")
  line.className = "editor-drop-line"
  line.setAttribute("aria-hidden", "true")
  line.hidden = true
  wrapper.append(element, line)

  let view: EditorView | null = null
  let locked = false
  let hovered: BlockRef | null = null
  let raf = 0
  let pending: { x: number; y: number } | null = null
  let dragging: BlockRef | null = null
  let target: DropTarget | null = null

  const hideLine = () => {
    line.hidden = true
    target = null
  }

  const show = (v: EditorView, block: EditorBlock) => {
    const dom = v.nodeDOM(block.pos)
    if (!(dom instanceof HTMLElement)) return
    element.style.visibility = ""
    element.style.pointerEvents = "auto"
    computePosition({ getBoundingClientRect: () => dom.getBoundingClientRect() }, element, options.computePositionConfig)
      .then(({ x, y, strategy }) => Object.assign(element.style, { position: strategy, left: `${x}px`, top: `${y}px` }))
      .catch(() => {}) // the editor went away meanwhile
  }

  const hide = () => {
    element.style.visibility = "hidden"
    element.style.pointerEvents = "none"
    if (hovered) {
      hovered = null
      onBlockChange(null)
    }
  }

  const setHovered = (v: EditorView, block: EditorBlock | null) => {
    if (!block) return hide()
    const ref = refOfBlock(block)
    const changed = !hovered || hovered.id !== ref.id || (ref.id === null && hovered.pos !== ref.pos)
    hovered = ref
    show(v, block)
    if (changed) onBlockChange(block)
  }

  const onDragStart = (event: DragEvent) => {
    if (!view || !hovered || !view.editable) return
    const v = view
    const block = resolveEditorBlock(v.state.doc, hovered)
    if (!block || !event.dataTransfer) return
    dragging = refOfBlock(block)
    const dom = v.nodeDOM(block.pos)
    event.dataTransfer.effectAllowed = "move"
    // Firefox starts a drag only with some data; dropped elsewhere it's the block's text.
    event.dataTransfer.setData("text/plain", block.node.textContent)
    if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 0)
    // The block shows selected while it's dragged.
    v.dispatch(v.state.tr.setSelection(NodeSelection.create(v.state.doc, block.pos)))
    // The gutter mustn't catch the drag's own events.
    setTimeout(() => (element.style.pointerEvents = "none"), 0)
  }

  const onDragEnd = () => {
    dragging = null
    hideLine()
    element.style.pointerEvents = "auto"
    hide()
  }

  const plugin = new Plugin({
    key: gutterPluginKey,
    state: {
      init: () => ({ locked: false }),
      apply(tr, value) {
        const lock = tr.getMeta("lockDragHandle")
        if (lock !== undefined) {
          locked = !!lock
          return { locked }
        }
        return value
      },
    },
    view(editorView) {
      view = editorView
      editorView.dom.parentElement?.appendChild(wrapper)
      element.draggable = false
      const source = options.dragSource?.() ?? element
      source.draggable = true
      source.addEventListener("dragstart", onDragStart)
      source.addEventListener("dragend", onDragEnd)
      hide()
      return {
        update(v, prevState) {
          if (!v.editable) {
            hide()
            return
          }
          source.draggable = !locked
          if (!hovered || v.state.doc.eq(prevState.doc)) return
          // Someone's edit: the same block (by id), wherever it is now; gone: hide.
          const block = resolveEditorBlock(v.state.doc, hovered)
          if (block) setHovered(v, block)
          else if (!locked) hide()
        },
        destroy() {
          cancelAnimationFrame(raf)
          source.removeEventListener("dragstart", onDragStart)
          source.removeEventListener("dragend", onDragEnd)
          wrapper.remove()
          view = null
        },
      }
    },
    props: {
      handleDOMEvents: {
        mousemove(v, event) {
          if (locked || dragging || !v.editable) return false
          pending = { x: event.clientX, y: event.clientY }
          if (raf) return false
          raf = requestAnimationFrame(() => {
            raf = 0
            const at = pending
            pending = null
            if (!at || locked || dragging) return
            const hit = pickBlock(v.state.doc, (pos) => domRect(v, pos), at.x, at.y)
            setHovered(v, hit?.block ?? null)
          })
          return false
        },
        mouseleave(_v, event) {
          if (locked || dragging) return false
          if (!wrapper.contains(event.relatedTarget as Node | null)) hide()
          return false
        },
        keydown(v) {
          // Typing hides the gutter (Tab then shows it at the caret's block: blockGutter.ts).
          if (!locked && v.hasFocus()) hide()
          return false
        },
        dragover(v, event) {
          if (!dragging) return false
          // The drop cursor plugin listens on the same element; this drag draws its own line.
          event.stopImmediatePropagation()
          const block = resolveEditorBlock(v.state.doc, dragging)
          const rectOf = (pos: number) => domRect(v, pos)
          const next = block ? dropTargetAt(v.state.doc, block, rectOf, event.clientX, event.clientY) : null
          if (!block || !next || isNoOpMove(block, next)) {
            hideLine()
            if (event.dataTransfer) event.dataTransfer.dropEffect = "none"
            event.preventDefault()
            return true
          }
          event.preventDefault()
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
          target = next
          const at = dropLine(v.state.doc, next, rectOf)
          const base = (line.offsetParent ?? wrapper).getBoundingClientRect()
          if (at) {
            line.hidden = false
            Object.assign(line.style, {
              top: `${at.y - base.top}px`,
              left: `${at.left - base.left}px`,
              width: at.height === undefined ? `${at.right - at.left}px` : "2px",
              height: at.height === undefined ? "" : `${at.height}px`,
            })
          } else line.hidden = true
          return true
        },
        drop(v, event) {
          if (!dragging) return false
          event.preventDefault()
          event.stopImmediatePropagation()
          const block = resolveEditorBlock(v.state.doc, dragging)
          const rectOf = (pos: number) => domRect(v, pos)
          const at = block ? (dropTargetAt(v.state.doc, block, rectOf, event.clientX, event.clientY) ?? target) : null
          dragging = null
          hideLine()
          if (block && at && v.editable) {
            const move = planBlockMove(v.state, block, at)
            if (move) applyBlockMove(v, { ...move, tr: move.tr.setMeta("uiEvent", "drop") })
          }
          v.focus()
          return true
        },
      },
    },
  })

  return {
    plugin,
    /** Shows the gutter at the block `ref` names (Tab from the text). False when it can't. */
    place(ref: BlockRef): boolean {
      if (!view) return false
      const block = resolveEditorBlock(view.state.doc, ref)
      if (!block || !(view.nodeDOM(block.pos) instanceof HTMLElement)) return false
      setHovered(view, block)
      return true
    },
    hide,
  }
}
