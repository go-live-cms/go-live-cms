import { describe, expect, it } from "vitest"
import {
  DEFAULT_TEMPLATE,
  describeTemplate,
  humanize,
  missingTemplateNote,
  pageTemplatesOf,
  templateOptions,
  templateRequestValue,
  templateValue,
} from "./pageTemplates"

// Page templates (#336): the active theme's list (the API's scan), how a stored template
// reads, and the picker's values.

const THEME = {
  page_templates: [
    { name: "default", label: "Default", description: "One reading column" },
    { name: "fullwidth", label: "Full width", description: "A title band across the page" },
  ],
}

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
})

describe("describeTemplate", () => {
  const templates = pageTemplatesOf(THEME)

  it("names the template the page renders with", () => {
    expect(describeTemplate(templates, "")).toEqual({ label: "Default", description: "One reading column", missing: false })
    expect(describeTemplate(templates, "fullwidth")).toMatchObject({ label: "Full width", missing: false })
  })

  // After a theme switch: the page renders with the default, and says so.
  it("falls back to the default for a template the theme doesn't have", () => {
    expect(describeTemplate(templates, "landing")).toEqual({ label: "Default", description: "One reading column", missing: true })
    expect(missingTemplateNote("landing", "Default")).toBe("“landing” isn’t in the active theme, so the page uses Default.")
  })

  it("shows the stored name while the list loads", () => {
    expect(describeTemplate(null, "full-width")).toEqual({ label: "Full width", missing: false })
    expect(describeTemplate(null, "")).toEqual({ label: "Default", missing: false })
  })
})

describe("templateOptions", () => {
  const templates = pageTemplatesOf(THEME)

  it("lists the theme's templates", () => {
    expect(templateOptions(templates, "").map((o) => o.value)).toEqual(["default", "fullwidth"])
    expect(templateOptions(templates, "fullwidth")[1]).toEqual({ value: "fullwidth", label: "Full width", description: "A title band across the page" })
  })

  it("keeps a stored template the theme doesn't have, marked", () => {
    const options = templateOptions(templates, "landing")
    expect(options.map((o) => o.value)).toEqual(["default", "fullwidth", "landing"])
    expect(options[2].label).toBe("Landing (not in this theme)")
  })
})
