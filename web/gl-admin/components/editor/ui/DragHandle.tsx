import { useState, useCallback, useRef, useEffect } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import type { Node as PMNode } from "prosemirror-model"
import { computePosition } from "@floating-ui/dom"
import { DragHandle as TipTapDragHandle } from "@tiptap/extension-drag-handle-react"
import { defaultComputePositionConfig } from "@tiptap/extension-drag-handle"
import BlockMenu from "./BlockMenu"
import MoveToDialog from "./MoveToDialog"
import AddBlockMenu from "./AddBlockMenu"
import { refOf, resolveBlock, topLevelBlockAt, type BlockRef } from "../utils/blockActions"

// The gutter beside the hovered block ("Post editor"; "Inserting blocks"): + opens the
// block catalog with its own search field (#415, AddBlockMenu), the drag handle drags to
// move, and clicking it (or Enter/Space on it) opens the block menu (#356): Colour,
// Duplicate, Copy link to block, Move to, Delete. Turn into, Comment (#192) and "Last
// edited by" aren't built here.
//
// The gutter follows the pointer (TipTap's drag-handle plugin). From the keyboard, Tab in
// the text shows it at the caret's block and focuses + (BlockGutterKeys); Tab again
// reaches the drag handle. The menus and the Move to dialog render outside this element
// (a portal / Modal): the plugin moves this element into the editor's DOM.

/**
 * Pins the handle (and its hovered block) while the menu is open. The React DragHandle
 * installs only the drag-handle plugin, not the extension that defines the
 * lockDragHandle / unlockDragHandle commands, so set the meta the plugin reads directly.
 * A meta-only transaction: no doc change, nothing reaches Yjs.
 */
export function setHandleLock(editor: TiptapEditor, locked: boolean) {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta("lockDragHandle", locked))
}

type Storage = Record<string, { openMoveTo?: ((ref: BlockRef) => void) | null; focusAddButton?: ((ref: BlockRef) => boolean) | null }>

export default function DragHandle({ editor, postUrl }: { editor: TiptapEditor; postUrl?: string | null }) {
  const [showDrag, setShowDrag] = useState(false)
  // The hovered block by id (its position as a fallback), so an edit by anyone between
  // showing the gutter and pressing + or the handle never retargets it.
  const hovered = useRef<BlockRef | null>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const [menuFor, setMenuFor] = useState<BlockRef | null>(null)
  const [addFor, setAddFor] = useState<BlockRef | null>(null)
  const [moveFor, setMoveFor] = useState<BlockRef | null>(null)

  const onDragHandleNodeChange = useCallback((data: { node: PMNode | null; editor: TiptapEditor; pos: number }) => {
    const block = data.node ? topLevelBlockAt(data.editor.state.doc, data.pos) : null
    hovered.current = block ? refOf(block) : null
    // Every block but an empty line: images and dividers have a menu too. An empty line
    // has + only (the design's "An empty line between blocks").
    setShowDrag(!!data.node && !(data.node.isTextblock && data.node.content.size === 0))
  }, [])

  // Ctrl Shift P opens Move to for the block holding the cursor (blockActions.ts).
  useEffect(() => {
    if (!editor) return
    const storage = (editor.storage as unknown as Storage).blockActions
    if (!storage) return
    storage.openMoveTo = (ref) => setMoveFor(ref)
    return () => {
      if (storage.openMoveTo) storage.openMoveTo = null
    }
  }, [editor])

  // Tab in the text: show the gutter at the caret's block and focus + (blockGutter.ts).
  useEffect(() => {
    if (!editor) return
    const storage = (editor.storage as unknown as Storage).blockGutter
    if (!storage) return
    storage.focusAddButton = (ref) => {
      const handle = gutterRef.current?.parentElement
      const block = resolveBlock(editor.state.doc, ref)
      const dom = block && editor.view.nodeDOM(block.pos)
      if (!handle || !block || !(dom instanceof HTMLElement)) return false
      hovered.current = refOf(block)
      setShowDrag(!(block.node.isTextblock && block.node.content.size === 0))
      // What the plugin does on hover: show the element and place it beside the block.
      handle.style.visibility = ""
      handle.style.pointerEvents = "auto"
      computePosition(dom, handle, defaultComputePositionConfig)
        .then(({ x, y, strategy }) => Object.assign(handle.style, { position: strategy, left: `${x}px`, top: `${y}px` }))
        .catch(() => {}) // the editor went away meanwhile
      addRef.current?.focus()
      return true
    }
    return () => {
      if (storage.focusAddButton) storage.focusAddButton = null
    }
  }, [editor])

  // The block + or the handle acts on: the hovered one (pointer, or Tab).
  const currentBlock = () => {
    const current = hovered.current
    if (!current || editor.isDestroyed) return null
    return resolveBlock(editor.state.doc, current)
  }

  const openMenu = () => {
    const block = currentBlock()
    if (!block) return
    setAddFor(null)
    // Keep the handle where it is while the menu is open (the pointer leaves the block).
    setHandleLock(editor, true)
    setMenuFor(refOf(block))
  }

  const closeMenu = (refocus: boolean) => {
    setMenuFor(null)
    setHandleLock(editor, false)
    if (refocus) buttonRef.current?.focus()
  }

  const openAdd = () => {
    const block = currentBlock()
    if (!block) return
    setMenuFor(null)
    setHandleLock(editor, true)
    setAddFor(refOf(block))
  }

  // Esc returns focus to + ("esc returns to +"); inserting leaves it in the new block.
  const closeAdd = (refocus: boolean) => {
    setAddFor(null)
    setHandleLock(editor, false)
    if (refocus) addRef.current?.focus()
  }

  if (!editor) return null

  return (
    <>
      <TipTapDragHandle editor={editor} onNodeChange={onDragHandleNodeChange}>
        <div ref={gutterRef} className="editor-gutter">
          <button
            ref={addRef}
            type="button"
            className={`editor-gutter__add${addFor ? " is-open" : ""}`}
            title="Add a block below"
            aria-label="Add block"
            aria-haspopup="listbox"
            aria-expanded={!!addFor}
            // A click, or Space / Enter from the keyboard (a button's own).
            onClick={() => (addFor ? closeAdd(false) : openAdd())}
            // Not a drag start: the whole gutter is draggable.
            onDragStart={(e) => e.preventDefault()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            ref={buttonRef}
            type="button"
            className={`editor-drag-handle${showDrag || menuFor ? "" : " is-hidden"}${menuFor ? " is-open" : ""}`}
            title="Drag to move, click for the block menu"
            aria-label="Block menu"
            aria-haspopup="menu"
            aria-expanded={!!menuFor}
            tabIndex={showDrag || menuFor ? undefined : -1}
            onClick={() => (menuFor ? closeMenu(false) : openMenu())}
          >
            <svg width="14" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="9" cy="6" r="1.6" />
              <circle cx="9" cy="12" r="1.6" />
              <circle cx="9" cy="18" r="1.6" />
              <circle cx="15" cy="6" r="1.6" />
              <circle cx="15" cy="12" r="1.6" />
              <circle cx="15" cy="18" r="1.6" />
            </svg>
          </button>
        </div>
      </TipTapDragHandle>
      {menuFor && (
        <BlockMenu
          editor={editor}
          target={menuFor}
          anchor={buttonRef}
          postUrl={postUrl}
          onClose={closeMenu}
          onMoveTo={(ref) => setMoveFor(ref)}
        />
      )}
      {addFor && <AddBlockMenu editor={editor} target={addFor} anchor={addRef} onClose={closeAdd} />}
      <MoveToDialog editor={editor} target={moveFor} onClose={() => setMoveFor(null)} />
    </>
  )
}
