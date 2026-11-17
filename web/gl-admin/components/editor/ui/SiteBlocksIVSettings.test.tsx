import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import type { SiteBlockType } from "@gl-admin/lib/blocks-spec"
import { siteBlockContent } from "../extensions/SiteBlocks"
import SiteBlockSettings, {
  GOLIVE_CREDIT_HELP,
  NAVIGATION_COLUMNS_HELP,
  NAVIGATION_MENU_HELP,
  POST_EXCERPT_LENGTH_HELP,
  POST_FACTS_HELP,
  QUERY_FEATURE_HELP,
  QUERY_PAGINATION_END_HELP,
  RELATED_POSTS_LIST_HELP,
  SEARCH_ICON_HELP,
  SEARCH_RESULTS_HELP,
  SITE_COPYRIGHT_HELP,
} from "./SiteBlockSettings"

// The Block tab of site blocks IV (#498): the new attrs on the existing site blocks and the six new
// blocks' notes. Each change is one transaction on the block found by its id; what's stored is the
// Block Spec's normalized attrs.

vi.mock("@gl-admin/lib/api/taxonomies", () => ({
  getAllTaxonomyTerms: vi.fn(async () => []),
  getTaxonomyTypes: vi.fn(async () => ({
    data: [
      { name: "category", label: "Categories", public: true },
      { name: "post_tag", label: "Tags", public: true },
    ],
    meta: {},
  })),
}))
vi.mock("@gl-admin/lib/api/menus", () => ({ listMenus: vi.fn(async () => []) }))
vi.mock("@gl-admin/lib/api/themes", () => ({
  getActiveTheme: vi.fn(async () => ({ config: { menu_locations: [{ name: "primary", label: "Primary" }, { name: "footer", label: "Footer" }] } })),
}))
vi.mock("@gl-admin/lib/api/postTypes", () => ({ getPostTypes: vi.fn(async () => ({ data: [], meta: {} })) }))
vi.mock("@gl-admin/lib/api/posts", () => ({ getCreditedAuthors: vi.fn(async () => []) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let editor: Editor | null = null
beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  editor?.destroy()
  editor = null
})

function open(type: SiteBlockType, attrs: Record<string, unknown> = {}) {
  editor?.destroy()
  editor = new Editor({ extensions: Object.values(schemaExtensions({ collaborating: false })), content: { type: "doc", content: [siteBlockContent(type, attrs)] } })
}
const ed = () => editor!
const block = () => ed().state.doc.child(0)
const stored = () => pmToBlockDoc(ed().state.doc).blocks[block().attrs["data-block-id"] as string]
async function show() {
  await act(async () => root.render(<SiteBlockSettings editor={ed()} node={block()} blockRef={{ id: block().attrs["data-block-id"] ?? null, pos: 0 }} />))
}
const button = (text: string) => {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found as HTMLButtonElement
}
const toggle = (label: string) => {
  const found = [...host.querySelectorAll('[role="switch"]')].find((s) => (s.closest("label") ?? s.parentElement)?.textContent?.includes(label))
  if (!found) throw new Error(`no switch "${label}"`)
  return found as HTMLButtonElement
}

describe("site blocks IV's settings (#498)", () => {
  it("navigation: footer columns hide the phone choice; the theme's phone menu says what it holds", async () => {
    open("navigation", { location: "primary" })
    await show()
    act(() => button("Menu button").click())
    expect(stored().attrs).toEqual({ location: "primary", overlay: "menu" })
    await show()
    expect(host.textContent).toContain(NAVIGATION_MENU_HELP)
    act(() => button("Footer columns").click())
    expect(stored().attrs).toEqual({ location: "primary", layout: "columns", overlay: "menu" })
    await show()
    expect(host.textContent).toContain(NAVIGATION_COLUMNS_HELP)
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Menu button")).toBe(false)
  })

  it("search: the icon link keeps only its label", async () => {
    open("search")
    await show()
    expect(host.querySelectorAll('input[type="text"]')).toHaveLength(3)
    act(() => button("Icon link").click())
    expect(stored().attrs).toEqual({ variant: "icon" })
    await show()
    expect(host.textContent).toContain(SEARCH_ICON_HELP)
    expect(host.querySelectorAll('input[type="text"]')).toHaveLength(1)
  })

  it("query: the featured first post and titles only", async () => {
    open("query", { inherit: true })
    await show()
    expect(host.textContent).toContain(QUERY_FEATURE_HELP)
    act(() => toggle("Feature the first post").click())
    expect(stored().attrs).toEqual({ inherit: true, feature: true })
    await show()
    act(() => toggle("Titles only").click())
    expect(stored().attrs).toEqual({ inherit: true, feature: true, layout: "links" })
  })

  it("query title's label hides its level; the pager's list end", async () => {
    open("query_title")
    await show()
    act(() => toggle("Show the page’s kind as a label").click())
    expect(stored().attrs).toEqual({ label: true })
    await show()
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "H2")).toBe(false)

    const query = { type: "doc", content: [siteBlockContent("query", { inherit: true })] }
    editor?.destroy()
    editor = new Editor({ extensions: Object.values(schemaExtensions({ collaborating: false })), content: query })
    let pagerPos = -1
    ed().state.doc.descendants((node, pos) => {
      if (node.type.name === "queryPagination") pagerPos = pos
    })
    const pager = ed().state.doc.nodeAt(pagerPos)!
    await act(async () => root.render(<SiteBlockSettings editor={ed()} node={pager} blockRef={{ id: pager.attrs["data-block-id"] ?? null, pos: pagerPos }} />))
    expect(host.textContent).toContain(QUERY_PAGINATION_END_HELP)
    act(() => toggle("Say when it’s all on one page").click())
    const pagers = Object.values(pmToBlockDoc(ed().state.doc).blocks).filter((b) => b.type === "query_pagination")
    expect(pagers.map((b) => b.attrs)).toEqual([{ end: true }])
  })

  it("an excerpt's length: empty is the theme's own, a number is words, clearing it goes back", async () => {
    open("post_excerpt")
    await show()
    const field = host.querySelector('input[type="number"]') as HTMLInputElement
    expect(field.value).toBe("")
    expect(field.placeholder).toBe("Theme default")
    expect(host.textContent).toContain(POST_EXCERPT_LENGTH_HELP)
    const type = (value: string) => {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value)
        field.dispatchEvent(new Event("input", { bubbles: true }))
      })
      act(() => {
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      })
    }
    type("200")
    expect(stored().attrs).toEqual({ length: 100 })
    await show()
    type("")
    expect(stored().attrs).toEqual({})
  })

  it("widths: the post's content and its featured image", async () => {
    open("post_content")
    await show()
    act(() => button("Wide").click())
    expect(stored().attrs).toEqual({ width: "wide" })
    open("post_featured_image")
    await show()
    act(() => button("Full").click())
    expect(stored().attrs).toEqual({ width: "full" })
    await show()
    act(() => button("Column").click())
    expect(stored().attrs).toEqual({})
  })

  it("the byline's date, every taxonomy's terms, related posts as links, the switch's icon button", async () => {
    open("post_byline")
    await show()
    act(() => toggle("Show the date").click())
    expect(stored().attrs).toEqual({ date: true })

    open("post_terms")
    await show()
    expect(host.querySelector("select")).not.toBeNull()
    act(() => toggle("Every taxonomy").click())
    expect(stored().attrs).toEqual({ all: true })
    await show()
    expect(host.querySelector("select")).toBeNull()

    open("related_posts")
    await show()
    act(() => button("Links").click())
    expect(stored().attrs).toEqual({ layout: "list" })
    await show()
    expect(host.textContent).toContain(RELATED_POSTS_LIST_HELP)
    expect([...(host.querySelector("select") as HTMLSelectElement).options][0].textContent).toBe("Category")

    open("color_scheme_switch")
    await show()
    act(() => button("Icon button").click())
    expect(stored().attrs).toEqual({ variant: "popover" })
  })

  it("post details: only beside nothing else; the new blocks say what they show", async () => {
    open("post_facts")
    await show()
    expect(host.textContent).toContain(POST_FACTS_HELP)
    act(() => toggle("Only when the page has no table of contents or category list").click())
    expect(stored().attrs).toEqual({ fallback: true })

    for (const [type, help] of [
      ["search_results", SEARCH_RESULTS_HELP],
      ["site_copyright", SITE_COPYRIGHT_HELP],
      ["golive_credit", GOLIVE_CREDIT_HELP],
    ] as const) {
      open(type)
      await show()
      expect(host.textContent, type).toContain(help)
    }
  })
})
