import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import type { SiteBlockType } from "@gl-admin/lib/blocks-spec"
import { siteBlockContent } from "../extensions/SiteBlocks"
import SiteBlockSettings, { COLOR_SCHEME_SWITCH_HELP, RELATED_POSTS_HELP, TABLE_OF_CONTENTS_HELP } from "./SiteBlockSettings"

// The Block tab of site blocks III (#497): related posts' count and taxonomy, the switch's look,
// the byline's reading time. Each change is one transaction on the block found by its id; what's
// stored is the Block Spec's normalized attrs.

vi.mock("@gl-admin/lib/api/taxonomies", () => ({
  getAllTaxonomyTerms: vi.fn(async () => []),
  getTaxonomyTypes: vi.fn(async () => ({
    data: [
      { name: "category", label: "Categories", public: true },
      { name: "post_tag", label: "Tags", public: true },
      { name: "internal", label: "Internal", public: false },
    ],
    meta: {},
  })),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let editor: Editor
beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  editor.destroy()
})

function open(type: SiteBlockType) {
  editor = new Editor({ extensions: Object.values(schemaExtensions({ collaborating: false })), content: { type: "doc", content: [siteBlockContent(type)] } })
}
const block = () => editor.state.doc.child(0)
const stored = () => Object.values(pmToBlockDoc(editor.state.doc).blocks)[0]
async function show() {
  await act(async () => root.render(<SiteBlockSettings editor={editor} node={block()} blockRef={{ id: block().attrs["data-block-id"] ?? null, pos: 0 }} />))
}

describe("site blocks III's settings (#497)", () => {
  it("related posts: the count, and a public taxonomy or any shared term", async () => {
    open("related_posts")
    await show()
    expect(host.textContent).toContain(RELATED_POSTS_HELP)
    const select = host.querySelector("select") as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(["Any shared term", "Categories", "Tags"])
    act(() => {
      select.value = "post_tag"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(stored().attrs).toEqual({ taxonomy: "post_tag" })
    const count = host.querySelector('input[type="number"]') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      setter.call(count, "9")
      count.dispatchEvent(new Event("input", { bubbles: true }))
    })
    act(() => {
      count.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    })
    // Clamped to 6 when it's stored.
    expect(stored().attrs).toEqual({ count: 6, taxonomy: "post_tag" })
    await show()
    act(() => {
      const select2 = host.querySelector("select") as HTMLSelectElement
      select2.value = ""
      select2.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(stored().attrs).toEqual({ count: 6 })
  })

  it("the switch's look and the byline's reading time", async () => {
    open("color_scheme_switch")
    await show()
    expect(host.textContent).toContain(COLOR_SCHEME_SWITCH_HELP)
    const list = [...host.querySelectorAll("button")].find((b) => b.textContent === "List")!
    act(() => list.click())
    expect(stored().attrs).toEqual({ variant: "menu" })
    act(() => root.unmount())
    editor.destroy()
    root = createRoot(host)

    open("post_byline")
    await show()
    const toggles = [...host.querySelectorAll('[role="switch"]')] as HTMLButtonElement[]
    // Avatars, reading time, and #498's date.
    expect(toggles).toHaveLength(3)
    act(() => toggles[1].click())
    expect(stored().attrs).toEqual({ readingTime: true })
  })

  it("the table of contents says when it shows nothing", async () => {
    open("table_of_contents")
    await show()
    expect(host.textContent).toContain(TABLE_OF_CONTENTS_HELP)
  })
})
