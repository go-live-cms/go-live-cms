import { describe, expect, it } from "vitest"
import {
  BUILDER_GROUP,
  DEFAULT_TEMPLATE,
  describeTemplate,
  humanize,
  isBuilderTemplate,
  missingTemplateNote,
  pageTemplateChoicesOf,
  pageTemplatesOf,
  SITE_EDITOR_TAG,
  templateNote,
  templateOptions,
  templateRequestValue,
  templateValue,
  type PageTemplateChoices,
} from "./pageTemplates"

// Page templates (#336): the active theme's list (the API's scan), how a stored template
// reads, and the picker's values; and the Site editor's page templates (#494).

const THEME = {
  page_templates: [
    { name: "default", label: "Default", description: "One reading column" },
    { name: "fullwidth", label: "Full width", description: "A title band across the page" },
  ],
}
const CHOICES: PageTemplateChoices = { themeName: "Paper", templates: pageTemplatesOf(THEME), builder: [] }
const WITH_BUILDER: PageTemplateChoices = { ...CHOICES, builder: [{ name: "block:landing", label: "Landing" }] }

describe("pageTemplatesOf", () => {
  it("reads the scan's list, default first", () => {
    expect(pageTemplatesOf({ page_templates: [{ name: "landing", label: "Landing" }, ...THEME.page_templates] })).toEqual([
      { name: "default", label: "Default", description: "One reading column" },
      { name: "landing", label: "Landing" },
      { name: "fullwidth", label: "Full width", description: "A title band across the page" },
    ])
  })

  it("always has the default, and skips what isn't a template", () => {
    expect(pageTemplatesOf(undefined)).toEqual([{ name: "default", label: "Default" }])
    expect(pageTemplatesOf({ layouts: {} })).toEqual([{ name: "default", label: "Default" }])
    expect(
      pageTemplatesOf({
        page_templates: [{ name: "../x" }, { name: "" }, null, { name: "wide" }, { name: "wide", label: "Again" }, { name: "big_hero", label: "  " }],
      })
    ).toEqual([
      { name: "default", label: "Default" },
      { name: "wide", label: "Wide" },
      { name: "big_hero", label: "Big hero" },
    ])
  })
})

describe("pageTemplateChoicesOf (GET /posts/page-templates)", () => {
  it("reads the theme, its layouts and its Site editor templates", () => {
    expect(
      pageTemplateChoicesOf({
        theme: { slug: "paper", name: " Paper " },
        templates: THEME.page_templates,
        builder_templates: [
          { name: "block:landing", label: "Landing" },
          { name: "block:spring-launch", label: "" },
          // Not a builder name, a repeat, nothing at all.
          { name: "landing", label: "Layout" },
          { name: "block:Bad", label: "Bad" },
          { name: "block:landing", label: "Again" },
          null,
        ],
      })
    ).toEqual({
      themeName: "Paper",
      templates: pageTemplatesOf(THEME),
      builder: [
        { name: "block:landing", label: "Landing" },
        { name: "block:spring-launch", label: "Spring launch" },
      ],
    })
  })

  it("reads no theme, and anything malformed, as the default alone", () => {
    expect(pageTemplateChoicesOf({ theme: null, templates: [{ name: "default", label: "Default" }], builder_templates: [] })).toEqual({
      themeName: null,
      templates: [{ name: "default", label: "Default" }],
      builder: [],
    })
    expect(pageTemplateChoicesOf("nope")).toEqual({ themeName: null, templates: [{ name: "default", label: "Default" }], builder: [] })
  })
})

it("humanize labels a layout file as the API does", () => {
  expect(humanize("full-width")).toBe("Full width")
  expect(humanize("BIG_hero")).toBe("Big hero")
  expect(humanize("")).toBe("")
})

it("stores the default as an empty name", () => {
  expect(templateValue("")).toBe(DEFAULT_TEMPLATE)
  expect(templateValue(undefined)).toBe(DEFAULT_TEMPLATE)
  expect(templateValue("fullwidth")).toBe("fullwidth")
  expect(templateRequestValue(DEFAULT_TEMPLATE)).toBe("")
  expect(templateRequestValue("fullwidth")).toBe("fullwidth")
  expect(templateRequestValue("block:landing")).toBe("block:landing")
})

it("isBuilderTemplate follows the API's block:<name> rule", () => {
  expect(isBuilderTemplate("block:landing")).toBe(true)
  expect(isBuilderTemplate("block:Landing")).toBe(false)
  expect(isBuilderTemplate("block:")).toBe(false)
  expect(isBuilderTemplate("landing")).toBe(false)
  expect(isBuilderTemplate(undefined)).toBe(false)
})

describe("describeTemplate", () => {
  it("names the template the page renders with", () => {
    expect(describeTemplate(CHOICES, "")).toEqual({ label: "Default", description: "One reading column", missing: false, builder: false, storedLabel: "Default" })
    expect(describeTemplate(CHOICES, "fullwidth")).toMatchObject({ label: "Full width", missing: false, builder: false })
    expect(templateNote(CHOICES, "fullwidth")).toBeUndefined()
  })

  // After a theme switch: the page renders with the default, and says so.
  it("falls back to the default for a template the theme doesn't have", () => {
    expect(describeTemplate(CHOICES, "landing")).toEqual({ label: "Default", description: "One reading column", missing: true, builder: false, storedLabel: "Landing" })
    expect(missingTemplateNote("landing", "Default")).toBe("“landing” isn’t in the active theme, so the page uses Default.")
    expect(templateNote(CHOICES, "landing")).toBe("“landing” isn’t in the active theme, so the page uses Default.")
  })

  it("names a published Site editor template by its title", () => {
    expect(describeTemplate(WITH_BUILDER, "block:landing")).toEqual({
      label: "Landing",
      description: "A page template made in the Site editor.",
      missing: false,
      builder: true,
      storedLabel: "Landing",
    })
    expect(templateNote(WITH_BUILDER, "block:landing")).toBeUndefined()
  })

  // Reset, deleted, or another theme's: the default renders, and the name is kept.
  it("falls back to the default for a Site editor template that isn't published", () => {
    expect(describeTemplate(WITH_BUILDER, "block:spring-sale")).toMatchObject({ label: "Default", missing: true, builder: true, storedLabel: "Spring sale" })
    expect(templateNote(WITH_BUILDER, "block:spring-sale")).toBe(
      "Spring sale isn’t published in Paper, so this page shows with Default. The choice is kept and applies again once it’s published."
    )
    expect(templateNote({ ...WITH_BUILDER, themeName: null }, "block:spring-sale")).toContain("isn’t published in the active theme,")
  })

  it("shows the stored name while the list loads", () => {
    expect(describeTemplate(null, "full-width")).toEqual({ label: "Full width", missing: false, builder: false, storedLabel: "Full width" })
    expect(describeTemplate(null, "")).toEqual({ label: "Default", missing: false, builder: false, storedLabel: "Default" })
    expect(describeTemplate(null, "block:spring-sale")).toEqual({ label: "Spring sale", missing: false, builder: true, storedLabel: "Spring sale" })
    expect(templateNote(null, "block:spring-sale")).toBeUndefined()
  })
})

describe("templateOptions", () => {
  it("lists the theme's templates, without headings when there are no Site editor ones", () => {
    expect(templateOptions(CHOICES, "").map((o) => o.value)).toEqual(["default", "fullwidth"])
    expect(templateOptions(CHOICES, "fullwidth")[1]).toEqual({ value: "fullwidth", label: "Full width", description: "A title band across the page" })
  })

  it("keeps a stored template the theme doesn't have, marked", () => {
    const options = templateOptions(CHOICES, "landing")
    expect(options.map((o) => o.value)).toEqual(["default", "fullwidth", "landing"])
    expect(options[2].label).toBe("Landing (not in this theme)")
  })

  it("lists the Site editor's templates after the theme's layouts, tagged, each kind under its heading", () => {
    const options = templateOptions(WITH_BUILDER, "landing")
    expect(options.map((o) => [o.value, o.group, o.tag])).toEqual([
      ["default", "Paper’s layouts", undefined],
      ["fullwidth", "Paper’s layouts", undefined],
      // A stored layout the theme lacks stays in its own kind's group.
      ["landing", "Paper’s layouts", undefined],
      ["block:landing", BUILDER_GROUP, SITE_EDITOR_TAG],
    ])
    expect(templateOptions({ ...WITH_BUILDER, themeName: null }, "")[0].group).toBe("Theme layouts")
  })

  it("keeps a stored Site editor template that isn't published, marked, in its group", () => {
    const options = templateOptions(CHOICES, "block:spring-sale")
    expect(options.map((o) => [o.value, o.group])).toEqual([
      ["default", "Paper’s layouts"],
      ["fullwidth", "Paper’s layouts"],
      ["block:spring-sale", BUILDER_GROUP],
    ])
    expect(options[2]).toMatchObject({ label: "Spring sale", tag: SITE_EDITOR_TAG, description: "Not published · renders with the default" })
  })
})
