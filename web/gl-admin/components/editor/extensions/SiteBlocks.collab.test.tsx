import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "@/components/BlockRenderer"
import { siteBlockContent } from "./SiteBlocks"

// The site blocks on the real collab server (#488, design theme-builder.md 4.2, 7.4). They are
// in the one schema, so a post's document can hold one: a client that ignores the post
// editor's menus can write one into the shared doc. It syncs to every peer, it stores (never
// `kept-invalid`), only its own attrs reach `block_doc`, and the post's page renders nothing
// for it. Two people editing one block's settings converge, and it survives a restart.

const editors: Editor[] = []
let relay: Relay

function makeEditor(doc: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: [...Object.values(schemaExtensions({ collaborating: true })), Collaboration.configure({ document: doc })] })
  editors.push(editor)
  return editor
}

const NAV = "blk-0488-nav-00000001"
const AFTER = "blk-0488-after-000001"
const ROGUE = "blk-0488-rogue-000001"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [NAV, AFTER],
  blocks: {
    [NAV]: { id: NAV, type: "navigation", version: 1, attrs: { location: "primary" } },
    [AFTER]: { id: AFTER, type: "paragraph", version: 1, attrs: { text: "after" } },
  },
} as unknown as BlockDocV1

describe("site blocks on the relay (#488)", () => {
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    relay = await startRelay({ blockDoc: canonical(seed), revision: 2 })
  })
  afterEach(async () => {
    while (editors.length) {
      const editor = editors.pop()!
      const element = editor.options.element as HTMLElement
      editor.destroy()
      element.remove()
    }
    await relay.destroy()
    vi.restoreAllMocks()
  })

  const stored = () => relay.api.posts.get("12")!.block_doc!

  it("a site block written into a post's Yjs doc reaches every peer, stores with its own attrs only, and renders nothing", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("after"), { what: "b to load" })
    expect(b.state.doc.child(0).type.name).toBe("navigation")

    const fragment = pa.doc.getXmlFragment("default")
    pa.doc.transact(() => {
      // A template part in a post, with things no site block keeps.
      const rogue = new Y.XmlElement("templatePart")
      rogue.setAttribute("data-block-id", ROGUE)
      rogue.setAttribute("slug", "header")
      rogue.setAttribute("html", "<script>alert(1)</script>")
      fragment.insert(0, [rogue])
      // And a link nobody may store, on the navigation that exists.
      ;(fragment.get(1) as Y.XmlElement).setAttribute("href", "javascript:alert(2)")
    })

    await waitFor(() => b.state.doc.child(0).type.name === "templatePart", { what: "b to see the part" })
    await waitFor(() => !!stored().blocks[ROGUE], { what: "the store" })
    const doc = stored()
    expect(doc.blocks[ROGUE]).toEqual({ id: ROGUE, type: "template_part", version: 1, attrs: { slug: "header" } })
    expect(doc.blocks[NAV]).toEqual({ id: NAV, type: "navigation", version: 1, attrs: { location: "primary" } })
    expect(JSON.stringify(doc)).not.toMatch(/script|javascript/)
    // A post's store: the post kind, where site blocks are inert, never an error.
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(() => validateBlockDoc(doc, { kind: "part" })).toThrow()

    // The post's page: its body has no site context, so both render nothing.
    const html = renderToStaticMarkup(<BlockRenderer doc={doc} />)
    expect(html).toContain("after")
    expect(html).not.toMatch(/template-part|site-nav|<nav|<header/)
  })

  it("#489: a whole query loop written into a post's Yjs doc reaches every peer, stores with its own attrs, renders nothing, and survives a restart", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("after"), { what: "b to load" })

    const QUERY = "blk-0489-query-000001"
    const TEMPLATE = "blk-0489-templ-000001"
    const TITLE = "blk-0489-title-000001"
    const BODY = "blk-0489-body-0000001"
    const PAGER = "blk-0489-pager-000001"
    pa.doc.transact(() => {
      const element = (name: string, attrs: Record<string, string>, children: Y.XmlElement[] = []) => {
        const el = new Y.XmlElement(name)
        for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
        if (children.length) el.insert(0, children)
        return el
      }
      // A query with a status and a query string nobody may store, a post template holding the
      // post's body (refused in a template, inert in a post), and the pager.
      const query = element("query", { "data-block-id": QUERY, termIds: "5,2", taxonomy: "category", status: "draft", where: "1=1" }, [
        element("postTemplate", { "data-block-id": TEMPLATE }, [element("postTitle", { "data-block-id": TITLE }), element("postContent", { "data-block-id": BODY })]),
        element("queryPagination", { "data-block-id": PAGER }),
      ])
      pa.doc.getXmlFragment("default").insert(0, [query])
    })

    await waitFor(() => b.state.doc.child(0).type.name === "query", { what: "b to see the query" })
    await waitFor(() => !!stored().blocks[QUERY], { what: "the store" })
    const doc = stored()
    expect(doc.blocks_order[0]).toBe(QUERY)
    expect(doc.blocks[QUERY]).toEqual({ id: QUERY, type: "query", version: 1, attrs: { taxonomy: "category", termIds: [2, 5] }, children: [TEMPLATE, PAGER] })
    expect(doc.blocks[TEMPLATE]).toEqual({ id: TEMPLATE, type: "post_template", version: 1, attrs: {}, children: [TITLE, BODY] })
    expect(JSON.stringify(doc)).not.toMatch(/draft|1=1/)
    // A post's store: inert there, never an error; as a template its body in a post template is refused.
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(() => validateBlockDoc(doc, { kind: "template" })).toThrow(/post_content can't be in a post_template/)

    const html = renderToStaticMarkup(<BlockRenderer doc={doc} />)
    expect(html).toContain("after")
    expect(html).not.toMatch(/query-loop|post-list|pagination|post-item/)

    await relay.restart()
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.getText().includes("after"), { what: "c to load after the restart" })
    expect(c.state.doc.child(0).type.name).toBe("query")
    expect(c.state.doc.child(0).attrs).toMatchObject({ "data-block-id": QUERY, termIds: "5,2", taxonomy: "category" })
  })

  // #497's four atoms and the byline's reading time, written straight into the shared doc.
  const ids497 = { relatedPosts: "blk-0497-related-0001", authorCards: "blk-0497-authors-0001", tableOfContents: "blk-0497-toc-00000001", colorSchemeSwitch: "blk-0497-switch-00001", postByline: "blk-0497-byline-00001" }
  function write497(doc: Y.Doc) {
    const ids = ids497
    doc.transact(() => {
      const elements = Object.entries(ids).map(([name, id]) => {
        const el = new Y.XmlElement(name)
        el.setAttribute("data-block-id", id)
        return el
      })
      // Things no site block keeps: a script, a handler, a list of posts.
      elements[0].setAttribute("postIds", "1,2,3")
      elements[3].setAttribute("onclick", "alert(1)")
      elements[4].setAttribute("readingTime", true as unknown as string)
      doc.getXmlFragment("default").insert(0, elements)
    })
  }

  it("#497: related posts, author cards, a table of contents, a switch and a byline's reading time written into a post's doc reach every peer, store with their own attrs, and render nothing", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("after"), { what: "b to load" })
    const ids = ids497
    write497(pa.doc)
    await waitFor(() => b.state.doc.childCount >= 7 && b.state.doc.child(0).type.name === "relatedPosts", { what: "b to see them" })
    await waitFor(() => !!stored().blocks[ids.postByline], { what: "the store" })
    expect(stored().blocks[ids.relatedPosts]).toEqual({ id: ids.relatedPosts, type: "related_posts", version: 1, attrs: {} })
    expect(stored().blocks[ids.colorSchemeSwitch]).toEqual({ id: ids.colorSchemeSwitch, type: "color_scheme_switch", version: 1, attrs: {} })
    expect(stored().blocks[ids.postByline]).toEqual({ id: ids.postByline, type: "post_byline", version: 1, attrs: { readingTime: true } })
    expect(JSON.stringify(stored())).not.toMatch(/alert|postIds/)
    expect(() => validateBlockDoc(stored())).not.toThrow()
    const html = renderToStaticMarkup(<BlockRenderer doc={stored()} />)
    expect(html).toContain("after")
    expect(html).not.toMatch(/related-posts|author-cards|toc-block|theme-choice|byline/)
  }, 20_000)

  it("#497: two people changing a related posts block's settings converge, and a restart keeps them and the reading time", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => a.getText().includes("after") && b.getText().includes("after"), { what: "both to load" })
    // A adds them from the editor, as the Site editor does (every attr written with the element).
    a.view.dispatch(a.state.tr.insert(0, [a.schema.nodeFromJSON(siteBlockContent("related_posts")), a.schema.nodeFromJSON(siteBlockContent("post_byline", { readingTime: true }))]))
    const ids = { relatedPosts: a.state.doc.child(0).attrs["data-block-id"] as string, postByline: a.state.doc.child(1).attrs["data-block-id"] as string }
    expect(ids.relatedPosts).toBeTruthy()
    await waitFor(() => b.state.doc.child(0).type.name === "relatedPosts", { what: "b to see them" })
    await waitFor(() => !!stored().blocks[ids.postByline], { what: "the first store" })

    // A sets the count while B picks a taxonomy: different attrs, both kept.
    a.view.dispatch(a.state.tr.setNodeMarkup(0, undefined, { ...a.state.doc.child(0).attrs, count: 6 }))
    b.view.dispatch(b.state.tr.setNodeMarkup(0, undefined, { ...b.state.doc.child(0).attrs, taxonomy: "post_tag" }))
    await waitFor(
      () => {
        const attrs = stored().blocks[ids.relatedPosts]?.attrs as Record<string, unknown> | undefined
        return attrs?.count === 6 && attrs?.taxonomy === "post_tag"
      },
      { what: "the store to have both" }
    )
    expect(a.state.doc.child(0).attrs).toMatchObject({ count: 6, taxonomy: "post_tag" })
    expect(b.state.doc.child(0).attrs).toMatchObject({ count: 6, taxonomy: "post_tag" })

    await relay.restart()
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.getText().includes("after"), { what: "c to load after the restart" })
    expect(c.state.doc.child(0).attrs).toMatchObject({ "data-block-id": ids.relatedPosts, count: 6, taxonomy: "post_tag" })
    expect(c.state.doc.child(1).attrs).toMatchObject({ "data-block-id": ids.postByline, readingTime: true })
  }, 20_000)

  it("#498: the six new blocks written into a post's doc reach every peer, store with no attrs, and render nothing", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("after"), { what: "b to load" })
    const ids = {
      queryTotal: "blk-0498-total-000001",
      authorAvatar: "blk-0498-avatar-00001",
      searchResults: "blk-0498-results-0001",
      postFacts: "blk-0498-facts-000001",
      siteCopyright: "blk-0498-copyright-01",
      goliveCredit: "blk-0498-credit-00001",
    }
    pa.doc.transact(() => {
      const elements = Object.entries(ids).map(([name, id]) => {
        const el = new Y.XmlElement(name)
        el.setAttribute("data-block-id", id)
        return el
      })
      // Things no site block keeps: a year, a link of the client's, markup, and a valid attr.
      elements[4].setAttribute("year", "1999")
      elements[5].setAttribute("href", "https://example.org")
      elements[2].setAttribute("html", "<mark>x</mark>")
      elements[3].setAttribute("fallback", true as unknown as string)
      pa.doc.getXmlFragment("default").insert(0, elements)
    })
    await waitFor(() => b.state.doc.childCount >= 7 && b.state.doc.child(0).type.name === "queryTotal", { what: "b to see them" })
    await waitFor(() => !!stored().blocks[ids.goliveCredit], { what: "the store" })
    expect(stored().blocks[ids.siteCopyright]).toEqual({ id: ids.siteCopyright, type: "site_copyright", version: 1, attrs: {} })
    expect(stored().blocks[ids.goliveCredit]).toEqual({ id: ids.goliveCredit, type: "golive_credit", version: 1, attrs: {} })
    expect(stored().blocks[ids.searchResults]).toEqual({ id: ids.searchResults, type: "search_results", version: 1, attrs: {} })
    expect(stored().blocks[ids.postFacts]).toEqual({ id: ids.postFacts, type: "post_facts", version: 1, attrs: { fallback: true } })
    expect(JSON.stringify(stored())).not.toMatch(/1999|example\.org|<mark>/)
    expect(() => validateBlockDoc(stored())).not.toThrow()
    const html = renderToStaticMarkup(<BlockRenderer doc={stored()} />)
    expect(html).toContain("after")
    expect(html).not.toMatch(/golive-credit|post-facts|search-results|avatar|©/)
  }, 20_000)

  it("#500: comments blocks written into a post's doc reach every peer, store with their title only, render nothing, and survive a restart", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("after"), { what: "b to load" })
    const FIRST = "blk-0500-comments-001"
    const SECOND = "blk-0500-comments-002"
    pa.doc.transact(() => {
      const first = new Y.XmlElement("comments")
      first.setAttribute("data-block-id", FIRST)
      // What no comments block keeps: markup in its title, a thread, a post of the client's.
      first.setAttribute("title", "  <b>Responses</b>  ")
      first.setAttribute("threads", "[{\"body\":\"hi\"}]")
      first.setAttribute("postId", "99")
      const second = new Y.XmlElement("comments")
      second.setAttribute("data-block-id", SECOND)
      second.setAttribute("title", "Comments")
      // Two in a post: inert there, never refused (a template holds one).
      pa.doc.getXmlFragment("default").insert(0, [first, second])
    })
    await waitFor(() => b.state.doc.child(0).type.name === "comments" && b.state.doc.child(1).type.name === "comments", { what: "b to see them" })
    await waitFor(() => !!stored().blocks[SECOND], { what: "the store" })
    // Plain text, as typed but trimmed: the title is text on the page, never markup.
    expect(stored().blocks[FIRST]).toEqual({ id: FIRST, type: "comments", version: 1, attrs: { title: "<b>Responses</b>" } })
    expect(stored().blocks[SECOND]).toEqual({ id: SECOND, type: "comments", version: 1, attrs: {} })
    expect(JSON.stringify(stored())).not.toMatch(/threads|postId|"hi"/)
    expect(() => validateBlockDoc(stored())).not.toThrow()
    expect(() => validateBlockDoc(stored(), { kind: "template" })).toThrow(/at most one comments block/)
    expect(() => validateBlockDoc(stored(), { kind: "part" })).toThrow(/can't be in a part/)
    // The post's page: its body has no site context, so neither renders a section or the script.
    const html = renderToStaticMarkup(<BlockRenderer doc={stored()} />)
    expect(html).toContain("after")
    expect(html).not.toMatch(/comments|comment-form|gl-comments/)

    await relay.restart()
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.getText().includes("after"), { what: "c to load after the restart" })
    // The shared doc keeps the attr as written; the bridge trims it on every store.
    expect(c.state.doc.child(0).attrs["data-block-id"]).toBe(FIRST)
    expect(String(c.state.doc.child(0).attrs.title).trim()).toBe("<b>Responses</b>")
  }, 20_000)

  it("#498: two people changing a navigation's layout and phone menu converge, and a restart keeps the new attrs", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => a.getText().includes("after") && b.getText().includes("after"), { what: "both to load" })
    a.view.dispatch(
      a.state.tr.insert(0, [
        a.schema.nodeFromJSON(siteBlockContent("navigation", { location: "primary" })),
        a.schema.nodeFromJSON(siteBlockContent("post_featured_image", { width: "wide" })),
        a.schema.nodeFromJSON(siteBlockContent("post_terms", { all: true })),
      ])
    )
    const ids = {
      navigation: a.state.doc.child(0).attrs["data-block-id"] as string,
      image: a.state.doc.child(1).attrs["data-block-id"] as string,
      terms: a.state.doc.child(2).attrs["data-block-id"] as string,
    }
    await waitFor(() => b.state.doc.child(0).type.name === "navigation", { what: "b to see them" })
    await waitFor(() => !!stored().blocks[ids.terms], { what: "the first store" })

    // A gives it the theme's phone menu while B sets the footer's columns: different attrs, both kept.
    a.view.dispatch(a.state.tr.setNodeMarkup(0, undefined, { ...a.state.doc.child(0).attrs, overlay: "menu" }))
    b.view.dispatch(b.state.tr.setNodeMarkup(0, undefined, { ...b.state.doc.child(0).attrs, layout: "columns" }))
    await waitFor(
      () => {
        const attrs = stored().blocks[ids.navigation]?.attrs as Record<string, unknown> | undefined
        return attrs?.overlay === "menu" && attrs?.layout === "columns"
      },
      { what: "the store to have both" }
    )
    expect(stored().blocks[ids.navigation].attrs).toEqual({ location: "primary", layout: "columns", overlay: "menu" })
    expect(stored().blocks[ids.image].attrs).toEqual({ width: "wide" })
    expect(stored().blocks[ids.terms].attrs).toEqual({ all: true })
    expect(a.state.doc.child(0).attrs).toMatchObject({ overlay: "menu", layout: "columns" })
    expect(b.state.doc.child(0).attrs).toMatchObject({ overlay: "menu", layout: "columns" })

    await relay.restart()
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.getText().includes("after"), { what: "c to load after the restart" })
    expect(c.state.doc.child(0).attrs).toMatchObject({ "data-block-id": ids.navigation, overlay: "menu", layout: "columns" })
    expect(c.state.doc.child(1).attrs).toMatchObject({ "data-block-id": ids.image, width: "wide" })
    expect(c.state.doc.child(2).attrs).toMatchObject({ "data-block-id": ids.terms, all: true })
  }, 20_000)

  it("two people changing one block's settings converge, and a restart keeps them", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => a.getText().includes("after") && b.getText().includes("after"), { what: "both to load" })

    // A picks a menu by id while B makes it a column: different attrs, both kept.
    a.view.dispatch(a.state.tr.setNodeMarkup(0, undefined, { ...a.state.doc.child(0).attrs, menuId: 7, location: null }))
    b.view.dispatch(b.state.tr.setNodeMarkup(0, undefined, { ...b.state.doc.child(0).attrs, layout: "column" }))
    await waitFor(
      () => {
        const attrs = stored().blocks[NAV]?.attrs as Record<string, unknown> | undefined
        return attrs?.menuId === 7 && attrs?.layout === "column"
      },
      { what: "the store to have both" }
    )
    expect(stored().blocks[NAV].attrs).toEqual({ menuId: 7, layout: "column" })
    expect(a.state.doc.child(0).attrs).toMatchObject({ menuId: 7, layout: "column" })
    expect(b.state.doc.child(0).attrs).toMatchObject({ menuId: 7, layout: "column" })

    await relay.restart()
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.getText().includes("after"), { what: "c to load after the restart" })
    expect(c.state.doc.child(0).attrs).toMatchObject({ "data-block-id": NAV, menuId: 7, layout: "column", location: null })
  })
})
