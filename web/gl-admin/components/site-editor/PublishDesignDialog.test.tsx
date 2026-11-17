import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import axe from "axe-core"
import type { SiteTemplate } from "@gl-admin/lib/api/siteDesign"

// "Publish site design" (#493; the board "Publish site design, reset & discard"): what goes
// live listed from the overview, refusals first and alone with Open, contrast after them with
// "Publish anyway", a failed flush saying nothing was published, and axe over each state.

const api = vi.hoisted(() => ({
  getSiteDesignOverview: vi.fn(),
  getGlobalStyles: vi.fn(),
  publishSiteDesign: vi.fn(),
}))
vi.mock("@gl-admin/lib/api/siteDesign", async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }))
vi.mock("@gl-admin/contexts/GoLiveContext", () => ({ useGoLive: () => ({ isDark: false }) }))

import { ContrastUnconfirmedError, DesignInvalidError } from "@gl-admin/lib/api/siteDesign"
import { ApiError } from "@gl-admin/lib/api/errors"
import PublishDesignDialog from "./PublishDesignDialog"

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
    source: "theme",
    source_hash: "",
    published: true,
    doc_name: "template-1",
    created_at: "",
    changed_at: "",
    change: "publish",
    has_unpublished_changes: true,
    published_version_no: 1,
    default_changed: false,
    can_delete: false,
    ...over,
  }
}

const overview = {
  theme: { id: 1, slug: "paper", name: "Paper" },
  templates: [row({ id: 1, slug: "single" }), row({ id: 2, kind: "part", slug: "header" }), row({ id: 3, slug: "archive", change: "", has_unpublished_changes: false })],
  global_styles_changed: true,
  global_styles_groups: ["colors"],
  unpublished_changes: 3,
}
const styles = {
  theme: { id: 1, slug: "paper", name: "Paper" },
  supported: true,
  tokens: {},
  font_options: [],
  system_fonts: [],
  draft: { colors: { light: { primary: "#225544" } } },
  draft_revision: 2,
  published: {},
  has_unpublished_changes: true,
  contrast: [],
  changed_at: null,
}
const pair = { palette: "dark", foreground: "primary", background: "surface", ratio: 4.1, minimum: 4.5, kind: "text" }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  api.getSiteDesignOverview.mockReset().mockResolvedValue(overview)
  api.getGlobalStyles.mockReset().mockResolvedValue(styles)
  api.publishSiteDesign.mockReset()
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
  for (let i = 0; i < 5; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const button = (label: string) => [...dialog().querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!

async function open(props: Partial<Parameters<typeof PublishDesignDialog>[0]> = {}) {
  const onClose = vi.fn()
  const onOpenItem = vi.fn()
  await act(async () => root.render(<PublishDesignDialog isOpen onClose={onClose} onOpenItem={onOpenItem} {...props} />))
  await settle()
  return { onClose, onOpenItem }
}

async function violations() {
  const result = await axe.run(dialog(), { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } })
  return result.violations.map((v) => v.id)
}

describe("Publish site design", () => {
  it("lists every changed template, part and the styles", async () => {
    await open()
    expect(dialog().textContent).toContain("Publish site design?")
    const items = [...dialog().querySelectorAll(".gl-styles-dialog__changes li")].map((li) => li.textContent)
    expect(items).toEqual(["Single postTemplate · changed", "HeaderTemplate part · changed", "Global stylesColours"])
    expect(dialog().textContent).toContain("To leave one out, discard its changes first.")
    expect(await violations()).toEqual([])
  })

  it("waits for the editor's edits first, then publishes and closes", async () => {
    const order: string[] = []
    const beforePublish = vi.fn(async () => {
      order.push("acknowledged")
    })
    api.publishSiteDesign.mockImplementation(async () => {
      order.push("published")
      return { release: { id: 9 }, global_styles: { version_no: 2 }, templates: [{}, {}], styles }
    })
    const onPublished = vi.fn()
    const { onClose } = await open({ beforePublish, onPublished })
    await act(async () => button("Publish").click())
    await settle()
    expect(order).toEqual(["acknowledged", "published"])
    expect(api.publishSiteDesign).toHaveBeenCalledWith({ confirmContrast: false })
    expect(onPublished).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it("names refusals, each with Open; nothing was published", async () => {
    api.publishSiteDesign.mockRejectedValueOnce(
      new DesignInvalidError("Nothing was published", [
        { code: "template_empty", id: 1, kind: "template", slug: "single" },
        { code: "part_unresolved", id: 2, kind: "part", slug: "header", part: "promo" },
      ])
    )
    const { onOpenItem } = await open()
    await act(async () => button("Publish").click())
    await settle()
    expect(dialog().textContent).toContain("Fix 2 things before publishing")
    expect(dialog().textContent).toContain("Nothing was published. These would break pages for readers.")
    expect(dialog().textContent).toContain("Single post is empty")
    expect(dialog().textContent).toContain("Header uses a part that doesn’t exist")
    expect(button("Publish").disabled).toBe(true)
    await act(async () => button("Open Header").click())
    expect(onOpenItem).toHaveBeenCalledWith(2)
    expect(await violations()).toEqual([])
  })

  it("on a phone a refusal says to fix it on a larger screen", async () => {
    api.publishSiteDesign.mockRejectedValueOnce(new DesignInvalidError("x", [{ code: "template_empty", id: 1, kind: "template", slug: "single" }]))
    await open({ onOpenItem: undefined })
    await act(async () => button("Publish").click())
    await settle()
    expect(dialog().textContent).toContain("Fix it on a larger screen.")
    expect([...dialog().querySelectorAll("button")].some((b) => b.textContent?.startsWith("Open"))).toBe(false)
  })

  it("asks about contrast, never refuses: Publish anyway", async () => {
    api.publishSiteDesign.mockRejectedValueOnce(new ContrastUnconfirmedError([pair] as never)).mockResolvedValueOnce({
      release: { id: 9 },
      global_styles: null,
      templates: [],
      styles,
    })
    await open()
    await act(async () => button("Publish").click())
    await settle()
    expect(dialog().textContent).toContain("1 colour pair is hard to read")
    expect(await violations()).toEqual([])
    await act(async () => button("Publish anyway").click())
    await settle()
    expect(api.publishSiteDesign).toHaveBeenLastCalledWith({ confirmContrast: true })
  })

  it("a failed flush: nothing was published, Try again", async () => {
    api.publishSiteDesign.mockRejectedValueOnce(new ApiError("The latest edits to Header couldn't be saved first", 503, null, "collab_unavailable"))
    await open()
    await act(async () => button("Publish").click())
    await settle()
    expect(dialog().textContent).toContain("Nothing was published.")
    expect(button("Try again")).toBeTruthy()
  })

  it("nothing to publish", async () => {
    api.getSiteDesignOverview.mockResolvedValue({ ...overview, templates: [], global_styles_changed: false, unpublished_changes: 0 })
    await open()
    expect(dialog().textContent).toContain("Nothing to publish")
    expect(button("Publish")).toBeUndefined()
  })
})
