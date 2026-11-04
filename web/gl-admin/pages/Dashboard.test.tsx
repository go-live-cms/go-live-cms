import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Home (#9, #340, #324): what each section shows, its empty and error states, and that
// one failed section or count doesn't take the rest of the page down.

const api = vi.hoisted(() => ({
  user: { id: 7, username: "elena", full_name: "Elena Vargas", role: "editor" } as Record<string, unknown>,
  getPosts: vi.fn(),
  getPostCounts: vi.fn(),
  getMedia: vi.fn(),
  getContinueEditing: vi.fn(),
  getNeedsAttention: vi.fn(),
  getActivity: vi.fn(),
}))

vi.mock("@gl-admin/lib/auth", () => ({
  authManager: { getState: () => ({ user: api.user }), subscribe: () => () => {} },
}))
vi.mock("@gl-admin/lib/api/posts", () => ({ getPosts: api.getPosts, getPostCounts: api.getPostCounts }))
vi.mock("@gl-admin/lib/api/media", () => ({ getMedia: api.getMedia }))
vi.mock("@gl-admin/lib/api/activity", () => ({
  getContinueEditing: api.getContinueEditing,
  getNeedsAttention: api.getNeedsAttention,
  getActivity: api.getActivity,
}))
vi.mock("@gl-admin/lib/api/settings", () => ({
  getSettings: () => Promise.resolve({ post_url_structure: "id", site_title: "GoLive Blog" }),
}))

import Dashboard, { greeting } from "./Dashboard"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const post = (id: number, status = "draft") => ({
  id,
  title: `Post ${id}`,
  user_id: 7,
  username: "elena",
  post_type: "post",
  post_status: status,
  created_at: "2026-10-20T10:00:00Z",
  changed_at: "2026-10-22T10:00:00Z",
  authors: [],
})

const recent = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Recent ${id}`,
  post_type: "post",
  post_status: "published",
  edited_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
  ...extra,
})

const ana = { id: 2, username: "ana", full_name: "Ana Costa" }
const event = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  verb: "published",
  object_type: "post",
  object_id: 10 + id,
  created_at: new Date(Date.now() - 3600_000).toISOString(),
  actor: ana,
  post: { id: 10 + id, title: `Event post ${id}`, post_type: "post", post_status: "published" },
  payload: {},
  ...extra,
})

const nothingNeeded = {
  failed_schedules: { total: 0, posts: [] },
  unpublished_changes: { total: 0, posts: [] },
  missing_alt: { media_count: 0, published_post_count: 0 },
  review_requests: [],
}

async function render() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    )
  })
  await flush()
}

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

const counts = () =>
  Array.from(container.querySelectorAll(".gl-home__count")).map((c) => `${c.querySelector("dt")?.textContent}=${c.querySelector("dd")?.textContent}`)

const section = (id: string) => container.querySelector(`section[aria-labelledby="${id}"]`) as HTMLElement

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.user.role = "editor"
  api.getPosts.mockResolvedValue({ data: [post(2)], meta: { total: 1 } })
  api.getPostCounts.mockImplementation(({ type }: { type: string }) =>
    Promise.resolve(
      type === "page" ? { counts: { published: 3, draft: 1, archived: 2 }, total: 6 } : { counts: { published: 31, draft: 12 }, total: 43, unpublished_changes: 2 }
    )
  )
  api.getMedia.mockResolvedValue({ data: [], meta: { total: 9 } })
  api.getContinueEditing.mockResolvedValue([recent(1, { has_unpublished_changes: true })])
  api.getNeedsAttention.mockResolvedValue(nothingNeeded)
  api.getActivity.mockResolvedValue({ activity: [], next_before: null })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("Home", () => {
  it("greets by the time of day", () => {
    expect(greeting(new Date(2026, 9, 27, 9))).toBe("Good morning")
    expect(greeting(new Date(2026, 9, 27, 14))).toBe("Good afternoon")
    expect(greeting(new Date(2026, 9, 27, 20))).toBe("Good evening")
  })

  it("shows the posts you worked on, drafts and counts", async () => {
    await render()
    expect(container.querySelector("h1")?.textContent).toMatch(/, Elena$/)
    expect(container.textContent).toContain("GoLive Blog")
    expect(api.getContinueEditing).toHaveBeenCalledWith({ limit: 3 })
    const card = container.querySelector<HTMLAnchorElement>(".gl-home__recent .gl-home__card")
    expect(card?.textContent).toContain("Recent 1")
    expect(card?.textContent).toContain("Edited 2 hours ago")
    expect(card?.getAttribute("href")).toBe("/content/edit/1")
    expect(container.querySelector(".gl-home__list")?.textContent).toContain("Post 2")
    expect(counts()).toEqual(["Published posts=31", "Changes not published=2", "Drafts=12", "Pages=4", "Media files=9"])
    // #326: the recent card says so, and the count opens the list's tab.
    expect(container.querySelector(".gl-home__card .gl-pill")?.textContent).toBe("Changes not published")
    const changes = Array.from(container.querySelectorAll<HTMLAnchorElement>(".gl-home__count a")).find((a) => a.textContent === "Changes not published")
    expect(changes?.getAttribute("href")).toBe("/content/post?view=changes")
  })

  it("flags a recent post whose scheduled publish failed", async () => {
    api.getContinueEditing.mockResolvedValue([recent(4, { post_status: "scheduled", publish_at: "2026-12-01T09:00:00Z", schedule_failed: true })])
    await render()
    expect(container.querySelector(".gl-home__card")?.textContent).toContain("Scheduled publish failed")
  })

  it("shows a recent post's scheduled update (#335)", async () => {
    api.getContinueEditing.mockResolvedValue([recent(5, { has_unpublished_changes: true, update_at: "2026-12-01T09:00:00Z" })])
    await render()
    expect(container.querySelector(".gl-home__card .gl-pill")?.textContent).toMatch(/^Update scheduled/)
  })

  it("says so when there is nothing to continue", async () => {
    api.getContinueEditing.mockResolvedValue([])
    await render()
    expect(container.querySelector(".gl-home__recent")).toBeNull()
    expect(container.textContent).toContain("Nothing to continue yet")
  })

  it("keeps the page when one count fails", async () => {
    api.getMedia.mockRejectedValue(new Error("boom"))
    await render()
    expect(container.querySelector("[role='alert']")).toBeNull()
    expect(container.textContent).toContain("Recent 1")
    expect(counts()).toEqual(["Published posts=31", "Changes not published=2", "Drafts=12", "Pages=4", "Media files=–Unavailable"])
  })

  it("scopes everything to a contributor's own posts", async () => {
    api.user.role = "contributor"
    await render()
    expect(api.getPostCounts).toHaveBeenCalledWith({ type: "post", user_id: 7 })
    expect(api.getPosts).toHaveBeenCalledWith(expect.objectContaining({ user_id: 7, status: "draft" }))
    expect(counts()[0]).toBe("Your published posts=31")
    // The Changes not published count is the editors' (their tab).
    expect(counts().some((c) => c.includes("not published"))).toBe(false)
  })
})

describe("Home: Needs attention", () => {
  it("lists what needs attention, each linking to where to fix it", async () => {
    api.getNeedsAttention.mockResolvedValue({
      failed_schedules: { total: 1, posts: [{ id: 3, title: "Launch day", post_type: "post", reason: "publish_failed", attempts: 2 }] },
      missing_alt: { media_count: 3, published_post_count: 2 },
      unpublished_changes: {
        total: 1,
        posts: [{ id: 8, title: "October changelog", post_type: "post", changed_at: "2026-10-22T10:00:00Z", last_editor: ana }],
      },
      review_requests: [],
    })
    await render()
    const rows = Array.from(section("home-attention").querySelectorAll<HTMLAnchorElement>("a.gl-home__row"))
    expect(rows.map((a) => [a.querySelector(".gl-home__row-title")?.textContent, a.getAttribute("href")])).toEqual([
      ["Scheduled publish failed", "/content/edit/3"],
      ["3 images have no alt text", "/media?alt=missing"],
      ["October changelog has unpublished changes", "/content/edit/8"],
    ])
    expect(rows[1].textContent).toContain("Used in 2 published posts")
    expect(rows[2].textContent).toContain("by Ana Costa")
  })

  it("is all caught up when there is nothing", async () => {
    await render()
    expect(section("home-attention").textContent).toContain("All caught up")
    expect(section("home-attention").querySelector("a")).toBeNull()
  })

  it("fails on its own", async () => {
    api.getNeedsAttention.mockRejectedValue(new Error("boom"))
    await render()
    expect(section("home-attention").querySelector("[role='alert']")?.textContent).toContain("Couldn't load what needs attention")
    expect(container.textContent).toContain("Recent 1")
    expect(section("home-activity").querySelector("[role='alert']")).toBeNull()
  })
})

describe("Home: Activity", () => {
  it("lists recent events, and Show more loads the next page", async () => {
    api.getActivity.mockImplementation(({ before }: { before?: number }) =>
      Promise.resolve(
        before
          ? { activity: [event(3, { verb: "scheduled", actor: { id: 7, username: "elena", full_name: "Elena Vargas" } })], next_before: null }
          : {
              activity: [event(1), event(2, { object_type: "media", verb: "uploaded", post: undefined, media: { id: 5, name: "hero.jpg" } })],
              next_before: 2,
            }
      )
    )
    await render()
    expect(api.getActivity).toHaveBeenCalledWith({ limit: 8 })
    const lines = () =>
      Array.from(section("home-activity").querySelectorAll(".gl-home__event")).map((li) => li.querySelector(".gl-home__event-text > span")?.textContent)
    expect(lines()).toEqual(["Ana Costa published Event post 1", "Ana Costa uploaded hero.jpg"])
    const links = Array.from(section("home-activity").querySelectorAll<HTMLAnchorElement>(".gl-home__event a")).map((a) => a.getAttribute("href"))
    expect(links).toEqual(["/content/edit/11", "/media/5"])
    expect(section("home-activity").textContent).toContain("1 hour ago")

    const more = Array.from(section("home-activity").querySelectorAll("button")).find((b) => b.textContent?.includes("Show more"))
    expect(more).toBeTruthy()
    await act(async () => {
      more!.click()
    })
    await flush()
    expect(api.getActivity).toHaveBeenLastCalledWith({ limit: 8, before: 2 })
    expect(lines()).toEqual(["Ana Costa published Event post 1", "Ana Costa uploaded hero.jpg", "You scheduled Event post 3"])
    expect(Array.from(section("home-activity").querySelectorAll("button")).some((b) => b.textContent?.includes("Show more"))).toBe(false)
  })

  it("says so when there is no activity yet", async () => {
    await render()
    expect(section("home-activity").textContent).toContain("No activity yet")
    expect(section("home-activity").querySelector("ol")).toBeNull()
  })

  it("fails on its own", async () => {
    api.getActivity.mockRejectedValue(new Error("boom"))
    await render()
    expect(section("home-activity").querySelector("[role='alert']")?.textContent).toContain("Couldn't load the activity")
    expect(section("home-attention").textContent).toContain("All caught up")
  })
})
