import { afterAll, beforeAll, describe, expect, it } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer, { EMBED_LOADER_SRC } from "./BlockRenderer"
import { blockRegistry } from "./blocks/registry"
import { docElementIds, docHasEmbed, pageHeadingAnchors, PageScopeContext } from "./blocks/utils/pageScope"
import { headingAnchors } from "./blocks/utils/headingAnchors"

// One page, several docs (#484, design 3.4 problems 4 and 5): a renderer nested in another's
// blocks (a template's post content, #491) skips the outer renderer's heading ids and leaves
// the embed loader to it, so the page gets each id once and the script once.

const heading = (id: string, text: string, level = 2) => ({ id, type: "heading", version: 1, attrs: { level, pm: { type: "heading", attrs: { level }, content: [{ type: "text", text }] } } })
const embed = (id: string) => ({ id, type: "embed", version: 1, attrs: { provider: "youtube", ref: "dQw4w9WgXcQ", title: "A video" } })
const doc = (...blocks: { id: string; [key: string]: unknown }[]): BlockDocV1 =>
  ({ doc_version: 1, blocks_order: blocks.map((b) => b.id), blocks: Object.fromEntries(blocks.map((b) => [b.id, b])) }) as unknown as BlockDocV1

// A stand-in for #491's post_content block: renders the doc it is given with its own renderer.
const NESTED = "test:page-scope/nested"
const nestedDocs = new Map<string, BlockDocV1>()
beforeAll(() => {
  blockRegistry.register({
    type: NESTED,
    name: "Nested",
    component: ({ block }: { block: { id: string } }) => <section data-nested={block.id}><BlockRenderer doc={nestedDocs.get(block.id)!} /></section>,
  } as never)
})
afterAll(() => {
  blockRegistry.unregister(NESTED)
})
const nested = (id: string, inner: BlockDocV1) => {
  nestedDocs.set(id, inner)
  return { id, type: NESTED, version: 1, attrs: {} }
}

const html = (d: BlockDocV1, props: Record<string, unknown> = {}) => renderToStaticMarkup(<BlockRenderer doc={d} {...props} />)
const ids = (markup: string) => [...markup.matchAll(/<h\d id="([^"]+)"/g)].map((m) => m[1])

describe("heading ids across nested docs (problem 4)", () => {
  it("a nested doc's headings skip the outer doc's and its reserved ids", () => {
    const post = doc(heading("ph1", "Overview"), heading("ph2", "Content"))
    const page = html(doc(heading("th1", "Overview"), nested("n1", post)), { reservedIds: ["content"] })
    expect(ids(page)).toEqual(["overview", "overview-2", "content-2"])
  })

  it("a nested doc on its own keeps the ids it always had", () => {
    expect(ids(html(doc(heading("ph1", "Overview"), heading("ph2", "Content"))))).toEqual(["overview", "content"])
  })

  it("reservedIds is ignored when the layout passes its own headings", () => {
    const d = doc(heading("h1", "Content"))
    expect(ids(html(d, { reservedIds: ["content"], headings: [{ blockId: "h1", id: "mine", level: 2, text: "Content" }] }))).toEqual(["mine"])
  })

  it("a nested doc's headings skip the outer doc's block anchors and footnote ids too", () => {
    const outer = doc({ id: "intro-block", type: "paragraph", version: 1, attrs: {} }, { id: "notes-block", type: "footnotes", version: 1, attrs: {} })
    const reserved = docElementIds(outer)
    expect(reserved).toEqual(expect.arrayContaining(["b-intro-block", "b-notes-block"]))
    const ids = headingAnchors(doc(heading("h1", "Fn 1"), heading("h2", "Ref 2"), heading("h3", "b intro block")), reserved).map((h) => h.id)
    expect(ids).toEqual(["fn-1-2", "ref-2-h2", "b-intro-block-2"])
    // No footnotes: only the anchors.
    expect(docElementIds(doc(heading("heading-001", "x")))).toEqual(["b-heading-001"])
  })

  it("pageHeadingAnchors gives docs rendered side by side the same rule", () => {
    const [template, post] = pageHeadingAnchors([doc(heading("t", "Intro")), doc(heading("p", "Intro"), heading("q", "Content"))], ["content"])
    expect(template.map((h) => h.id)).toEqual(["intro"])
    expect(post.map((h) => h.id)).toEqual(["intro-2", "content-2"])
  })
})

describe("the embed loader once per page (problem 5)", () => {
  const scripts = (markup: string) => markup.match(/<script[^>]*>/g) ?? []

  it("one script, from the outermost renderer, when both docs have an embed", () => {
    const page = html(doc(embed("e1"), nested("n2", doc(embed("e2")))))
    expect(scripts(page)).toEqual([`<script src="${EMBED_LOADER_SRC}" defer="">`])
    // After the outer doc's blocks, as on a page with one doc.
    expect(page.endsWith(`</div><script src="${EMBED_LOADER_SRC}" defer=""></script>`)).toBe(true)
  })

  it("added by the outermost renderer when only a nested doc has an embed", () => {
    const page = html(doc(heading("h", "Intro"), nested("n3", doc(embed("e3")))))
    expect(scripts(page)).toHaveLength(1)
    expect(page.indexOf("<script")).toBeGreaterThan(page.indexOf('data-nested="n3"'))
  })

  it("a nested renderer that reports after the outermost rendered its end adds the script itself", () => {
    // As after a Suspense boundary resolves late: the outermost answers "too late".
    const late = { reservedIds: [], needEmbedLoader: () => false }
    const page = renderToStaticMarkup(
      <PageScopeContext.Provider value={late}>
        <BlockRenderer doc={doc(embed("e9"))} />
      </PageScopeContext.Provider>,
    )
    expect(scripts(page)).toEqual([`<script src="${EMBED_LOADER_SRC}" defer="">`])
  })

  it("none on a page without an embed", () => {
    expect(scripts(html(doc(heading("h", "Intro"), nested("n4", doc(heading("i", "Inner"))))))).toEqual([])
  })

  it("docHasEmbed: an embed with a target, not one without", () => {
    expect(docHasEmbed(doc(embed("e")))).toBe(true)
    expect(docHasEmbed(doc({ id: "x", type: "embed", version: 1, attrs: {} } as never))).toBe(false)
    expect(docHasEmbed(null)).toBe(false)
  })
})
