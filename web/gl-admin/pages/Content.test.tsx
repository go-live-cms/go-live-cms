import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The Posts and Pages lists (#340): loading and empty states, tab counts, the
// contributor's access column, and the Pages tree.

const api = vi.hoisted(() => ({
  user: { id: 7, username: "elena", full_name: "Elena V.", role: "editor" } as Record<string, unknown>,
  getPosts: vi.fn(),
  getPostCounts: vi.fn(),
}))

vi.mock("@gl-admin/lib/auth", () => ({
  authManager: {
    getState: () => ({ user: api.user }),
    subscribe: () => () => {},
    getAccessToken: () => null,
  },
}))
vi.mock("@gl-admin/lib/api/posts", () => ({
  getPosts: api.getPosts,
  getPostCounts: api.getPostCounts,
  updatePost: vi.fn(),
  deletePost: vi.fn(),
}))
vi.mock("@gl-admin/lib/api/postTypes", () => ({
  getPostTypes: () =>
    Promise.resolve({
      data: [
        { name: "post", label: "Posts", hierarchical: false },
        { name: "page", label: "Pages", hierarchical: true },
      ],
    }),
}))
vi.mock("@gl-admin/lib/api/settings", () => ({
  getSettings: () => Promise.resolve({ post_url_structure: "slug", site_title: "GoLive Blog" }),
}))

import Content from "./Content"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const never = () => new Promise<never>(() => {})

const post = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  title: `Post ${id}`,
  slug: `post-${id}`,
  description: "",
  user_id: 7,
  username: "elena",
  url: "",
  post_type: "post",
  post_status: "draft",
  post_parent: null,
  menu_order: 0,
  created_at: "2026-10-20T10:00:00Z",
  changed_at: "2026-10-22T10:00:00Z",
  authors: [{ id: 7, username: "elena", full_name: "Elena V." }],
  ...over,
})

const list = (posts: unknown[]) => Promise.resolve({ data: posts, meta: { total: posts.length } })

async function render(path: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/content/:typeName" element={<Content />} />
        </Routes>
      </MemoryRouter>
    )
  })
  // Let the mocked requests settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const text = () => container.textContent ?? ""
const tabs = () => Array.from(container.querySelectorAll("[role='tab']")).map((t) => t.textContent)

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.user.role = "editor"
  api.getPosts.mockReset()
  api.getPostCounts.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("Posts list", () => {
  it("shows skeleton counts and rows while loading", async () => {
    api.getPosts.mockImplementation(never)
    api.getPostCounts.mockImplementation(never)
    await render("/content/post")

    expect(tabs()).toEqual(["All", "Published", "Drafts", "Archived"])
    expect(container.querySelectorAll("[role='tab'] .gl-skeleton")).toHaveLength(4)
    expect(container.querySelector(".gl-table-scroll")?.getAttribute("aria-busy")).toBe("true")
    expect(container.querySelector("[role='status']")?.textContent).toBe("Loading posts…")
    expect(text()).not.toContain("No posts yet")
  })

  it("shows the empty state, without tabs, when there are no posts at all", async () => {
    api.getPosts.mockImplementation(() => list([]))
    api.getPostCounts.mockResolvedValue({ counts: {}, total: 0 })
    await render("/content/post")

    expect(text()).toContain("No posts yet")
    expect(container.querySelector(".gl-empty-state button")?.textContent).toBe("Write a post")
    expect(tabs()).toEqual([])
  })

  it("shows the tab counts, All leaving archived out", async () => {
    api.getPosts.mockImplementation(() => list([post(1)]))
    api.getPostCounts.mockResolvedValue({ counts: { draft: 12, published: 31, archived: 4 }, total: 47 })
    await render("/content/post")

    expect(tabs()).toEqual(["All43", "Published31", "Drafts12", "Archived4"])
    expect(api.getPosts).toHaveBeenCalledWith(expect.objectContaining({ type: "post", status: "draft,published", sort: "changed_at", order: "desc" }))
    expect(text()).toContain("Post 1")
    expect(text()).toContain("/post/post-1")
  })

  it("says a tab is empty when other tabs aren't", async () => {
    api.getPosts.mockImplementation(() => list([]))
    api.getPostCounts.mockResolvedValue({ counts: { published: 2 }, total: 2 })
    await render("/content/post?view=draft")

    expect(api.getPosts).toHaveBeenCalledWith(expect.objectContaining({ status: "draft" }))
    expect(text()).toContain("Nothing in Drafts")
    expect(text()).not.toContain("No posts yet")
  })

  it("gives contributors their tabs, the note and the access column", async () => {
    api.user.role = "contributor"
    api.getPosts.mockImplementation(() =>
      list([
        post(1, { post_status: "published" }),
        post(2, { user_id: 3, username: "kenji", authors: [{ id: 3, username: "kenji", full_name: "Kenji T." }] }),
      ])
    )
    api.getPostCounts.mockImplementation(({ user_id }: { user_id?: number }) =>
      Promise.resolve(user_id ? { counts: { draft: 2, published: 1 }, total: 3 } : { counts: { draft: 12, published: 31 }, total: 43 })
    )
    await render("/content/post")

    expect(tabs()).toEqual(["All43", "My posts3", "Published31"])
    expect(api.getPostCounts).toHaveBeenCalledWith({ type: "post", user_id: 7 })
    expect(text()).toContain("As a contributor you can edit the posts you own")
    expect(text()).toContain("Your access")
    expect(text()).toContain("Can edit · an editor publishes your changes")
    expect(text()).toContain("View only")
    const buttons = Array.from(container.querySelectorAll("td button")).map((b) => b.textContent)
    expect(buttons).toContain("Edit")
    expect(buttons).toContain("Open")
  })
})

describe("Pages list", () => {
  it("shows pages as a tree", async () => {
    api.getPosts.mockImplementation(() =>
      list([
        post(1, { title: "About", post_type: "page", post_status: "published", menu_order: 1 }),
        post(2, { title: "Team", post_type: "page", post_parent: 1 }),
        post(3, { title: "Home", post_type: "page", post_status: "published", menu_order: 0 }),
      ])
    )
    await render("/content/page")

    expect(tabs()).toEqual(["All3", "Published2", "Drafts1", "Archived0"])
    const titles = Array.from(container.querySelectorAll("tbody .gl-content-list__link")).map((a) => a.textContent)
    expect(titles).toEqual(["Home", "About", "Team"])
    expect(text()).toContain(", level 2")
  })

  it("shows the empty state when there are no pages", async () => {
    api.getPosts.mockImplementation(() => list([]))
    await render("/content/page")
    expect(text()).toContain("No pages yet")
  })
})
