import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import { Extension, type Editor, type Range } from "@tiptap/core"
import { PluginKey } from "prosemirror-state"
import { Suggestion } from "../utils/suggestion"
import Avatar from "@gl-admin/components/ui/Avatar"
import { searchMentionContent, searchMentionPeople, type MentionContent, type MentionPerson } from "@gl-admin/lib/api/mentions"
import { rememberMentionPeople } from "@gl-admin/lib/mentionNames"
import { flattenMentionSections, mentionSections, optionLabel, type MentionOption } from "@gl-admin/lib/mentionMenu"
import { loadedSiteDateSettings } from "@gl-admin/lib/hooks/useSiteSettings"
import { DEFAULT_DATE_SETTINGS, siteDay } from "@/lib/siteDates"
import { openDateChipDialog } from "./DateChipDialog"

// The @ menu (#320; the canvas's "Editor menus & states" › "Mention / link to content (@)"):
// "@" after a space (or at the start of a line) opens People, "Link to post or page" and the
// dates; what follows the @ searches them. It looks and behaves like the slash menu (#415):
// focus stays in the text, which points at the listbox (aria-controls) and the highlighted
// option (aria-activedescendant); ↑↓ move across groups and wrap, ↵ inserts, Esc closes and
// keeps the typed text (mentionMenuManager), Tab closes it. With a query nothing matches
// (only "Date or reminder" left), ↵ is the editor's again, as in the slash menu.

export const MENTION_MENU_ID = "gl-mention-menu"

/** How long typing pauses before the menu asks the API. */
export const MENTION_SEARCH_DEBOUNCE_MS = 120

export interface MentionMenuListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

interface Props {
  query: string
  command: (option: MentionOption) => void
  editor: Editor
}

interface Results {
  query: string
  people: MentionPerson[]
  content: MentionContent[]
}

// One answer per query for the session (memory only, rule 0), so typing back and forth
// doesn't ask again.
const cache = new Map<string, Results>()

/** Tests: forget the answers. */
export function resetMentionMenuCache(): void {
  cache.clear()
}

function useMentionResults(query: string): { results: Results | null; loading: boolean } {
  const key = query.trim().toLowerCase()
  const [results, setResults] = useState<Results | null>(() => cache.get(key) ?? null)
  const latest = useRef(key)

  useEffect(() => {
    latest.current = key
    const cached = cache.get(key)
    if (cached) {
      setResults(cached)
      return
    }
    const timer = setTimeout(async () => {
      const [people, content] = await Promise.all([
        searchMentionPeople(key).catch(() => [] as MentionPerson[]),
        searchMentionContent(key).catch(() => [] as MentionContent[]),
      ])
      const answer = { query: key, people, content }
      cache.set(key, answer)
      rememberMentionPeople(people)
      if (latest.current === key) setResults(answer)
    }, MENTION_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [key])

  // Results for another query are never shown (they could insert the wrong person).
  const current = results && results.query === key ? results : null
  return { results: current, loading: !current }
}

const optionId = (index: number) => `${MENTION_MENU_ID}-option-${index}`

const CALENDAR_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
)
const POST_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
  </svg>
)
const PAGE_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M9 21V9" />
  </svg>
)

function OptionBody({ option }: { option: MentionOption }) {
  switch (option.kind) {
    case "person":
      return (
        <>
          <Avatar user={{ id: option.person.id, name: option.name, src: option.person.avatar }} size={24} decorative />
          <span className="editor-insert__name">{option.name}</span>
          {option.role && <span className="editor-insert__meta">{option.role}</span>}
        </>
      )
    case "content":
      return (
        <>
          <span className="mention-menu__icon">{option.content.post_type === "page" ? PAGE_ICON : POST_ICON}</span>
          <span className="editor-insert__name">{option.title}</span>
          <span className="editor-insert__meta">{option.typeLabel}</span>
        </>
      )
    case "date":
      return (
        <>
          <span className="mention-menu__icon">{CALENDAR_ICON}</span>
          <span className="editor-insert__name">{option.label}</span>
          {option.date !== "pick" && option.date !== "day" && <span className="editor-insert__meta">{option.day}</span>}
        </>
      )
  }
}

export const MentionMenuList = forwardRef<MentionMenuListRef, Props>(function MentionMenuList({ query, command, editor }, ref) {
  const { results, loading } = useMentionResults(query)
  const today = siteDay(new Date(), loadedSiteDateSettings() ?? DEFAULT_DATE_SETTINGS)
  const sections = useMemo(
    () => mentionSections({ query, people: results?.people ?? [], content: results?.content ?? [], today }),
    [query, results, today]
  )
  const options = useMemo(() => flattenMentionSections(sections), [sections])
  // Only "Date or reminder" left for a typed query: nothing matched, so ↵ stays the editor's
  // until an arrow key picks the row.
  const nothingMatched = !loading && query.trim() !== "" && options.length === 1 && options[0].kind === "date" && options[0].date === "pick"
  const [active, setActive] = useState(0)
  useEffect(() => setActive(nothingMatched ? -1 : 0), [query, nothingMatched])
  const index = options.length === 0 ? -1 : Math.min(active, options.length - 1)
  const listRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      const count = options.length
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (count === 0) return false
        event.preventDefault()
        const down = event.key === "ArrowDown"
        setActive((at) => {
          const from = Math.min(at, count - 1)
          if (from < 0) return down ? 0 : count - 1
          return down ? (from + 1) % count : (from - 1 + count) % count
        })
        return true
      }
      if (event.key === "Enter") {
        const option = index >= 0 ? options[index] : null
        if (!option) return false
        event.preventDefault()
        command(option)
        return true
      }
      return false
    },
  }))

  // The text is the combobox: point it at the list and the active option.
  useEffect(() => {
    if (editor.isDestroyed) return
    const dom = editor.view.dom
    if (index >= 0) {
      dom.setAttribute("aria-controls", `${MENTION_MENU_ID}-list`)
      dom.setAttribute("aria-activedescendant", optionId(index))
      listRef.current?.ownerDocument.getElementById(optionId(index))?.scrollIntoView?.({ block: "nearest" })
    } else {
      dom.removeAttribute("aria-controls")
      dom.removeAttribute("aria-activedescendant")
    }
  }, [editor, index, options])
  useEffect(
    () => () => {
      if (editor.isDestroyed) return
      editor.view.dom.removeAttribute("aria-controls")
      editor.view.dom.removeAttribute("aria-activedescendant")
    },
    [editor]
  )

  let at = 0
  const trimmed = query.trim()
  return (
    <div className="editor-insert mention-menu">
      <div ref={listRef} id={`${MENTION_MENU_ID}-list`} role="listbox" aria-label={trimmed ? `Mention or link matching ${trimmed}` : "Mention or link"} className="editor-insert__list">
        {loading && (
          <div role="status" className="mention-menu__status">
            Searching…
          </div>
        )}
        {nothingMatched && (
          <div role="status" className="mention-menu__status">
            No people or posts match “{trimmed}”
          </div>
        )}
        {sections.map((section, s) => (
          <div key={section.id} role="group" aria-label={section.label}>
            {s > 0 && <div className="mention-menu__divider" aria-hidden="true" />}
            {section.heading && (
              <div className="editor-insert__group" aria-hidden="true">
                {section.label}
              </div>
            )}
            {section.options.map((option) => {
              const i = at++
              const selected = i === index
              return (
                <div
                  key={option.key}
                  id={optionId(i)}
                  role="option"
                  aria-selected={selected}
                  aria-label={optionLabel(option)}
                  className={`editor-insert__option mention-menu__option mention-menu__option--${option.kind}${selected ? " is-active" : ""}`}
                  // Keep focus in the text.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => !selected && setActive(i)}
                  onClick={() => command(option)}
                >
                  <OptionBody option={option} />
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div className="editor-insert__footer" aria-hidden="true">
        {nothingMatched ? <span>{`esc closes the menu and keeps “@${trimmed}” as text`}</span> : ["↑↓ to move", "↵ to insert", "esc to close"].map((part) => <span key={part}>{part}</span>)}
      </div>
    </div>
  )
})

/**
 * What picking an option does: replace the typed "@query" (`range`) with a mention, a link
 * or a date chip, and a space. "Date or reminder" removes the "@query" and opens the date
 * dialog at the caret, which inserts the chip.
 */
export function pickMentionOption(editor: Editor, range: Range, option: MentionOption): void {
  if (!editor.isEditable) return
  switch (option.kind) {
    case "person":
      rememberMentionPeople([option.person])
      editor.chain().focus().insertMention({ userId: option.person.id, label: option.name }, range).run()
      return
    case "content":
      editor.chain().focus().insertContentLink({ postId: option.content.id, label: option.title }, range).run()
      return
    case "date":
      if (option.date === "pick") {
        editor.chain().focus().deleteRange(range).run()
        openDateChipDialog(editor)
        return
      }
      editor.chain().focus().insertDateChip({ date: option.day!, time: null, reminder: false }, range).run()
  }
}

/**
 * Where "@" opens the menu: text that takes inline nodes. Not in code (a code block, or
 * inside the `code` mark), nor in a caption (`text*`: an image's, a table's).
 */
export function mentionMenuAllowed({ state, range }: { state: any; range: { from: number } }): boolean {
  const $at = state.doc.resolve(range.from)
  const parent = $at.parent
  if (parent.type.spec.code) return false
  if (!parent.type.contentMatch.matchType(state.schema.nodes.mention)) return false
  const codeMark = state.schema.marks.code
  return !(codeMark && codeMark.isInSet($at.marks()))
}

export const MentionMenuExtension = Extension.create({
  name: "mentionMenu",

  addOptions() {
    return {
      suggestion: {
        char: "@",
        pluginKey: new PluginKey("mentionMenu"),
        startOfLine: false,
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: MentionOption }) => pickMentionOption(editor, range, props),
        items: () => [] as MentionOption[],
        render: () => ({}),
      },
    }
  },

  addExtensions() {
    return [Suggestion.extend({ name: "mentionSuggestion" }).configure({ ...this.options.suggestion })]
  },
})

export default MentionMenuExtension
