import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The post sidebar's categories and tags (#167). #331: one category per post, a radio
// group; picking one replaces the category (the API's PUT), and a `post` has no "None".

const api = vi.hoisted(() => ({
  assigned: [] as unknown[],
  addPostTaxonomyTerm: vi.fn(),
  removePostTaxonomyTerm: vi.fn(),
}))

const TYPES = [
  { id: 1, name: "category", label: "Categories", hierarchical: true, show_ui: true, default_term_id: 9 },
  { id: 2, name: "tag", label: "Tags", hierarchical: false, show_ui: true, default_term_id: null },
  { id: 3, name: "topic", label: "Topics", hierarchical: true, show_ui: true, default_term_id: null },
]
const term = (id: number, name: string, taxonomy_type_id: number, parent_id?: number) => ({
  id,
  name,
  slug: name.toLowerCase(),
  description: "",
  taxonomy_type_id,
  parent_id,
  created_at: "",
})
const CATEGORIES = [term(4, "Guides", 1), term(5, "Setup", 1, 4), term(9, "Uncategorized", 1)]
const TOPICS = [term(20, "Design", 3), term(21, "Code", 3)]

vi.mock("@gl-admin/lib/api/taxonomies", () => ({
  getTaxonomyTypes: () => Promise.resolve({ data: TYPES }),
  getPostTaxonomyTerms: () => Promise.resolve(api.assigned),
  getAllTaxonomyTerms: (type: string) => Promise.resolve(type === "category" ? CATEGORIES : TOPICS),
  addPostTaxonomyTerm: api.addPostTaxonomyTerm,
  removePostTaxonomyTerm: api.removePostTaxonomyTerm,
  createTaxonomyTerm: vi.fn(),
  getTaxonomyTermBySlug: vi.fn(),
  searchTaxonomyTerms: () => Promise.resolve({ data: [] }),
}))

import PostTaxonomies from "./PostTaxonomies"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

async function render(props: { postType?: string; readOnly?: boolean } = {}) {
  const onChange = vi.fn()
  await act(async () => root.render(<PostTaxonomies postId={42} readOnly={props.readOnly ?? false} postType={props.postType} onChange={onChange} />))
  await settle()
  return onChange
}

const group = () => container.querySelector<HTMLElement>("[role='radiogroup']")!
const radio = (label: string) =>
  Array.from(group().querySelectorAll<HTMLInputElement>("input[type='radio']")).find((r) => r.closest("label")?.textContent === label)!
const checked = () =>
  Array.from(group().querySelectorAll<HTMLInputElement>("input[type='radio']"))
    .filter((r) => r.checked)
    .map((r) => r.closest("label")?.textContent)

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.assigned = [CATEGORIES[2]]
  api.addPostTaxonomyTerm.mockReset().mockResolvedValue({ replaced_term_ids: [9] })
  api.removePostTaxonomyTerm.mockReset().mockResolvedValue({ default_term_id: null })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("the category", () => {
  it("is a labelled radio group with the default checked, and no None for a post", async () => {
    await render({ postType: "post" })
    const labelId = group().getAttribute("aria-labelledby")!
    expect(document.getElementById(labelId)?.textContent).toBe("Categories")
    expect(Array.from(group().querySelectorAll("label")).map((l) => l.textContent)).toEqual(["Guides", "Setup", "Uncategorized"])
    expect(checked()).toEqual(["Uncategorized"])
    // Native radios with one name: arrow keys move the selection.
    const names = new Set(Array.from(group().querySelectorAll<HTMLInputElement>("input")).map((r) => r.name))
    expect(names.size).toBe(1)
  })

  it("replaces the category when another is picked", async () => {
    const onChange = await render({ postType: "post" })
    await act(async () => radio("Guides").click())
    await settle()
    expect(api.addPostTaxonomyTerm).toHaveBeenCalledWith(42, 4)
    expect(api.removePostTaxonomyTerm).not.toHaveBeenCalled()
    expect(checked()).toEqual(["Guides"])
    expect(onChange).toHaveBeenCalled()
  })

  it("puts the previous one back if saving fails", async () => {
    api.addPostTaxonomyTerm.mockRejectedValue(new Error("Server unavailable"))
    await render({ postType: "post" })
    await act(async () => radio("Guides").click())
    await settle()
    expect(checked()).toEqual(["Uncategorized"])
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Server unavailable")
  })

  it("offers None to other types, which removes the category", async () => {
    api.assigned = [CATEGORIES[0]]
    await render({ postType: "page" })
    expect(checked()).toEqual(["Guides"])
    await act(async () => radio("None").click())
    await settle()
    expect(api.removePostTaxonomyTerm).toHaveBeenCalledWith(42, 4)
    expect(checked()).toEqual(["None"])
  })

  it("shows the default the API puts back after None", async () => {
    api.assigned = [CATEGORIES[0]]
    api.removePostTaxonomyTerm.mockResolvedValue({ default_term_id: 9 })
    await render({ postType: "page" })
    await act(async () => radio("None").click())
    await settle()
    expect(checked()).toEqual(["Uncategorized"])
  })

  it("can't be changed read-only", async () => {
    await render({ postType: "post", readOnly: true })
    expect(radio("Guides").disabled).toBe(true)
  })
})

it("keeps checkboxes for other hierarchical taxonomies", async () => {
  await render({ postType: "post" })
  const topics = container.querySelector("ul[aria-label='Topics']")!
  expect(topics.querySelectorAll("input[type='checkbox']")).toHaveLength(2)
  expect(container.querySelectorAll("[role='radiogroup']")).toHaveLength(1)
})
