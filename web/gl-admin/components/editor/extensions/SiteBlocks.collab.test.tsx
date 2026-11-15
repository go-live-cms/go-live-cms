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
