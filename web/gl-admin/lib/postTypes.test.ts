import { describe, expect, it } from "vitest"
import {
  draftFromPostType,
  isBuiltInPostType,
  nameFromLabel,
  newPostTypeDraft,
  postTypeInput,
  supportsSummary,
  validatePostTypeDraft,
} from "./postTypes"
import type { PostType } from "./api/types"

// The Post types form (#343): what it sends and what it refuses, mirroring
// api/post_types.go.

const caseStudy: PostType = {
  id: 3,
  name: "case_study",
  label: "Case studies",
  description: "Customer stories",
  hierarchical: false,
  public: true,
  has_archive: false,
  menu_position: 30,
  supports: ["title", "content", "seo"],
  is_active: true,
  registered_by: "user",
  show_ui: true,
  show_in_menu: true,
  created_at: "",
}

describe("built-in types", () => {
  it("are posts and pages, which the API refuses to change", () => {
    expect(isBuiltInPostType("post")).toBe(true)
    expect(isBuiltInPostType("page")).toBe(true)
    expect(isBuiltInPostType("case_study")).toBe(false)
    expect(validatePostTypeDraft({ ...newPostTypeDraft(), label: "Posts", name: "post" }, true)).toMatch(/built in/)
  })
})

describe("postTypeInput", () => {
  it("sends every boolean and keeps the description, since PUT clears what's missing", () => {
    const draft = { ...draftFromPostType(caseStudy), label: "  Stories " }
    expect(postTypeInput(draft, caseStudy)).toEqual({
      label: "Stories",
      description: "Customer stories",
      public: true,
      hierarchical: false,
      has_archive: false,
      menu_position: 30,
      supports: ["title", "content", "seo"],
    })
  })

  it("sends no menu position when the field is empty", () => {
    expect(postTypeInput({ ...newPostTypeDraft(), label: "Events", name: "event" }).menu_position).toBeUndefined()
  })

  it("starts a new type with the API's defaults", () => {
    expect(newPostTypeDraft()).toMatchObject({ public: true, hierarchical: false, has_archive: true, supports: ["title", "content", "description"] })
  })
})

describe("draftFromPostType", () => {
  it("shows the API's 0 (no position) as empty", () => {
    expect(draftFromPostType({ ...caseStudy, menu_position: 0 }).menu_position).toBe("")
    expect(draftFromPostType(caseStudy).menu_position).toBe("30")
  })
})

describe("validatePostTypeDraft", () => {
  const valid = { ...newPostTypeDraft(), label: "Events", name: "event" }

  it("accepts a valid draft", () => {
    expect(validatePostTypeDraft(valid, true)).toBeNull()
  })

  it("checks the label, the name (only when creating) and the menu position", () => {
    expect(validatePostTypeDraft({ ...valid, label: "E" }, true)).toMatch(/label/)
    expect(validatePostTypeDraft({ ...valid, name: "Not OK" }, true)).toMatch(/name/)
    expect(validatePostTypeDraft({ ...valid, name: "Not OK" }, false)).toBeNull()
    expect(validatePostTypeDraft({ ...valid, menu_position: "-1" }, true)).toMatch(/menu position/)
    expect(validatePostTypeDraft({ ...valid, menu_position: "12" }, true)).toBeNull()
  })

  it("refuses to create over an existing type, since POST upserts", () => {
    expect(validatePostTypeDraft(valid, true, ["post", "event"])).toMatch(/already a post type named “event”/)
    // Editing keeps its own name.
    expect(validatePostTypeDraft(valid, false, ["event"])).toBeNull()
  })
})

it("nameFromLabel follows the API's identifier rule", () => {
  expect(nameFromLabel("Case Studies")).toBe("case_studies")
  expect(nameFromLabel("  Café & Bar! ")).toBe("cafe_bar")
})

it("supportsSummary counts the known fields only", () => {
  expect(supportsSummary(caseStudy.supports)).toBe("2 of 4")
  expect(supportsSummary(null)).toBe("0 of 4")
})
