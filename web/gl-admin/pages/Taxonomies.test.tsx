import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Taxonomies (#343): categories list as a tree, children indented under their parent;
// the panel beside the list edits the term picked; flat types (tags) add by name.

const api = vi.hoisted(() => ({
  role: "editor",
  getAllTaxonomyTerms: vi.fn(),
  createTaxonomyTerm: vi.fn(),
}))

vi.mock("@gl-admin/lib/hooks/useCurrentRole", () => ({ useCurrentRole: () => api.role }))
vi.mock("@gl-admin/lib/api/taxonomies", () => ({
  getTaxonomyTypes: () =>
    Promise.resolve({
      data: [
        { id: 1, name: "category", label: "Categories", hierarchical: true, show_ui: true, description: "" },
        { id: 2, name: "tag", label: "Tags", hierarchical: false, show_ui: true, description: "" },
      ],
    }),
  getAllTaxonomyTerms: api.getAllTaxonomyTerms,
  createTaxonomyTerm: api.createTaxonomyTerm,
  updateTaxonomyTerm: vi.fn(),
  deleteTaxonomyTerm: vi.fn(),
}))

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
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
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

  it("has no select boxes: merging tags waits for #331", async () => {
    await render("/taxonomies?type=tag")
    expect(container.querySelector("input[type='checkbox']")).toBeNull()
    expect(container.textContent).not.toMatch(/Merge/)
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
