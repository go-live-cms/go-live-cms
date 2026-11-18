import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A page's Template field (#336): the active theme's page layouts, saved at once
// through PUT /posts/:id/template, with "Settings changed" after; and its published Site
// editor page templates under their own heading (#494).

const api = vi.hoisted(() => ({ setPageTemplate: vi.fn(), getPostById: vi.fn(), getPageTemplates: vi.fn() }))
vi.mock("@gl-admin/lib/api/posts", () => api)
const CHOICES = {
  theme: { slug: "paper", name: "Paper" },
  templates: [
    { name: "default", label: "Default", description: "One reading column" },
    { name: "fullwidth", label: "Full width", description: "A title band across the page" },
  ],
  builder_templates: [],
}
const WITH_BUILDER = { ...CHOICES, builder_templates: [{ name: "block:landing", label: "Landing" }, { name: "block:docs", label: "Docs" }] }

import PageTemplateField from "./PageTemplateField"
import { resetPageTemplates } from "@gl-admin/lib/hooks/usePageTemplates"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const settle = () =>
  act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
  })

const trigger = () => container.querySelector<HTMLButtonElement>("button[role='combobox']")!
const hint = () =>
  (trigger().getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
const pick = async (label: string) => {
  await act(async () => trigger().click())
  const option = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((o) => o.textContent?.startsWith(label))!
  await act(async () => option.click())
  await settle()
}

async function render(props: Partial<Parameters<typeof PageTemplateField>[0]> = {}) {
  await act(async () => root.render(<PageTemplateField postId={7} initial="" readOnly={false} {...props} />))
  await settle()
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.setPageTemplate.mockReset().mockResolvedValue({ post: { id: 7 } })
  api.getPostById.mockReset()
  api.getPageTemplates.mockReset().mockResolvedValue(CHOICES)
  resetPageTemplates()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("PageTemplateField", () => {
  it("shows the theme's templates and saves a pick", async () => {
    const onSaved = vi.fn()
    await render({ onSaved })
    expect(trigger().textContent).toContain("Default")
    expect(hint()).toContain("One reading column")

    await pick("Full width")
    expect(api.setPageTemplate).toHaveBeenCalledWith(7, "fullwidth")
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(trigger().textContent).toContain("Full width")

    // Back to the default: stored as "".
    await pick("Default")
    expect(api.setPageTemplate).toHaveBeenLastCalledWith(7, "")
  })

  it("says when the active theme doesn't have the page's template", async () => {
    await render({ initial: "landing" })
    expect(trigger().textContent).toContain("Landing (not in this theme)")
    expect(hint()).toContain("“landing” isn’t in the active theme, so the page uses Default.")
  })

  it("puts the old one back when the save fails", async () => {
    api.setPageTemplate.mockRejectedValue(new Error("the active theme has no page template with this name"))
    const onSaved = vi.fn()
    await render({ initial: "fullwidth", onSaved })
    await pick("Default")
    expect(trigger().textContent).toContain("Full width")
    expect(container.textContent).toContain("the active theme has no page template with this name")
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("says so when the theme's templates can't load, and tries again", async () => {
    api.getPageTemplates.mockRejectedValueOnce(new Error("timeout"))
    await render()
    expect(trigger().disabled).toBe(true)
    expect(hint()).toContain("Couldn't load the theme's templates.")

    const again = [...container.querySelectorAll("button")].find((b) => b.textContent === "Try again")!
    await act(async () => again.click())
    await settle()
    expect(trigger().disabled).toBe(false)
    expect(hint()).toContain("One reading column")
    expect(container.textContent).not.toContain("Try again")
  })

  it("is read-only for someone who can't change the page's settings", async () => {
    await render({ readOnly: true })
    expect(trigger().disabled).toBe(true)
  })

  describe("Site editor page templates (#494)", () => {
    const groups = () =>
      [...document.querySelectorAll<HTMLElement>("[role='listbox'] [role='group']")].map((group) => ({
        name: document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent,
        options: [...group.querySelectorAll("[role='option']")].map((o) => o.textContent),
      }))

    it("lists them after the theme's layouts, under their own heading, and saves one", async () => {
      api.getPageTemplates.mockResolvedValue(WITH_BUILDER)
      const onSaved = vi.fn()
      await render({ onSaved })
      await act(async () => trigger().click())
      expect(groups()).toEqual([
        { name: "Paper’s layouts", options: ["DefaultOne reading column", "Full widthA title band across the page"] },
        { name: "Made in the Site editor", options: ["LandingSite editor", "DocsSite editor"] },
      ])
      const option = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((o) => o.textContent?.startsWith("Landing"))!
      await act(async () => option.click())
      await settle()

      expect(api.setPageTemplate).toHaveBeenCalledWith(7, "block:landing")
      expect(onSaved).toHaveBeenCalledTimes(1)
      // The trigger shows the title and the tag.
      expect(trigger().textContent).toBe("LandingSite editor")
      expect(hint()).toContain("A page template made in the Site editor.")
    })

    it("keeps no headings while the theme has none", async () => {
      await render()
      await act(async () => trigger().click())
      expect(groups()).toEqual([])
      expect([...document.querySelectorAll("[role='option']")].map((o) => o.textContent)).toEqual([
        "DefaultOne reading column",
        "Full widthA title band across the page",
      ])
    })

    // Reset, deleted or another theme's: the page renders the default and keeps the name.
    it("keeps a stored one that isn't published, and says what the page shows instead", async () => {
      api.getPageTemplates.mockResolvedValue(WITH_BUILDER)
      await render({ initial: "block:pricing" })
      expect(trigger().textContent).toBe("PricingSite editor")
      expect(hint()).toContain(
        "Pricing isn’t published in Paper, so this page shows with Default. The choice is kept and applies again once it’s published."
      )
      await act(async () => trigger().click())
      expect(groups()[1].options).toEqual(["LandingSite editor", "DocsSite editor", "PricingSite editorNot published · renders with the default"])
      expect(api.setPageTemplate).not.toHaveBeenCalled()
    })

    it("shows the stored one, tagged, while the list loads", async () => {
      api.getPageTemplates.mockReturnValue(new Promise(() => {}))
      await render({ initial: "block:spring-launch" })
      expect(trigger().textContent).toBe("Spring launchSite editor")
      expect(trigger().disabled).toBe(true)
    })
  })

  it("re-reads the template after a restored version", async () => {
    api.getPostById.mockResolvedValue({ post: { id: 7, page_template: "fullwidth" } })
    await render()
    expect(api.getPostById).not.toHaveBeenCalled()
    await act(async () => root.render(<PageTemplateField postId={7} initial="" readOnly={false} settingsKey={1} />))
    await settle()
    expect(api.getPostById).toHaveBeenCalledWith(7)
    expect(trigger().textContent).toContain("Full width")
  })
})
