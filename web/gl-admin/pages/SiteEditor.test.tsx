import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import axe from "axe-core"
import type { SiteTemplate } from "@gl-admin/lib/api/siteDesign"

// The Site editor's overview (#493; the board "Site editor · overview") on a mocked API: what
// renders each route, "Changes not published" per item and in total, Customize, the row menu,
// the phone's read-only list, and axe over the page.

const api = vi.hoisted(() => ({
  getSiteDesignOverview: vi.fn(),
  getGlobalStyles: vi.fn(),
  createSiteTemplate: vi.fn(),
  resetSiteTemplate: vi.fn(),
  keepEditingSiteTemplate: vi.fn(),
  deleteSiteTemplate: vi.fn(),
}))
const media = vi.hoisted(() => ({ phone: false }))
vi.mock("@gl-admin/lib/api/siteDesign", async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }))
vi.mock("@gl-admin/components/site-editor/siteContext", () => ({
  loadSiteDesignContext: async () => ({
    themeName: "Paper",
    themeSlug: "paper",
    shippedTemplates: { "404": {} },
    shippedParts: {},
    vocabulary: { postTypes: [], pageLayouts: [{ name: "fullwidth", label: "Full width" }], taxonomies: [{ name: "category", label: "Category" }] },
  }),
}))
vi.mock("@gl-admin/lib/api/designPreview", () => ({ openDesignPreview: vi.fn() }))
vi.mock("@gl-admin/contexts/GoLiveContext", () => ({ useGoLive: () => ({ baseTitle: "GoLive Admin |", isDark: false }) }))
vi.mock("@gl-admin/components/sidebar/Sidebar", () => ({ MOBILE_QUERY: "(width <= 768px)" }))
vi.mock("@gl-admin/lib/hooks/useMediaQuery", () => ({ useMediaQuery: () => media.phone }))

import SiteEditorPage from "./SiteEditor"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function row(over: Partial<SiteTemplate>): SiteTemplate {
  return {
    id: 1,
    theme_slug: "paper",
    kind: "template",
    slug: "single",
    title: "",
    block_revision: 2,
    working_state: "custom",
    source: "starter",
    source_hash: "",
    published: true,
    doc_name: "template-1",
    created_at: "",
    changed_at: "",
    change: "",
    has_unpublished_changes: false,
    published_version_no: 1,
    default_changed: false,
    can_delete: false,
    ...over,
  }
}

const overview = {
  theme: { id: 1, slug: "paper", name: "Paper" },
  templates: [
    row({ id: 1, slug: "single", change: "publish", has_unpublished_changes: true }),
    row({ id: 2, slug: "archive" }),
    row({ id: 3, kind: "part", slug: "header", change: "publish", has_unpublished_changes: true }),
  ],
  global_styles_changed: true,
  global_styles_groups: ["colors", "fonts"],
  unpublished_changes: 3,
}

let container: HTMLDivElement
let root: Root
let path = ""

function Where() {
  path = useLocation().pathname + useLocation().search
  return null
}

beforeEach(() => {
  media.phone = false
  api.getSiteDesignOverview.mockReset().mockResolvedValue(overview)
  api.getGlobalStyles.mockReset().mockResolvedValue({ supported: true, contrast: [{}] })
  api.createSiteTemplate.mockReset().mockResolvedValue(row({ id: 42, slug: "home" }))
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ""
})

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

async function render() {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/site-editor"]}>
        <Where />
        <Routes>
          <Route path="/site-editor" element={<main><SiteEditorPage /></main>} />
          <Route path="*" element={<div />} />
        </Routes>
      </MemoryRouter>
    )
  )
  await settle()
}

const rowOf = (name: string) => [...container.querySelectorAll(".site-editor__row")].find((r) => r.querySelector(".site-editor__row-title")?.textContent?.startsWith(name))!

describe("the Site editor overview", () => {
  it("says what renders each route, per item and in total", async () => {
    await render()
    expect(document.title).toBe("GoLive Admin | Site editor")
    expect(container.querySelector("h1")!.textContent).toBe("Site editor")
    expect(rowOf("Single post").textContent).toContain("Customized · changes not published")
    expect(rowOf("Single post").textContent).toContain("Replaces Paper’s post layouts")
    expect(rowOf("Archive").textContent).toContain("Customized")
    expect(rowOf("Home").textContent).toContain("Theme layout · home/default")
    expect(rowOf("404").textContent).toContain("Theme template · 404")
    expect(rowOf("Page · Full width").textContent).toContain("Theme layout · page/fullwidth")
    expect(rowOf("Header").textContent).toContain("Customized · changes not published")
    expect(rowOf("Footer").textContent).toContain("Theme layout · Paper’s footer")
    const publish = [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Publish site design"))!
    expect(publish.getAttribute("aria-label")).toBe("Publish site design, 3 changes")
    expect(container.textContent).toContain("Colours, Fonts changed.")
    expect(container.textContent).toContain("1 colour pair below the contrast minimum")
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" ")}`)).toEqual([])
  })

  it("Customize makes the row from its source and opens it", async () => {
    await render()
    const customize = rowOf("Home").querySelector<HTMLButtonElement>('button[aria-label="Customize Home"]')!
    await act(async () => customize.click())
    await settle()
    expect(api.createSiteTemplate).toHaveBeenCalledWith({ kind: "template", slug: "home", from: "starter" })
    expect(path).toBe("/site-editor/templates/42")
  })

  it("Customize on a row that exists meanwhile opens that one", async () => {
    const { TemplateExistsError } = await import("@gl-admin/lib/api/siteDesign")
    api.createSiteTemplate.mockRejectedValueOnce(new TemplateExistsError(7))
    await render()
    await act(async () => rowOf("404").querySelector<HTMLButtonElement>('button[aria-label="Customize 404"]')!.click())
    await settle()
    expect(api.createSiteTemplate).toHaveBeenCalledWith({ kind: "template", slug: "404", from: "theme" })
    expect(path).toBe("/site-editor/templates/7")
  })

  it("the row menu: Discard opens the item's editor, which asks (rule 9)", async () => {
    await render()
    const more = rowOf("Single post").querySelector<HTMLButtonElement>('button[aria-label="More for Single post"]')!
    await act(async () => more.click())
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)
    expect(items).toEqual(["Edit", "Preview", "History", "Discard changes…", "Reset to theme default…", "DeletePublished once. Reset it instead."])
    await act(async () => ([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((i) => i.textContent === "Discard changes…")!).click())
    expect(path).toBe("/site-editor/templates/1?action=discard")
  })

  it("Reset asks first, then sets the working state only", async () => {
    api.resetSiteTemplate.mockResolvedValue(row({ working_state: "reset" }))
    await render()
    await act(async () => rowOf("Archive").querySelector<HTMLButtonElement>('button[aria-label="More for Archive"]')!.click())
    await act(async () => ([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((i) => i.textContent === "Reset to theme default…")!).click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain("Reset Archive to the theme default?")
    expect(dialog.textContent).toContain("Archive will use Paper’s code layout again when you publish.")
    await act(async () => ([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Reset on publish")!).click())
    await settle()
    expect(api.resetSiteTemplate).toHaveBeenCalledWith(2)
  })

  it("on a phone: read-only rows, Publish still works", async () => {
    media.phone = true
    await render()
    expect(container.textContent).toContain("Use a larger screen to edit templates and styles.")
    expect(container.querySelector('button[aria-label^="Customize"]')).toBeNull()
    expect(container.querySelector('button[aria-label^="More for"]')).toBeNull()
    expect([...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Publish site design"))!.disabled).toBe(false)
  })

  it("the error page when the overview can't load", async () => {
    api.getSiteDesignOverview.mockRejectedValue(new Error("boom"))
    await render()
    expect(container.textContent).toContain("Something went wrong")
  })
})
