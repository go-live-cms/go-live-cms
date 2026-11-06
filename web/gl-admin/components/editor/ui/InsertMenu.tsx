import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { flattenSections, isAdminOnly, searchCatalog, type CatalogEntry, type CatalogMatch, type CatalogSection } from "../blocks/catalog"
import { BlockIcon } from "./BlockIcon"

// The block list both insert menus show (#415, "Inserting blocks"): the slash menu
// (SlashCommand.tsx, focus stays in the text) and the + menu in the gutter
// (AddBlockMenu.tsx, with its own search field). Five groups in the design's order, the
// matched part of a name in bold, the keyword that matched on the right, the "Admins" pill,
// "No blocks match" when nothing does, and the keys in the footer. ↑↓ walk the options in
// screen order, across groups, and wrap.

export interface InsertMenuState {
  sections: CatalogSection[]
  /** The options in screen order (what the arrow keys walk through). */
  options: CatalogMatch[]
  active: number
  setActive: (index: number) => void
  /** Handles ↑ / ↓ (and Home / End when `withHomeEnd`). True when it moved. */
  move: (key: string, withHomeEnd?: boolean) => boolean
  activeEntry: CatalogEntry | null
}

export function useInsertMenu(entries: readonly CatalogEntry[], query: string): InsertMenuState {
  const sections = useMemo(() => searchCatalog(entries, query), [entries, query])
  const options = useMemo(() => flattenSections(sections), [sections])
  const [active, setActive] = useState(0)
  // A new query starts at its first result. Only the query: the slash menu is updated on
  // every transaction (a collaborator typing elsewhere), which mustn't move the highlight.
  useEffect(() => setActive(0), [query])
  const index = options.length === 0 ? -1 : Math.min(active, options.length - 1)

  const move = (key: string, withHomeEnd = false) => {
    const count = options.length
    if (count === 0) return false
    const step: ((at: number) => number) | null =
      key === "ArrowDown"
        ? (at) => (at + 1) % count
        : key === "ArrowUp"
          ? (at) => (at - 1 + count) % count
          : withHomeEnd && key === "Home"
            ? () => 0
            : withHomeEnd && key === "End"
              ? () => count - 1
              : null
    if (!step) return false
    // From the latest index: two keys can arrive before a render.
    setActive((at) => step(Math.min(at, count - 1)))
    return true
  }

  return { sections, options, active: index, setActive, move, activeEntry: options[index]?.entry ?? null }
}

export const optionId = (idPrefix: string, index: number) => `${idPrefix}-option-${index}`

/** `name` with [start, end) in bold. */
function Highlighted({ name, match }: { name: string; match?: [number, number] }) {
  if (!match) return <>{name}</>
  const [start, end] = match
  return (
    <>
      {name.slice(0, start)}
      <b className="editor-insert__match">{name.slice(start, end)}</b>
      {name.slice(end)}
    </>
  )
}

interface ListProps {
  menu: InsertMenuState
  query: string
  idPrefix: string
  onPick: (entry: CatalogEntry) => void
}

export function InsertMenuList({ menu, query, idPrefix, onPick }: ListProps) {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the active option in view as the keys move it.
  useEffect(() => {
    if (menu.active < 0) return
    listRef.current?.ownerDocument.getElementById(optionId(idPrefix, menu.active))?.scrollIntoView?.({ block: "nearest" })
  }, [menu.active, idPrefix])

  if (menu.options.length === 0) {
    return (
      <div role="status" className="editor-insert__empty">
        <b>No blocks match “{query.trim()}”</b>
        <span>Check the spelling, or delete the search to see every block.</span>
      </div>
    )
  }

  let index = 0
  const trimmed = query.trim()
  return (
    <div
      ref={listRef}
      id={`${idPrefix}-list`}
      role="listbox"
      aria-label={trimmed ? `Blocks matching ${trimmed}` : "Blocks"}
      className="editor-insert__list"
    >
      {menu.sections.map((section) => (
        <div key={section.group} role="group" aria-label={section.label}>
          <div className="editor-insert__group" aria-hidden="true">
            {section.label}
          </div>
          {section.matches.map((match) => {
            const i = index++
            const { entry } = match
            const selected = i === menu.active
            return (
              <div
                key={entry.id}
                id={optionId(idPrefix, i)}
                role="option"
                aria-selected={selected}
                className={`editor-insert__option${selected ? " is-active" : ""}`}
                // Keep focus where it is (the text, or the + menu's search field).
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => !selected && menu.setActive(i)}
                onClick={() => onPick(entry)}
              >
                <span className="editor-insert__tile" aria-hidden="true">
                  <BlockIcon icon={entry.icon} />
                </span>
                <span className="editor-insert__name">
                  <Highlighted name={entry.name} match={match.nameMatch} />
                </span>
                {isAdminOnly(entry) && <span className="editor-insert__pill">Admins</span>}
                {match.keyword && (
                  <span className="editor-insert__meta" aria-hidden="true">
                    {match.keyword}
                  </span>
                )}
                {entry.markdown && (
                  <span className="editor-insert__key" aria-hidden="true">
                    {entry.markdown}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/**
 * The footer: the keys while nothing is typed (`idle`), the result count and what ↵
 * inserts while searching, and what Esc does when nothing matches (`noMatch`).
 */
export function InsertMenuFooter({ menu, query, idle, noMatch }: { menu: InsertMenuState; query: string; idle: ReactNode[]; noMatch: ReactNode }) {
  const count = menu.options.length
  let parts: ReactNode[]
  if (count === 0) parts = [noMatch]
  else if (!query.trim()) parts = idle
  else parts = [`${count} result${count === 1 ? "" : "s"}`, menu.activeEntry ? `↵ inserts ${menu.activeEntry.name}` : null]
  return (
    <div className="editor-insert__footer" aria-hidden="true">
      {parts.filter(Boolean).map((part, i) => (
        <span key={i}>{part}</span>
      ))}
    </div>
  )
}
