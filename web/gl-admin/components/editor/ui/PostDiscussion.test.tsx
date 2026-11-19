import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import axe from "axe-core"

// The post's Discussion section (#527): what Default means now from the shared rule, a
// change applies at once through PUT /posts/:id/discussion (no Update, no "Changes not
// published"), and a failure says so.

const settingsApi = vi.hoisted(() => ({ getSettings: vi.fn() }))
vi.mock("@gl-admin/lib/api/settings", () => settingsApi)
const typesApi = vi.hoisted(() => ({ getPostTypeByName: vi.fn() }))
vi.mock("@gl-admin/lib/api/postTypes", () => typesApi)
const discussionApi = vi.hoisted(() => ({ getPostDiscussion: vi.fn(), setPostDiscussion: vi.fn() }))
vi.mock("@gl-admin/lib/api/postDiscussion", () => discussionApi)
vi.mock("@gl-admin/lib/hooks/useSiteSettings", () => ({
  useSiteDateSettings: () => ({ language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" }),
}))

import PostDiscussion from "./PostDiscussion"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  })

const answer = (discussion: string, over: Record<string, unknown> = {}) => ({
  post_id: 7,
  discussion,
  state: "open",
  closes_at: null,
  first_published_at: new Date(Date.now() - 2 * 86400000).toISOString(),
  ...over,
})

async function render(published = true) {
  await act(async () => root.render(<PostDiscussion postId={7} postType="post" published={published} />))
  await settle()
}

const radio = (label: string) =>
  Array.from(container.querySelectorAll("label")).find((l) => l.textContent === label)?.querySelector("input") as HTMLInputElement
const text = () => container.textContent ?? ""
const status = () => container.querySelector("[role='status']")!

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  settingsApi.getSettings.mockReset().mockResolvedValue({ comments_enabled: true, comments_close_after_days: 0 })
  typesApi.getPostTypeByName.mockReset().mockResolvedValue({
    post_type: { name: "post", label: "Posts", public: true, is_active: true, supports: ["title", "comments"] },
  })
  discussionApi.getPostDiscussion.mockReset().mockResolvedValue(answer("default"))
  discussionApi.setPostDiscussion.mockReset().mockImplementation(async (_id, discussion) => answer(discussion))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it("is a labelled section with the four choices, Default checked", async () => {
  await render()
  const section = container.querySelector("section")!
  expect(section.getAttribute("aria-labelledby")).toBe(section.querySelector("h3")!.id)
  expect(section.querySelector("h3")!.textContent).toBe("Discussion")
  expect(Array.from(section.querySelectorAll("label")).map((l) => l.textContent)).toEqual(["Default", "Open", "Closed", "Off"])
  expect(radio("Default").checked).toBe(true)
  expect(discussionApi.getPostDiscussion).toHaveBeenCalledWith(7)
  expect(typesApi.getPostTypeByName).toHaveBeenCalledWith("post")
})

it("says what Default means now, from the shared rule", async () => {
  await render()
  expect(text()).toContain("Default · Open")
  expect(text()).toContain("Follows Posts and the site.")
})

it("with the site's timer, says when it closes", async () => {
  settingsApi.getSettings.mockResolvedValue({ comments_enabled: true, comments_close_after_days: 30 })
  discussionApi.getPostDiscussion.mockResolvedValue(answer("default", { first_published_at: "2026-11-03T09:00:00Z" }))
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-19T12:00:00Z"))
  try {
    await render()
    expect(text()).toContain("Default · Open · closes on Dec 3")
  } finally {
    vi.useRealTimers()
  }
})

it("applies a change at once and says so, with no Update", async () => {
  await render()
  await act(async () => radio("Closed").click())
  await settle()
  expect(discussionApi.setPostDiscussion).toHaveBeenCalledWith(7, "closed")
  expect(radio("Closed").checked).toBe(true)
  expect(text()).toContain("Closed · shows its comments, takes no new ones")
  expect(status().textContent).toBe("Comments closed. Readers see it within a few minutes; no Update needed.")
})

it("a draft's change saves too", async () => {
  await render(false)
  await act(async () => radio("Off").click())
  await settle()
  expect(status().textContent).toBe("Comments section hidden. Saved; no Update needed.")
})

it("keeps its live region in the page, empty, before it speaks", async () => {
  await render()
  expect(status().textContent).toBe("")
})

it("a failed save goes back to the saved choice and alerts", async () => {
  discussionApi.setPostDiscussion.mockRejectedValue(new Error("down"))
  await render()
  await act(async () => radio("Open").click())
  await settle()
  expect(radio("Default").checked).toBe(true)
  expect(container.querySelector("[role='alert']")?.textContent).toBe("Couldn’t save the change. Try again.")
})

it("with comments off for the site, the choice is still kept", async () => {
  settingsApi.getSettings.mockResolvedValue({ comments_enabled: false, comments_close_after_days: 0 })
  await render()
  expect(text()).toContain("Off · comments are off for this site")
  await act(async () => radio("Open").click())
  await settle()
  expect(discussionApi.setPostDiscussion).toHaveBeenCalledWith(7, "open")
  expect(status().textContent).toContain("It applies once comments are on for the site")
})

it("on a type without comments, Default reads Off", async () => {
  typesApi.getPostTypeByName.mockResolvedValue({ post_type: { name: "page", label: "Pages", public: true, is_active: true, supports: ["title"] } })
  await render()
  expect(text()).toContain("Default · Off")
  expect(text()).toContain("Pages don’t take comments.")
})

it("passes axe after a change and after a failed one (#479, #480)", async () => {
  const run = async () => {
    const result = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
      // A panel section on its own: no <h1>, no <main>.
      rules: {
        "color-contrast": { enabled: false },
        region: { enabled: false },
        "page-has-heading-one": { enabled: false },
        "landmark-one-main": { enabled: false },
      },
    })
    return result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.html) }))
  }
  await render()
  await act(async () => radio("Closed").click())
  await settle()
  expect(await run()).toEqual([])
  discussionApi.setPostDiscussion.mockRejectedValue(new Error("down"))
  await act(async () => radio("Open").click())
  await settle()
  expect(container.querySelector("[role='alert']")).not.toBeNull()
  expect(await run()).toEqual([])
})

describe("a failed read", () => {
  it("offers Try again", async () => {
    discussionApi.getPostDiscussion.mockRejectedValueOnce(new Error("down"))
    await render()
    expect(text()).toContain("Couldn’t load the discussion settings.")
    await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Try again")!.click())
    await settle()
    expect(radio("Default").checked).toBe(true)
  })
})
