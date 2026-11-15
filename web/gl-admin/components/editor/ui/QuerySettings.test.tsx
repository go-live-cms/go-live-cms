import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { siteBlockContent } from "../extensions/SiteBlocks"
import SiteBlockSettings, { orderLabels, QUERY_INHERIT_HELP, QUERY_PUBLISHED_HELP } from "./SiteBlockSettings"

// The query loop's Block tab (#489, the blocks canvas's "Query loop" settings column): "Use this
// page's list", or the type, count, order, category and author. Each change is one transaction
// on the block found by its id, and what's stored is the Block Spec's normalized attrs.

vi.mock("@gl-admin/lib/api/postTypes", () => ({
  getPostTypes: vi.fn(async () => ({
    data: [
      { name: "post", label: "Posts", public: true, is_active: true },
      { name: "product", label: "Products", public: true, is_active: true },
      { name: "internal", label: "Internal", public: false, is_active: true },
    ],
    meta: {},
  })),
}))
vi.mock("@gl-admin/lib/api/taxonomies", () => ({
  getAllTaxonomyTerms: vi.fn(async () => [{ id: 4, name: "Guides", slug: "guides" }]),
  getTaxonomyTypes: vi.fn(async () => ({ data: [], meta: {} })),
}))
vi.mock("@gl-admin/lib/api/posts", () => ({
  getCreditedAuthors: vi.fn(async () => [{ id: 9, username: "ana", full_name: "Ana Costa" }]),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let editor: Editor
beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  editor = new Editor({ extensions: Object.values(schemaExtensions({ collaborating: false })), content: { type: "doc", content: [siteBlockContent("query")] } })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  editor.destroy()
})

const query = () => editor.state.doc.child(0)
const stored = () => pmToBlockDoc(editor.state.doc).blocks[Object.keys(pmToBlockDoc(editor.state.doc).blocks).find((id) => pmToBlockDoc(editor.state.doc).blocks[id].type === "query")!]
async function show() {
  await act(async () => root.render(<SiteBlockSettings editor={editor} node={query()} blockRef={{ id: query().attrs["data-block-id"] ?? null, pos: 0 }} />))
}
function pick(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

describe("the query loop's settings (#489)", () => {
  it("lists the public types, the categories and the credited authors; each choice is stored", async () => {
    await show()
    expect(host.textContent).toContain(QUERY_INHERIT_HELP)
    expect(host.textContent).toContain(QUERY_PUBLISHED_HELP)
    const [type, category, author] = [...host.querySelectorAll("select")] as HTMLSelectElement[]
    expect([...type.options].map((o) => o.textContent)).toEqual(["Posts", "Products"])
    expect([...category.options].map((o) => o.textContent)).toEqual(["Any", "Guides"])
    expect([...author.options].map((o) => o.textContent)).toEqual(["Anyone", "Ana Costa"])

    pick(type, "product")
    pick(category, "4")
    pick(author, "9")
    // The category's taxonomy and its terms in one change, so neither is left without the other.
    expect(query().attrs).toMatchObject({ postType: "product", taxonomy: "category", termIds: "4", authorId: 9 })
    expect(stored().attrs).toEqual({ postType: "product", taxonomy: "category", termIds: [4], authorId: 9 })
    pick(category, "")
    expect(stored().attrs).toEqual({ postType: "product", authorId: 9 })
  })

  it("Use this page's list hides the choices; Order says what it orders", async () => {
    await show()
    const toggle = host.querySelector('[role="switch"]') as HTMLButtonElement
    act(() => toggle.click())
    expect(query().attrs.inherit).toBe(true)
    await show()
    expect(host.querySelectorAll("select")).toHaveLength(0)
    expect(stored().attrs).toEqual({ inherit: true })
    expect(orderLabels("date")).toEqual({ desc: "Newest first", asc: "Oldest first" })
    expect(orderLabels("title")).toEqual({ asc: "A to Z", desc: "Z to A" })
  })
})
