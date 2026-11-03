import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The media detail page (#342): a bad id is a 404, clearing a field holds Save (the API
// would keep the old value) except the alt text, and "Decorative image" (#325).

const api = vi.hoisted(() => ({
  getMediaById: vi.fn(),
  getMediaPosts: vi.fn(),
  updateMedia: vi.fn(),
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
  updateMedia: api.updateMedia,
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
  api.updateMedia.mockReset()
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

describe("MediaDetail: alt text and decorative (#325)", () => {
  const house = (over: Record<string, unknown> = {}) => ({
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
    decorative: false,
    ...over,
  })
  const saveButton = () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Save")!
  const decorativeBox = () =>
    Array.from(container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")).find((c) =>
      c.closest("label")?.textContent?.includes("Decorative image")
    )!
  const type = async (el: HTMLTextAreaElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value)
      el.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }

  it("the alt text may be cleared: Save sends it empty", async () => {
    api.getMediaById.mockResolvedValue({ media: house() })
    api.updateMedia.mockImplementation((_id: number, data: Record<string, unknown>) => Promise.resolve({ media: house(data) }))
    await render("/media/5")
    await type(container.querySelector<HTMLTextAreaElement>("#media-alt")!, "")
    expect(container.textContent).not.toContain("This can't be empty.")
    expect(saveButton().disabled).toBe(false)
    await act(async () => saveButton().click())
    expect(api.updateMedia).toHaveBeenCalledWith(5, { name: "house.jpg", alt: "", description: "A house on a hill" })
  })

  it("Decorative image turns the alt text off and is saved", async () => {
    api.getMediaById.mockResolvedValue({ media: house() })
    api.updateMedia.mockImplementation((_id: number, data: Record<string, unknown>) => Promise.resolve({ media: house(data) }))
    await render("/media/5")
    const alt = container.querySelector<HTMLTextAreaElement>("#media-alt")!
    expect(saveButton().disabled).toBe(true)
    await act(async () => decorativeBox().click())
    expect(alt.disabled).toBe(true)
    expect(alt.value).toBe("A red house")
    expect(container.textContent).toContain("Not used while the image is marked decorative.")
    expect(saveButton().disabled).toBe(false)

    await act(async () => saveButton().click())
    expect(api.updateMedia).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ decorative: true, alt: "A red house" })
    )
    expect(decorativeBox().checked).toBe(true)
    expect(saveButton().disabled).toBe(true)
  })

  it("loads a decorative image ticked, and Discard brings back what's stored", async () => {
    api.getMediaById.mockResolvedValue({ media: house({ decorative: true }) })
    await render("/media/5")
    expect(decorativeBox().checked).toBe(true)
    expect(container.querySelector<HTMLTextAreaElement>("#media-alt")!.disabled).toBe(true)
    await act(async () => decorativeBox().click())
    const discard = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Discard changes")!
    await act(async () => discard.click())
    expect(decorativeBox().checked).toBe(true)
  })
})
