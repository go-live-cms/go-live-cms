import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Settings (#343, #330): the sticky unsaved-changes bar appears once a field differs
// from what's saved, Discard puts the saved values back, and Save sends the draft.

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}))

vi.mock("@gl-admin/lib/auth", () => ({
  authManager: { getState: () => ({ accessToken: "token", user: null }), subscribe: () => () => {} },
}))
vi.mock("@gl-admin/lib/api/settings", () => ({
  getSettings: api.getSettings,
  updateSettings: api.updateSettings,
}))
// The Front page field's pages (#336).
const posts = vi.hoisted(() => ({ getPosts: vi.fn(), getPostById: vi.fn() }))
vi.mock("@gl-admin/lib/api/posts", () => posts)
const editorSettings = vi.hoisted(() => ({ setEditorSettings: vi.fn() }))
// URLs & redirects (#331).
const redirects = vi.hoisted(() => ({ listRedirects: vi.fn(), createRedirect: vi.fn(), deleteRedirect: vi.fn() }))
vi.mock("@gl-admin/lib/api/redirects", () => redirects)
vi.mock("@gl-admin/lib/editorSettings", () => editorSettings)

import Settings from "./Settings"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SAVED = {
  id: 1,
  site_title: "GoLive Blog",
  posts_per_page: 10,
  post_url_structure: "slug",
  site_tagline: "Notes from the team",
  site_language: "en-US",
  site_timezone: "America/Sao_Paulo",
  date_format: "month_day_year",
  editor_markdown_shortcuts: true,
  editor_allowed_embeds: ["youtube", "vimeo"],
  allow_signup: false,
  site_address: "https://cms.example.com",
  created_at: "2026-10-01T00:00:00Z",
  changed_at: "2026-10-01T00:00:00Z",
}

let container: HTMLDivElement
let root: Root

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

async function render() {
  await act(async () => root.render(<Settings />))
  // The settings request, then Input's lazily loaded mask.
  await settle()
}

const bar = () => container.querySelector<HTMLElement>("[role='region'][aria-label='Unsaved changes']")
const field = (name: string) => container.querySelector<HTMLInputElement>(`input[id='input-${name}']`)!
const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement

// Types the way the browser does: the native value setter, then an input event.
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.getSettings.mockReset().mockResolvedValue({ ...SAVED })
  api.updateSettings.mockReset()
  editorSettings.setEditorSettings.mockReset()
  posts.getPosts.mockReset().mockResolvedValue({
    data: [
      { id: 12, title: "Home", post_type: "page", post_status: "published" },
      { id: 4, title: "About", post_type: "page", post_status: "published" },
    ],
    meta: { total: 2 },
  })
  posts.getPostById.mockReset()
  redirects.listRedirects.mockReset().mockResolvedValue({ redirects: [], total: 0 })
  redirects.createRedirect.mockReset()
  redirects.deleteRedirect.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("the unsaved-changes bar", () => {
  it("stays hidden until something changes", async () => {
    await render()
    expect(field("site_title").value).toBe("GoLive Blog")
    expect(bar()).toBeNull()
  })

  it("names the change once a field is dirty, and hides again when it's typed back", async () => {
    await render()
    await type(field("site_title"), "GoLive Notes")
    expect(bar()?.textContent).toContain("You changed the site title")

    await type(field("site_title"), "GoLive Blog")
    expect(bar()).toBeNull()
  })

  it("counts a radio change too", async () => {
    await render()
    const byId = container.querySelector<HTMLInputElement>("input[type='radio'][value='id']")!
    await act(async () => byId.click())
    expect(bar()?.textContent).toContain("You changed the post URL structure")
  })

  it("Discard puts the saved values back without a request", async () => {
    await render()
    await type(field("site_title"), "Draft title")
    await type(field("posts_per_page"), "25")
    expect(bar()?.textContent).toContain("You changed the site title and posts per page")

    await act(async () => button("Discard").click())
    await settle()
    expect(bar()).toBeNull()
    expect(field("site_title").value).toBe("GoLive Blog")
    expect(field("posts_per_page").value).toBe("10")
    expect(api.updateSettings).not.toHaveBeenCalled()
  })

  it("Save sends the draft and hides the bar once saved", async () => {
    api.updateSettings.mockImplementation(async (body) => ({ ...SAVED, ...body }))
    await render()
    await type(field("site_title"), "GoLive Notes")

    await act(async () => button("Save changes").click())
    await settle()
    expect(api.updateSettings).toHaveBeenCalledWith(
      {
        site_title: "GoLive Notes",
        site_tagline: "Notes from the team",
        site_language: "en-US",
        site_timezone: "America/Sao_Paulo",
        date_format: "month_day_year",
        posts_per_page: 10,
        post_url_structure: "slug",
        editor_markdown_shortcuts: true,
        allow_signup: false,
      },
      "token"
    )
    expect(bar()).toBeNull()
    expect(field("site_title").value).toBe("GoLive Notes")
    // Editors opened from now on get the saved editor settings.
    expect(editorSettings.setEditorSettings).toHaveBeenCalledWith(expect.objectContaining({ editor_markdown_shortcuts: true }))
  })

  it("keeps the bar with the error when the save fails", async () => {
    api.updateSettings.mockRejectedValue(new Error("Server unavailable"))
    await render()
    await type(field("site_title"), "GoLive Notes")

    await act(async () => button("Save changes").click())
    await settle()
    expect(bar()?.textContent).toContain("Couldn't save. Server unavailable")
    expect(bar()?.querySelector("[role='alert']")).not.toBeNull()
  })

  it("refuses an empty title before sending anything", async () => {
    await render()
    await type(field("site_title"), "")
    await act(async () => button("Save changes").click())
    await settle()
    expect(api.updateSettings).not.toHaveBeenCalled()
    expect(bar()?.textContent).toContain("Enter a site title.")
  })
})

describe("Front page (#336)", () => {
  const frontField = () =>
    [...container.querySelectorAll<HTMLButtonElement>("button[role='combobox']")].find(
      (b) => container.querySelector(`label[for='${b.id}']`)?.textContent === "Front page"
    )!
  const hintOf = (b: HTMLButtonElement) =>
    (b.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")

  it("lists the latest posts and the published pages, and saves the pick", async () => {
    api.updateSettings.mockImplementation(async (body) => ({ ...SAVED, front_page_id: null, ...body }))
    await render()
    expect(posts.getPosts).toHaveBeenCalledWith(expect.objectContaining({ type: "page", status: "published" }))
    const trigger = frontField()
    expect(trigger.textContent).toContain("Your latest posts")
    expect(hintOf(trigger)).toContain("Your home page lists your latest posts.")

    await act(async () => trigger.click())
    const options = [...document.querySelectorAll<HTMLElement>("[role='option']")]
    expect(options.map((o) => o.textContent)).toEqual(["Your latest posts", "About", "Home"])
    await act(async () => options[2].click())
    await settle()
    expect(bar()?.textContent).toContain("You changed the front page")

    await act(async () => button("Save changes").click())
    await settle()
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ front_page_id: 12 }), "token")
    expect(hintOf(frontField())).toContain("Your home page shows this page")
  })

  it("warns when the saved front page isn't published, and saves other fields without it", async () => {
    api.getSettings.mockResolvedValue({ ...SAVED, front_page_id: 30 })
    posts.getPostById.mockResolvedValue({ post: { id: 30, title: "Old home", post_type: "page", post_status: "draft" } })
    api.updateSettings.mockImplementation(async (body) => ({ ...SAVED, front_page_id: 30, ...body }))
    await render()
    const trigger = frontField()
    expect(trigger.textContent).toContain("Old home (not published)")
    expect(hintOf(trigger)).toContain("“Old home” isn’t published, so your home page shows your latest posts until it is.")

    await type(field("site_title"), "GoLive Notes")
    await act(async () => button("Save changes").click())
    await settle()
    expect(api.updateSettings.mock.calls[0][0]).not.toHaveProperty("front_page_id")
  })
})

describe("General and Editor (#330)", () => {
  it("shows the tagline, language, time zone and date format, and the sections nav", async () => {
    await render()
    expect(field("site_tagline").value).toBe("Notes from the team")
    const text = container.textContent ?? ""
    for (const shown of ["Language", "English (US)", "Time zone", "Date format", "Editor", "Markdown shortcuts"]) {
      expect(text).toContain(shown)
    }
    const nav = container.querySelector("nav[aria-label='Settings sections']")!
    expect([...nav.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["General", "#gl-settings-general"],
      ["Editor", "#gl-settings-editor"],
      ["Accounts", "#gl-settings-accounts"],
      ["URLs & redirects", "#gl-settings-urls"],
    ])
  })

  it("marks the section in the URL's hash as current", async () => {
    window.history.replaceState(null, "", "#gl-settings-editor")
    try {
      await render()
      const current = container.querySelector("nav[aria-label='Settings sections'] a[aria-current='true']")
      expect(current?.textContent).toBe("Editor")
    } finally {
      window.history.replaceState(null, "", window.location.pathname)
    }
  })

  it("shows the site address read-only with its HTTPS state and the runbook link", async () => {
    await render()
    expect(container.textContent).toContain("https://cms.example.com")
    expect(container.textContent).toContain("HTTPS on")
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent?.includes("Change domain"))!
    expect(link.getAttribute("href")).toMatch(/docs\/operations\/deploy\.md#change-the-domain$/)
    expect(container.querySelector("input[name='site_address']")).toBeNull()

    api.getSettings.mockResolvedValue({ ...SAVED, site_address: "http://localhost:4321" })
    await act(async () => root.unmount())
    root = createRoot(container)
    await render()
    expect(container.textContent).toContain("No HTTPS")
  })

  it("labels each date format with today in the chosen language and zone", async () => {
    await render()
    const labels = [...container.querySelectorAll(".gl-settings__date-format .gl-choice__label")].map((l) => l.textContent)
    expect(labels).toHaveLength(3)
    expect(labels[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(labels[0]).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/)
  })

  it("toggles Markdown shortcuts through the bar", async () => {
    api.updateSettings.mockImplementation(async (body) => ({ ...SAVED, ...body }))
    await render()
    const toggle = container.querySelector<HTMLButtonElement>("button[role='switch']")!
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    await act(async () => toggle.click())
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(bar()?.textContent).toContain("You changed the Markdown shortcuts")

    await act(async () => button("Save changes").click())
    await settle()
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ editor_markdown_shortcuts: false }), "token")
    expect(editorSettings.setEditorSettings).toHaveBeenCalledWith(expect.objectContaining({ editor_markdown_shortcuts: false }))
  })

  it("refuses an over-long tagline before sending anything", async () => {
    await render()
    await type(field("site_tagline"), "x".repeat(161))
    await act(async () => button("Save changes").click())
    await settle()
    expect(api.updateSettings).not.toHaveBeenCalled()
    expect(bar()?.textContent).toContain("at most 160")
  })
})

it("hides the settings that have no backend yet (#352)", async () => {
  await render()
  const text = container.textContent ?? ""
  for (const hidden of ["Allowed embeds", "Media", "Email"]) {
    expect(text).not.toContain(hidden)
  }
})

describe("Accounts (#191)", () => {
  const signupSwitch = () => container.querySelector<HTMLButtonElement>("#gl-settings-accounts button[role='switch']")!

  it("shows the sign-up switch, off as saved, in its own section", async () => {
    await render()
    expect(container.querySelector("#gl-settings-accounts")?.textContent).toContain("Allow anyone to sign up")
    expect(container.querySelector("nav[aria-label='Settings sections']")?.textContent).toContain("Accounts")
    expect(signupSwitch().getAttribute("aria-checked")).toBe("false")
  })

  it("turns sign-up on through the bar", async () => {
    api.updateSettings.mockImplementation(async (body) => ({ ...SAVED, ...body }))
    await render()
    await act(async () => signupSwitch().click())
    expect(bar()?.textContent).toContain("You changed the sign-up setting")

    await act(async () => button("Save changes").click())
    await settle()
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ allow_signup: true }), "token")
    expect(bar()).toBeNull()
  })
})

describe("URLs & redirects (#331)", () => {
  const ROW = {
    id: 3,
    from_path: "/blog/collab-preview",
    to_path: "/blog/collaboration",
    status_code: 301,
    source: "manual",
    external: false,
    created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    created_by: { id: 2, username: "ana", full_name: "Ana Costa", avatar: null },
  }
  const section = () => container.querySelector<HTMLElement>("#gl-settings-urls")!
  const rfield = (name: "from" | "to") => container.querySelector<HTMLInputElement>(`#gl-redirect-${name}`)!
  const rows = () => Array.from(section().querySelectorAll("tbody tr"))
  const submitAdd = async () => {
    await act(async () => section().querySelector<HTMLFormElement>("form[aria-label='Add a redirect']")!.requestSubmit())
    await settle()
  }

  it("offers the category URL structure and links the hint to the section", async () => {
    await render()
    const byCategory = container.querySelector<HTMLInputElement>("input[type='radio'][value='category']")!
    expect(byCategory.closest("label")?.textContent).toContain("By category")
    expect(byCategory.closest("label")?.textContent).toContain("/guides/my-first-post")
    await act(async () => byCategory.click())
    expect(bar()?.textContent).toContain("You changed the post URL structure")

    const link = Array.from(container.querySelectorAll("a")).find((a) => a.closest(".gl-workspace-field__hint") && a.textContent === "URLs & redirects")!
    expect(link.getAttribute("href")).toBe("#gl-settings-urls")
  })

  it("is its own form, outside the settings form", async () => {
    await render()
    expect(section().closest("form")).toBeNull()
    expect(section().querySelector("h2")?.textContent).toBe("URLs & redirects")
    expect(section().textContent).toContain("Send an old address to a new one, so saved links and search results keep working.")
  })

  it("shows the empty state, then the list with who added each and when", async () => {
    await render()
    expect(section().textContent).toContain("No redirects yet")

    redirects.listRedirects.mockResolvedValue({
      redirects: [
        ROW,
        { ...ROW, id: 2, from_path: "/old", to_path: "https://example.com/x", external: true, status_code: 302, source: "manual" },
        { ...ROW, id: 1, from_path: "/tag/photos", to_path: "/tag/images", source: "merge", created_by: null },
      ],
      total: 3,
    })
    act(() => root.unmount())
    root = createRoot(container)
    await render()
    expect(redirects.listRedirects).toHaveBeenCalledWith({ limit: 20, offset: 0 })
    expect(section().querySelector("h3")?.textContent).toBe("3 redirects")
    const [first, second, third] = rows()
    expect(first.textContent).toContain("/blog/collab-preview")
    expect(first.textContent).toContain("Ana Costa")
    expect(first.textContent).toContain("5 minutes ago")
    expect(first.querySelector(".gl-avatar")).not.toBeNull()
    expect(second.textContent).toContain("External")
    expect(second.textContent).toContain("302")
    expect(third.textContent).toContain("Automatic")
    expect(section().querySelector("button[aria-label='Delete redirect from /old']")).not.toBeNull()
    expect(button("Show more")).toBeUndefined()
  })

  it("adds a redirect at once, without the unsaved-changes bar, and Enter there doesn't save settings", async () => {
    redirects.createRedirect.mockResolvedValue({ ...ROW, id: 10, from_path: "/old-page", to_path: "/new-page", status_code: 302 })
    await render()
    await type(rfield("from"), "/old-page/")
    await type(rfield("to"), "/new-page")
    await act(async () => section().querySelector<HTMLInputElement>("input[type='radio'][value='302']")!.click())
    expect(bar()).toBeNull()

    // Enter in the From field: the settings form's handler must not run.
    await act(async () => {
      rfield("from").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    })
    expect(api.updateSettings).not.toHaveBeenCalled()

    await submitAdd()
    expect(redirects.createRedirect).toHaveBeenCalledWith({ from_path: "/old-page", to_path: "/new-page", status_code: 302 })
    expect(rows()[0].textContent).toContain("/old-page")
    expect(section().querySelector("h3")?.textContent).toBe("1 redirect")
    expect(rfield("from").value).toBe("")
    expect(api.updateSettings).not.toHaveBeenCalled()
  })

  it("checks the addresses before sending, and shows the API's codes on their field", async () => {
    await render()
    await type(rfield("from"), "/gl-admin/x")
    await type(rfield("to"), "new")
    await submitAdd()
    expect(redirects.createRedirect).not.toHaveBeenCalled()
    expect(section().textContent).toContain("Addresses under /gl-admin can’t be redirected.")
    expect(section().textContent).toContain("Start with / for a page on this site")

    const { ApiError } = await import("@gl-admin/lib/api/errors")
    redirects.createRedirect.mockRejectedValue(new ApiError("exists", 409, null, "redirect_exists"))
    await type(rfield("from"), "/taken")
    await type(rfield("to"), "/new")
    await submitAdd()
    expect(rfield("from").getAttribute("aria-invalid")).toBe("true")
    expect(section().textContent).toContain("/taken already redirects somewhere.")
  })

  it("deletes after a confirmation", async () => {
    redirects.listRedirects.mockResolvedValue({ redirects: [ROW], total: 1 })
    await render()
    await act(async () => section().querySelector<HTMLButtonElement>("button[aria-label='Delete redirect from /blog/collab-preview']")!.click())
    const dialog = container.querySelector("[role='alertdialog']")!
    expect(dialog.textContent).toContain("/blog/collab-preview will stop sending visitors to /blog/collaboration")
    await act(async () => button("Delete redirect").click())
    await settle()
    expect(redirects.deleteRedirect).toHaveBeenCalledWith(3)
    expect(container.querySelector("[role='alertdialog']")).toBeNull()
    expect(section().textContent).toContain("No redirects yet")
  })

  it("shows a load error with Try again, and Show more past the first page", async () => {
    redirects.listRedirects.mockRejectedValueOnce(new Error("Server unavailable"))
    await render()
    expect(section().textContent).toContain("Couldn't load redirects")

    redirects.listRedirects
      .mockResolvedValueOnce({ redirects: [ROW], total: 2 })
      .mockResolvedValueOnce({ redirects: [{ ...ROW, id: 1, from_path: "/older" }], total: 2 })
    await act(async () => button("Try again").click())
    await settle()
    expect(rows()).toHaveLength(1)
    await act(async () => button("Show more").click())
    await settle()
    expect(redirects.listRedirects).toHaveBeenLastCalledWith({ limit: 20, offset: 1 })
    expect(rows()).toHaveLength(2)
    expect(button("Show more")).toBeUndefined()
  })
})
