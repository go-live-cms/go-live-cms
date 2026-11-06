import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react"
import { createPortal } from "react-dom"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { useClickOutside, useFloating, useStableId } from "@gl-admin/components/ui/a11y"
import { toast } from "@gl-admin/components/ui/Toast"
import { authManager } from "@gl-admin/lib/auth"
import { getActiveTheme, menuEntries, type CatalogEntry } from "../blocks/catalog"
import { insertFromGutter } from "../utils/blockGutter"
import type { BlockRef } from "../utils/blockActions"
import { InsertMenuFooter, InsertMenuList, optionId, useInsertMenu } from "./InsertMenu"

// The + menu (#415, "+ in the margin, opened from the keyboard"): the block catalog under
// the gutter's + with its own search field, which has focus and is the combobox for the
// list. Typing filters, ↑↓ move across groups, ↵ inserts (into the line + is on when it's
// empty, else on a new line below it), Esc closes and returns focus to +, Tab closes.

type Props = {
  editor: TiptapEditor
  target: BlockRef
  anchor: RefObject<HTMLElement | null>
  onClose: (refocus: boolean) => void
  /** Tests: the entries to offer instead of the catalog's for the signed-in user. */
  entries?: readonly CatalogEntry[]
}

export default function AddBlockMenu({ editor, target, anchor, onClose, entries: given }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const idPrefix = useStableId("gl-add-block")
  const [query, setQuery] = useState("")
  const { style, ready } = useFloating(anchor, menuRef, true, "bottom-start")
  // Read once per opening: the role and theme don't change while it's open.
  const entries = useMemo(
    () => given ?? menuEntries({ role: authManager.getState().user?.role, theme: getActiveTheme() }),
    [given]
  )
  const menu = useInsertMenu(entries, query)

  useClickOutside([menuRef, anchor], true, () => onClose(false))

  useEffect(() => {
    if (ready) inputRef.current?.focus()
  }, [ready])

  const pick = (entry: CatalogEntry) => {
    // The text takes focus now, not a frame later (TipTap's focus()), so what's typed
    // straight after ↵ goes into the new block.
    if (!editor.isDestroyed) editor.view.focus()
    onClose(false)
    if (!insertFromGutter(editor, target, entry)) toast.warning("That block isn't in the post any more")
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
      return
    }
    if (e.key === "Tab") {
      onClose(false)
      return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      if (menu.activeEntry) pick(menu.activeEntry)
      return
    }
    if (menu.move(e.key)) e.preventDefault()
  }

  const host = typeof document !== "undefined" ? (document.getElementById("admin") ?? document.body) : null
  if (!host) return null

  const hasOptions = menu.options.length > 0
  return createPortal(
    <div ref={menuRef} className="editor-insert editor-insert--add" style={style}>
      <div className="editor-insert__search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <label htmlFor={`${idPrefix}-search`} className="editor-insert__label">
          Search blocks
        </label>
        <input
          ref={inputRef}
          id={`${idPrefix}-search`}
          type="text"
          className="editor-insert__input"
          role="combobox"
          aria-expanded={hasOptions}
          aria-controls={hasOptions ? `${idPrefix}-list` : undefined}
          aria-activedescendant={menu.active >= 0 ? optionId(idPrefix, menu.active) : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search blocks"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <InsertMenuList menu={menu} query={query} idPrefix={idPrefix} onPick={pick} />
      <InsertMenuFooter menu={menu} query={query} idle={["Type to search", "↑↓ ↵", "esc returns to +"]} noMatch="esc returns to +" />
    </div>,
    host
  )
}
