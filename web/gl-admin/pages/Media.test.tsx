import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The media library page (#342): loading and empty states, the filtered empty state,
// and the side panel with its "Used in" list.

const api = vi.hoisted(() => ({
  user: { id: 7, username: "elena", full_name: "Elena V.", role: "editor" } as Record<string, unknown>,
  getMedia: vi.fn(),
  getMediaPosts: vi.fn(),
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
  createMedia: vi.fn(),
  updateMedia: vi.fn(),
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
