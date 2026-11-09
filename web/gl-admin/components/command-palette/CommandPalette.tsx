import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import Avatar from "@gl-admin/components/ui/Avatar"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import { SearchIcon } from "@gl-admin/components/ui/icons"
import { useEscape, useFocusTrap, useStableId } from "@gl-admin/components/ui/a11y"
import { useScrollLock } from "@gl-admin/components/ui/Modal"
import NavIcon from "@gl-admin/components/sidebar/NavIcon"
import { searchCommandPalette, type CommandPaletteResults } from "@gl-admin/lib/api/commandPalette"
import { getMediaVariantPreviewURL } from "@gl-admin/lib/api/media"
import {
  COMMAND_PALETTE_DEBOUNCE_MS,
  flattenPaletteSections,
  isCommandPaletteShortcut,
  isEditorFocused,
  onCommandPaletteOpen,
  paletteActions,
  paletteSections,
  type PaletteOption,
} from "@gl-admin/lib/commandPalette"
import { useCurrentRole } from "@gl-admin/lib/hooks/useCurrentRole"
import { mediaKind } from "@gl-admin/lib/mediaLibrary"
import { canCreateContent } from "@gl-admin/lib/roles"
import "@gl-admin/assets/styles/components/ui/modal.scss"
import "@gl-admin/assets/styles/components/command-palette.scss"

// The command palette (#41; the canvas's "Search · command palette"). Ctrl K anywhere but
// in the block editor, where it stays the link dialog, or the sidebar's Search button.
// Looks and works like the + menu (#415): the field has focus and is the combobox for the
// listbox, ↑↓ move across groups and wrap, ↵ opens, the matched part is in bold, the keys
// are in the footer. It's a modal dialog, so Esc or the scrim closes it, Tab stays inside
// and focus goes back to where it was.

interface SearchState {
  key: string
  results: CommandPaletteResults | null
  failed: boolean
}

// The answer for what's typed now, and only that: every change cancels the request before
// it, and an answer for other text is never shown (it could open the wrong post).
function usePaletteSearch(query: string, enabled: boolean): { results: CommandPaletteResults | null; loading: boolean; failed: boolean } {
  const key = query.trim()
  const [state, setState] = useState<SearchState>({ key: "", results: null, failed: false })

  useEffect(() => {
    if (!enabled || !key) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchCommandPalette(key, controller.signal).then(
        (results) => {
          if (!controller.signal.aborted) setState({ key, results, failed: false })
        },
        () => {
          if (!controller.signal.aborted) setState({ key, results: null, failed: true })
        }
      )
    }, COMMAND_PALETTE_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [key, enabled])

  const current = state.key === key ? state : null
  return {
    results: current?.results ?? null,
    loading: enabled && key !== "" && !current,
    failed: !!current?.failed,
  }
}

const optionId = (idPrefix: string, index: number) => `${idPrefix}-option-${index}`

function Label({ option }: { option: PaletteOption }) {
  if (!option.match) return <>{option.label}</>
  const [start, end] = option.match
  return (
    <>
      {option.label.slice(0, start)}
      <b className="gl-command-palette__match">{option.label.slice(start, end)}</b>
      {option.label.slice(end)}
    </>
  )
}

const TAG_ICON = <NavIcon name="tag" size={14} />

function Lead({ option }: { option: PaletteOption }) {
  if (option.kind === "user") {
    return <Avatar user={{ id: option.user.id, name: option.label, src: option.user.avatar }} size={24} decorative />
  }
  if (option.kind === "media" && mediaKind(option.media) === "image") {
    return <img className="gl-command-palette__thumb" src={getMediaVariantPreviewURL(option.media, "thumb")} alt="" />
  }
  return (
    <span className="gl-command-palette__tile" aria-hidden="true">
      {option.kind === "term" ? TAG_ICON : <NavIcon name={option.kind === "media" ? "media" : option.icon} size={14} />}
    </span>
  )
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const role = useCurrentRole()
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const idPrefix = useStableId("gl-command-palette")
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)

  useScrollLock(true)
  useEscape(true, onClose)
  useFocusTrap(dialogRef, true, { initialFocus: inputRef })

  const trimmed = query.trim()
  // Only content roles may call the search (requireContentAuthor).
  const { results, loading, failed } = usePaletteSearch(query, canCreateContent(role))
  const actions = useMemo(() => paletteActions(role), [role])
  const sections = useMemo(() => paletteSections({ query, actions, results }), [query, actions, results])
  const options = useMemo(() => flattenPaletteSections(sections), [sections])
  const index = options.length === 0 ? -1 : Math.min(active, options.length - 1)
  const activeOption = index >= 0 ? options[index] : null

  // A new query starts at its first result.
  useEffect(() => setActive(0), [query])

  // Keep the active option in view as the keys move it.
  useEffect(() => {
    if (index < 0) return
    listRef.current?.ownerDocument.getElementById(optionId(idPrefix, index))?.scrollIntoView?.({ block: "nearest" })
  }, [index, idPrefix])

  const pick = (option: PaletteOption) => {
    onClose()
    navigate(option.to)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === "Enter") {
      e.preventDefault()
      if (activeOption) pick(activeOption)
      return
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    e.preventDefault()
    const count = options.length
    if (count === 0) return
    const step = e.key === "ArrowDown" ? 1 : -1
    // From the latest index: two keys can arrive before a render.
    setActive((at) => (Math.min(at, count - 1) + step + count) % count)
  }

  const noResults = trimmed !== "" && !loading && !failed && options.length === 0
  const status = loading ? "Searching…" : failed ? "Search failed" : noResults ? `No results for ${trimmed}` : trimmed ? `${options.length} result${options.length === 1 ? "" : "s"}` : ""
  let footer: string[]
  if (loading) footer = ["Searching…", "esc to close"]
  else if (noResults || failed) footer = ["esc to close"]
  else if (!trimmed || !activeOption) footer = ["↑↓ to move", "↵ to open", "esc to close"]
  else footer = [`${options.length} result${options.length === 1 ? "" : "s"}`, `↵ opens ${activeOption.label}`, "esc to close"]

  let at = 0
  return (
    <div
      className="gl-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Search" tabIndex={-1} className="gl-modal gl-command-palette">
        <div className="gl-command-palette__search">
          <SearchIcon size={16} />
          <label htmlFor={`${idPrefix}-input`} className="gl-command-palette__sr">
            Search
          </label>
          <input
            ref={inputRef}
            id={`${idPrefix}-input`}
            type="text"
            className="gl-command-palette__input"
            role="combobox"
            aria-expanded={options.length > 0}
            aria-controls={options.length > 0 ? `${idPrefix}-list` : undefined}
            aria-activedescendant={index >= 0 ? optionId(idPrefix, index) : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search or jump to…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="gl-command-palette__key" aria-hidden="true">
            esc
          </kbd>
        </div>

        {options.length > 0 && (
          <div ref={listRef} id={`${idPrefix}-list`} role="listbox" aria-label={trimmed ? `Results for ${trimmed}` : "Jump to"} className="gl-command-palette__list">
            {sections.map((section) => (
              <div key={section.id} role="group" aria-label={section.label}>
                <div className="gl-command-palette__group" aria-hidden="true">
                  {section.label}
                </div>
                {section.options.map((option) => {
                  const i = at++
                  const selected = i === index
                  return (
                    <div
                      key={option.key}
                      id={optionId(idPrefix, i)}
                      role="option"
                      aria-selected={selected}
                      aria-label={option.meta ? `${option.label}, ${option.meta}` : option.label}
                      className={`gl-command-palette__option${selected ? " is-active" : ""}`}
                      // Keep focus in the field.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => !selected && setActive(i)}
                      onClick={() => pick(option)}
                    >
                      <Lead option={option} />
                      <span className="gl-command-palette__name">
                        <Label option={option} />
                      </span>
                      {option.meta && <span className="gl-command-palette__meta">{option.meta}</span>}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}

        {loading && (
          <div className="gl-command-palette__skeleton" aria-hidden="true">
            {["46%", "62%", "38%"].map((width) => (
              <div key={width} className="gl-command-palette__skeleton-row">
                <Skeleton width={24} height={24} />
                <Skeleton shape="text" width={width} />
              </div>
            ))}
          </div>
        )}

        {noResults && (
          <div className="gl-command-palette__empty">
            <b>No results for “{trimmed}”</b>
            <span>Check the spelling, or try a different word.</span>
          </div>
        )}

        {failed && (
          <div className="gl-command-palette__empty">
            <b>Search isn't available</b>
            <span>Check your connection and try again.</span>
          </div>
        )}

        <div role="status" className="gl-command-palette__sr">
          {status}
        </div>

        <div className="gl-command-palette__footer" aria-hidden="true">
          {footer.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

// Another dialog or drawer is open: it holds focus (its Tab trap would pull focus out of
// the palette) and its work would be lost by a jump to another page.
const modalOpen = () => document.querySelector('[aria-modal="true"]') !== null

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const { pathname, search } = useLocation()
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => onCommandPaletteOpen(() => setOpen(true)), [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isCommandPaletteShortcut(e)) return
      if (!openRef.current && (isEditorFocused(document.activeElement) || modalOpen())) return
      e.preventDefault()
      if (!e.repeat) setOpen(!openRef.current)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // Back or forward while it's open.
  useEffect(() => setOpen(false), [pathname, search])

  return open ? <PaletteDialog onClose={() => setOpen(false)} /> : null
}
