import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Settings (#343): the sticky unsaved-changes bar appears once a field differs from
// what's saved, Discard puts the saved values back, and Save sends the draft.

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

import Settings from "./Settings"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SAVED = {
  id: 1,
  site_title: "GoLive Blog",
  posts_per_page: 10,
  post_url_structure: "slug",
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
      { site_title: "GoLive Notes", posts_per_page: 10, post_url_structure: "slug" },
      "token"
    )
    expect(bar()).toBeNull()
    expect(field("site_title").value).toBe("GoLive Notes")
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

it("hides the settings that have no backend yet (#330, #331)", async () => {
  await render()
  const text = container.textContent ?? ""
  for (const hidden of ["Tagline", "Language", "Time zone", "Date format", "Editor", "URLs & redirects"]) {
    expect(text).not.toContain(hidden)
  }
})
