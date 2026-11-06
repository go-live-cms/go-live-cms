import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from "react"
import { createPortal } from "react-dom"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { NodeSelection } from "prosemirror-state"
import { defaultComputePositionConfig } from "@tiptap/extension-drag-handle"
import BlockMenu from "./BlockMenu"
import MoveToDialog from "./MoveToDialog"
import AddBlockMenu from "./AddBlockMenu"
import { refOf, resolveBlock, type BlockRef } from "../utils/blockActions"
import { createGutterPlugin, gutterPluginKey } from "../utils/gutterPlugin"
import type { EditorBlock } from "../utils/blockTree"

// The gutter beside the hovered block ("Post editor"; "Inserting blocks"), at any depth
// (#417): + opens the block catalog with its own search field (#415, AddBlockMenu), the drag
// handle drags to move (into or out of a group, by the nesting table), and clicking it (or
// Enter/Space on it) opens the block menu (#356): Colour, Duplicate, Copy link to block,
// Move to, Delete, and Comment (#192) when the post has comments. Turn into and "Last
// edited by" aren't built here.
//
// The gutter follows the pointer (utils/gutterPlugin.ts). From the keyboard, Tab in the
// text or on a selected block shows it at that block and focuses + (BlockGutterKeys); Tab
// again reaches the drag handle, then the block's own toolbar when it has one (a group's
// Width and Background). The menus and the Move to dialog render outside this element (a
// portal / Modal): the plugin moves the gutter into the editor's DOM.

/**
 * Pins the gutter (and its hovered block) while a menu is open. A meta-only transaction:
 * no doc change, nothing reaches Yjs.
 */
export function setHandleLock(editor: TiptapEditor, locked: boolean) {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta("lockDragHandle", locked))
}

type Storage = Record<string, { openMoveTo?: ((ref: BlockRef) => void) | null; focusAddButton?: ((ref: BlockRef) => boolean) | null }>

/** The first control of the block's own toolbar (`data-block-toolbar`), if it has one. */
function blockToolbarControl(editor: TiptapEditor, block: EditorBlock): HTMLElement | null {
  const dom = editor.view.nodeDOM(block.pos)
  if (!(dom instanceof HTMLElement)) return null
  const toolbar = Array.from(dom.children).find((child) => child instanceof HTMLElement && child.hasAttribute("data-block-toolbar"))
  return (toolbar as HTMLElement | undefined)?.querySelector<HTMLElement>("button:not([disabled])") ?? null
}

export default function DragHandle({
  editor,
  postUrl,
  onComment,
}: {
  editor: TiptapEditor
  postUrl?: string | null
  onComment?: (ref: BlockRef) => void
}) {
  const [showDrag, setShowDrag] = useState(false)
  // The hovered block by id (its position as a fallback), so an edit by anyone between
  // showing the gutter and pressing + or the handle never retargets it.
  const hovered = useRef<BlockRef | null>(null)
  // The plugin moves this element into the editor's DOM; React renders into it (a portal),
  // so it never loses track of its children.
  const [host] = useState(() => {
    const element = document.createElement("div")
    element.className = "editor-gutter-host"
    return element
  })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const gutter = useRef<ReturnType<typeof createGutterPlugin> | null>(null)
  const [menuFor, setMenuFor] = useState<BlockRef | null>(null)
  const [addFor, setAddFor] = useState<BlockRef | null>(null)
  const [moveFor, setMoveFor] = useState<BlockRef | null>(null)

  const onBlockChange = useCallback((block: EditorBlock | null) => {
    hovered.current = block ? refOf(block) : null
    // Every block but an empty line: images and dividers have a menu too. An empty line
    // has + only (the design's "An empty line between blocks").
    setShowDrag(!!block && !(block.node.isTextblock && block.node.content.size === 0))
  }, [])

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const plugin = createGutterPlugin({
      element: host,
      dragSource: () => buttonRef.current,
      computePositionConfig: defaultComputePositionConfig,
      onBlockChange,
    })
    gutter.current = plugin
    editor.registerPlugin(plugin.plugin)
    return () => {
      gutter.current = null
      if (!editor.isDestroyed) editor.unregisterPlugin(gutterPluginKey)
      host.remove()
    }
  }, [editor, host, onBlockChange])

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

  // Tab in the text or on a selected block: show the gutter at that block and focus + (blockGutter.ts).
  useEffect(() => {
    if (!editor) return
    const storage = (editor.storage as unknown as Storage).blockGutter
    if (!storage) return
    storage.focusAddButton = (ref) => {
      if (!gutter.current?.place(ref)) return false
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

  // Esc returns focus to +; inserting leaves it in the new block.
  const closeAdd = (refocus: boolean) => {
    setAddFor(null)
    setHandleLock(editor, false)
    if (refocus) addRef.current?.focus()
  }

  // Tab on the handle: on to the block's own toolbar ("Keyboard": "reach its + and drag
  // handle, then its toolbar"). The block is selected so its toolbar shows.
  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Tab" || event.shiftKey || menuFor) return
    const block = currentBlock()
    if (!block) return
    if (!(editor.state.selection instanceof NodeSelection && editor.state.selection.from === block.pos)) {
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, block.pos)))
    }
    const control = blockToolbarControl(editor, block)
    if (!control) return
    event.preventDefault()
    control.focus()
  }

  if (!editor) return null

  return (
    <>
      {createPortal(
        <div className="editor-gutter">
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
            draggable={false}
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
            onKeyDown={onHandleKeyDown}
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
        </div>,
        host,
      )}
      {menuFor && (
        <BlockMenu
          editor={editor}
          target={menuFor}
          anchor={buttonRef}
          postUrl={postUrl}
          onClose={closeMenu}
          onMoveTo={(ref) => setMoveFor(ref)}
          onComment={onComment}
        />
      )}
      {addFor && <AddBlockMenu editor={editor} target={addFor} anchor={addRef} onClose={closeAdd} />}
      <MoveToDialog editor={editor} target={moveFor} onClose={() => setMoveFor(null)} />
    </>
  )
}
