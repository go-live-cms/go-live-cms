import type { Settings, UpdateSettingsRequest } from "@gl-admin/lib/api/settings"

// Settings › Discussion (#527, docs/design/reader-comments.md 12.1; the redesign canvas's
// "Settings · Discussion" and "Discussion settings…" boards): what the page edits, the
// checks it runs before saving, what it sends, and the unsaved-changes bar's words.
//
// The checks are the API's (api/discussion_settings.go), pinned by
// discussionSettingsVectors.json, which both suites run: the form refuses what the API
// refuses, field by field, before a request is made.

/**
 * The site switch ("Allow comments on this site") stays hidden until the moderation queue
 * ships (design section 17: comments can be turned on only after phase 3, which also needs
 * Discussion, #526). #526 sets this to true (and updates the test that pins it); nothing
 * else changes. While it is false the page shows the switch only to turn comments off
 * again if the API already has them on.
 */
export const COMMENTS_SWITCH_READY = false

export type CommentsModeration = NonNullable<Settings["comments_moderation"]>
export type CommentsThreading = NonNullable<Settings["comments_threading"]>
export type CommentsOrder = NonNullable<Settings["comments_order"]>

// The API's bounds (discussionSettingsVectors.json's `limits`).
export const DISCUSSION_LIMITS = {
  comments_max_links: [0, 10],
  comments_close_after_days: [0, 3650],
  comments_per_page: [10, 100],
  word_list_max: 500,
  word_max: 64,
  notice_max: 400,
} as const

export type DiscussionNumberField = "comments_max_links" | "comments_close_after_days" | "comments_per_page"

// The defaults of 12.1, for a response that lacks a field.
const DEFAULTS = {
  comments_moderation: "first" as CommentsModeration,
  comments_max_links: 1,
  comments_close_after_days: 0,
  comments_threading: "replies" as CommentsThreading,
  comments_order: "oldest" as CommentsOrder,
  comments_per_page: 30,
}

/** The form's values: numbers and word lists as typed. */
export interface DiscussionDraft {
  comments_enabled: boolean
  comments_moderation: CommentsModeration
  comments_max_links: string
  comments_hold_words: string
  comments_spam_words: string
  comments_close_after_days: string
  comments_threading: CommentsThreading
  comments_order: CommentsOrder
  comments_per_page: string
  comments_notice: string
  comments_privacy_page_id: number | null
}

export type DiscussionField = keyof DiscussionDraft

export function toDiscussionDraft(settings: Settings): DiscussionDraft {
  return {
    comments_enabled: settings.comments_enabled ?? false,
    comments_moderation: settings.comments_moderation ?? DEFAULTS.comments_moderation,
    comments_max_links: String(settings.comments_max_links ?? DEFAULTS.comments_max_links),
    comments_hold_words: (settings.comments_hold_words ?? []).join("\n"),
    comments_spam_words: (settings.comments_spam_words ?? []).join("\n"),
    comments_close_after_days: String(settings.comments_close_after_days ?? DEFAULTS.comments_close_after_days),
    comments_threading: settings.comments_threading ?? DEFAULTS.comments_threading,
    comments_order: settings.comments_order ?? DEFAULTS.comments_order,
    comments_per_page: String(settings.comments_per_page ?? DEFAULTS.comments_per_page),
    comments_notice: settings.comments_notice ?? "",
    comments_privacy_page_id: settings.comments_privacy_page_id ?? null,
  }
}

// In form order, with the bar's words for each.
const FIELDS: { key: DiscussionField; label: string }[] = [
  { key: "comments_enabled", label: "comments switch" },
  { key: "comments_moderation", label: "moderation" },
  { key: "comments_max_links", label: "link limit" },
  { key: "comments_hold_words", label: "hold words" },
  { key: "comments_spam_words", label: "spam words" },
  { key: "comments_close_after_days", label: "close-after days" },
  { key: "comments_per_page", label: "threads per page" },
  { key: "comments_threading", label: "replies" },
  { key: "comments_order", label: "order" },
  { key: "comments_notice", label: "notice" },
  { key: "comments_privacy_page_id", label: "privacy page" },
]

/** Labels of the fields that differ from what's saved, in form order. */
export function changedDiscussionFields(saved: DiscussionDraft | null, draft: DiscussionDraft): string[] {
  if (!saved) return []
  return FIELDS.filter(({ key }) => saved[key] !== draft[key]).map(({ label }) => label)
}

/** "You changed the hold words", "… the link limit and order", "… 3 settings". */
export function discussionUnsavedMessage(changed: string[]): string {
  if (changed.length === 0) return ""
  if (changed.length === 1) return `You changed the ${changed[0]}`
  if (changed.length === 2) return `You changed the ${changed[0]} and ${changed[1]}`
  return `You changed ${changed.length} settings`
}

// --- The API's checks -----------------------------------------------------------------

// Go's unicode.IsControl (C0 and C1) and the bidi embeddings, overrides and isolates
// (api/discussion_text.go isBidiControl).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const BIDI = /[‪-‮⁦-⁩]/
// Go's strings.TrimSpace (unicode.IsSpace).
const GO_SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
const GO_TRIM = new RegExp(`^[${GO_SPACE}]+|[${GO_SPACE}]+$`, "g")
const goTrim = (s: string) => s.replace(GO_TRIM, "")
const length = (s: string) => Array.from(s).length

export type WordListCode = "entry_invalid" | "entry_too_long" | "too_many"
export type WordListResult = { ok: true; words: string[] } | { ok: false; code: WordListCode; line?: number }

/**
 * A word list as the API stores it (4.2, normalizeDiscussionWords): one entry per line,
 * trimmed, blank lines dropped, duplicates ignoring case kept once in their first place;
 * at most 500 entries of at most 64 characters, one line of plain text each. `line` is the
 * 1-based line of the first problem.
 */
export function normalizeWordList(lines: readonly string[]): WordListResult {
  const words: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const word = goTrim(lines[i])
    if (word === "") continue
    if (CONTROL.test(word) || BIDI.test(word)) return { ok: false, code: "entry_invalid", line: i + 1 }
    if (length(word) > DISCUSSION_LIMITS.word_max) return { ok: false, code: "entry_too_long", line: i + 1 }
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    words.push(word)
  }
  if (words.length > DISCUSSION_LIMITS.word_list_max) return { ok: false, code: "too_many" }
  return { ok: true, words }
}

/** The textarea's lines (CR LF and CR count as line ends, as typed or pasted). */
export function wordLines(text: string): string[] {
  return text === "" ? [] : text.split(/\r\n|\r|\n/)
}

export function wordListError(result: WordListResult): string | null {
  if (result.ok) return null
  switch (result.code) {
    case "entry_too_long":
      return `Line ${result.line} is longer than ${DISCUSSION_LIMITS.word_max} characters.`
    case "entry_invalid":
      return `Line ${result.line} has a character that can't be in a word, such as a tab.`
    case "too_many":
      return `Keep it to ${DISCUSSION_LIMITS.word_list_max} entries or fewer.`
  }
}

export type NoticeCode = "not_one_line" | "too_long"
export type NoticeResult = { ok: true; notice: string } | { ok: false; code: NoticeCode }

/** The notice as the API stores it (7.5): trimmed, one line of plain text, at most 400 characters. */
export function normalizeNotice(raw: string): NoticeResult {
  const notice = goTrim(raw)
  if (CONTROL.test(notice) || BIDI.test(notice)) return { ok: false, code: "not_one_line" }
  if (length(notice) > DISCUSSION_LIMITS.notice_max) return { ok: false, code: "too_long" }
  return { ok: true, notice }
}

/** A whole number in the field's range, or null. */
export function rangeValue(field: DiscussionNumberField, typed: string): number | null {
  const text = typed.trim()
  if (!/^-?\d+$/.test(text)) return null
  const value = Number(text)
  const [lo, hi] = DISCUSSION_LIMITS[field]
  return value >= lo && value <= hi ? value : null
}

/** The field errors the form shows, keyed by field; empty when it may save. */
export function validateDiscussionDraft(draft: DiscussionDraft): Partial<Record<DiscussionField, string>> {
  const errors: Partial<Record<DiscussionField, string>> = {}
  for (const field of ["comments_max_links", "comments_close_after_days", "comments_per_page"] as const) {
    if (rangeValue(field, draft[field]) === null) {
      const [lo, hi] = DISCUSSION_LIMITS[field]
      errors[field] = `Enter a number from ${lo} to ${hi}.`
    }
  }
  for (const field of ["comments_hold_words", "comments_spam_words"] as const) {
    const message = wordListError(normalizeWordList(wordLines(draft[field])))
    if (message) errors[field] = message
  }
  const notice = normalizeNotice(draft.comments_notice)
  if (!notice.ok) {
    errors.comments_notice =
      notice.code === "too_long"
        ? `Keep it to ${DISCUSSION_LIMITS.notice_max} characters or fewer.`
        : "Write the notice as one line of plain text, without line breaks or tabs."
  }
  return errors
}

/**
 * The PUT /settings body: only the fields that changed (the API keeps what's absent), as
 * the API reads them. Call after validateDiscussionDraft found nothing.
 */
export function toDiscussionRequest(draft: DiscussionDraft, saved: DiscussionDraft): UpdateSettingsRequest {
  const body: UpdateSettingsRequest = {}
  const changed = (key: DiscussionField) => draft[key] !== saved[key]
  if (changed("comments_enabled")) body.comments_enabled = draft.comments_enabled
  if (changed("comments_moderation")) body.comments_moderation = draft.comments_moderation
  if (changed("comments_threading")) body.comments_threading = draft.comments_threading
  if (changed("comments_order")) body.comments_order = draft.comments_order
  for (const field of ["comments_max_links", "comments_close_after_days", "comments_per_page"] as const) {
    const value = rangeValue(field, draft[field])
    if (changed(field) && value !== null) body[field] = value
  }
  for (const field of ["comments_hold_words", "comments_spam_words"] as const) {
    const result = normalizeWordList(wordLines(draft[field]))
    if (changed(field) && result.ok) body[field] = result.words
  }
  const notice = normalizeNotice(draft.comments_notice)
  if (changed("comments_notice") && notice.ok) body.comments_notice = notice.notice
  // Only a change: the API checks that a chosen page is published, and a saved one that
  // was unpublished since mustn't stop the other fields from saving (as the front page).
  if (changed("comments_privacy_page_id")) body.comments_privacy_page_id = draft.comments_privacy_page_id
  return body
}

/** Whether the switch shows: once #526 ships, or while comments are on, to turn them off. */
export function showCommentsSwitch(saved: DiscussionDraft, ready: boolean = COMMENTS_SWITCH_READY): boolean {
  return ready || saved.comments_enabled
}

/**
 * Off shows the switch alone (the board): the rest applies only while comments are on. It
 * follows the draft, so turning the switch on shows the rest at once.
 */
export function showDiscussionDetails(draft: DiscussionDraft): boolean {
  return draft.comments_enabled
}

/**
 * A 400 the form didn't predict, placed on its field: `invalid_discussion_settings`
 * ("comments_max_links must be between 0 and 10", writeDiscussionSettingsError) or
 * `invalid_privacy_page` (the page isn't published any more). Null for anything else.
 */
export function apiFieldError(code: string | null, serverMessage: string | null): { field: DiscussionField; message: string } | null {
  if (code === "invalid_privacy_page") {
    return { field: "comments_privacy_page_id", message: "Choose a published page, or None. This one isn't published any more." }
  }
  if (code !== "invalid_discussion_settings" || !serverMessage) return null
  const space = serverMessage.indexOf(" ")
  const field = serverMessage.slice(0, space) as DiscussionField
  const rest = serverMessage.slice(space + 1)
  if (space < 0 || !FIELDS.some((f) => f.key === field) || !rest) return null
  // "must be between 0 and 10" → "It must be between 0 and 10."; "entries must …" → "Entries must …".
  const text = rest.startsWith("entries") ? rest[0].toUpperCase() + rest.slice(1) : `It ${rest}`
  return { field, message: `${text}.` }
}

export const MODERATION_OPTIONS: { value: CommentsModeration; label: string; description: string }[] = [
  { value: "all", label: "Hold every comment", description: "Nothing reaches the page until an editor or admin approves it." },
  {
    value: "first",
    label: "Hold until a commenter has one approved",
    description: "A commenter’s first comment waits; after that they publish at once. Recommended.",
  },
  { value: "none", label: "Publish when no rule holds it", description: "The rules below still hold a comment, or send it to Spam." },
]

export const THREADING_OPTIONS: { value: CommentsThreading; label: string }[] = [
  { value: "replies", label: "Threaded" },
  { value: "flat", label: "Flat" },
]

export const ORDER_OPTIONS: { value: CommentsOrder; label: string }[] = [
  { value: "oldest", label: "Oldest first" },
  { value: "newest", label: "Newest first" },
]
