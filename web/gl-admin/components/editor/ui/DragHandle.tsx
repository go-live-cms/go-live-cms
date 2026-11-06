import { useState, useCallback, useRef, useEffect } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import type { Node as PMNode } from "prosemirror-model"
import { DragHandle as TipTapDragHandle } from "@tiptap/extension-drag-handle-react"
import BlockMenu from "./BlockMenu"
import MoveToDialog from "./MoveToDialog"
import { refOf, topLevelBlockAt, type BlockRef } from "../utils/blockActions"

// The block handle in the gutter ("Post editor": the hovered block). Drag to move; click
// (or Enter/Space on it) for the block menu (#356): Colour, Duplicate, Copy link to block,
// Move to, Delete. The design's "add block below" button, Turn into, Comment (#192) and
// "Last edited by" aren't built here.
//
// The menu and the Move to dialog render outside this element (a portal / Modal): the
// drag-handle plugin moves this element into the editor's DOM.

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

export default function DragHandle({ editor, postUrl }: { editor: TiptapEditor; postUrl?: string | null }) {
  const [showDrag, setShowDrag] = useState(false)
  const hovered = useRef<{ node: PMNode; pos: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [menuFor, setMenuFor] = useState<BlockRef | null>(null)
  const [moveFor, setMoveFor] = useState<BlockRef | null>(null)

  const onDragHandleNodeChange = useCallback((data: { node: PMNode | null; editor: TiptapEditor; pos: number }) => {
    hovered.current = data.node ? { node: data.node, pos: data.pos } : null
    // Every block but an empty line: images and dividers have a menu too.
    setShowDrag(!!data.node && !(data.node.isTextblock && data.node.content.size === 0))
  }, [])

  // Ctrl Shift P opens Move to for the block holding the cursor (blockActions.ts).
  useEffect(() => {
    if (!editor) return
    const storage = (editor.storage as unknown as Record<string, { openMoveTo: ((ref: BlockRef) => void) | null }>).blockActions
    if (!storage) return
    storage.openMoveTo = (ref) => setMoveFor(ref)
    return () => {
      if (storage.openMoveTo) storage.openMoveTo = null
    }
  }, [editor])

  const openMenu = () => {
    const current = hovered.current
    if (!current || editor.isDestroyed) return
    const block = topLevelBlockAt(editor.state.doc, current.pos)
    if (!block) return
    // Keep the handle where it is while the menu is open (the pointer leaves the block).
    setHandleLock(editor, true)
    setMenuFor(refOf(block))
  }

  const closeMenu = (refocus: boolean) => {
    setMenuFor(null)
    setHandleLock(editor, false)
    if (refocus) buttonRef.current?.focus()
  }

  if (!editor) return null

  return (
    <>
      <TipTapDragHandle editor={editor} onNodeChange={onDragHandleNodeChange}>
        <button
          ref={buttonRef}
          type="button"
          className={`editor-drag-handle${showDrag || menuFor ? "" : " is-hidden"}${menuFor ? " is-open" : ""}`}
          title="Drag to move, click for the block menu"
          aria-label="Block menu"
          aria-haspopup="menu"
          aria-expanded={!!menuFor}
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
      <MoveToDialog editor={editor} target={moveFor} onClose={() => setMoveFor(null)} />
    </>
  )
}
