import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import type { Schema } from "@tiptap/pm/model"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { blockDocToPMWithReport, pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { SITE_BLOCK_NODE_NAMES, siteBlockKindIssues, validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { BlockNodeViews } from "./BlockNodeViews"
import { PasteSanitizer } from "./PasteSanitizer"
import { QUERY_NO_RESULTS_TEXT, SiteBlockContext } from "./SiteBlocks"
import { queryLoopSummary, siteBlockInertNote, siteBlockSummary } from "./SiteBlockViews"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"

// Site blocks II in the editor (#489; the blocks canvas's "Query loop, post template,
// pagination, no results" and "Post blocks" rows): the query loop's three containers and its
// pager in the one schema, the bridge both ways, labelled frames and placeholders, inert in a
// post, and no way in through paste.

stubJsdomRangeLayout()

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

let cachedSchema: Schema | null = null
function schemaOf(): Schema {
  cachedSchema ??= new Editor({ extensions: Object.values(schemaExtensions({ collaborating: false })) }).schema
  return cachedSchema
}

function open(doc: BlockDocV1 | null, kind: "post" | "template" | "part" = "template") {
  const element = document.createElement("div")
  document.body.append(element)
  editor = new Editor({
    element,
    extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockNodeViews, PasteSanitizer, SiteBlockContext.configure({ kind })],
    content: doc ? blockDocToPMWithReport(doc, schemaOf()).node.toJSON() : "<p>first</p>",
  })
  return editor
}

const block = (id: string, type: string, attrs: Record<string, unknown> = {}, children?: string[]) => ({ id, type, version: 1, attrs, ...(children ? { children } : {}) })

/** A template: a query (top level) with a post template, its pager and no results, then a paragraph. */
function loopDoc(queryAttrs: Record<string, unknown> = {}, extra: Record<string, ReturnType<typeof block>> = {}, templateChildren = ["title-0001", "date-00001"]): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: ["query-0001", "para-00001"],
    blocks: {
      "query-0001": block("query-0001", "query", queryAttrs, ["templ-0001", "pager-0001", "empty-0001"]),
      "templ-0001": block("templ-0001", "post_template", {}, templateChildren),
      "title-0001": block("title-0001", "post_title", { level: 3 }),
      "date-00001": block("date-00001", "post_date", { format: "short" }),
      "pager-0001": block("pager-0001", "query_pagination"),
      "empty-0001": block("empty-0001", "query_no_results", {}, ["para-00002"]),
      "para-00002": block("para-00002", "paragraph", { text: "Nothing in Guides yet." }),
      "para-00001": block("para-00001", "paragraph", { text: "after" }),
      ...extra,
    },
  } as unknown as BlockDocV1
}

describe("the query loop in the schema (#489)", () => {
  it("a query sits at the top level or in a group; its three parts only in a query", () => {
    const { nodes } = schemaOf()
    for (const name of ["query", "postTemplate", "queryNoResults"]) {
      expect(nodes[name].isAtom, name).toBe(false)
      expect(nodes[name].isInGroup("block"), name).toBe(false)
      expect(nodes[name].spec.isolating, name).toBe(true)
      expect(nodes[name].spec.attrs?.["data-block-id"], name).toBeDefined()
    }
    expect(nodes.queryPagination.spec.atom).toBe(true)
    expect(nodes.doc.contentMatch.matchType(nodes.query)).toBeTruthy()
    expect(nodes.group.contentMatch.matchType(nodes.query)).toBeTruthy()
    expect(nodes.column.contentMatch.matchType(nodes.query)).toBeFalsy()
    for (const part of [nodes.postTemplate, nodes.queryPagination, nodes.queryNoResults]) {
      expect(nodes.doc.contentMatch.matchType(part), part.name).toBeFalsy()
      expect(nodes.group.contentMatch.matchType(part), part.name).toBeFalsy()
      expect(nodes.query.contentMatch.matchType(part), part.name).toBeTruthy()
    }
    // A post template and no results hold flow, columns, details and media & text; never a group or a query.
    for (const holder of [nodes.postTemplate, nodes.queryNoResults]) {
      for (const ok of ["postTitle", "paragraph", "columns", "details", "mediaText", "search"]) expect(holder.contentMatch.matchType(nodes[ok]), `${holder.name} ${ok}`).toBeTruthy()
      for (const no of ["group", "query", "postTemplate", "queryPagination"]) expect(holder.contentMatch.matchType(nodes[no]), `${holder.name} ${no}`).toBeFalsy()
    }
  })
})

describe("the bridge (#489)", () => {
  it("round trips a query loop: attrs and ids kept, the terms a comma list on the node and an array in Block Spec", () => {
    const doc = loopDoc({ postType: "product", perPage: 3, orderBy: "title", order: "asc", taxonomy: "category", termIds: [3, 7], authorId: 12 })
    const ed = open(doc)
    const query = ed.state.doc.child(0)
    expect(query.type.name).toBe("query")
    expect(query.attrs).toMatchObject({ postType: "product", perPage: 3, termIds: "3,7", taxonomy: "category", authorId: 12, inherit: false })
    const back = pmToBlockDoc(ed.state.doc)
    expect(back.blocks_order).toEqual(doc.blocks_order)
    // The site blocks come back exactly; a paragraph comes back in its pm form, as anywhere.
    for (const id of Object.keys(doc.blocks).filter((id) => doc.blocks[id].type !== "paragraph")) expect(back.blocks[id], id).toEqual(doc.blocks[id])
    expect(back.blocks["empty-0001"].children).toEqual(["para-00002"])
    expect(() => validateBlockDoc(back, { kind: "template" })).not.toThrow()
  })

  it("a child the table refuses is dropped and reported under its container, never the whole loop", () => {
    const doc = loopDoc({}, {
      "group-0001": block("group-0001", "group", {}, ["para-00003"]),
      "para-00003": block("para-00003", "paragraph", { text: "x" }),
    }, ["title-0001", "group-0001", "date-00001"])
    const { node, dropped } = blockDocToPMWithReport(doc, schemaOf())
    expect(dropped).toEqual([{ id: "group-0001", parentId: "templ-0001", afterId: "title-0001" }])
    expect(() => node.check()).not.toThrow()
    expect(node.child(0).child(0).childCount).toBe(2)
  })

  it("an empty query gets a post template with one empty line, with ids from the query's own", () => {
    const doc = { doc_version: 1, blocks_order: ["query-0001"], blocks: { "query-0001": block("query-0001", "query", { inherit: true }, []) } } as unknown as BlockDocV1
    const first = blockDocToPMWithReport(doc, schemaOf()).node
    const again = blockDocToPMWithReport(doc, schemaOf()).node
    expect(first.toJSON()).toEqual(again.toJSON())
    const template = first.child(0).child(0)
    expect(template.type.name).toBe("postTemplate")
    expect(template.attrs["data-block-id"]).toBe("query-0001-post-template")
    expect(template.child(0).attrs["data-block-id"]).toBe("query-0001-post-template-paragraph")
    expect(() => first.check()).not.toThrow()
  })

  it("a client's extra attrs on a query stop at the bridge: no status, no query string", () => {
    const ed = open(loopDoc())
    ed.view.dispatch(ed.state.tr.setNodeMarkup(0, undefined, { ...ed.state.doc.child(0).attrs, perPage: 500, termIds: "9,x,2", taxonomy: "category", postType: "posts?status=draft" }))
    expect(pmToBlockDoc(ed.state.doc).blocks["query-0001"].attrs).toEqual({ perPage: 24, taxonomy: "category", termIds: [2, 9] })
  })
})

describe("insertSiteBlock (#489)", () => {
  it("puts a whole query loop in: a post template with a title, a date and an excerpt, the pager and no results", () => {
    const ed = open(null)
    ed.commands.setTextSelection(ed.state.doc.content.size - 1)
    expect(ed.commands.insertSiteBlock("query", { inherit: true })).toBe(true)
    let query: ReturnType<Editor["state"]["doc"]["child"]> | null = null
    ed.state.doc.forEach((node) => {
      if (node.type.name === "query") query = node
    })
    expect(query).not.toBeNull()
    expect(query!.attrs.inherit).toBe(true)
    expect(query!.textContent).toBe(QUERY_NO_RESULTS_TEXT)
    const stored = pmToBlockDoc(ed.state.doc)
    expect(() => validateBlockDoc(stored, { kind: "template" })).not.toThrow()
    expect(Object.values(stored.blocks).map((b) => b.type).filter((type) => type !== "paragraph").sort()).toEqual(
      ["post_date", "post_excerpt", "post_template", "post_title", "query", "query_no_results", "query_pagination"].sort()
    )
  })
})

describe("the views (#489)", () => {
  it("label the loop and its parts, and the post blocks", () => {
    const ed = open(loopDoc({ perPage: 3 }))
    const frames = [...ed.view.dom.querySelectorAll(".editor-site-container")]
    expect(frames.map((f) => f.querySelector(".editor-site-block__name")!.textContent)).toEqual(["Query loop", "Post template", "No results"])
    expect(frames[0].querySelector(".editor-site-block__detail")!.textContent).toBe("Posts · 3, newest first")
    // The blocks inside stay editable: only the header isn't.
    expect(frames[0].querySelector(".editor-site-container__head")!.getAttribute("contenteditable")).toBe("false")
    expect(frames[2].querySelector(".editor-site-container__content")!.textContent).toBe("Nothing in Guides yet.")
    const atoms = [...ed.view.dom.querySelectorAll(".editor-site-block")].map((a) => a.querySelector(".editor-site-block__name")!.textContent)
    expect(atoms).toEqual(["Post title", "Post date", "Pagination"])
    expect(ed.view.dom.querySelector('[data-type="query"]')!.getAttribute("data-block-id")).toBe("query-0001")
    expect(ed.view.dom.querySelector(".is-inert")).toBeNull()
  })

  it("say in a post that they show nothing there; a part can't hold the post's content", () => {
    const post = open(loopDoc(), "post")
    expect(post.view.dom.querySelector(".editor-site-container.is-inert [role=note]")!.textContent).toBe(
      "Query loop only works in the Site editor. In a post it shows nothing on the page. You can remove it."
    )
    post.destroy()
    editor = null
    expect(siteBlockInertNote("post_content", "part")).toBe("Post content can't go in a part, so it shows nothing. You can remove it.")
    expect(siteBlockInertNote("post_content", "template")).toBeNull()
    expect(siteBlockInertNote("query", "part")).toBeNull()
  })

  it("summaries read the stored rules", () => {
    expect(queryLoopSummary({ inherit: true, perPage: 3 })).toBe("This page’s list · its pages")
    expect(queryLoopSummary({ taxonomy: "category", termIds: "4", orderBy: "title", order: "asc" })).toBe("Posts in 1 term · 10, A to Z")
    expect(queryLoopSummary({ postType: "product", authorId: 2, order: "asc" })).toBe("product by one author · 10, oldest first")
    expect(siteBlockSummary("post_title", {})).toBe("Sized for the page")
    expect(siteBlockSummary("post_title", { level: 3, link: true })).toBe("H3 · links to the post")
    expect(siteBlockSummary("post_excerpt", { length: 25 })).toBe("25 words")
    expect(siteBlockSummary("post_featured_image", { aspect: "16-9", link: true })).toBe("16:9 · links to the post")
    expect(siteBlockSummary("post_date", { which: "modified", format: "short" })).toBe("updated, short")
    expect(siteBlockSummary("post_terms", { taxonomy: "tag" })).toBe("Taxonomy: tag")
    expect(siteBlockSummary("query_title", { level: 2 })).toBe("H2 · the page’s list, named")
  })
})

describe("paste can't make one (#489, design 4.4: no parse rules)", () => {
  const siteNodes = new Set<string>(Object.values(SITE_BLOCK_NODE_NAMES))
  const siteNodesIn = (ed: Editor) => {
    const found: string[] = []
    ed.state.doc.descendants((node) => {
      if (siteNodes.has(node.type.name)) found.push(node.type.name)
    })
    return found
  }

  it("the editor's own copy of a query loop pastes only the text inside it", () => {
    const ed = open(loopDoc())
    const { dom } = ed.view.serializeForClipboard(ed.state.doc.slice(0, ed.state.doc.content.size))
    const copied = dom.innerHTML
    expect(copied).toContain('data-type="query"')
    ed.commands.setContent("<p>start</p>")
    ed.commands.setTextSelection(3)
    ed.view.pasteHTML(copied, new Event("paste") as ClipboardEvent)
    expect(siteNodesIn(ed)).toEqual([])
    expect(ed.state.doc.textContent).toContain("Nothing in Guides yet.")
  })

  it("markup written to look like one makes none", () => {
    const ed = open(null)
    for (const html of [
      '<div data-type="query" inherit="true"><div data-type="post-template"><p>x</p></div></div>',
      '<div data-type="post-content"></div>',
      '<div data-pm-slice="0 0 [&quot;query&quot;,{&quot;inherit&quot;:true},&quot;postTemplate&quot;,null]"><p>x</p></div>',
      '<ul class="post-list"><li class="post-item"><h3 class="post-item-title"><a href="/p">A post</a></h3></li></ul>',
      '<nav class="pagination"><a href="/page/2/">2</a></nav>',
    ]) {
      ed.commands.setTextSelection(1)
      ed.view.pasteHTML(html, new Event("paste") as ClipboardEvent)
      expect(siteNodesIn(ed), html).toEqual([])
      ed.commands.setContent(html)
      expect(siteNodesIn(ed), html).toEqual([])
    }
  })
})

describe("where post_content may sit (#489, design 4.2)", () => {
  it("names the block the kind refuses", () => {
    const doc = loopDoc({}, { "body-00001": block("body-00001", "post_content") }, ["title-0001", "body-00001"])
    expect(siteBlockKindIssues(doc, "template")).toEqual([{ path: ["blocks", "body-00001"], message: "a post_content can't be in a post_template" }])
    expect(siteBlockKindIssues(doc, "part")).toEqual([{ path: ["blocks", "body-00001"], message: "a post_content can't be in a part" }])
    expect(siteBlockKindIssues(doc, "post")).toEqual([])
  })
})
