import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Home (#9, #340): what each section shows, and that one failed count doesn't take the
// rest of the page down.

const api = vi.hoisted(() => ({
  user: { id: 7, username: "elena", full_name: "Elena Vargas", role: "editor" } as Record<string, unknown>,
  getPosts: vi.fn(),
  getPostCounts: vi.fn(),
  getMedia: vi.fn(),
}))

vi.mock("@gl-admin/lib/auth", () => ({
  authManager: { getState: () => ({ user: api.user }), subscribe: () => () => {} },
}))
vi.mock("@gl-admin/lib/api/posts", () => ({ getPosts: api.getPosts, getPostCounts: api.getPostCounts }))
vi.mock("@gl-admin/lib/api/media", () => ({ getMedia: api.getMedia }))
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

async function render() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const counts = () =>
  Array.from(container.querySelectorAll(".gl-home__count")).map((c) => `${c.querySelector("dt")?.textContent}=${c.querySelector("dd")?.textContent}`)

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.user.role = "editor"
  api.getPosts.mockImplementation(({ status }: { status: string }) =>
    Promise.resolve({ data: status === "draft" ? [post(2)] : [post(1, "published")], meta: { total: 1 } })
  )
  api.getPostCounts.mockImplementation(({ type }: { type: string }) =>
    Promise.resolve(type === "page" ? { counts: { published: 3, draft: 1, archived: 2 }, total: 6 } : { counts: { published: 31, draft: 12 }, total: 43 })
  )
  api.getMedia.mockResolvedValue({ data: [], meta: { total: 9 } })
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

  it("shows recent posts, drafts and counts", async () => {
    await render()
    expect(container.querySelector("h1")?.textContent).toMatch(/, Elena$/)
    expect(container.textContent).toContain("GoLive Blog")
    expect(container.querySelector(".gl-home__recent")?.textContent).toContain("Post 1")
    expect(container.querySelector(".gl-home__list")?.textContent).toContain("Post 2")
    expect(counts()).toEqual(["Published posts=31", "Drafts=12", "Pages=4", "Media files=9"])
  })

  it("keeps the page when one count fails", async () => {
    api.getMedia.mockRejectedValue(new Error("boom"))
    await render()
    expect(container.querySelector("[role='alert']")).toBeNull()
    expect(container.textContent).toContain("Post 1")
    expect(counts()).toEqual(["Published posts=31", "Drafts=12", "Pages=4", "Media files=–Unavailable"])
  })

  it("scopes everything to a contributor's own posts", async () => {
    api.user.role = "contributor"
    await render()
    expect(api.getPostCounts).toHaveBeenCalledWith({ type: "post", user_id: 7 })
    expect(api.getPosts).toHaveBeenCalledWith(expect.objectContaining({ user_id: 7, status: "draft" }))
    expect(counts()[0]).toBe("Your published posts=31")
  })
})
