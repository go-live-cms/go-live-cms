import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Taxonomies (#343): categories list as a tree, children indented under their parent;
// the panel beside the list edits the term picked; flat types (tags) add by name.

const api = vi.hoisted(() => ({
  role: "editor",
  structure: "category",
  getAllTaxonomyTerms: vi.fn(),
  createTaxonomyTerm: vi.fn(),
  updateTaxonomyTerm: vi.fn(),
  deleteTaxonomyTerm: vi.fn(),
  mergeTaxonomyTerms: vi.fn(),
}))

vi.mock("@gl-admin/lib/hooks/useCurrentRole", () => ({ useCurrentRole: () => api.role }))
vi.mock("@gl-admin/lib/api/taxonomies", () => ({
  getTaxonomyTypes: () =>
    Promise.resolve({
      data: [
        { id: 1, name: "category", label: "Categories", hierarchical: true, public: true, show_ui: true, description: "", default_term_id: 9 },
        { id: 2, name: "tag", label: "Tags", hierarchical: false, public: true, show_ui: true, description: "", default_term_id: null },
      ],
    }),
  getAllTaxonomyTerms: api.getAllTaxonomyTerms,
  createTaxonomyTerm: api.createTaxonomyTerm,
  updateTaxonomyTerm: api.updateTaxonomyTerm,
  deleteTaxonomyTerm: api.deleteTaxonomyTerm,
  mergeTaxonomyTerms: api.mergeTaxonomyTerms,
}))
// The post URL structure (#331), read once through useSiteSettings.
vi.mock("@gl-admin/lib/api/settings", () => ({ getSettings: () => Promise.resolve({ post_url_structure: api.structure }) }))

import Taxonomies from "./Taxonomies"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const term = (id: number, name: string, parent_id?: number, post_count = 0) => ({
  id,
  name,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  description: "",
  parent_id,
  taxonomy_type_id: 1,
  post_count,
  created_at: "",
})

// Out of order on purpose: the tree sorts parents A–Z with their children under them.
const CATEGORIES = [
  term(4, "Guides"),
  term(2, "Changelog", 1, 6),
  term(1, "Product updates", undefined, 14),
  term(5, "Setup", 4),
  term(6, "Advanced setup", 5),
  term(9, "Uncategorized", undefined, 2),
]

let container: HTMLDivElement
let root: Root

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

async function render(path = "/taxonomies?type=category") {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Taxonomies />
      </MemoryRouter>
    )
  )
  await settle()
}

const names = () =>
  Array.from(container.querySelectorAll<HTMLElement>("tbody .gl-term-name")).map((el) => ({
    name: el.querySelector(".gl-row-link, .gl-term-name__text")?.textContent,
    depth: Number(el.dataset.depth),
    branch: !!el.querySelector(".gl-term-name__branch"),
  }))

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.role = "editor"
  api.getAllTaxonomyTerms.mockReset().mockImplementation((type: string) => Promise.resolve(type === "category" ? CATEGORIES : []))
  api.createTaxonomyTerm.mockReset()
  api.updateTaxonomyTerm.mockReset()
  api.deleteTaxonomyTerm.mockReset().mockResolvedValue({})
  api.mergeTaxonomyTerms.mockReset()
  api.structure = "category"
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("opened from the command palette (#41)", () => {
  const editing = () => container.querySelector('.gl-row-link[aria-current="true"]')?.textContent

  it("opens the term's panel for someone who can edit it", async () => {
    await render("/taxonomies?type=category&term=4")
    expect(editing()).toBe("Guides")
  })

  it("only lists the terms for a contributor", async () => {
    api.role = "contributor"
    await render("/taxonomies?type=category&term=4")
    expect(container.querySelector(".gl-row-link")).toBeNull()
    expect(names()[0].name).toBe("Guides")
  })
})

describe("the category tree", () => {
  it("nests children under their parent, indented a level each", async () => {
    await render()
    expect(names()).toEqual([
      { name: "Guides", depth: 0, branch: false },
      { name: "Setup", depth: 1, branch: true },
      { name: "Advanced setup", depth: 2, branch: true },
      { name: "Product updates", depth: 0, branch: false },
      { name: "Changelog", depth: 1, branch: true },
      { name: "Uncategorized", depth: 0, branch: false },
    ])
    const indent = (name: string) =>
      Array.from(container.querySelectorAll<HTMLElement>(".gl-term-name")).find((el) => el.textContent?.includes(name))!.style.getPropertyValue("--depth")
    expect(indent("Advanced setup")).toBe("2")
  })

  it("tells screen readers which parent a child is in", async () => {
    await render()
    const changelog = Array.from(container.querySelectorAll(".gl-term-name")).find((el) => el.textContent?.startsWith("└Changelog"))
    expect(changelog?.querySelector(".gl-workspace__sr")?.textContent).toBe(", in Product updates")
  })

  it("starts with the New category panel, and opens a term in it when picked", async () => {
    await render()
    expect(container.querySelector(".gl-workspace__panel h2")?.textContent).toBe("New category")

    const setup = container.querySelector<HTMLButtonElement>("button[aria-label='Edit Setup']")!
    await act(async () => setup.click())
    await settle()
    expect(container.querySelector(".gl-workspace__panel h2")?.textContent).toBe("Edit “Setup”")
    expect(setup.closest("tr")?.classList.contains("is-current")).toBe(true)
    expect(setup.getAttribute("aria-current")).toBe("true")
  })
})

describe("tags", () => {
  it("adds by name above the list and has no panel until a tag is picked", async () => {
    await render("/taxonomies?type=tag")
    expect(container.querySelector("h1")?.textContent).toBe("Tags")
    expect(container.querySelector(".gl-quick-add")).not.toBeNull()
    expect(container.querySelector(".gl-workspace__panel")).toBeNull()
    expect(container.querySelector("nav[aria-label='Taxonomies'] [aria-current='page']")?.textContent).toBe("Tags")
  })

})

// #331: one category per post, nested one level, in post URLs; tags merge.
const TAGS = [
  { ...term(5, "Images", undefined, 5), taxonomy_type_id: 2 },
  { ...term(7, "Photos", undefined, 3), taxonomy_type_id: 2 },
  { ...term(8, "Releases", undefined, 0), taxonomy_type_id: 2 },
]

const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined
const checkbox = (label: string) => container.querySelector<HTMLInputElement>(`input[type='checkbox'][aria-label='${label}']`)!
const panel = () => container.querySelector<HTMLElement>(".gl-workspace__panel")
const hintOf = (el: Element) =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function edit(name: string) {
  await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label='Edit ${name}']`)!.click())
  await settle()
}

describe("categories (#331)", () => {
  it("states the rules and marks the default category", async () => {
    await render()
    expect(container.textContent).toContain("Each post has one category. Categories can be nested one level and appear in the post’s URL.")
    const row = container.querySelector("button[aria-label='Edit Uncategorized']")!.closest(".gl-term-name")!
    expect(row.querySelector(".gl-workspace__badge")?.textContent).toBe("Default")
    expect(container.querySelectorAll("tbody .gl-workspace__badge")).toHaveLength(1)
  })

  it("has no Delete for the default category", async () => {
    await render()
    await edit("Uncategorized")
    expect(button("Delete")).toBeUndefined()
    await edit("Guides")
    expect(button("Delete")).toBeDefined()
  })

  it("shows the slug's place in post URLs and what changing it does", async () => {
    await render()
    await edit("Product updates")
    const slug = panel()!.querySelector<HTMLInputElement>("input[name='term-slug']")!
    expect(panel()!.querySelector(".gl-slug-field__prefix")?.textContent).toBe("/")
    expect(hintOf(slug)).not.toContain("Old links redirect")

    await typeInto(slug, "news")
    expect(hintOf(slug)).toContain("Changing it updates 14 post URLs. Old links redirect.")
  })

  it("shows /category/ under the other URL structures", async () => {
    api.structure = "slug"
    await render()
    expect(container.textContent).not.toContain("appear in the post’s URL")
    await edit("Guides")
    expect(panel()!.querySelector(".gl-slug-field__prefix")?.textContent).toBe("/category/")
  })

  it("offers only top-level parents, and none to a category with subcategories", async () => {
    await render()
    await edit("Product updates")
    const parent = panel()!.querySelector<HTMLButtonElement>("button[role='combobox']")!
    expect(parent.disabled).toBe(true)
    expect(hintOf(parent)).toContain("“Product updates” has subcategories, so it stays at the top level.")

    await edit("Changelog")
    const picker = panel()!.querySelector<HTMLButtonElement>("button[role='combobox']")!
    await act(async () => picker.click())
    const options = Array.from(document.querySelectorAll("[role='option']")).map((o) => o.textContent)
    expect(options).toEqual(["None (top level)", "Guides", "Product updates", "Uncategorized"])
  })

  it("says a deleted category's posts move to the default one", async () => {
    await render()
    await edit("Product updates")
    await act(async () => button("Delete")!.click())
    const dialog = container.querySelector("[role='alertdialog']")!
    expect(dialog.textContent).toContain("They move to “Uncategorized”.")
    await act(async () => button("Delete and move posts")!.click())
    await settle()
    expect(api.deleteTaxonomyTerm).toHaveBeenCalledWith(1, true)
  })

  it("explains the API's nesting rule on the parent field", async () => {
    const { ApiError } = await import("@gl-admin/lib/api/errors")
    api.updateTaxonomyTerm.mockRejectedValue(new ApiError("nesting", 400, null, "nesting_too_deep"))
    await render()
    await edit("Guides")
    await act(async () => button("Save")!.click())
    await settle()
    expect(panel()!.textContent).toContain("Categories nest one level")
  })
})

describe("selecting tags (#331)", () => {
  beforeEach(() => {
    api.getAllTaxonomyTerms.mockImplementation((type: string) => Promise.resolve(type === "tag" ? TAGS : CATEGORIES))
  })

  const liveCount = () => container.querySelector(".gl-workspace__sr[aria-live='polite']")?.textContent

  it("has a labelled checkbox per tag and a bulk bar once some are selected", async () => {
    await render("/taxonomies?type=tag")
    expect(container.querySelector("thead input[aria-label='Select all']")).not.toBeNull()
    expect(container.querySelector("[aria-label='Bulk actions']")).toBeNull()

    await act(async () => checkbox("Select Photos").click())
    expect(container.querySelector("[aria-label='Bulk actions']")?.textContent).toContain("1 selected")
    expect(liveCount()).toBe("1 tag selected")
    // Merging needs two
    expect(button("Merge…")).toBeUndefined()

    await act(async () => checkbox("Select Images").click())
    expect(liveCount()).toBe("2 tags selected")
    expect(button("Merge…")).toBeDefined()
  })

  it("has no checkboxes for categories or for contributors", async () => {
    await render()
    expect(container.querySelector("tbody input[type='checkbox']")).toBeNull()
    api.role = "contributor"
    act(() => root.unmount())
    root = createRoot(container)
    await render("/taxonomies?type=tag")
    expect(container.querySelector("input[type='checkbox']")).toBeNull()
  })

  it("merges the selected tags into the one kept", async () => {
    api.mergeTaxonomyTerms.mockResolvedValue({ taxonomy_term: TAGS[0], merged_ids: [7], moved_posts: 3, redirects: [] })
    await render("/taxonomies?type=tag")
    await act(async () => checkbox("Select Photos").click())
    await act(async () => checkbox("Select Images").click())
    await act(async () => button("Merge…")!.click())

    expect(panel()!.querySelector("h2")?.textContent).toBe("Merge 2 tags")
    expect(Array.from(panel()!.querySelectorAll(".gl-merge-panel__chip")).map((c) => c.textContent)).toEqual(["Images", "Photos"])
    expect(panel()!.querySelector("button[role='combobox']")?.textContent).toContain("Images")
    expect(panel()!.textContent).toContain(
      "The 3 posts tagged Photos get Images instead, and Photos is deleted. /tag/photos redirects to /tag/images."
    )

    api.getAllTaxonomyTerms.mockClear()
    await act(async () => button("Merge tags")!.click())
    await settle()
    expect(api.mergeTaxonomyTerms).toHaveBeenCalledWith(5, [7])
    expect(api.getAllTaxonomyTerms).toHaveBeenCalledWith("tag")
    expect(panel()).toBeNull()
    expect(container.querySelector("[aria-label='Bulk actions']")).toBeNull()
  })

  it("lets you keep another tag", async () => {
    await render("/taxonomies?type=tag")
    await act(async () => checkbox("Select Photos").click())
    await act(async () => checkbox("Select Images").click())
    await act(async () => button("Merge…")!.click())
    await act(async () => panel()!.querySelector<HTMLButtonElement>("button[role='combobox']")!.click())
    const photos = Array.from(document.querySelectorAll<HTMLElement>("[role='option']")).find((o) => o.textContent === "Photos")!
    await act(async () => photos.click())
    expect(panel()!.textContent).toContain("The 5 posts tagged Images get Photos instead, and Images is deleted.")
  })

  it("deletes the selected tags one by one after one confirmation", async () => {
    await render("/taxonomies?type=tag")
    await act(async () => checkbox("Select Photos").click())
    await act(async () => checkbox("Select Releases").click())
    await act(async () => button("Delete")!.click())
    const dialog = container.querySelector("[role='alertdialog']")!
    expect(dialog.querySelector("h2")?.textContent).toBe("Delete 2 tags?")
    expect(dialog.textContent).toContain("1 of them is assigned to posts.")

    await act(async () => button("Delete 2 tags")!.click())
    await settle()
    // Forced only for the one in use
    expect(api.deleteTaxonomyTerm.mock.calls).toEqual([
      [7, true],
      [8, false],
    ])
    expect(container.querySelector("[role='alertdialog']")).toBeNull()
  })

  it("keeps the dialog with what failed when one delete fails", async () => {
    api.deleteTaxonomyTerm.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Server down"))
    await render("/taxonomies?type=tag")
    await act(async () => checkbox("Select Photos").click())
    await act(async () => checkbox("Select Releases").click())
    await act(async () => button("Delete")!.click())
    await act(async () => button("Delete 2 tags")!.click())
    await settle()
    expect(container.querySelector("[role='alertdialog']")?.textContent).toContain("Deleted 1 of 2. Couldn’t delete “Releases”: Server down")
  })
})

it("is view-only for contributors: no panel, no edit buttons", async () => {
  api.role = "contributor"
  await render()
  expect(names().map((n) => n.name)).toContain("Setup")
  expect(container.querySelector(".gl-workspace__panel")).toBeNull()
  expect(container.querySelector("button[aria-label^='Edit ']")).toBeNull()
  expect(container.textContent).toContain("View only")
})
