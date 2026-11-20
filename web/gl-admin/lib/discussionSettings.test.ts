import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { Settings } from "@gl-admin/lib/api/settings"
import {
  DISCUSSION_LIMITS,
  apiFieldError,
  changedDiscussionFields,
  discussionUnsavedMessage,
  normalizeNotice,
  normalizeWordList,
  rangeValue,
  showDiscussionDetails,
  toDiscussionDraft,
  toDiscussionRequest,
  validateDiscussionDraft,
  wordLines,
  type DiscussionNumberField,
} from "./discussionSettings"

// Settings › Discussion (#527): the form refuses what PUT /settings refuses. The vectors
// are shared with api/discussion_settings_vectors_test.go; read with JSON.parse, as the
// other shared vectors are.
type VString = string | { repeat: { text: string; times: number } }
type VLine = VString | { numbered: number }
const vectors = JSON.parse(readFileSync(path.resolve(__dirname, "discussionSettingsVectors.json"), "utf8")) as {
  limits: Record<string, unknown>
  ranges: { field: DiscussionNumberField; value: number; ok: boolean }[]
  words: { name: string; input: VLine[]; normalized?: VLine[]; code?: string; line?: number }[]
  notice: { name: string; input: VString; normalized?: VString; code?: string }[]
}

const str = (s: VString): string => (typeof s === "string" ? s : s.repeat.text.repeat(s.repeat.times))
const lines = (items: VLine[]): string[] =>
  items.flatMap((item) =>
    typeof item === "object" && "numbered" in item ? Array.from({ length: item.numbered }, (_, i) => `word${i + 1}`) : [str(item)]
  )

describe("the shared vectors", () => {
  it("agree on the limits", () => {
    expect(vectors.limits).toEqual(DISCUSSION_LIMITS)
  })

  it.each(vectors.ranges.map((c) => [`${c.field}=${c.value}`, c] as const))("range %s", (_, c) => {
    expect(rangeValue(c.field, String(c.value)) !== null).toBe(c.ok)
  })

  it.each(vectors.words.map((c) => [c.name, c] as const))("words: %s", (_, c) => {
    const result = normalizeWordList(lines(c.input))
    if (c.normalized) {
      expect(result).toEqual({ ok: true, words: lines(c.normalized) })
    } else {
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe(c.code)
        if (c.line !== undefined) expect(result.line).toBe(c.line)
      }
    }
  })

  it.each(vectors.notice.map((c) => [c.name, c] as const))("notice: %s", (_, c) => {
    const result = normalizeNotice(str(c.input))
    if (c.normalized !== undefined) expect(result).toEqual({ ok: true, notice: str(c.normalized) })
    else expect(result).toEqual({ ok: false, code: c.code })
  })
})

const SAVED: Settings = {
  id: 1,
  site_title: "GoLive",
  posts_per_page: 10,
  post_url_structure: "slug",
  site_tagline: "",
  site_language: "en-US",
  site_timezone: "UTC",
  date_format: "month_day_year",
  editor_markdown_shortcuts: true,
  editor_allowed_embeds: [],
  allow_signup: false,
  front_page_id: null,
  site_address: "",
  comments_enabled: true,
  comments_moderation: "first",
  comments_max_links: 1,
  comments_hold_words: ["refund", "unsubscribe"],
  comments_spam_words: ["casino"],
  comments_close_after_days: 30,
  comments_threading: "replies",
  comments_order: "oldest",
  comments_per_page: 30,
  comments_notice: "",
  comments_privacy_page_id: null,
  created_at: "",
  changed_at: "",
}

describe("the draft", () => {
  it("is the saved settings as the form shows them", () => {
    expect(toDiscussionDraft(SAVED)).toMatchObject({
      comments_max_links: "1",
      comments_hold_words: "refund\nunsubscribe",
      comments_spam_words: "casino",
      comments_close_after_days: "30",
      comments_per_page: "30",
    })
  })

  it("falls back to 12.1's defaults for an answer without the fields", () => {
    const { comments_enabled, comments_hold_words, comments_moderation, comments_per_page, ...rest } = SAVED
    void comments_enabled, void comments_hold_words, void comments_moderation, void comments_per_page
    expect(toDiscussionDraft(rest as Settings)).toMatchObject({
      comments_enabled: false,
      comments_moderation: "first",
      comments_hold_words: "",
      comments_per_page: "30",
    })
  })

  it("names what changed, in form order", () => {
    const saved = toDiscussionDraft(SAVED)
    expect(changedDiscussionFields(saved, saved)).toEqual([])
    expect(discussionUnsavedMessage(changedDiscussionFields(saved, { ...saved, comments_close_after_days: "7" }))).toBe(
      "You changed the close-after days"
    )
    const two = changedDiscussionFields(saved, { ...saved, comments_order: "newest", comments_max_links: "2" })
    expect(two).toEqual(["link limit", "order"])
    expect(discussionUnsavedMessage(two)).toBe("You changed the link limit and order")
    expect(discussionUnsavedMessage(["a", "b", "c"])).toBe("You changed 3 settings")
  })
})

describe("validateDiscussionDraft", () => {
  const saved = toDiscussionDraft(SAVED)

  it("accepts the saved settings", () => {
    expect(validateDiscussionDraft(saved)).toEqual({})
  })

  it("refuses numbers out of range, or not numbers, with the range", () => {
    expect(validateDiscussionDraft({ ...saved, comments_max_links: "12" })).toEqual({ comments_max_links: "Enter a number from 0 to 10." })
    expect(validateDiscussionDraft({ ...saved, comments_per_page: "5" }).comments_per_page).toBe("Enter a number from 10 to 100.")
    expect(validateDiscussionDraft({ ...saved, comments_close_after_days: "" }).comments_close_after_days).toBe(
      "Enter a number from 0 to 3650."
    )
    expect(validateDiscussionDraft({ ...saved, comments_close_after_days: "1.5" }).comments_close_after_days).toBeDefined()
  })

  it("names the line of a word that's too long (the board's invalid state)", () => {
    const hold = `refund\ncasino\na phrase that runs far past the sixty-four characters a single entry is allowed`
    expect(validateDiscussionDraft({ ...saved, comments_hold_words: hold })).toEqual({
      comments_hold_words: "Line 3 is longer than 64 characters.",
    })
    expect(validateDiscussionDraft({ ...saved, comments_spam_words: "ok\r\nta\tb" }).comments_spam_words).toBe(
      "Line 2 has a character that can't be in a word, such as a tab."
    )
  })

  it("with comments off, hidden fields don't block the save, and invalid ones aren't sent", () => {
    const off = { ...saved, comments_enabled: false, comments_max_links: "12", comments_order: "newest" as const }
    expect(validateDiscussionDraft(off)).toEqual({})
    expect(toDiscussionRequest(off, saved)).toEqual({ comments_enabled: false, comments_order: "newest" })
  })

  it("refuses a notice on two lines or over 400 characters", () => {
    expect(validateDiscussionDraft({ ...saved, comments_notice: "One.\nTwo." }).comments_notice).toMatch(/one line/)
    expect(validateDiscussionDraft({ ...saved, comments_notice: "x".repeat(401) }).comments_notice).toMatch(/400/)
  })
})

describe("toDiscussionRequest", () => {
  const saved = toDiscussionDraft(SAVED)

  it("sends only what changed, as the API reads it", () => {
    expect(toDiscussionRequest(saved, saved)).toEqual({})
    expect(
      toDiscussionRequest(
        {
          ...saved,
          comments_max_links: " 3 ",
          comments_hold_words: "refund\n\n  Refund \nfree money\n",
          comments_notice: "  Be kind.  ",
          comments_threading: "flat",
        },
        saved
      )
    ).toEqual({ comments_max_links: 3, comments_hold_words: ["refund", "free money"], comments_notice: "Be kind.", comments_threading: "flat" })
  })

  it("clears a word list with []", () => {
    expect(toDiscussionRequest({ ...saved, comments_spam_words: "" }, saved)).toEqual({ comments_spam_words: [] })
  })

  it("sends the privacy page only when it changed, null for none", () => {
    const withPage = { ...saved, comments_privacy_page_id: 8 }
    expect(toDiscussionRequest(withPage, saved)).toEqual({ comments_privacy_page_id: 8 })
    expect(toDiscussionRequest(saved, withPage)).toEqual({ comments_privacy_page_id: null })
  })

  it("sends the switch when it changed", () => {
    expect(toDiscussionRequest({ ...saved, comments_enabled: false }, saved)).toEqual({ comments_enabled: false })
  })
})

describe("Off", () => {
  const saved = toDiscussionDraft(SAVED)

  it("off shows the switch alone", () => {
    expect(showDiscussionDetails({ ...saved, comments_enabled: false })).toBe(false)
    expect(showDiscussionDetails({ ...saved, comments_enabled: true })).toBe(true)
  })
})

describe("apiFieldError", () => {
  it("puts the API's refusal on its field", () => {
    expect(apiFieldError("invalid_discussion_settings", "comments_max_links must be between 0 and 10")).toEqual({
      field: "comments_max_links",
      message: "It must be between 0 and 10.",
    })
    expect(apiFieldError("invalid_discussion_settings", "comments_hold_words entries must be at most 64 characters")).toEqual({
      field: "comments_hold_words",
      message: "Entries must be at most 64 characters.",
    })
    expect(apiFieldError("invalid_privacy_page", "the privacy page must be a published page")?.field).toBe("comments_privacy_page_id")
  })

  it("leaves anything else to the bar", () => {
    expect(apiFieldError(null, "failed")).toBeNull()
    expect(apiFieldError("invalid_discussion_settings", "site_title must be short")).toBeNull()
  })
})

it("wordLines splits on any line end", () => {
  expect(wordLines("")).toEqual([])
  expect(wordLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"])
})
