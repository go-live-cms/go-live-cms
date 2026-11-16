import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import axe from "axe-core"
import { declaredTokens, SYSTEM_FONT_STACKS, contrastFailures } from "@/lib/globalStyles"
import defaultConfig from "../../themes/default/theme.config"
import type { GlobalStylesResponse } from "@gl-admin/lib/api/siteDesign"

// The global styles screen (#487) on a mocked API: saving as you go with base_revision,
// the API's messages, a 409's other draft, Reset, the preview's reloads, the styles-only
// publish with its contrast confirmation, and axe over each state.

const api = vi.hoisted(() => ({
  getGlobalStyles: vi.fn(),
  saveGlobalStyles: vi.fn(),
  publishSiteDesign: vi.fn(),
}))
const preview = vi.hoisted(() => ({ openDesignPreview: vi.fn(), createDesignPreview: vi.fn() }))
const media = vi.hoisted(() => ({ phone: false }))

vi.mock("@gl-admin/lib/api/siteDesign", async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }))
vi.mock("@gl-admin/lib/api/designPreview", () => preview)
vi.mock("@gl-admin/contexts/GoLiveContext", () => ({
  useGoLive: () => ({ baseTitle: "GoLive Admin |", isDark: false }),
}))
vi.mock("@gl-admin/components/sidebar/Sidebar", () => ({ MOBILE_QUERY: "(width <= 768px)" }))
vi.mock("@gl-admin/lib/hooks/useMediaQuery", () => ({ useMediaQuery: () => media.phone }))

import GlobalStyles from "./GlobalStyles"
import { ContrastUnconfirmedError, StylesChangedError } from "@gl-admin/lib/api/siteDesign"
import { ApiError } from "@gl-admin/lib/api/errors"
import { Toaster } from "@gl-admin/components/ui/Toast"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tokens = declaredTokens(defaultConfig)
const theme = { tokens, fontOptions: defaultConfig.fontOptions }

function response(over: Partial<GlobalStylesResponse> = {}): GlobalStylesResponse {
  const draft = over.draft ?? {}
  return {
    theme: { id: 1, slug: "default", name: "Paper" },
    supported: true,
    tokens,
    font_options: (defaultConfig.fontOptions ?? []).map(({ id, label, stack }) => ({ id, label, stack })),
    system_fonts: Object.keys(SYSTEM_FONT_STACKS),
    draft,
    draft_revision: 3,
    published: {},
    has_unpublished_changes: Object.keys(draft).length > 0,
    contrast: contrastFailures(theme, draft),
    changed_at: null,
    ...over,
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  media.phone = false
  api.getGlobalStyles.mockReset().mockResolvedValue(response())
  api.saveGlobalStyles
    .mockReset()
    .mockImplementation(async (styles: Record<string, unknown>, base: number) =>
      response({ draft: styles, draft_revision: base + 1 })
    )
  api.publishSiteDesign.mockReset()
  preview.openDesignPreview.mockReset().mockResolvedValue({ token: "t", theme: "default", expires_at: "" })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

async function render() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <GlobalStyles />
        <Toaster />
      </MemoryRouter>
    )
  })
  await act(async () => {})
}

const byLabel = (label: string) => {
  const found = [...document.querySelectorAll("label")].find((l) => l.textContent?.replace(" (changed)", "") === label)
  if (!found) throw new Error(`no field labelled ${label}`)
  return document.getElementById(found.htmlFor) as HTMLInputElement
}

const button = (name: string | RegExp) => {
  const match = (text: string) => (typeof name === "string" ? text === name : name.test(text))
  const found = [...document.querySelectorAll("button")].find(
    (b) => match((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()) || match((b.textContent ?? "").trim())
  )
  if (!found) throw new Error(`no button ${name}`)
  return found as HTMLButtonElement
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

// Leaving the field saves at once (no waiting for the pause).
async function commit(input: HTMLInputElement) {
  await act(async () => {
    input.focus()
    input.blur()
  })
  await act(async () => {})
}

async function click(element: HTMLElement) {
  await act(async () => element.click())
  await act(async () => {})
}

async function violations(context: Element = document.body) {
  const result = await axe.run(context, {
    // The preview frame is the public site (its own axe checks, #481), and jsdom can't post into it.
    iframes: false,
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: false },
      "landmark-one-main": { enabled: false },
    },
  })
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
}

describe("the global styles screen", () => {
  it("draws light and dark side by side, every group, the contrast and the preview", async () => {
    await render()
    expect(document.title).toBe("GoLive Admin | Global styles")
    expect(byLabel("Primary (light)").value).toBe((tokens.colors as { light: { primary: string } }).light.primary)
    expect(byLabel("Primary (dark)").value).toBe((tokens.colors as { dark: { primary: string } }).dark.primary)
    for (const heading of ["Colours", "Block colours", "Fonts", "Type scale", "Layout", "Spacing & radius"]) {
      expect([...document.querySelectorAll("h2")].some((h) => h.textContent === heading)).toBe(true)
    }
    expect(container.textContent).toContain("Text on background")
    expect(container.querySelector("iframe")?.getAttribute("title")).toBe("Your site with these styles")
    expect(preview.openDesignPreview).toHaveBeenCalledWith(expect.stringMatching(/^gl-styles-preview-/), "/")
    expect(await violations()).toEqual([])
  }, 30_000) // axe over the whole form (about 150 fields)

  it("saves the whole draft with its revision, and reloads the preview", async () => {
    await render()
    const calls = preview.openDesignPreview.mock.calls.length
    const field = byLabel("Primary (light)")
    await type(field, "#155E4B")
    await commit(field)
    expect(api.saveGlobalStyles).toHaveBeenCalledWith({ colors: { light: { primary: "#155E4B" } } }, 3)
    expect(preview.openDesignPreview.mock.calls.length).toBe(calls + 1)
    expect(container.textContent).toContain("Saved")
    expect(container.textContent).toContain("Changes not published")
    // The next save is made to the revision the last one returned.
    const content = byLabel("Content width")
    await type(content, "640px")
    await commit(content)
    expect(api.saveGlobalStyles).toHaveBeenLastCalledWith(
      { colors: { light: { primary: "#155E4B" } }, layout: { contentWidth: "640px" } },
      4
    )
  })

  it("saves after a pause without leaving the field", async () => {
    vi.useFakeTimers()
    await render()
    await type(byLabel("Gutter"), "24px")
    expect(api.saveGlobalStyles).not.toHaveBeenCalled()
    expect(container.textContent).toContain("Saving…")
    await act(async () => {
      vi.advanceTimersByTime(700)
    })
    expect(api.saveGlobalStyles).toHaveBeenCalledWith({ layout: { gutter: "24px" } }, 3)
  })

  it("refuses what the API refuses, with its message, and sends nothing", async () => {
    await render()
    const size = byLabel("Size xl")
    await type(size, "calc(1.5rem + 1px)")
    await commit(size)
    expect(api.saveGlobalStyles).not.toHaveBeenCalled()
    expect(size.getAttribute("aria-invalid")).toBe("true")
    const message = document.getElementById(size.getAttribute("aria-describedby")!.split(" ")[0])!
    expect(message.textContent).toBe("Must be a length (px, rem, em, %, vw) or clamp() of lengths.")
    expect(message.getAttribute("role")).toBe("alert")
    expect(container.textContent).toContain("Fix the marked value to save")
    expect(await violations()).toEqual([])

    // The order rules too, once every value is right.
    await type(size, "1.5rem")
    const content = byLabel("Content width")
    await type(content, "1000px")
    await commit(content)
    expect(api.saveGlobalStyles).not.toHaveBeenCalled()
    expect(container.textContent).toContain("contentWidth must be at most wideWidth.")
  }, 30_000)

  it("shows the other admin's draft on a 409, naming the change that wasn't saved", async () => {
    const theirs = response({ draft: { colors: { light: { primary: "#1b7760" } } }, draft_revision: 9 })
    api.saveGlobalStyles.mockRejectedValueOnce(new StylesChangedError(theirs))
    await render()
    const field = byLabel("Primary (light)")
    await type(field, "#155e4b")
    await commit(field)
    expect(byLabel("Primary (light)").value).toBe("#1b7760")
    const notice = [...document.querySelectorAll('[role="alert"]')].find((n) =>
      n.textContent?.includes("Another admin changed the styles")
    )
    expect(notice?.textContent).toContain("Your last change, Primary (light) to #155e4b, wasn't saved.")
    expect(notice?.textContent).toContain("The form now shows their version.")
    // Their revision is the base of the next save.
    const gutter = byLabel("Gutter")
    await type(gutter, "24px")
    await commit(gutter)
    expect(api.saveGlobalStyles).toHaveBeenLastCalledWith(
      { colors: { light: { primary: "#1b7760" } }, layout: { gutter: "24px" } },
      9
    )
  })

  it("keeps a value whose save failed, and tries again", async () => {
    api.saveGlobalStyles.mockRejectedValueOnce(
      new ApiError("Something went wrong on the server. Please try again in a moment.", 500)
    )
    await render()
    const field = byLabel("Header height")
    await type(field, "72px")
    await commit(field)
    expect(container.textContent).toContain("Couldn't save your last change")
    expect(byLabel("Header height").value).toBe("72px")
    await click(button("Try again"))
    expect(api.saveGlobalStyles).toHaveBeenCalledTimes(2)
    expect(api.saveGlobalStyles).toHaveBeenLastCalledWith({ layout: { headerHeight: "72px" } }, 3)
    expect(container.textContent).toContain("Saved")
  })

  it("resets one group, and asks before resetting all", async () => {
    const draft = { colors: { light: { primary: "#155e4b" } }, layout: { contentWidth: "640px" } }
    api.getGlobalStyles.mockResolvedValue(response({ draft }))
    await render()
    expect(byLabel("Content width").value).toBe("640px")
    await click(button("Reset layout"))
    expect(api.saveGlobalStyles).toHaveBeenLastCalledWith({ colors: { light: { primary: "#155e4b" } } }, 3)
    expect(byLabel("Content width").value).toBe("680px")
    expect(button("Reset layout").disabled).toBe(true)

    await click(button("Reset all…"))
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain("Reset all global styles?")
    expect(api.saveGlobalStyles).toHaveBeenCalledTimes(1)
    await click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Reset all")!)
    expect(api.saveGlobalStyles).toHaveBeenLastCalledWith({}, 4)
  })

  it("publishes the styles, showing the failing pairs and asking to publish anyway", async () => {
    const draft = { colors: { dark: { primary: "#1b3a30" } } }
    const stored = response({ draft })
    expect(stored.contrast.length).toBeGreaterThan(0)
    api.getGlobalStyles.mockResolvedValue(stored)
    api.publishSiteDesign.mockResolvedValue({
      release: { id: 1, theme_slug: "default", published_at: "" },
      global_styles: { version_no: 1, groups: ["colors"], contrast_failures: 1 },
      styles: { ...stored, published: draft, has_unpublished_changes: false },
    })
    await render()
    // The field in a failing pair says so in words, not only by its edge.
    expect(container.textContent).toContain("Fails contrast")

    await click(button(/^Publish site design/))
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain("Publish site design?")
    expect(dialog.textContent).toContain("Global styles")
    expect(dialog.textContent).toContain("Colours")
    expect(dialog.textContent).toMatch(/Primary on background · dark/)
    expect(dialog.textContent).toContain("needs 4.5:1")
    expect(await violations(dialog)).toEqual([])
    await click([...dialog.querySelectorAll("button")].find((b) => b.textContent?.includes("Publish anyway"))!)
    expect(api.publishSiteDesign).toHaveBeenCalledWith({ confirmContrast: true })
    expect(document.body.textContent).toContain("Site design published")
    expect(container.textContent).not.toContain("Changes not published")
  })

  it("asks again when the publish finds pairs the dialog didn't list", async () => {
    const draft = { layout: { gutter: "24px" } }
    api.getGlobalStyles.mockResolvedValue(response({ draft }))
    api.publishSiteDesign.mockRejectedValueOnce(
      new ContrastUnconfirmedError([
        { palette: "light", foreground: "text", background: "surface", ratio: 3.2, minimum: 4.5 },
      ])
    )
    await render()
    await click(button(/^Publish site design/))
    const dialog = document.querySelector('[role="dialog"]')!
    await click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Publish")!)
    expect(api.publishSiteDesign).toHaveBeenCalledWith({ confirmContrast: false })
    expect(dialog.textContent).toContain("Text on surface · light")
    expect(dialog.textContent).toContain("Publish anyway")
  })

  it("names a theme that doesn't read global styles", async () => {
    api.getGlobalStyles.mockResolvedValue(
      response({ supported: false, theme: { id: 2, slug: "plain", name: "Plain" } })
    )
    await render()
    expect(container.textContent).toContain("Plain doesn't support global styles")
    expect(container.querySelector('a[href="/themes"]')?.textContent).toBe("Back to Themes")
    expect(await violations()).toEqual([])
  })

  it("asks for a larger screen on a phone", async () => {
    media.phone = true
    await render()
    expect(container.textContent).toContain("Use a larger screen to edit styles")
    expect(api.getGlobalStyles).toHaveBeenCalled()
    expect(await violations()).toEqual([])
  })

  it("offers Try again when the styles can't be read", async () => {
    api.getGlobalStyles.mockRejectedValueOnce(
      new ApiError("Something went wrong on the server. Please try again in a moment.", 500)
    )
    await render()
    expect(container.textContent).toContain("Couldn't load the styles")
    await click(button("Try again"))
    expect(byLabel("Primary (light)")).toBeTruthy()
  })

  it("offers the preview again when it can't load", async () => {
    preview.openDesignPreview.mockRejectedValueOnce(new Error("no"))
    await render()
    expect(container.textContent).toContain("The preview couldn't load")
    await click(button("Reload preview"))
    expect(preview.openDesignPreview).toHaveBeenCalledTimes(2)
  })

  it("switches the preview's width and scheme with buttons", async () => {
    await render()
    const phone = button("Phone")
    expect(phone.getAttribute("aria-pressed")).toBe("false")
    await click(phone)
    expect(phone.getAttribute("aria-pressed")).toBe("true")
    expect(container.querySelector("iframe")!.style.width).toBe("375px")
    await click(button("Dark"))
    expect(button("Dark").getAttribute("aria-pressed")).toBe("true")
  })
})
