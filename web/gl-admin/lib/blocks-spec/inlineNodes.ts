// Inline nodes (#320): an @ mention, a link to a post or page, and a date chip. They live
// inside a text block's `pm` (paragraphs, headings, list items, quotes, table cells), so
// no block type changes and no block version is bumped: an older renderer shows nothing
// for them (an unknown inline node renders null).
//
// What each one stores, and why:
// - `mention` {userId, label}: the member's id, and their name when it was inserted (a
//   fallback for a member removed since, and the text the plain-text `text` attr and
//   search read). The editor shows the member's current name; the public API replaces the
//   whole attrs with `{label: <current name>}`, so neither an id nor an email ever reaches
//   the site (api/inline_nodes.go).
// - `contentLink` {postId, label}: the target post's id and the link text the author
//   inserted (its title then). The URL is never stored: the public API resolves the post's
//   current URL at read time (slug changes, #331's category URLs), and leaves the href out
//   when the target isn't published (a draft, the trash, a private type), so the site
//   shows the text without a link.
// - `dateChip` {date, time, reminder}: a calendar day (YYYY-MM-DD), an optional time
//   (HH:MM, the site's time zone) and whether its author asked to be reminded then. It is
//   formatted when rendered, in the site's language and date format. The reminder's
//   author is never in the doc: the API takes it from the collab store's per-block
//   attribution (#328), which a client can't forge.
//
// Every value is checked the same way by the editor's parse rules, the paste sanitizer,
// the API's sanitizer (`inlineNodeVectors.json` is shared with its tests) and the
// renderer: an attr that doesn't pass is dropped (null), and a node without its id or
// date is left out.

/** ProseMirror node names (also the Yjs element names). */
export const MENTION_NODE = "mention"
export const CONTENT_LINK_NODE = "contentLink"
export const DATE_CHIP_NODE = "dateChip"

export const INLINE_NODE_NAMES = [MENTION_NODE, CONTENT_LINK_NODE, DATE_CHIP_NODE] as const

/** A mention's and a content link's stored label, in code points. */
export const INLINE_LABEL_MAX_LENGTH = 200

/** A user or post id: a positive integer (JSON numbers, or digits from HTML). */
export function normalizeEntityId(value: unknown): number | null {
  const n = typeof value === "string" && /^\d{1,15}$/.test(value.trim()) ? Number(value.trim()) : value
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * A label as stored: one line (control characters become spaces, runs of whitespace one
 * space), trimmed, at most INLINE_LABEL_MAX_LENGTH code points; null when empty.
 */
export function normalizeInlineLabel(value: unknown): string | null {
  if (typeof value !== "string") return null
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim()
  if (!line) return null
  const chars = Array.from(line)
  return chars.length > INLINE_LABEL_MAX_LENGTH ? chars.slice(0, INLINE_LABEL_MAX_LENGTH).join("").trim() : line
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** A real calendar day as YYYY-MM-DD (years 1000–9999), else null. */
export function normalizeChipDate(value: unknown): string | null {
  if (typeof value !== "string") return null
  const match = DATE_RE.exec(value.trim())
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (year < 1000 || month < 1 || month > 12 || day < 1) return null
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day <= daysInMonth ? match[0] : null
}

/** HH:MM on a 24-hour clock, else null. */
export function normalizeChipTime(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return TIME_RE.test(trimmed) ? trimmed : null
}

/** A reminder is `true` or nothing. */
export function normalizeReminder(value: unknown): boolean {
  return value === true || value === "true"
}

/** The time a reminder fires when its chip has no time of its own (site time zone). */
export const DEFAULT_REMINDER_TIME = "09:00"

export interface MentionAttrs {
  userId: number
  label: string | null
}

export interface ContentLinkAttrs {
  postId: number
  label: string | null
}

export interface DateChipAttrs {
  date: string
  time: string | null
  reminder: boolean
}

/** A mention node's attrs as stored, or null when it has no valid user id. */
export function mentionAttrs(attrs: Record<string, unknown> | null | undefined): MentionAttrs | null {
  const userId = normalizeEntityId(attrs?.userId)
  return userId === null ? null : { userId, label: normalizeInlineLabel(attrs?.label) }
}

/** A content link node's attrs as stored, or null when it has no valid post id. */
export function contentLinkAttrs(attrs: Record<string, unknown> | null | undefined): ContentLinkAttrs | null {
  const postId = normalizeEntityId(attrs?.postId)
  return postId === null ? null : { postId, label: normalizeInlineLabel(attrs?.label) }
}

/** A date chip's attrs as stored, or null when it has no valid date. A reminder always has a time. */
export function dateChipAttrs(attrs: Record<string, unknown> | null | undefined): DateChipAttrs | null {
  const date = normalizeChipDate(attrs?.date)
  if (date === null) return null
  const reminder = normalizeReminder(attrs?.reminder)
  const time = normalizeChipTime(attrs?.time) ?? (reminder ? DEFAULT_REMINDER_TIME : null)
  return { date, time, reminder }
}

/** "2026-11-12" → that day at 12:00 UTC: formatted in UTC it is the same calendar day everywhere. */
export function chipDateInstant(date: string): Date {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12))
}

/** "14:30" → "2:30 PM" (en-US) or "14:30", in `language`. */
export function formatChipTime(time: string, language = "en-US"): string {
  const [h, m] = time.split(":").map(Number)
  try {
    return new Intl.DateTimeFormat(language, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2000, 0, 1, h, m)))
  } catch {
    return time
  }
}
