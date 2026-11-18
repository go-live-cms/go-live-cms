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

describe("site blocks IV in the editor (#498)", () => {
  const NEW_498 = ["query_total", "author_avatar", "search_results", "post_facts", "site_copyright", "golive_credit"] as const

  it("the six new blocks and the new attrs round trip through the bridge, defaults left out", () => {
    const doc = docOf(
      ["navigation", { location: "primary", overlay: "menu" }],
      ["navigation", { location: "footer", layout: "columns" }],
      ["search", { variant: "icon", label: "Search" }],
      ["query_title", { label: true }],
      ["post_content", { width: "wide" }],
      ["post_featured_image", { width: "full" }],
      ["post_byline", { date: true, readingTime: true }],
      ["post_terms", { all: true }],
      ["related_posts", { layout: "list", taxonomy: "category" }],
      ["color_scheme_switch", { variant: "popover" }],
      ["post_facts", { fallback: true }],
      ["query_total", {}],
      ["author_avatar", {}],
      ["search_results", {}],
      ["site_copyright", {}],
      ["golive_credit", {}],
      ["post_featured_image", { width: "column" }],
    )
    const ed = open(doc, "template")
    expect(topTypes(ed)).toEqual([
      "navigation", "navigation", "search", "queryTitle", "postContent", "postFeaturedImage", "postByline", "postTerms", "relatedPosts", "colorSchemeSwitch",
      "postFacts", "queryTotal", "authorAvatar", "searchResults", "siteCopyright", "goliveCredit", "postFeaturedImage", "paragraph",
    ])
    expect(ed.state.doc.child(0).attrs).toMatchObject({ location: "primary", overlay: "menu", layout: "row" })
    expect(ed.state.doc.child(1).attrs).toMatchObject({ layout: "columns", overlay: "phone" })
    expect(ed.state.doc.child(16).attrs).toMatchObject({ width: "column" })
    const back = pmToBlockDoc(ed.state.doc)
    for (const id of doc.blocks_order.slice(0, 16)) expect(back.blocks[id]).toEqual(doc.blocks[id])
    // The column is the default: left out.
    expect(back.blocks[ID(16)].attrs).toEqual({})
  })

  it("a query's featured first post, titles only, and its pager's list end round trip", () => {
    const blocks: Record<string, unknown> = {
      "query-000001": { id: "query-000001", type: "query", version: 1, attrs: { inherit: true, feature: true, layout: "links" }, children: ["tmpl-000001", "pager-00001"] },
      "tmpl-000001": { id: "tmpl-000001", type: "post_template", version: 1, attrs: {}, children: ["title-00001"] },
      "title-00001": { id: "title-00001", type: "post_title", version: 1, attrs: {} },
      "pager-00001": { id: "pager-00001", type: "query_pagination", version: 1, attrs: { end: true } },
    }
    const doc = { doc_version: 1, blocks_order: ["query-000001"], blocks } as unknown as BlockDocV1
    const ed = open(doc, "template")
    const query = ed.state.doc.child(0)
    expect(query.attrs).toMatchObject({ inherit: true, feature: true, layout: "links" })
    expect(query.child(1).attrs).toMatchObject({ end: true })
    const back = pmToBlockDoc(ed.state.doc)
    expect(back.blocks["query-000001"]).toEqual(blocks["query-000001"])
    expect(back.blocks["pager-00001"]).toEqual(blocks["pager-00001"])
  })

  it("a client's bad values stop at the bridge", () => {
    const ed = open(docOf(["navigation", { location: "primary" }], ["post_terms", {}]), "template")
    ed.view.dispatch(ed.state.tr.setNodeMarkup(0, undefined, { ...ed.state.doc.child(0).attrs, layout: "grid", overlay: "dialog" }))
    const termsPos = ed.state.doc.child(0).nodeSize
    // Every taxonomy wins over one: the taxonomy is left out.
    ed.view.dispatch(ed.state.tr.setNodeMarkup(termsPos, undefined, { ...ed.state.doc.child(1).attrs, all: true, taxonomy: "post_tag" }))
    const back = pmToBlockDoc(ed.state.doc)
    expect(back.blocks[ID(0)].attrs).toEqual({ location: "primary" })
    expect(back.blocks[ID(1)].attrs).toEqual({ all: true })
  })

  it("are labelled placeholders that say what they're set to", () => {
    const ed = open(
      docOf(
        ["navigation", { location: "footer", layout: "columns" }],
        ["navigation", { location: "primary", overlay: "menu" }],
        ["search", { variant: "icon" }],
        ["query_title", { label: true }],
        ["post_byline", { date: true }],
        ["post_terms", { all: true }],
        ["related_posts", { layout: "list" }],
        ["color_scheme_switch", { variant: "popover" }],
        ["post_facts", { fallback: true }],
        ["query_total", {}],
        ["site_copyright", {}],
        ["golive_credit", {}],
      ),
      "template"
    )
    const views = [...ed.view.dom.querySelectorAll(".editor-site-block")]
    expect(views.map((v) => v.querySelector(".editor-site-block__name")!.textContent)).toEqual([
      "Navigation", "Navigation", "Search", "Query title", "Post byline", "Post terms", "Related posts", "Colour scheme switch", "Post details", "Query total", "Copyright", "GoLive credit",
    ])
    expect(views.map((v) => v.querySelector(".editor-site-block__detail")!.textContent)).toEqual([
      "Location: footer · Footer columns",
      "Location: primary · row · phone menu",
      "Icon link · “Search”",
      "Label · the page’s kind (Category, Author …)",
      "With avatars · date",
      "Every taxonomy",
      "“In <term>” · 3 links sharing the post’s category",
      "Light · Dark · System, behind an icon button",
      "Published · Updated · Reading time · only when nothing else is beside the post",
      "“12 posts” · how many the page lists",
      "© this year, the site’s title",
      "Published with GoLive",
    ])
    expect(ed.view.dom.querySelector(".is-inert")).toBeNull()
    ed.destroy()
    const post = open(docOf(["golive_credit", {}]), "post")
    expect(post.view.dom.querySelector(".editor-site-block.is-inert [role=note]")?.textContent).toBe("GoLive credit only works in the Site editor. In a post it shows nothing on the page. You can remove it.")
  })

  it("the query loop's summary says when it features the first post or lists titles only", () => {
    expect(siteBlockSummary("query", { inherit: true, feature: true })).toBe("This page’s list · its pages · Featured first post")
    expect(siteBlockSummary("query", { perPage: 3, layout: "links" })).toBe("Posts · 3, newest first · titles only")
    // An excerpt without a length follows the theme, and is the post's dek on its page.
    expect(siteBlockSummary("post_excerpt", {})).toBe("Theme’s length · the post’s dek on its page")
    // 35 words is a length like any other: only an absent one is the theme's.
    expect(siteBlockSummary("post_excerpt", { length: 35 })).toBe("35 words")
  })

  it("insertSiteBlock puts each new one in with its defaults", () => {
    const ed = open(null, "template")
    for (const type of NEW_498) {
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
