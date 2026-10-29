import { describe, expect, it } from "vitest"
import { changedFields, toDraft, unsavedMessage, validateDraft, type SettingsDraft } from "./settingsForm"

// The General settings form (#343): which fields are dirty and what the bar says.

const saved: SettingsDraft = { site_title: "GoLive Blog", posts_per_page: 10, post_url_structure: "slug" }

describe("changedFields", () => {
  it("is empty while the draft matches what was saved", () => {
    expect(changedFields(saved, { ...saved })).toEqual([])
  })

  it("names each changed field in form order", () => {
    expect(changedFields(saved, { ...saved, post_url_structure: "id", site_title: "New" })).toEqual([
      "site title",
      "post URL structure",
    ])
  })

  it("is empty before the settings have loaded", () => {
    expect(changedFields(null, saved)).toEqual([])
  })
})

describe("unsavedMessage", () => {
  it("names one or two fields and counts more", () => {
    expect(unsavedMessage([])).toBe("")
    expect(unsavedMessage(["site title"])).toBe("You changed the site title")
    expect(unsavedMessage(["site title", "posts per page"])).toBe("You changed the site title and posts per page")
    expect(unsavedMessage(["site title", "posts per page", "post URL structure"])).toBe("You changed 3 settings")
  })
})

describe("validateDraft", () => {
  it("accepts the API's bounds", () => {
    expect(validateDraft(saved)).toBeNull()
    expect(validateDraft({ ...saved, posts_per_page: 1 })).toBeNull()
    expect(validateDraft({ ...saved, posts_per_page: 100 })).toBeNull()
  })

  it("names the fix for an empty title or a bad page size", () => {
    expect(validateDraft({ ...saved, site_title: "" })).toBe("Enter a site title.")
    expect(validateDraft({ ...saved, site_title: "x".repeat(201) })).toMatch(/at most 200/)
    for (const n of [0, 101, Number.NaN, 2.5]) {
      expect(validateDraft({ ...saved, posts_per_page: n })).toMatch(/1 to 100/)
    }
  })
})

it("toDraft keeps only the edited fields", () => {
  expect(
    toDraft({ id: 1, created_at: "", changed_at: "", site_title: "A", posts_per_page: 5, post_url_structure: "id" })
  ).toEqual({ site_title: "A", posts_per_page: 5, post_url_structure: "id" })
})
