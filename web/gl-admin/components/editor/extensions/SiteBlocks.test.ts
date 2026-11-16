import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import type { Schema } from "@tiptap/pm/model"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { blockDocToPM, pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { SITE_BLOCK_NODE_NAMES, SITE_BLOCK_TYPES, SITE_FLOW_BLOCK_TYPES, siteBlockNodeAttrs, type BlockDocV1, type SiteBlockType } from "@gl-admin/lib/blocks-spec"
import { BlockNodeViews } from "./BlockNodeViews"
import { PasteSanitizer } from "./PasteSanitizer"
import { editorDocKind, SiteBlockContext } from "./SiteBlocks"
import { partName, siteBlockInertNote, siteBlockSummary } from "./SiteBlockViews"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"

// The site blocks in the editor (#488; the blocks canvas's "Site blocks in the editor"):
// atoms in the one schema, labelled placeholders, inert in a post, and no way in through paste.

stubJsdomRangeLayout()

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function open(doc: BlockDocV1 | null, kind: "post" | "template" | "part" = "post") {
  const element = document.createElement("div")
  document.body.append(element)
  editor = new Editor({
    element,
    extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockNodeViews, PasteSanitizer, SiteBlockContext.configure({ kind })],
    content: doc ? blockDocToPM(doc, schemaOf()).toJSON() : "<p>first</p>",
  })
  return editor
}

let cachedSchema: Schema | null = null
function schemaOf(): Schema {
  cachedSchema ??= new Editor({ extensions: Object.values(schemaExtensions({ collaborating: false })) }).schema
  return cachedSchema
}

const ID = (n: number) => `site-blk-000${n}`

function docOf(...blocks: [SiteBlockType, Record<string, unknown>][]): BlockDocV1 {
  const entries = blocks.map(([type, attrs], i) => [ID(i), { id: ID(i), type, version: 1, attrs }] as const)
  return {
    doc_version: 1,
    blocks_order: [...entries.map(([id]) => id), "para-000001"],
    blocks: { ...Object.fromEntries(entries), "para-000001": { id: "para-000001", type: "paragraph", version: 1, attrs: { text: "after" } } },
  } as unknown as BlockDocV1
}

const topTypes = (ed: Editor) => {
  const names: string[] = []
  ed.state.doc.forEach((node) => names.push(node.type.name))
  return names
}

describe("site blocks in the schema (#488)", () => {
  it("are atoms outside the block group, so a quote or a list item can't hold one", () => {
    const schema = schemaOf()
    for (const type of SITE_FLOW_BLOCK_TYPES) {
      const node = schema.nodes[SITE_BLOCK_NODE_NAMES[type]]
      expect(node.spec.atom, type).toBe(true)
      expect(node.isInGroup("block"), type).toBe(false)
      expect(schema.nodes.blockquote.contentMatch.matchType(node), type).toBeFalsy()
      expect(schema.nodes.doc.contentMatch.matchType(node), type).toBeTruthy()
      expect(node.spec.attrs?.["data-block-id"], type).toBeDefined()
    }
  })

  it("round trip through the bridge, each block's attrs and id kept, defaults left out", () => {
    const doc = docOf(
      ["site_title", { level: 1, link: false }],
      ["site_tagline", {}],
      ["site_logo", { width: 120 }],
      ["navigation", { location: "primary", layout: "column" }],
      ["search", { label: "Search the blog", button: "Go" }],
      ["template_part", { slug: "header" }]
    )
    const ed = open(doc, "template")
    expect(topTypes(ed)).toEqual(["siteTitle", "siteTagline", "siteLogo", "navigation", "search", "templatePart", "paragraph"])
    const back = pmToBlockDoc(ed.state.doc)
    expect(back.blocks_order).toEqual(doc.blocks_order)
    for (const id of doc.blocks_order.slice(0, 6)) expect(back.blocks[id]).toEqual(doc.blocks[id])
  })

  it("a client's extra attrs stop at the bridge", () => {
    const ed = open(docOf(["navigation", { menuId: 4 }]), "template")
    const pos = 0
    ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { ...ed.state.doc.child(0).attrs, location: "primary", menuId: 4, layout: "grid" }))
    expect(pmToBlockDoc(ed.state.doc).blocks[ID(0)].attrs).toEqual({ menuId: 4 })
  })

  it("insertSiteBlock puts one in, with its defaults", () => {
    const ed = open(null, "template")
    ed.commands.setTextSelection(ed.state.doc.content.size - 1)
    expect(ed.commands.insertSiteBlock("navigation", { location: "footer" })).toBe(true)
    const nav = topTypes(ed).indexOf("navigation")
    expect(nav).toBeGreaterThan(-1)
    expect(ed.state.doc.child(nav).attrs).toMatchObject({ ...siteBlockNodeAttrs("navigation", {}), location: "footer" })
  })
})

describe("site block views", () => {
  it("are labelled placeholders, never the site's data", () => {
    const ed = open(docOf(["site_title", {}], ["navigation", { location: "primary" }], ["template_part", { slug: "header" }]), "template")
    const views = [...ed.view.dom.querySelectorAll(".editor-site-block")]
    expect(views.map((v) => v.querySelector(".editor-site-block__name")!.textContent)).toEqual(["Site title", "Navigation", "Header"])
    expect(views[0].querySelector(".editor-site-block__detail")!.textContent).toBe("Paragraph · links home")
    expect(views[1].querySelector(".editor-site-block__detail")!.textContent).toBe("Location: primary · row")
    expect(views.every((v) => v.getAttribute("contenteditable") === "false")).toBe(true)
    expect(ed.view.dom.querySelector(".is-inert")).toBeNull()
    expect(ed.view.dom.querySelector('[data-type="site-title"]')!.getAttribute("data-block-id")).toBe(ID(0))
  })

  it("say in a post that they show nothing there, and a part says it can't hold a part", () => {
    const post = open(docOf(["search", {}]), "post")
    expect(editorDocKind(post)).toBe("post")
    const note = post.view.dom.querySelector(".editor-site-block.is-inert [role=note]")
    expect(note?.textContent).toBe("Search only works in the Site editor. In a post it shows nothing on the page. You can remove it.")
    post.destroy()
    const part = open(docOf(["template_part", { slug: "footer" }], ["site_title", {}]), "part")
    const inert = [...part.view.dom.querySelectorAll(".editor-site-block.is-inert")]
    expect(inert).toHaveLength(1)
    expect(inert[0].textContent).toContain("Template part can't go in a part")
  })

  it("follow their node: a collaborator's change re-renders the summary", () => {
    const ed = open(docOf(["site_logo", {}]), "template")
    expect(ed.view.dom.querySelector(".editor-site-block__detail")!.textContent).toBe("48 px · links home")
    ed.view.dispatch(ed.state.tr.setNodeMarkup(0, undefined, { ...ed.state.doc.child(0).attrs, width: 120, link: false }))
    expect(ed.view.dom.querySelector(".editor-site-block__detail")!.textContent).toBe("120 px")
  })

  it("summaries and notes read the stored rules", () => {
    expect(siteBlockSummary("site_title", { level: 2, link: false })).toBe("H2")
    expect(siteBlockSummary("navigation", { menuId: 3, layout: "column", overlay: "never" })).toBe("Menu 3 · column · never folds")
    expect(siteBlockSummary("navigation", {})).toBe("No menu chosen · row")
    expect(siteBlockSummary("search", { placeholder: "Search the blog" })).toBe("“Search the blog” · Search")
    expect(siteBlockSummary("template_part", {})).toBe("Choose a part in the Block tab")
    expect(siteBlockInertNote("site_title", "template")).toBeNull()
    expect(siteBlockInertNote("site_title", "part")).toBeNull()
    expect(partName("promo_bar")).toBe("Promo bar")
  })
})

describe("site blocks III in the editor (#497)", () => {
  it("round trip through the bridge with their attrs, defaults left out, and the byline's reading time", () => {
    const doc = docOf(
      ["related_posts", { count: 5, taxonomy: "post_tag" }],
      ["author_cards", {}],
      ["table_of_contents", {}],
      ["color_scheme_switch", { variant: "menu" }],
      ["post_byline", { avatars: false, readingTime: true }],
      ["related_posts", {}],
    )
    const ed = open(doc, "template")
    expect(topTypes(ed)).toEqual(["relatedPosts", "authorCards", "tableOfContents", "colorSchemeSwitch", "postByline", "relatedPosts", "paragraph"])
    expect(ed.state.doc.child(0).attrs).toMatchObject({ count: 5, taxonomy: "post_tag" })
    expect(ed.state.doc.child(5).attrs).toMatchObject({ count: 3, taxonomy: null })
    expect(ed.state.doc.child(4).attrs).toMatchObject({ avatars: false, readingTime: true })
    const back = pmToBlockDoc(ed.state.doc)
    for (const id of doc.blocks_order.slice(0, 6)) expect(back.blocks[id]).toEqual(doc.blocks[id])
  })

  it("a client's extra or bad attrs stop at the bridge", () => {
    const ed = open(docOf(["related_posts", {}], ["color_scheme_switch", {}]), "template")
    ed.view.dispatch(ed.state.tr.setNodeMarkup(0, undefined, { ...ed.state.doc.child(0).attrs, count: 40, taxonomy: "Bad name" }))
    const switchPos = ed.state.doc.child(0).nodeSize
    ed.view.dispatch(ed.state.tr.setNodeMarkup(switchPos, undefined, { ...ed.state.doc.child(1).attrs, variant: "toggle" }))
    const back = pmToBlockDoc(ed.state.doc)
    expect(back.blocks[ID(0)].attrs).toEqual({ count: 6 })
    expect(back.blocks[ID(1)].attrs).toEqual({})
  })

  it("are labelled placeholders, and say in a post that they show nothing there", () => {
    const ed = open(docOf(["related_posts", { count: 1, taxonomy: "category" }], ["author_cards", {}], ["table_of_contents", {}], ["color_scheme_switch", {}], ["post_byline", { readingTime: true }]), "template")
    const views = [...ed.view.dom.querySelectorAll(".editor-site-block")]
    expect(views.map((v) => v.querySelector(".editor-site-block__name")!.textContent)).toEqual(["Related posts", "Author cards", "Table of contents", "Colour scheme switch", "Post byline"])
    expect(views.map((v) => v.querySelector(".editor-site-block__detail")!.textContent)).toEqual([
      "“More to read” · 1 post, sharing a category",
      "“Written by” · the post’s credited authors",
      "“On this page” · the post’s H2s and H3s, from three headings",
      "Light · Dark · System, side by side",
      "With avatars · reading time",
    ])
    expect(ed.view.dom.querySelector(".is-inert")).toBeNull()
    ed.destroy()
    const post = open(docOf(["color_scheme_switch", {}]), "post")
    expect(post.view.dom.querySelector(".editor-site-block.is-inert [role=note]")?.textContent).toBe("Colour scheme switch only works in the Site editor. In a post it shows nothing on the page. You can remove it.")
    post.destroy()
    const part = open(docOf(["table_of_contents", {}], ["related_posts", {}]), "part")
    expect(part.view.dom.querySelector(".is-inert")).toBeNull()
  })

  it("insertSiteBlock puts each in with its defaults", () => {
    const ed = open(null, "template")
    for (const type of ["related_posts", "author_cards", "table_of_contents", "color_scheme_switch"] as const) {
      ed.commands.setTextSelection(ed.state.doc.content.size - 1)
      expect(ed.commands.insertSiteBlock(type), type).toBe(true)
      const at = topTypes(ed).indexOf(SITE_BLOCK_NODE_NAMES[type])
      expect(at, type).toBeGreaterThan(-1)
      expect(ed.state.doc.child(at).attrs, type).toMatchObject(siteBlockNodeAttrs(type, {}))
    }
  })
})

describe("paste can't make a site block (#488, design 4.4: no parse rules)", () => {
  const siteNodes = new Set<string>(Object.values(SITE_BLOCK_NODE_NAMES))
  const hasSiteNode = (ed: Editor) => {
    let found = false
    ed.state.doc.descendants((node) => {
      if (siteNodes.has(node.type.name)) found = true
    })
    return found
  }
  const pasteEvent = () => new Event("paste") as ClipboardEvent

  it("the editor's own copy of every site block pastes as nothing, in a post and in a template", () => {
    for (const kind of ["post", "template"] as const) {
      const ed = open(
        docOf(["site_title", { level: 1 }], ["site_tagline", {}], ["site_logo", {}], ["navigation", { location: "primary" }], ["search", {}], ["template_part", { slug: "header" }]),
        kind
      )
      const { dom } = ed.view.serializeForClipboard(ed.state.doc.slice(0, ed.state.doc.content.size))
      const copied = dom.innerHTML
      // What was copied names them (data-pm-slice and the elements' data-type), so the test means something.
      expect(copied).toContain('data-type="site-title"')
      ed.commands.setContent("<p>start</p>")
      ed.commands.setTextSelection(3)
      ed.view.pasteHTML(copied, pasteEvent())
      expect(hasSiteNode(ed), kind).toBe(false)
      ed.destroy()
      editor = null
    }
  })

  it("markup written to look like one, a slice context naming one, or setContent make none", () => {
    const ed = open(null, "template")
    const crafted = [
      '<div data-type="site-title" level="1">Title</div>',
      '<div data-type="navigation" menuid="3" location="primary"></div>',
      '<div data-type="template-part" slug="header"><p>inside</p></div>',
      '<div data-pm-slice="0 0 [&quot;templatePart&quot;,{&quot;slug&quot;:&quot;header&quot;}]"><p>x</p></div>',
      '<form role="search" class="search-form"><input name="q"><button>Search</button></form>',
    ]
    for (const html of crafted) {
      ed.commands.setTextSelection(1)
      ed.view.pasteHTML(html, pasteEvent())
      expect(hasSiteNode(ed), html).toBe(false)
      ed.commands.setContent(html)
      expect(hasSiteNode(ed), html).toBe(false)
    }
  })

  it("a selected site block copies and pastes as nothing, so a cut and paste moves no data", () => {
    const ed = open(docOf(["navigation", { menuId: 9 }]), "template")
    ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, 0)))
    const { dom } = ed.view.serializeForClipboard(ed.state.selection.content())
    ed.commands.setTextSelection(ed.state.doc.content.size - 1)
    ed.view.pasteHTML(dom.innerHTML, pasteEvent())
    const navs = topTypes(ed).filter((name) => name === "navigation")
    expect(navs).toHaveLength(1)
  })
})
