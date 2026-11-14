import { describe, expect, it, vi } from "vitest"
import defaultConfig from "../../themes/default/theme.config"
import { blockingScripts, bodyScripts, scriptDataAttributes } from "./themeAssets"
import { checkTemplatePartSlug, isTemplatePartSlug } from "./templateParts"
import { log } from "./log"

// The asset and part halves of the theme contract (#484, design 3.5).

describe("theme scripts", () => {
  const scripts = [
    { src: "/a.js", blocking: true, data: { "storage-key": "k" } },
    { src: "/b.js", defer: true },
    { src: "/c.js", async: true, blocking: false },
    { src: "", blocking: true },
  ]

  it("blocking ones go in <head>, the rest at the end of <body>, in order", () => {
    expect(blockingScripts(scripts).map((s) => s.src)).toEqual(["/a.js"])
    expect(bodyScripts(scripts).map((s) => s.src)).toEqual(["/b.js", "/c.js"])
    expect(blockingScripts(undefined)).toEqual([])
    expect(bodyScripts(undefined)).toEqual([])
  })

  it("data becomes data-* attributes; a name that isn't one is left out", () => {
    expect(scriptDataAttributes({ src: "/a.js", data: { "storage-key": "k", "Bad Name": "x", onload: "y", "x\"y": "z" } })).toEqual({ "data-storage-key": "k", "data-onload": "y" })
    expect(scriptDataAttributes({ src: "/a.js" })).toEqual({})
  })

  it("the default theme registers theme-init.js as its one blocking script", () => {
    expect(blockingScripts(defaultConfig.assets?.scripts)).toEqual([
      { src: "/themes/default/scripts/theme-init.js", blocking: true, data: { "storage-key": defaultConfig.darkMode.storageKey } },
    ])
    expect(bodyScripts(defaultConfig.assets?.scripts)).toEqual([])
  })
})

describe("template part slugs", () => {
  it("are what site_templates.slug allows", () => {
    for (const slug of ["header", "footer", "sidebar_2", "a", "x".repeat(80)]) expect(isTemplatePartSlug(slug)).toBe(true)
    for (const slug of ["", "Header", "-header", "head er", "x".repeat(81), 42, undefined]) expect(isTemplatePartSlug(slug)).toBe(false)
  })

  it("an invalid one is logged once, not on every render", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {})
    expect(checkTemplatePartSlug("Not A Slug")).toBe(false)
    expect(checkTemplatePartSlug("Not A Slug")).toBe(false)
    expect(checkTemplatePartSlug("header")).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith("template_part_slug_invalid", { slug: "Not A Slug" })
    warn.mockRestore()
  })
})
