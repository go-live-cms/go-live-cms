import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A page's Template field (#336): the active theme's page layouts, saved at once
// through PUT /posts/:id/template, with "Settings changed" after.

const api = vi.hoisted(() => ({ setPageTemplate: vi.fn(), getPostById: vi.fn() }))
vi.mock("@gl-admin/lib/api/posts", () => api)
const THEME = {
  config: {
    page_templates: [
      { name: "default", label: "Default", description: "One reading column" },
      { name: "fullwidth", label: "Full width", description: "A title band across the page" },
    ],
  },
}
const themes = vi.hoisted(() => ({ getActiveTheme: vi.fn() }))
vi.mock("@gl-admin/lib/api/themes", () => themes)

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
  themes.getActiveTheme.mockReset().mockResolvedValue(THEME)
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
    themes.getActiveTheme.mockRejectedValueOnce(new Error("timeout"))
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
