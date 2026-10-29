import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Post types (#343): Posts and Pages are built in and only listed; others open in the
// panel, which sends every field so PUT doesn't reset what it isn't given.

const api = vi.hoisted(() => ({
  getPostTypes: vi.fn(),
  createPostType: vi.fn(),
  updatePostType: vi.fn(),
}))

vi.mock("@gl-admin/lib/api/postTypes", () => api)

import PostTypes from "./PostTypes"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const type = (name: string, label: string, over: Record<string, unknown> = {}) => ({
  id: name.length,
  name,
  label,
  description: "",
  hierarchical: false,
  public: true,
  has_archive: true,
  menu_position: 0,
  supports: ["title", "content"],
  is_active: true,
  registered_by: "user",
  show_ui: true,
  show_in_menu: true,
  created_at: "",
  ...over,
})

const TYPES = [type("post", "Posts"), type("page", "Pages", { hierarchical: true }), type("event", "Events", { description: "Meetups", menu_position: 30 })]

let container: HTMLDivElement
let root: Root

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label) as
    | HTMLButtonElement
    | undefined

beforeEach(async () => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.getPostTypes.mockReset().mockResolvedValue({ data: TYPES })
  api.createPostType.mockReset()
  api.updatePostType.mockReset()
  await act(async () => root.render(<PostTypes />))
  await settle()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("built-in types", () => {
  it("are marked and can't be opened for editing", () => {
    const rows = Array.from(container.querySelectorAll("tbody tr"))
    expect(rows.map((r) => r.querySelector(".gl-post-type-label")?.textContent)).toEqual(["PostsBuilt-in", "PagesBuilt-in", "Events"])
    expect(button("Edit Posts")).toBeUndefined()
    expect(button("Edit Pages")).toBeUndefined()
    expect(button("Edit Events")).toBeDefined()
  })
})

it("saves an edit with every field, keeping the description and the name", async () => {
  api.updatePostType.mockImplementation(async (name, body) => ({ post_type: { ...TYPES[2], ...body, name } }))
  await act(async () => button("Edit Events")!.click())
  await settle()
  expect(container.querySelector(".gl-workspace__panel h2")?.textContent).toBe("Edit “Events”")
  // The name can't change after creation: it's shown, not an input.
  expect(container.querySelector("input[id='gl-post-type-name']")).toBeNull()

  const archive = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.startsWith("Archive page"))!
  await act(async () => archive.querySelector("input")!.click())
  await act(async () => button("Save")!.click())
  await settle()

  expect(api.updatePostType).toHaveBeenCalledWith("event", {
    label: "Events",
    description: "Meetups",
    public: true,
    hierarchical: false,
    has_archive: false,
    menu_position: 30,
    supports: ["title", "content"],
  })
})

it("hides what the API can't store: no icon picker, no delete", async () => {
  await act(async () => button("New post type")!.click())
  await settle()
  expect(container.textContent).not.toMatch(/Icon/)
  expect(button("Delete")).toBeUndefined()
})
