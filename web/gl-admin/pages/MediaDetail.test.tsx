import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The media detail page (#342): a bad id is a 404, and clearing a field holds Save
// (the API would keep the old value).

const api = vi.hoisted(() => ({
  getMediaById: vi.fn(),
  getMediaPosts: vi.fn(),
}))

vi.mock("@gl-admin/lib/auth", () => ({
  authManager: {
    getState: () => ({ user: { id: 7, username: "elena", role: "editor" } }),
    subscribe: () => () => {},
    getAccessToken: () => null,
  },
}))
vi.mock("@gl-admin/lib/api/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gl-admin/lib/api/media")>()),
  getMediaById: api.getMediaById,
  getMediaPosts: api.getMediaPosts,
  updateMedia: vi.fn(),
  replaceMediaFile: vi.fn(),
  deleteMedia: vi.fn(),
}))

import MediaDetail from "./MediaDetail"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function render(path: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/media/:id" element={<MediaDetail />} />
        </Routes>
      </MemoryRouter>
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.getMediaById.mockReset()
  api.getMediaPosts.mockReset().mockImplementation(() => Promise.resolve([]))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("MediaDetail", () => {
  it("a non-numeric id is a 404 without a request", async () => {
    await render("/media/abc")
    expect(api.getMediaById).not.toHaveBeenCalled()
    expect(container.textContent).toMatch(/not found|404/i)
  })

  it("clearing a stored field shows why and holds Save", async () => {
    api.getMediaById.mockImplementation(() =>
      Promise.resolve({
        media: {
          id: 5,
          name: "house.jpg",
          description: "A house on a hill",
          alt: "A red house",
          media_path: "uploads/house.jpg",
          user_id: 7,
          created_at: "2026-10-26T10:00:00Z",
          changed_at: "2026-10-26T10:00:00Z",
          file_size: 2048,
          mime_type: "image/jpeg",
          width: 800,
          height: 600,
          original_filename: "house.jpg",
          variants: {},
          focal_point: null,
        },
      })
    )
    await render("/media/5")
    const description = container.querySelector<HTMLTextAreaElement>("#media-description")!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
      setter.call(description, "")
      description.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(container.textContent).toContain("This can't be empty.")
    const save = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save")!
    expect(save.disabled).toBe(true)
  })
})
