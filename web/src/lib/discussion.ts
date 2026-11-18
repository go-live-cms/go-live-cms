// Reader comments (#499; rules #522, docs/design/reader-comments.md 6.3 and 12.4).
//
// The TypeScript twins of api/discussion.go and api/discussion_text.go: the discussion
// state rule, for the admin's Discussion section and the renderer, and the text rules,
// for the form's counter. The API has the last word (the text is validated once, in Go).
// Both suites run discussionStateVectors.json and discussionTextVectors.json, so the two
// agree by construction. Import-free, so the public site and the admin can both use it.

// --- The state rule (12.4) ----------------------------------------------------------

/** posts.discussion (12.3). */
export type PostDiscussion = "default" | "open" | "closed" | "off"

export type DiscussionStateName = "open" | "closed" | "off"

/** What the rule reads from Settings › Discussion. */
export interface DiscussionSite {
  comments_enabled: boolean
  comments_close_after_days: number
}

/** What it reads from the post's type: served by the site (public and active), and its fields. */
export interface DiscussionType {
  public: boolean
  supports: readonly string[]
}

/** What it reads from the post. */
export interface DiscussionPost {
  discussion: PostDiscussion | string
  first_published_at: string | null
}

/**
 * The clock-free half of the rule: what a cached `/public` answer carries. `closes_at` is
 * when an open state ends ("close after N days"), or null.
 */
export interface DiscussionSetting {
  state: DiscussionStateName
  closes_at: string | null
}

/** The post type's Comments field (12.2). */
export const COMMENTS_SUPPORT = "comments"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 12.4 without the clock:
 *   off     if the site is off, the post's choice is Off, the type isn't served, or the
 *           post follows the default and its type has no Comments field;
 *   closed  if the post's choice is Closed;
 *   open    otherwise, closing first_published_at + close_after_days later when the post
 *           follows the default and the site sets a limit.
 * An explicit Open ignores the timer.
 */
export function discussionSetting(site: DiscussionSite, type: DiscussionType, post: DiscussionPost): DiscussionSetting {
  if (!site.comments_enabled || !type.public || post.discussion === "off") return { state: "off", closes_at: null }
  if (post.discussion === "closed") return { state: "closed", closes_at: null }
  if (post.discussion === "open") return { state: "open", closes_at: null }
  if (post.discussion !== "default" || !type.supports.includes(COMMENTS_SUPPORT)) return { state: "off", closes_at: null }
  const first = post.first_published_at ? Date.parse(post.first_published_at) : NaN
  if (site.comments_close_after_days > 0 && Number.isFinite(first)) {
    return { state: "open", closes_at: new Date(first + site.comments_close_after_days * DAY_MS).toISOString() }
  }
  return { state: "open", closes_at: null }
}

/** Applies the clock: an open state is closed once `now` reaches `closes_at`. */
export function discussionState(setting: DiscussionSetting, now: Date): DiscussionStateName {
  if (setting.state === "open" && setting.closes_at !== null && now.getTime() >= Date.parse(setting.closes_at)) {
    return "closed"
  }
  return setting.state
}

// --- The text rules (6.3, 3.5) ------------------------------------------------------

/** The limits of discussionTextVectors.json, in characters (code points). */
export const READER_COMMENT_LIMITS = {
  body_min: 2,
  body_max: 4000,
  max_blank_lines: 2,
  name_max: 60,
} as const

export type ReaderCommentTextCode =
  | "body_invalid"
  | "body_too_short"
  | "body_too_long"
  | "name_invalid"
  | "name_required"
  | "name_too_long"

export type ReaderCommentTextResult = { ok: true; text: string } | { ok: false; code: ReaderCommentTextCode }

// Go's unicode.IsControl: C0 and C1. Body text allows LF and tab.
const BODY_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
const NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f]/
// Bidi embeddings, overrides and isolates.
const BIDI_CONTROL = /[‪-‮⁦-⁩]/
// Go's strings.TrimSpace (unicode.IsSpace), which differs from String.prototype.trim:
// U+0085 is space, U+FEFF isn't.
const GO_SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
const GO_TRIM = new RegExp(`^[${GO_SPACE}]+|[${GO_SPACE}]+$`, "g")

function goTrimSpace(text: string): string {
  return text.replace(GO_TRIM, "")
}

/** Characters as the API counts them: code points. */
export function readerCommentLength(text: string): number {
  return Array.from(text).length
}

/**
 * The comment's text as the API stores it, or the API's 400 code: CR LF and CR become
 * LF; controls other than LF and tab, and bidi controls, are refused; spaces and tabs
 * ending a line go; more than two blank lines in a row are cut to two; the whole is
 * trimmed; 2 to 4000 characters must remain.
 */
export function normalizeReaderCommentBody(raw: string): ReaderCommentTextResult {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  if (BODY_CONTROL.test(text) || BIDI_CONTROL.test(text)) return { ok: false, code: "body_invalid" }
  const out: string[] = []
  let blank = 0
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/[ \t]+$/, "")
    if (line === "") {
      blank++
      if (blank > READER_COMMENT_LIMITS.max_blank_lines) continue
    } else {
      blank = 0
    }
    out.push(line)
  }
  const normalized = goTrimSpace(out.join("\n"))
  const length = readerCommentLength(normalized)
  if (length < READER_COMMENT_LIMITS.body_min) return { ok: false, code: "body_too_short" }
  if (length > READER_COMMENT_LIMITS.body_max) return { ok: false, code: "body_too_long" }
  return { ok: true, text: normalized }
}

/** The name as the API stores it (trimmed), or its 400 code: 1 to 60 characters, one line. */
export function normalizeReaderCommentName(raw: string): ReaderCommentTextResult {
  if (NAME_CONTROL.test(raw) || BIDI_CONTROL.test(raw)) return { ok: false, code: "name_invalid" }
  const name = goTrimSpace(raw)
  const length = readerCommentLength(name)
  if (length === 0) return { ok: false, code: "name_required" }
  if (length > READER_COMMENT_LIMITS.name_max) return { ok: false, code: "name_too_long" }
  return { ok: true, text: name }
}
