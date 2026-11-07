import { describe, expect, it } from "vitest"
import { DATE_OR_REMINDER_LABEL, dateOptions, flattenMentionSections, mentionSections, optionLabel, personName } from "./mentionMenu"
import type { MentionContent, MentionPerson } from "./api/mentions"

// The @ menu's groups and rows (#320, the canvas's "Mention / link to content (@)").

const ana: MentionPerson = { id: 7, username: "ana", full_name: "Ana Costa", avatar: null, role: "editor" }
const anais: MentionPerson = { id: 8, username: "anais", full_name: "", avatar: null, role: "contributor" }
const post: MentionContent = { id: 3, title: "Analytics for every post", post_type: "post", post_type_label: "Post", post_status: "published" }
const page: MentionContent = { id: 4, title: " ", post_type: "page", post_type_label: "Page", post_status: "draft" }

describe("mentionSections", () => {
  it("is People, then Link to post or page, then the dates, in the design's order", () => {
    const sections = mentionSections({ query: "", people: [ana, anais], content: [post, page], today: "2026-11-07" })
    expect(sections.map((s) => [s.id, s.label, s.heading])).toEqual([
      ["people", "People", true],
      ["content", "Link to post or page", true],
      ["dates", "Dates", false],
    ])
    const rows = flattenMentionSections(sections)
    expect(rows.map(optionLabel)).toEqual([
      "Ana Costa, Editor",
      "anais, Contributor",
      "Analytics for every post, Post",
      "Untitled, Page",
      "Today",
      "Tomorrow",
      `${DATE_OR_REMINDER_LABEL}…`,
    ])
  })

  it("leaves out a group with no results; the date row is always there", () => {
    const sections = mentionSections({ query: "zzz", people: [], content: [], today: "2026-11-07" })
    expect(sections.map((s) => s.id)).toEqual(["dates"])
    expect(flattenMentionSections(sections).map((o) => o.key)).toEqual(["date-pick"])
  })

  it("shows at most five of each", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...ana, id: i + 1 }))
    expect(mentionSections({ query: "", people: many, content: [], today: "2026-11-07" })[0].options).toHaveLength(5)
  })
})

describe("dateOptions", () => {
  it("offers today and tomorrow (site days) while the query is empty or starts one", () => {
    expect(dateOptions("", "2026-12-31").map((o) => (o.kind === "date" ? [o.date, o.day] : null))).toEqual([
      ["today", "2026-12-31"],
      ["tomorrow", "2027-01-01"],
      ["pick", undefined],
    ])
    expect(dateOptions("tom", "2026-11-07").map((o) => o.key)).toEqual(["date-tomorrow", "date-pick"])
    expect(dateOptions("da", "2026-11-07").map((o) => o.key)).toEqual(["date-today", "date-tomorrow", "date-pick"])
    expect(dateOptions("ana", "2026-11-07").map((o) => o.key)).toEqual(["date-pick"])
  })

  it("offers a typed day", () => {
    expect(dateOptions("2026-12-24", "2026-11-07").map((o) => o.key)).toEqual(["date-day-2026-12-24", "date-pick"])
    expect(dateOptions("2026-02-30", "2026-11-07").map((o) => o.key)).toEqual(["date-pick"])
  })
})

it("names a member by full name, else username", () => {
  expect(personName(ana)).toBe("Ana Costa")
  expect(personName(anais)).toBe("anais")
})
