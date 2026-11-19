import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import axe from "axe-core"

// Settings › Discussion (#527): off shows the switch alone, the switch stays hidden until
// the moderation queue ships, the form refuses what the API refuses before any request,
// and a save sends only what changed.

const api = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn() }))
vi.mock("@gl-admin/lib/auth", () => ({
  authManager: { getState: () => ({ accessToken: "token", user: null }), subscribe: () => () => {} },
}))
vi.mock("@gl-admin/lib/api/settings", () => api)
const posts = vi.hoisted(() => ({ getPosts: vi.fn(), getPostById: vi.fn() }))
vi.mock("@gl-admin/lib/api/posts", () => posts)
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock("@gl-admin/components/ui/Toast", () => ({ toast: toasts }))

import SettingsDiscussion from "./SettingsDiscussion"
import { ApiError } from "@gl-admin/lib/api/errors"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SAVED = {
  id: 1,
  site_title: "GoLive",
  posts_per_page: 10,
  post_url_structure: "slug",
  site_tagline: "",
  site_language: "en-US",
  site_timezone: "UTC",
  date_format: "month_day_year",
  editor_markdown_shortcuts: true,
  editor_allowed_embeds: [],
  allow_signup: false,
  front_page_id: null,
  site_address: "",
  comments_enabled: true,
  comments_moderation: "first",
  comments_max_links: 1,
  comments_hold_words: ["refund"],
  comments_spam_words: ["casino"],
  comments_close_after_days: 0,
  comments_threading: "replies",
  comments_order: "oldest",
  comments_per_page: 30,
  comments_notice: "",
  comments_privacy_page_id: null,
  created_at: "",
  changed_at: "",
}

let container: HTMLDivElement
let root: Root

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  })

async function render(props: { switchReady?: boolean } = {}) {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/settings/discussion"]}>
        <SettingsDiscussion {...props} />
      </MemoryRouter>
    )
  )
  await settle()
}

const bar = () => container.querySelector<HTMLElement>("[role='region'][aria-label='Unsaved changes']")
const input = (name: string) => container.querySelector<HTMLInputElement>(`input[name='${name}']`)!
const textarea = (name: string) => container.querySelector<HTMLTextAreaElement>(`textarea[name='${name}']`)!
const sw = () => container.querySelector<HTMLButtonElement>("button[role='switch']")
const button = (label: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.getSettings.mockReset().mockResolvedValue({ ...SAVED })
  api.updateSettings.mockReset().mockImplementation(async (body) => ({ ...SAVED, ...body }))
  posts.getPosts.mockReset().mockResolvedValue({ data: [{ id: 8, title: "Privacy policy", post_type: "page", post_status: "published" }] })
  posts.getPostById.mockReset()
  toasts.success.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it("reads the settings with the admin's token, for the word lists", async () => {
  await render()
  expect(api.getSettings).toHaveBeenCalledWith("token")
  expect(textarea("comments_hold_words").value).toBe("refund")
  expect(document.title).toMatch(/Discussion settings$/)
})

it("is its own page after Editor in the Settings menu", async () => {
  await render()
  const nav = container.querySelector("nav[aria-label='Settings sections']")!
  expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["General", "Editor", "Discussion", "Accounts", "URLs & redirects"])
  expect(nav.querySelector("a[aria-current='page']")?.textContent).toBe("Discussion")
  expect(nav.querySelector("a")?.getAttribute("href")).toBe("/settings#gl-settings-general")
})

it("groups Moderation, Display and Privacy", async () => {
  await render()
  expect([...container.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Moderation", "Display", "Privacy"])
})

describe("the site switch (hidden until #526)", () => {
  it("isn't offered while comments are off: a note says why, and nothing else shows", async () => {
    api.getSettings.mockResolvedValue({ ...SAVED, comments_enabled: false })
    await render()
    expect(sw()).toBeNull()
    expect(container.textContent).toContain("Comments can’t be turned on yet")
    expect(container.querySelector("h3")).toBeNull()
    expect(textarea("comments_hold_words")).toBeNull()
  })

  it("shows while comments are on, so they can be turned off", async () => {
    await render()
    expect(sw()?.getAttribute("aria-checked")).toBe("true")
  })
})

describe("Off hides the rest", () => {
  it("shows the switch alone when off, and the rest when turned on", async () => {
    api.getSettings.mockResolvedValue({ ...SAVED, comments_enabled: false })
    await render({ switchReady: true })
    expect(sw()?.getAttribute("aria-checked")).toBe("false")
    expect(container.querySelector("h3")).toBeNull()
    expect(container.textContent).toContain("The rest of the settings appear when comments are on.")

    await act(async () => sw()!.click())
    expect([...container.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Moderation", "Display", "Privacy"])
    expect(bar()?.textContent).toContain("You changed the comments switch")

    await act(async () => button("Save changes").click())
    await settle()
    expect(api.updateSettings).toHaveBeenCalledWith({ comments_enabled: true }, "token")
    expect(toasts.success).toHaveBeenCalledWith("Comments are on")
  })

  it("turning it off hides the rest at once", async () => {
    await render({ switchReady: true })
    await act(async () => sw()!.click())
    expect(container.querySelector("h3")).toBeNull()
  })
})

describe("the form refuses what the API refuses", () => {
  it("a link limit out of range: no request, the field marked and focused", async () => {
    await render()
    await type(input("comments_max_links"), "12")
    await act(async () => button("Save changes").click())
    await settle()
    expect(api.updateSettings).not.toHaveBeenCalled()
    const field = input("comments_max_links")
    expect(field.getAttribute("aria-invalid")).toBe("true")
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Enter a number from 0 to 10.")
    expect(document.activeElement).toBe(field)
    expect(bar()?.textContent).toContain("Fix the fields marked in red to save.")
  })

  it("a hold word over 64 characters, by its line", async () => {
    await render()
    await type(textarea("comments_hold_words"), "refund\ncasino\n" + "x".repeat(65))
    await act(async () => button("Save changes").click())
    await settle()
    expect(api.updateSettings).not.toHaveBeenCalled()
    expect(textarea("comments_hold_words").getAttribute("aria-invalid")).toBe("true")
    expect(container.textContent).toContain("Line 3 is longer than 64 characters.")

    // Fixed while typing, once a save was tried.
    await type(textarea("comments_hold_words"), "refund\ncasino")
    expect(textarea("comments_hold_words").getAttribute("aria-invalid")).toBeNull()
  })

  it("a refusal the form didn't predict lands on its field", async () => {
    api.updateSettings.mockRejectedValue(
      new ApiError("Comments per page must be between 10 and 100.", 400, null, "invalid_discussion_settings", "comments_per_page must be between 10 and 100")
    )
    await render()
    await type(input("comments_per_page"), "40")
    await act(async () => button("Save changes").click())
    await settle()
    expect(input("comments_per_page").getAttribute("aria-invalid")).toBe("true")
    expect(container.textContent).toContain("It must be between 10 and 100.")
  })
})

it("saves only what changed, then shows it saved", async () => {
  await render()
  await type(input("comments_close_after_days"), "30")
  await type(textarea("comments_spam_words"), "casino\n Casino \nreplica")
  const flat = Array.from(container.querySelectorAll<HTMLInputElement>("input[type='radio']")).find((r) => r.value === "flat")!
  await act(async () => flat.click())
  expect(bar()?.textContent).toContain("You changed 3 settings")

  await act(async () => button("Save changes").click())
  await settle()
  expect(api.updateSettings).toHaveBeenCalledWith(
    { comments_threading: "flat", comments_close_after_days: 30, comments_spam_words: ["casino", "replica"] },
    "token"
  )
  expect(toasts.success).toHaveBeenCalledWith("Discussion settings saved")
  expect(bar()).toBeNull()
})

it("Discard puts the saved values back", async () => {
  await render()
  await type(input("comments_max_links"), "4")
  await act(async () => button("Discard").click())
  expect(input("comments_max_links").value).toBe("1")
  expect(bar()).toBeNull()
})

/** axe's WCAG 2.x A/AA and best-practice rules (as components/ui/axe.test.tsx runs them). */
async function violations(context: Element) {
  const result = await axe.run(context, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: false },
      "landmark-one-main": { enabled: false },
    },
  })
  return result.violations.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.map((n) => n.html) }))
}

describe("axe (#479, #480)", () => {
  it("the whole form, with the board's invalid values", async () => {
    await render()
    await type(textarea("comments_hold_words"), "refund\n" + "x".repeat(65))
    await type(input("comments_max_links"), "12")
    await act(async () => button("Save changes").click())
    await settle()
    expect(container.querySelectorAll("[aria-invalid='true']")).toHaveLength(2)
    expect(await violations(container)).toEqual([])
  }, 30_000)

  it("off, with the note in place of the switch", async () => {
    api.getSettings.mockResolvedValue({ ...SAVED, comments_enabled: false })
    await render()
    expect(await violations(container)).toEqual([])
  })
})

it("a failed load offers Try again", async () => {
  api.getSettings.mockRejectedValueOnce(new Error("down"))
  await render()
  expect(container.textContent).toContain("Couldn't load the discussion settings")
  await act(async () => button("Try again").click())
  await settle()
  expect(textarea("comments_hold_words")).not.toBeNull()
})
