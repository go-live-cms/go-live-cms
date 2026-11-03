import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The media library page (#342): loading and empty states, the filtered empty state,
// the side panel with its "Used in" list, and missing alt text (#325).

const api = vi.hoisted(() => ({
  user: { id: 7, username: "elena", full_name: "Elena V.", role: "editor" } as Record<string, unknown>,
  getMedia: vi.fn(),
  getMediaPosts: vi.fn(),
  getMediaById: vi.fn(),
  createMedia: vi.fn(),
  updateMedia: vi.fn(),
}))

vi.mock("@gl-admin/lib/auth", () => ({
  authManager: {
    getState: () => ({ user: api.user }),
    subscribe: () => () => {},
    getAccessToken: () => null,
  },
}))
vi.mock("@gl-admin/lib/api/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gl-admin/lib/api/media")>()),
  getMedia: api.getMedia,
  getMediaPosts: api.getMediaPosts,
  getMediaById: api.getMediaById,
  createMedia: api.createMedia,
  updateMedia: api.updateMedia,
  deleteMedia: vi.fn(),
}))

import Media from "./Media"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const never = () => new Promise<never>(() => {})

const file = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  name: `photo-${id}.jpg`,
  description: "",
  alt: `Photo ${id}`,
  media_path: `uploads/photo-${id}.jpg`,
  user_id: 7,
  created_at: "2026-10-26T10:00:00Z",
  changed_at: "2026-10-26T10:00:00Z",
  file_size: 2048,
  mime_type: "image/jpeg",
  width: 800,
  height: 600,
  original_filename: `photo-${id}.jpg`,
  variants: {},
  post_count: 0,
  ...over,
})

const page = (items: unknown[], total = items.length) => Promise.resolve({ data: items, meta: { total } })

async function render(path = "/media") {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/media" element={<Media />} />
        </Routes>
      </MemoryRouter>
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const text = () => container.textContent ?? ""

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.user = { id: 7, username: "elena", full_name: "Elena V.", role: "editor" }
  api.getMedia.mockReset()
  api.getMediaPosts.mockReset()
  api.getMediaById.mockReset()
  api.createMedia.mockReset()
  api.updateMedia.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("Media library", () => {
  it("loading: skeleton tiles, no count yet", async () => {
    api.getMedia.mockImplementation(never)
    await render()
    expect(container.querySelector("[aria-busy=true]")).not.toBeNull()
    expect(container.querySelectorAll(".gl-media-tile--skeleton")).toHaveLength(12)
    expect(container.querySelector(".gl-media__count")).toBeNull()
    expect(text()).toContain("Loading media…")
  })

  it("empty: the drop zone with Choose files, and no toolbar", async () => {
    api.getMedia.mockImplementation(() => page([]))
    await render()
    expect(container.querySelector(".gl-media-dropzone")).not.toBeNull()
    expect(text()).toContain("Drop files here to upload")
    expect(text()).toContain("Choose files")
    expect(text()).toContain("No files yet")
    expect(container.querySelector("input[type=search]")).toBeNull()
  })

  it("empty for a role that can't upload: says so, no upload buttons", async () => {
    api.user.role = "subscriber"
    api.getMedia.mockImplementation(() => page([]))
    await render()
    expect(text()).toContain("Your role can't upload media")
    expect(text()).not.toContain("Choose files")
    expect(text()).not.toContain("Upload")
  })

  it("filtered and empty: offers to clear the filters instead", async () => {
    api.getMedia.mockImplementation(() => page([]))
    await render("/media?type=video")
    expect(api.getMedia).toHaveBeenLastCalledWith(expect.objectContaining({ type: "video", sort: "date_desc" }))
    expect(text()).toContain("No media matches these filters")
    expect(container.querySelector(".gl-media-dropzone")).toBeNull()
  })

  it("lists files with a count, and opens the panel with where each is used", async () => {
    api.getMedia.mockImplementation(() => page([file(1), file(2)], 30))
    api.getMediaPosts.mockImplementation(() =>
      Promise.resolve([
        { post: { id: 11, title: "October changelog", post_type: "post", post_status: "published" }, media_order: 0, relationship_type: "featured" },
        { post: { id: 11, title: "October changelog", post_type: "post", post_status: "published" }, media_order: 2, relationship_type: "gallery" },
        { post: { id: 12, title: "About", post_type: "page", post_status: "draft" }, media_order: 1, relationship_type: "gallery" },
      ])
    )
    await render()
    expect(text()).toContain("30 files")
    expect(text()).toContain("Showing 2 of 30")
    const tiles = container.querySelectorAll<HTMLButtonElement>("button.gl-media-tile")
    expect(tiles).toHaveLength(2)

    await act(async () => tiles[0].click())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(api.getMediaPosts).toHaveBeenCalledWith(1)
    const panel = container.querySelector("aside[aria-label='File details']")!
    expect(panel).not.toBeNull()
    expect(tiles[0].getAttribute("aria-pressed")).toBe("true")
    const links = Array.from(panel.querySelectorAll<HTMLAnchorElement>(".gl-used-in__link"))
    // The changelog uses it twice (featured and in the body): one row.
    expect(links.map((a) => a.textContent)).toEqual(["October changelog", "About"])
    expect(links[0].getAttribute("href")).toBe("/content/edit/11")
    expect(panel.querySelector("a[href='/media/1']")?.textContent).toBe("Edit details")
  })

  it("a contributor sees another's file read-only", async () => {
    api.user = { id: 8, username: "c", role: "contributor" }
    api.getMedia.mockImplementation(() => page([file(1)]))
    api.getMediaPosts.mockImplementation(() => Promise.resolve([]))
    await render("/media?file=1")
    const panel = container.querySelector("aside[aria-label='File details']")!
    expect(panel.querySelector("[aria-label='Delete file']")).toBeNull()
    expect(panel.querySelector("textarea")).toBeNull()
    expect(panel.textContent).toContain("No post or page uses this file yet.")
    expect(panel.querySelector("a[href='/media/1']")?.textContent).toBe("Details")
  })
})

describe("Media library URL state", () => {
  it("opens ?file= for a file that isn't on the first page by fetching it", async () => {
    api.getMedia.mockImplementation(() => page([file(1)], 40))
    api.getMediaById.mockImplementation(() => Promise.resolve({ media: file(99, { name: "deep.jpg" }) }))
    api.getMediaPosts.mockImplementation(() => Promise.resolve([]))
    await render("/media?file=99")
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(api.getMediaById).toHaveBeenCalledWith(99)
    expect(container.querySelector("aside[aria-label='File details'] h2")?.textContent).toBe("deep.jpg")
  })

  it("keeps a filter picked while the search is still debouncing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      api.getMedia.mockImplementation(() => page([file(1)]))
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={["/media"]}>
            <Routes>
              <Route path="/media" element={<Media />} />
            </Routes>
          </MemoryRouter>
        )
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const search = container.querySelector<HTMLInputElement>("input[type=search]")!
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        setter.call(search, "cat")
        search.dispatchEvent(new Event("input", { bubbles: true }))
      })
      const video = container.querySelector<HTMLInputElement>("input[name=media-type][value=video]")!
      await act(async () => video.click())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(api.getMedia).toHaveBeenLastCalledWith(expect.objectContaining({ search: "cat", type: "video" }))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("Media library: missing alt text (#325)", () => {
  const tileFor = (id: number) => container.querySelector<HTMLButtonElement>(`button.gl-media-tile[data-id='${id}']`)!
  const altFilter = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Missing alt text")!

  it("tags images without alt text, not decorative ones, files or images that have it", async () => {
    api.getMedia.mockImplementation(() =>
      page([
        file(1, { alt: "" }),
        file(2, { alt: "   " }),
        file(3),
        file(4, { alt: "", decorative: true }),
        file(5, { alt: "", name: "roles.pdf", media_path: "uploads/roles.pdf", mime_type: "application/pdf" }),
      ])
    )
    await render()
    const tagged = [1, 2, 3, 4, 5].filter((id) => tileFor(id).querySelector(".gl-media-tile__alt"))
    expect(tagged).toEqual([1, 2])
    expect(tileFor(1).querySelector(".gl-media-tile__alt")?.textContent).toBe("No alt text")
    // The tag is part of the tile's accessible name.
    expect(tileFor(1).textContent).toContain("No alt text")
  })

  it("select mode hides the tag: the check box takes its corner", async () => {
    api.getMedia.mockImplementation(() => page([file(1, { alt: "" })]))
    await render()
    const select = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Select")!
    await act(async () => select.click())
    expect(tileFor(1).querySelector(".gl-media-tile__check")).not.toBeNull()
    expect(tileFor(1).querySelector(".gl-media-tile__alt")).toBeNull()
  })

  it("the filter toggles ?alt=missing and asks the API for missing_alt", async () => {
    api.getMedia.mockImplementation(() => page([file(1, { alt: "" })]))
    await render()
    expect(api.getMedia).toHaveBeenLastCalledWith(expect.objectContaining({ missing_alt: undefined }))
    expect(altFilter().getAttribute("aria-pressed")).toBe("false")

    await act(async () => altFilter().click())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(api.getMedia).toHaveBeenLastCalledWith(expect.objectContaining({ missing_alt: true, offset: 0 }))
    expect(altFilter().getAttribute("aria-pressed")).toBe("true")

    await act(async () => altFilter().click())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(api.getMedia).toHaveBeenLastCalledWith(expect.objectContaining({ missing_alt: undefined }))
  })

  it("from the URL, with the other filters, and Load more keeps it", async () => {
    api.getMedia.mockImplementation(() => page([file(1, { alt: "" })], 2))
    await render("/media?alt=missing&type=image")
    expect(api.getMedia).toHaveBeenLastCalledWith(expect.objectContaining({ missing_alt: true, type: "image" }))
    expect(altFilter().getAttribute("aria-pressed")).toBe("true")

    const more = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Load more")!
    await act(async () => more.click())
    expect(api.getMedia).toHaveBeenLastCalledWith(expect.objectContaining({ missing_alt: true, offset: 1 }))
  })

  it("nothing missing: says so and offers the whole library", async () => {
    api.getMedia.mockImplementation(() => page([]))
    await render("/media?alt=missing")
    expect(text()).toContain("No images are missing alt text")
    const all = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Show all media")!
    await act(async () => all.click())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(api.getMedia).toHaveBeenLastCalledWith(expect.objectContaining({ missing_alt: undefined }))
  })

  it("uploads send no alt text (the file name isn't one)", async () => {
    api.getMedia.mockImplementation(() => page([file(1)]))
    api.createMedia.mockResolvedValue({ media: file(2) })
    await render()
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!
    const picked = new File(["x"], "team-photo.jpg", { type: "image/jpeg" })
    Object.defineProperty(input, "files", { value: [picked], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(api.createMedia).toHaveBeenCalledTimes(1)
    const form = api.createMedia.mock.calls[0][0] as FormData
    expect(form.get("name")).toBe("team-photo.jpg")
    expect(form.has("alt")).toBe(false)
  })

  it("the panel marks an image decorative, which turns its alt text off", async () => {
    api.getMedia.mockImplementation(() => page([file(1, { alt: "" })]))
    api.getMediaPosts.mockImplementation(() => Promise.resolve([]))
    api.updateMedia.mockImplementation((_id: number, data: Record<string, unknown>) =>
      Promise.resolve({ media: file(1, { alt: "", ...data }) })
    )
    await render("/media?file=1")
    const panel = container.querySelector("aside[aria-label='File details']")!
    const alt = panel.querySelector<HTMLTextAreaElement>("#media-panel-alt")!
    const decorative = Array.from(panel.querySelectorAll<HTMLInputElement>("input[type=checkbox]")).find((c) =>
      c.closest("label")?.textContent?.includes("Decorative image")
    )!
    expect(alt.disabled).toBe(false)
    await act(async () => decorative.click())
    expect(alt.disabled).toBe(true)
    expect(panel.textContent).toContain("Not used while the image is marked decorative.")

    const save = Array.from(panel.querySelectorAll("button")).find((b) => b.textContent === "Save")!
    await act(async () => save.click())
    expect(api.updateMedia).toHaveBeenCalledWith(1, { alt: "", decorative: true })
    // The saved row replaces the tile's: no tag any more.
    expect(tileFor(1).querySelector(".gl-media-tile__alt")).toBeNull()
  })
})
