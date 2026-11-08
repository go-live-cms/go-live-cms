import type { MentionContent, MentionPerson } from "./api/mentions"
import { roleLabel } from "./roles"
import { normalizeChipDate } from "./blocks-spec/inlineNodes"

// The @ menu (#320, the canvas's "Editor menus & states" › "Mention / link to content (@)"):
// People, then "Link to post or page", then the dates, in that order, one list the arrow
// keys walk through (and wrap). Pure, so the order, the date options and what each one
// inserts are tested without an editor (mentionMenu.test.ts).

export type DateOptionKind = "today" | "tomorrow" | "day" | "pick"

export type MentionOption =
  | { kind: "person"; key: string; person: MentionPerson; name: string; role: string }
  | { kind: "content"; key: string; content: MentionContent; title: string; typeLabel: string }
  | { kind: "date"; key: string; date: DateOptionKind; label: string; day?: string }

export interface MentionSection {
  id: "people" | "content" | "dates"
  /** The group's heading; the dates have none on the canvas (a divider, then the row). */
  label: string
  heading: boolean
  options: MentionOption[]
}

/** How many of each the menu shows (the API answers at most that many). */
export const MENTION_MENU_LIMIT = 5

export const DATE_OR_REMINDER_LABEL = "Date or reminder"

export function personName(person: Pick<MentionPerson, "full_name" | "username">): string {
  return person.full_name.trim() || person.username
}

/** YYYY-MM-DD plus `days`, on the calendar (no time zone involved). */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + days))
  return next.toISOString().slice(0, 10)
}

const startsWord = (text: string, query: string) => text.toLowerCase().split(/\s+/).some((word) => word.startsWith(query))

/**
 * The date rows for `query`: Today and Tomorrow (while the query is empty or starts one of
 * their words, or "date"), a typed YYYY-MM-DD day, and always "Date or reminder" (opens
 * the date dialog). `today` is the site's day (`siteDay`).
 */
export function dateOptions(query: string, today: string): MentionOption[] {
  const q = query.trim().toLowerCase()
  const options: MentionOption[] = []
  const quick = (kind: "today" | "tomorrow", label: string, day: string) => {
    if (!q || startsWord(label, q) || "date".startsWith(q)) options.push({ kind: "date", key: `date-${kind}`, date: kind, label, day })
  }
  quick("today", "Today", today)
  quick("tomorrow", "Tomorrow", addDays(today, 1))
  const typed = normalizeChipDate(q)
  if (typed) options.push({ kind: "date", key: `date-day-${typed}`, date: "day", label: typed, day: typed })
  options.push({ kind: "date", key: "date-pick", date: "pick", label: DATE_OR_REMINDER_LABEL })
  return options
}

/** The menu's groups for these results; an empty group is left out. */
export function mentionSections({
  query,
  people,
  content,
  today,
}: {
  query: string
  people: readonly MentionPerson[]
  content: readonly MentionContent[]
  today: string
}): MentionSection[] {
  const sections: MentionSection[] = []
  const personOptions: MentionOption[] = people.slice(0, MENTION_MENU_LIMIT).map((person) => ({
    kind: "person",
    key: `person-${person.id}`,
    person,
    name: personName(person),
    role: roleLabel(person.role) ?? "",
  }))
  if (personOptions.length) sections.push({ id: "people", label: "People", heading: true, options: personOptions })
  const contentOptions: MentionOption[] = content.slice(0, MENTION_MENU_LIMIT).map((post) => ({
    kind: "content",
    key: `content-${post.id}`,
    content: post,
    title: post.title.trim() || "Untitled",
    typeLabel: post.post_type_label || post.post_type,
  }))
  if (contentOptions.length) sections.push({ id: "content", label: "Link to post or page", heading: true, options: contentOptions })
  sections.push({ id: "dates", label: "Dates", heading: false, options: dateOptions(query, today) })
  return sections
}

export function flattenMentionSections(sections: readonly MentionSection[]): MentionOption[] {
  return sections.flatMap((section) => section.options)
}

/** What a row reads as for a screen reader (the visible role and type are part of it). */
export function optionLabel(option: MentionOption): string {
  switch (option.kind) {
    case "person":
      return option.role ? `${option.name}, ${option.role}` : option.name
    case "content":
      return `${option.title}, ${option.typeLabel}`
    case "date":
      return option.date === "pick" ? `${DATE_OR_REMINDER_LABEL}…` : option.label
  }
}
