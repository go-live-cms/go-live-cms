import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Post types (#343): types open in the panel, which sends every field so PUT doesn't
// reset what it isn't given. Posts and Pages are built in: only Comments changes (#527).

const api = vi.hoisted(() => ({
  getPostTypes: vi.fn(),
  createPostType: vi.fn(),
  updatePostType: vi.fn(),
  updateBuiltInPostTypeSupports: vi.fn(),
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

const TYPES = [
  // Posts take comments since #522's migration.
  type("post", "Posts", { supports: ["title", "content", "comments"] }),
  type("page", "Pages", { hierarchical: true }),
  type("event", "Events", { description: "Meetups", menu_position: 30 }),
]

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
  api.updateBuiltInPostTypeSupports.mockReset()
  await act(async () => root.render(<PostTypes />))
  await settle()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const checkbox = (label: string) =>
  Array.from(container.querySelectorAll(".gl-workspace__panel label")).find((l) => l.textContent?.startsWith(label))?.querySelector("input") as
    | HTMLInputElement
    | undefined

describe("built-in types (#527: the Post types · Posts board)", () => {
  it("are marked and open with every field locked but Comments", async () => {
    const rows = Array.from(container.querySelectorAll("tbody tr"))
    expect(rows.map((r) => r.querySelector(".gl-post-type-label")?.textContent)).toEqual(["PostsBuilt-in", "PagesBuilt-in", "Events"])
    await act(async () => button("Edit Posts")!.click())
    await settle()
    const panel = container.querySelector(".gl-workspace__panel")!
    expect(panel.querySelector("h2")?.textContent).toBe("Posts")
    expect(panel.textContent).toContain("A built-in type. Only Comments can change here; the rest is fixed.")
    expect(panel.querySelector<HTMLInputElement>("#gl-post-type-label")!.readOnly).toBe(true)
    expect(panel.querySelector<HTMLInputElement>("#gl-post-type-position")!.readOnly).toBe(true)
    // Disabled itself, or by its fieldset (Behaviour).
    for (const locked of ["Title", "Content", "Excerpt", "Featured image", "Public", "Hierarchical", "Archive page"]) {
      expect(checkbox(locked)!.matches(":disabled"), locked).toBe(true)
    }
    expect(checkbox("Comments")!.matches(":disabled")).toBe(false)
    expect(checkbox("Comments")!.closest("label")!.textContent).toContain("Readers can comment on published items")
  })

  it("saves Comments alone: `supports` with the stored fields as they are", async () => {
    api.updateBuiltInPostTypeSupports.mockImplementation(async (name, supports) => ({ post_type: { ...TYPES[0], name, supports } }))
    await act(async () => button("Edit Posts")!.click())
    await settle()
    expect(checkbox("Comments")!.checked).toBe(true)
    await act(async () => checkbox("Comments")!.click())
    await act(async () => button("Save")!.click())
    await settle()
    expect(api.updateBuiltInPostTypeSupports).toHaveBeenCalledWith("post", ["title", "content"])
    expect(api.updatePostType).not.toHaveBeenCalled()

    // And back on: the field joins the stored list.
    await act(async () => checkbox("Comments")!.click())
    await act(async () => button("Save")!.click())
    await settle()
    expect(api.updateBuiltInPostTypeSupports).toHaveBeenLastCalledWith("post", ["title", "content", "comments"])
  })

  it("shows the API's refusal", async () => {
    api.updateBuiltInPostTypeSupports.mockRejectedValue(new Error("cannot modify system post types"))
    await act(async () => button("Edit Pages")!.click())
    await settle()
    await act(async () => checkbox("Comments")!.click())
    await act(async () => button("Save")!.click())
    await settle()
    expect(container.querySelector(".gl-workspace__panel [role='alert']")?.textContent).toContain("cannot modify system post types")
  })
})

it("counts Comments among the fields (5 of them)", () => {
  const fields = Array.from(container.querySelectorAll("tbody tr")).map((r) => r.querySelectorAll("td")[2]?.textContent)
  expect(fields).toEqual(["3 of 5", "2 of 5", "2 of 5"])
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
