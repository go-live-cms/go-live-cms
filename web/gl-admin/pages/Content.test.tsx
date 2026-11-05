import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The Posts and Pages lists (#340): loading and empty states, tab counts, the
// contributor's access column, and the Pages tree.

const api = vi.hoisted(() => ({
  user: { id: 7, username: "elena", full_name: "Elena V.", role: "editor" } as Record<string, unknown>,
  getPosts: vi.fn(),
  getPostCounts: vi.fn(),
  searchPosts: vi.fn(),
  duplicatePost: vi.fn(),
  bulkPosts: vi.fn(),
  getCreditedAuthors: vi.fn(),
  trashPost: vi.fn(),
  restorePost: vi.fn(),
  deletePostPermanently: vi.fn(),
  getAllTaxonomyTerms: vi.fn(),
  listPostTemplates: vi.fn(),
  createPostTemplate: vi.fn(),
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
  searchPosts: api.searchPosts,
  duplicatePost: api.duplicatePost,
  updatePost: vi.fn(),
  bulkPosts: api.bulkPosts,
  getCreditedAuthors: api.getCreditedAuthors,
  trashPost: api.trashPost,
  restorePost: api.restorePost,
  deletePostPermanently: api.deletePostPermanently,
}))
vi.mock("@gl-admin/lib/api/postTemplates", () => ({
  listPostTemplates: api.listPostTemplates,
  createPostTemplate: api.createPostTemplate,
  createPostFromTemplate: vi.fn(),
  renamePostTemplate: vi.fn(),
  deletePostTemplate: vi.fn(),
}))
vi.mock("@gl-admin/lib/api/taxonomies", () => ({
  getAllTaxonomyTerms: api.getAllTaxonomyTerms,
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
import { toast } from "@gl-admin/components/ui/Toast"
import { DUPLICATED_MESSAGE } from "@gl-admin/lib/contentList"
import { ApiError } from "@gl-admin/lib/api/errors"
import { savedTemplateMessage } from "@gl-admin/lib/postTemplates"

function EditorStub() {
  const { id } = useParams()
  return <p data-testid="editor">Editing post {id}</p>
}

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
          <Route path="/content/edit/:id" element={<EditorStub />} />
          <Route path="/content/:typeName/new" element={<p data-testid="blank">Blank editor</p>} />
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
  api.searchPosts.mockReset()
  api.duplicatePost.mockReset()
  api.bulkPosts.mockReset()
  api.trashPost.mockReset()
  api.restorePost.mockReset()
  api.deletePostPermanently.mockReset()
  api.getCreditedAuthors.mockReset()
  api.getCreditedAuthors.mockResolvedValue([])
  api.getAllTaxonomyTerms.mockReset()
  api.getAllTaxonomyTerms.mockResolvedValue([])
  api.listPostTemplates.mockReset()
  api.listPostTemplates.mockResolvedValue([])
  api.createPostTemplate.mockReset()
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

    expect(tabs()).toEqual(["All", "Published", "Changes not published", "Drafts", "Scheduled", "Archived", "Trash"])
    expect(container.querySelectorAll("[role='tab'] .gl-skeleton")).toHaveLength(7)
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
    api.getPostCounts.mockResolvedValue({ counts: { draft: 12, published: 31, archived: 4 }, total: 47, unpublished_changes: 2 })
    await render("/content/post")

    expect(tabs()).toEqual(["All43", "Published31", "Changes not published2", "Drafts12", "Scheduled0", "Archived4", "Trash0"])
    expect(api.getPosts).toHaveBeenCalledWith(expect.objectContaining({ type: "post", status: "draft,published,scheduled", sort: "changed_at", order: "desc" }))
    expect(text()).toContain("Post 1")
    expect(text()).toContain("/post/post-1")
  })

  // #326: published posts whose working copy differs from the live one.
  it("lists published posts with changes not published in their tab, with the pill", async () => {
    api.getPosts.mockImplementation(() =>
      list([post(1, { post_status: "published", has_unpublished_changes: true }), post(2, { post_status: "published" })])
    )
    api.getPostCounts.mockResolvedValue({ counts: { published: 2 }, total: 2, unpublished_changes: 1 })
    await render("/content/post?view=changes")

    expect(api.getPosts).toHaveBeenCalledWith(expect.objectContaining({ status: "published", unpublished_changes: "true" }))
    const pills = Array.from(container.querySelectorAll("tbody .gl-pill")).map((p) => p.textContent)
    expect(pills).toEqual(["Changes not published", "Published"])
    expect(container.querySelector("tbody .gl-pill--accent")?.textContent).toBe("Changes not published")
  })

  it("leaves the filter off the other tabs", async () => {
    api.getPosts.mockImplementation(() => list([]))
    api.getPostCounts.mockResolvedValue({ counts: { published: 2 }, total: 2, unpublished_changes: 1 })
    await render("/content/post?view=published")

    expect(api.getPosts.mock.calls[0][0]).not.toHaveProperty("unpublished_changes")
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

    expect(tabs()).toEqual(["All43", "My posts3", "Published31", "Trash0"])
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

describe("Duplicate in the row menu (#354)", () => {
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  const menuItems = () => Array.from(container.querySelectorAll("[role='menuitem']")).map((m) => m.textContent)
  const openMenu = async (title: string) => {
    const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label='Actions for ${title}']`)
    expect(trigger).not.toBeNull()
    await act(async () => trigger!.click())
  }
  const choose = async (label: string) => {
    const item = Array.from(container.querySelectorAll<HTMLElement>("[role='menuitem']")).find((m) => m.textContent?.startsWith(label))
    expect(item).toBeDefined()
    await act(async () => item!.click())
    await settle()
  }

  afterEach(() => vi.restoreAllMocks())

  it("duplicates the post and opens the copy in the editor with a toast", async () => {
    const success = vi.spyOn(toast, "success")
    api.getPosts.mockImplementation(() => list([post(1, { post_status: "published" })]))
    api.getPostCounts.mockResolvedValue({ counts: { published: 1 }, total: 1 })
    api.duplicatePost.mockResolvedValue({ post: post(500, { title: "Post 1 (copy)" }) })
    await render("/content/post")

    await openMenu("Post 1")
    expect(menuItems()[0]).toBe("Edit")
    expect(menuItems()[1]).toContain("Duplicate")
    await choose("Duplicate")

    expect(api.duplicatePost).toHaveBeenCalledWith(1)
    expect(success).toHaveBeenCalledWith(DUPLICATED_MESSAGE)
    expect(DUPLICATED_MESSAGE).toBe("Duplicated. You’re editing the copy.")
    expect(container.querySelector("[data-testid='editor']")?.textContent).toBe("Editing post 500")
  })

  it("gives a contributor Duplicate on someone else's post, and nothing else to change", async () => {
    api.user.role = "contributor"
    api.getPosts.mockImplementation(() =>
      list([post(2, { user_id: 3, username: "kenji", authors: [{ id: 3, username: "kenji", full_name: "Kenji T." }] })])
    )
    api.getPostCounts.mockResolvedValue({ counts: { draft: 1 }, total: 1 })
    api.duplicatePost.mockResolvedValue({ post: post(501, { title: "Post 2 (copy)" }) })
    await render("/content/post")

    await openMenu("Post 2")
    expect(menuItems().map((m) => m?.replace(/A new draft.*/, ""))).toEqual(["Open", "Duplicate"])
    await choose("Duplicate")
    expect(api.duplicatePost).toHaveBeenCalledWith(2)
    expect(container.querySelector("[data-testid='editor']")?.textContent).toBe("Editing post 501")
  })

  it("stays on the list and says why when it fails", async () => {
    const error = vi.spyOn(toast, "error")
    api.getPosts.mockImplementation(() => list([post(1)]))
    api.getPostCounts.mockResolvedValue({ counts: { draft: 1 }, total: 1 })
    api.duplicatePost.mockRejectedValue(new Error("forbidden"))
    await render("/content/post")

    await openMenu("Post 1")
    await choose("Duplicate")

    expect(error).toHaveBeenCalledTimes(1)
    expect(container.querySelector("[data-testid='editor']")).toBeNull()
    expect(text()).toContain("Post 1")
  })
})

describe("Post templates in the list (#322)", () => {
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  const openMenu = async (title: string) => {
    const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label='Actions for ${title}']`)
    expect(trigger).not.toBeNull()
    await act(async () => trigger!.click())
  }
  const menuItems = () => Array.from(container.querySelectorAll("[role='menuitem']")).map((m) => m.textContent)
  const choose = async (label: string) => {
    const item = Array.from(container.querySelectorAll<HTMLElement>("[role='menuitem']")).find((m) => m.textContent?.startsWith(label))
    expect(item).toBeDefined()
    await act(async () => item!.click())
    await settle()
  }
  const dialog = () => container.querySelector<HTMLElement>("[role='dialog']")
  const buttonByText = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === label)
  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  const template = { id: 4, post_type: "post", name: "Weekly update", terms: [], featured_image_id: null, created_by_id: 7, created_by_name: "", created_at: "", changed_at: "" }

  afterEach(() => vi.restoreAllMocks())

  it("saves a post as a template from its row menu, with its settings when asked", async () => {
    const success = vi.spyOn(toast, "success")
    api.getPosts.mockImplementation(() => list([post(1, { title: "Release notes", post_status: "published" })]))
    api.getPostCounts.mockResolvedValue({ counts: { published: 1 }, total: 1 })
    api.createPostTemplate.mockResolvedValue({ ...template, id: 9, name: "Release notes" })
    await render("/content/post")

    await openMenu("Release notes")
    expect(menuItems()[2]).toContain("Save as template…")
    await choose("Save as template…")
    expect(dialog()?.textContent).toContain("Save as template")
    const name = container.querySelector<HTMLInputElement>("#gl-save-template-name")!
    expect(name.value).toBe("Release notes")
    const settings = dialog()!.querySelector<HTMLInputElement>("input[type='checkbox']")!
    expect(settings.checked).toBe(false)
    await act(async () => settings.click())
    await act(async () => buttonByText("Save template")!.click())
    await settle()

    expect(api.createPostTemplate).toHaveBeenCalledWith({ post_id: 1, name: "Release notes", with_settings: true })
    expect(success).toHaveBeenCalledWith(savedTemplateMessage("Release notes"))
    expect(dialog()).toBeNull()
  })

  it("keeps the dialog open on a name the type already has", async () => {
    api.getPosts.mockImplementation(() => list([post(1, { title: "Release notes" })]))
    api.getPostCounts.mockResolvedValue({ counts: { draft: 1 }, total: 1 })
    api.createPostTemplate.mockRejectedValue(new ApiError("taken", 409, null, "template_name_taken"))
    await render("/content/post")

    await openMenu("Release notes")
    await choose("Save as template…")
    const name = container.querySelector<HTMLInputElement>("#gl-save-template-name")!
    await type(name, "x")
    await act(async () => buttonByText("Save template")!.click())
    await settle()
    expect(api.createPostTemplate).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain("Use at least 3 characters.")

    await type(name, "Weekly update")
    await act(async () => buttonByText("Save template")!.click())
    await settle()
    expect(api.createPostTemplate).toHaveBeenCalledWith({ post_id: 1, name: "Weekly update", with_settings: false })
    expect(dialog()?.textContent).toContain("There's already a post template named “Weekly update”.")
  })

  it("isn't offered to contributors (the API's editors-only rule)", async () => {
    api.user.role = "contributor"
    api.getPosts.mockImplementation(() => list([post(1)]))
    api.getPostCounts.mockResolvedValue({ counts: { draft: 1 }, total: 1 })
    await render("/content/post")
    await openMenu("Post 1")
    expect(menuItems().some((m) => m?.startsWith("Save as template"))).toBe(false)
  })

  it("New opens the chooser when the type has templates, else a blank post as before", async () => {
    api.getPosts.mockImplementation(() => list([post(1)]))
    api.getPostCounts.mockResolvedValue({ counts: { draft: 1 }, total: 1 })
    api.listPostTemplates.mockResolvedValue([template])
    await render("/content/post")
    expect(api.listPostTemplates).toHaveBeenCalledWith("post")
    await act(async () => buttonByText("New post")!.click())
    await settle()
    expect(dialog()?.textContent).toContain("Weekly update")
    expect(container.querySelector("[data-testid='blank']")).toBeNull()

    await act(async () => root.unmount())
    root = createRoot(container)
    api.listPostTemplates.mockResolvedValue([])
    await render("/content/post")
    await act(async () => buttonByText("New post")!.click())
    await settle()
    expect(dialog()).toBeNull()
    expect(container.querySelector("[data-testid='blank']")).not.toBeNull()
  })
})

describe("Posts list search (#145)", () => {
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

  it("searches the index with the tab's filters after a pause, best match first", async () => {
    api.getPosts.mockImplementation(() => list([post(1)]))
    api.getPostCounts.mockResolvedValue({ counts: { draft: 2, published: 3 }, total: 5 })
    api.searchPosts.mockImplementation(() => list([post(9, { title: "Alt text guide" })]))
    await render("/content/post?view=draft")

    vi.useFakeTimers()
    try {
      const input = container.querySelector<HTMLInputElement>(".gl-content-list__search input")!
      expect(input.placeholder).toBe("Search posts")
      await act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        setValue.call(input, "alt text")
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
      expect(api.searchPosts).not.toHaveBeenCalled()
      await act(async () => {
        vi.advanceTimersByTime(400)
      })
    } finally {
      vi.useRealTimers()
    }
    await settle()

    expect(api.searchPosts).toHaveBeenCalledWith(expect.objectContaining({ q: "alt text", type: "post", status: "draft", offset: 0 }))
    expect(api.searchPosts.mock.calls[0][0]).not.toHaveProperty("sort")
    expect(text()).toContain("Alt text guide")
    expect(text()).toContain("Best match first")
    expect(container.querySelector(".gl-content-list__search input")).not.toBeNull()
  })

  it("loads a search from the URL and says when nothing matches", async () => {
    api.getPostCounts.mockResolvedValue({ counts: { draft: 2 }, total: 2 })
    api.searchPosts.mockImplementation(() => list([]))
    await render("/content/post?q=quantum")

    expect(api.getPosts).not.toHaveBeenCalled()
    expect(api.searchPosts).toHaveBeenCalledWith(expect.objectContaining({ q: "quantum", status: "draft,published,scheduled" }))
    expect(container.querySelector<HTMLInputElement>(".gl-content-list__search input")!.value).toBe("quantum")
    expect(text()).toContain("No posts match “quantum”")
    expect(text()).toContain("Clear search")
  })

  it("searches within Changes not published", async () => {
    api.getPostCounts.mockResolvedValue({ counts: { published: 2 }, total: 2, unpublished_changes: 1 })
    api.searchPosts.mockImplementation(() => list([]))
    await render("/content/post?view=changes&q=launch")

    expect(api.searchPosts).toHaveBeenCalledWith(expect.objectContaining({ q: "launch", status: "published", unpublished_changes: "true" }))
  })

  it("passes the contributor's own-posts filter on", async () => {
    api.user.role = "contributor"
    api.getPostCounts.mockResolvedValue({ counts: { draft: 2 }, total: 2 })
    api.searchPosts.mockImplementation(() => list([post(1)]))
    await render("/content/post?view=mine&q=notes")

    expect(api.searchPosts).toHaveBeenCalledWith(expect.objectContaining({ q: "notes", user_id: "7" }))
  })
})

describe("Posts list paging", () => {
  it("moves back to the last page when the current one empties", async () => {
    api.getPostCounts.mockResolvedValue({ counts: { draft: 20 }, total: 20 })
    const page = Array.from({ length: 10 }, (_, i) => post(i + 1))
    api.getPosts.mockImplementation(({ offset }: { offset: number }) =>
      offset === 0 ? Promise.resolve({ data: page, meta: { total: 20 } }) : Promise.resolve({ data: [], meta: { total: 10 } })
    )
    await render("/content/post")

    const second = Array.from(container.querySelectorAll(".gl-pagination__navigation button")).find((b) => b.textContent === "2")
    await act(async () => {
      second!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    const offsets = api.getPosts.mock.calls.map(([q]) => q.offset)
    expect(offsets).toEqual([0, 10, 0])
    expect(text()).toContain("Post 1")
    expect(text()).not.toContain("Nothing in All")
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

    expect(tabs()).toEqual(["All3", "Published2", "Changes not published0", "Drafts1", "Scheduled0", "Archived0", "Trash0"])
    const titles = Array.from(container.querySelectorAll("tbody .gl-content-list__link")).map((a) => a.textContent)
    expect(titles).toEqual(["Home", "About", "Team"])
    expect(text()).toContain(", level 2")
  })

  it("filters the tree to pages with changes not published (#326)", async () => {
    api.getPosts.mockImplementation(() =>
      list([
        post(1, { title: "About", post_type: "page", post_status: "published", has_unpublished_changes: true }),
        post(2, { title: "Team", post_type: "page", post_status: "published", post_parent: 1 }),
        post(3, { title: "Home", post_type: "page", post_status: "draft" }),
      ])
    )
    await render("/content/page?view=changes")

    expect(tabs()).toContain("Changes not published1")
    const titles = Array.from(container.querySelectorAll("tbody .gl-content-list__link")).map((a) => a.textContent)
    expect(titles).toEqual(["About"])
    expect(container.querySelector("tbody .gl-pill")?.textContent).toBe("Changes not published")
  })

  it("shows the empty state when there are no pages", async () => {
    api.getPosts.mockImplementation(() => list([]))
    await render("/content/page")
    expect(text()).toContain("No pages yet")
  })
})

// #327: the Author / Category / Tag filters, bulk selection with its report, and the Trash tab.
describe("Posts list filters, bulk actions and trash (#327)", () => {
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  const click = async (el: Element | null | undefined) => {
    expect(el).toBeTruthy()
    await act(async () => (el as HTMLElement).click())
    await settle()
  }
  const button = (label: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === label || b.getAttribute("aria-label") === label
    )
  const menuItem = (label: string) =>
    Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']")).find((m) => m.textContent?.startsWith(label))
  const check = async (title: string) => {
    const box = container.querySelector<HTMLInputElement>(`input[aria-label='Select ${title}']`)
    expect(box).not.toBeNull()
    await act(async () => box!.click())
  }
  const bar = () => container.querySelector("[aria-label='Bulk actions']")
  const barLabels = () => Array.from(bar()!.querySelectorAll("button")).map((b) => b.textContent || b.getAttribute("aria-label"))

  beforeEach(() => {
    api.getCreditedAuthors.mockResolvedValue([
      { id: 12, username: "ana", full_name: "Ana Costa" },
      { id: 13, username: "marco", full_name: "" },
    ])
    api.getAllTaxonomyTerms.mockImplementation((type: string) =>
      Promise.resolve(type === "category" ? [{ id: 3, name: "Guides", slug: "guides" }] : [{ id: 40, name: "Release", slug: "release" }])
    )
    api.getPostCounts.mockResolvedValue({ counts: { draft: 2, published: 1, trash: 1 }, total: 4 })
  })

  afterEach(() => vi.restoreAllMocks())

  it("passes the filters from the URL on, with the tab and sort, and names them on their buttons", async () => {
    api.getPosts.mockImplementation(() => list([post(1)]))
    await render("/content/post?view=draft&author=12&category=3&tag=40&sort=title")

    expect(api.getPosts).toHaveBeenCalledWith(
      expect.objectContaining({ status: "draft", author_id: "12", terms: "3,40", sort: "title", order: "asc" })
    )
    expect(button("Author: Ana Costa")).toBeDefined()
    expect(button("Category: Guides")).toBeDefined()
    expect(button("Tag: Release")).toBeDefined()
    expect(api.getCreditedAuthors).toHaveBeenCalledWith({ type: "post" })
  })

  it("filters from the menus and clears them", async () => {
    api.getPosts.mockImplementation(() => list([post(1)]))
    await render("/content/post")

    await click(button("Filter by author"))
    expect(menuItem("Any author")).toBeDefined()
    await click(menuItem("marco"))
    expect(api.getPosts).toHaveBeenLastCalledWith(expect.objectContaining({ author_id: "13" }))
    await click(button("Filter by tag"))
    await click(menuItem("Release"))
    expect(api.getPosts).toHaveBeenLastCalledWith(expect.objectContaining({ author_id: "13", terms: "40" }))

    await click(button("Clear filters"))
    expect(api.getPosts.mock.calls.at(-1)![0]).not.toHaveProperty("author_id")
    expect(api.getPosts.mock.calls.at(-1)![0]).not.toHaveProperty("terms")
  })

  it("says nothing matches the filters, and searches with them", async () => {
    api.getPosts.mockImplementation(() => list([]))
    await render("/content/post?category=3")
    expect(text()).toContain("No posts match these filters")
    expect(button("Clear filters")).toBeDefined()
  })

  it("searches with the filters", async () => {
    api.searchPosts.mockImplementation(() => list([]))
    await render("/content/post?category=3&q=launch")
    expect(api.searchPosts).toHaveBeenCalledWith(expect.objectContaining({ q: "launch", terms: "3" }))
  })

  it("selects rows, runs a bulk action, and reports each post that failed (partial failure)", async () => {
    api.getPosts.mockImplementation(() => list([post(1, { title: "Spring launch" }), post(2, { title: "Pricing" }), post(3)]))
    api.bulkPosts.mockResolvedValue({
      action: "publish",
      results: [
        { id: 1, ok: true, post_status: "published" },
        { id: 2, ok: false, status: 503, code: "collab_unavailable", error: "flush failed" },
      ],
      succeeded: 1,
      failed: 1,
    })
    await render("/content/post")

    expect(bar()).toBeNull()
    await check("Spring launch")
    await check("Pricing")
    expect(bar()!.textContent).toContain("2 selected")
    expect(barLabels()).toEqual(["Publish", "Move to trash", "Clear selection"])
    const countsBefore = api.getPostCounts.mock.calls.length

    await click(button("Publish"))
    expect(api.bulkPosts).toHaveBeenCalledWith("publish", [1, 2])
    const report = container.querySelector(".gl-bulk-report")!
    expect(report.textContent).toContain("1 post published. 1 post wasn’t published")
    expect(report.textContent).toContain("Pricing: The latest edits couldn’t be saved; try again")
    // The failed post stays selected; the counts reload.
    expect(bar()!.textContent).toContain("1 selected")
    expect(container.querySelector<HTMLInputElement>("input[aria-label='Select Pricing']")!.checked).toBe(true)
    expect(api.getPostCounts.mock.calls.length).toBeGreaterThan(countsBefore)

    await click(button("Clear selection"))
    expect(bar()).toBeNull()
  })

  it("starts a new page with nothing selected, so a bulk action never reaches rows out of sight", async () => {
    api.getPostCounts.mockResolvedValue({ counts: { draft: 20 }, total: 20 })
    api.getPosts.mockImplementation(({ offset }: { offset: number }) =>
      Promise.resolve({ data: Array.from({ length: 10 }, (_, i) => post(offset + i + 1)), meta: { total: 20 } })
    )
    await render("/content/post")
    await check("Post 1")
    expect(bar()!.textContent).toContain("1 selected")

    const second = Array.from(container.querySelectorAll(".gl-pagination__navigation button")).find((b) => b.textContent === "2")
    await click(second)
    expect(text()).toContain("Post 11")
    expect(bar()).toBeNull()
  })

  it("gives a contributor only Move to trash in bulk", async () => {
    api.user.role = "contributor"
    api.getPosts.mockImplementation(() => list([post(1)]))
    await render("/content/post?view=mine")
    await check("Post 1")
    expect(barLabels()).toEqual(["Move to trash", "Clear selection"])
  })

  it("moves one post to the trash from its menu", async () => {
    api.getPosts.mockImplementation(() => list([post(1)]))
    api.trashPost.mockResolvedValue({ post: post(1, { post_status: "trash" }) })
    await render("/content/post")

    await click(container.querySelector("button[aria-label='Actions for Post 1']"))
    await click(menuItem("Move to trash"))
    expect(api.trashPost).toHaveBeenCalledWith(1)
  })

  it("shows the Trash tab: its posts aren't links, and they restore or delete permanently", async () => {
    api.getPosts.mockImplementation(() =>
      list([post(5, { title: "Old news", post_status: "trash", trashed_from_status: "published", deleted_at: "2026-10-30T10:00:00Z" })])
    )
    api.restorePost.mockResolvedValue({ post: post(5, { post_status: "published" }) })
    await render("/content/post?view=trash")

    expect(tabs()).toContain("Trash1")
    expect(api.getPosts).toHaveBeenCalledWith(expect.objectContaining({ status: "trash" }))
    expect(text()).toContain("Posts in the trash are off the site")
    expect(text()).toContain("Trashed")
    expect(container.querySelector("tbody a.gl-content-list__link")).toBeNull()
    expect(container.querySelector("tbody .gl-content-list__link--trashed")?.textContent).toBe("Old news")

    await click(container.querySelector("button[aria-label='Actions for Old news']"))
    const items = Array.from(document.querySelectorAll("[role='menuitem']")).map((m) => m.textContent?.replace(/Back with.*/, ""))
    expect(items).toEqual(["Restore", "Delete permanently"])
    await click(menuItem("Restore"))
    expect(api.restorePost).toHaveBeenCalledWith(5)

    // Bulk: Restore and Delete permanently, which asks first.
    api.bulkPosts.mockResolvedValue({ action: "delete", results: [{ id: 5, ok: true }], succeeded: 1, failed: 0 })
    await check("Old news")
    expect(barLabels()).toEqual(["Restore", "Delete permanently", "Clear selection"])
    await click(Array.from(bar()!.querySelectorAll("button")).find((b) => b.textContent === "Delete permanently"))
    expect(api.bulkPosts).not.toHaveBeenCalled()
    const dialog = document.querySelector("[role='alertdialog']")!
    expect(dialog.textContent).toContain("Delete 1 post permanently?")
    await click(Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Delete permanently"))
    expect(api.bulkPosts).toHaveBeenCalledWith("delete", [5])
    expect(container.querySelector(".gl-bulk-report")!.textContent).toContain("1 post deleted")
  })

  it("says the trash is empty", async () => {
    api.getPosts.mockImplementation(() => list([]))
    await render("/content/post?view=trash")
    expect(text()).toContain("The trash is empty")
  })
})
