import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SITE_BLOCK_TYPES, type BlockDocV1, type SiteBlockType } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../BlockRenderer"
import { blockRegistry } from "./registry"
import { SiteContext, type SiteMenu, type SiteRenderContext } from "./utils/siteContext"

// The site blocks on the public page (#488, the blocks canvas's "Published site blocks"). Each
// renders the default theme's own markup from the SiteRenderContext SSR fills, and nothing
// without one: a post's body never has one, so a site block in a post shows nothing.

const ID = (n: number) => `blk-site-00000${n}`

function docOf(...blocks: [SiteBlockType, Record<string, unknown>][]): BlockDocV1 {
  const entries = blocks.map(([type, attrs], i) => [ID(i), { id: ID(i), type, version: 1, attrs }] as const)
  return { doc_version: 1, blocks_order: entries.map(([id]) => id), blocks: Object.fromEntries(entries) } as unknown as BlockDocV1
}

const main: SiteMenu = {
  name: "Main",
  items: [
    { id: 1, label: "Guides", url: "/category/guides", children: [], current: true },
    { id: 2, label: "About", url: "/about", children: [{ id: 3, label: "Team", url: "/about/team", children: [] }] },
  ],
}

const headerPart: BlockDocV1 = docOf(["site_title", {}], ["navigation", { location: "primary" }])

function context(overrides: Partial<SiteRenderContext> = {}): SiteRenderContext {
  return {
    inTemplate: true,
    kind: "template",
    site: { title: "GoLive Blog", tagline: "Notes from the team building GoLive" },
    logo: {
      media: {
        media_path: "/uploads/media/leaf-mark-0123.png",
        width: 512,
        height: 256,
        variants: { thumb: { path: "/uploads/media/_variants/leaf/thumb.png", width: 320, height: 160 } },
      },
      alt: "A green leaf",
    },
    menusByLocation: { primary: main, footer: null },
    menusById: { "7": { name: "Company", items: [{ id: 9, label: "Privacy", url: "/privacy", children: [] }] } },
    parts: { header: headerPart },
    currentPath: "/category/guides",
    ...overrides,
  }
}

const render = (doc: BlockDocV1, site?: SiteRenderContext | null) => renderToStaticMarkup(<BlockRenderer doc={doc} site={site} />)

describe("site blocks outside a template (#488, design 4.2)", () => {
  it("every one renders nothing in a post's body, which has no site context", () => {
    const doc = docOf(["site_title", { level: 1 }], ["site_tagline", {}], ["site_logo", {}], ["navigation", { location: "primary" }], ["search", {}], ["template_part", { slug: "header" }])
    expect(render(doc)).toBe('<div class="block-content"></div>')
  })

  it("a nested renderer inherits the context, and site={null} clears it (a post's body inside a template, #489)", () => {
    const inner = docOf(["site_title", {}])
    const inherited = renderToStaticMarkup(
      <SiteContext.Provider value={context()}>
        <BlockRenderer doc={inner} />
      </SiteContext.Provider>
    )
    expect(inherited).toContain("site-title")
    const cleared = renderToStaticMarkup(
      <SiteContext.Provider value={context()}>
        <BlockRenderer doc={inner} site={null} />
      </SiteContext.Provider>
    )
    expect(cleared).toBe('<div class="block-content"></div>')
  })

  it("every type has a renderer of the site block version", () => {
    for (const type of SITE_BLOCK_TYPES) expect(blockRegistry.get(type)?.version, type).toBe(1)
  })
})

describe("site blocks in a template", () => {
  it("site title: a paragraph linking home by default, a heading on request, plain when it doesn't link", () => {
    expect(render(docOf(["site_title", {}]), context())).toContain('<p id="b-blk-site-000000" class="site-title-block"><a href="/" class="site-title">GoLive Blog</a></p>')
    expect(render(docOf(["site_title", { level: 1 }]), context())).toContain('<h1 id="b-blk-site-000000" class="title site-title-block"><a href="/">GoLive Blog</a></h1>')
    expect(render(docOf(["site_title", { level: 2, link: false }]), context())).toContain('<h2 id="b-blk-site-000000" class="title site-title-block">GoLive Blog</h2>')
    expect(render(docOf(["site_title", {}]), context({ currentPath: "/" }))).toContain('aria-current="page"')
  })

  it("site tagline: the tagline, or nothing without one", () => {
    expect(render(docOf(["site_tagline", {}]), context())).toContain('<p id="b-blk-site-000000" class="site-tagline">Notes from the team building GoLive</p>')
    expect(render(docOf(["site_tagline", {}]), context({ site: { title: "x", tagline: "" } }))).not.toContain("site-tagline")
  })

  it("site logo: the image at the block's width, linked and named after the site; nothing without one", () => {
    const linked = render(docOf(["site_logo", { width: 120 }]), context())
    expect(linked).toContain('<a id="b-blk-site-000000" href="/" class="site-logo-block" aria-label="GoLive Blog, home">')
    expect(linked).toContain('src="/uploads/media/leaf-mark-0123.png"')
    expect(linked).toContain('width="120" height="60"')
    expect(linked).toContain('sizes="120px"')
    expect(linked).toContain('alt=""')
    const alone = render(docOf(["site_logo", { link: false }]), context())
    expect(alone).toContain('<span id="b-blk-site-000000" class="site-logo-block">')
    expect(alone).toContain('width="48" height="24"')
    expect(alone).toContain('alt="GoLive Blog"')
    expect(render(docOf(["site_logo", {}]), context({ logo: null }))).not.toContain("site-logo")
    // A path that isn't a safe URL never becomes a src.
    const unsafe = context({ logo: { media: { media_path: "javascript:alert(1)", width: 10, height: 10 }, alt: "" } })
    expect(render(docOf(["site_logo", {}]), unsafe)).not.toMatch(/javascript|site-logo/)
  })

  it("navigation: a location's menu as the header's nav, current page marked, children in a disclosure", () => {
    const html = render(docOf(["navigation", { location: "primary" }]), context())
    expect(html).toContain('<nav class="site-nav" aria-label="Main">')
    expect(html).toContain('<a href="/category/guides" aria-current="page">Guides</a>')
    expect(html).toContain('data-nav-group=""')
    expect(html).toContain('<ul id="nav-sub-blk-site-000000-2" class="nav-submenu" role="list">')
    // It folds into a menu button at phone width by default, with no script.
    expect(html).toContain('class="nav-block has-overlay"')
    expect(html).toContain('<details class="nav-overlay"><summary class="icon-btn" aria-label="Main: open menu">')
  })

  it("navigation: a menu by id, a column, never folded", () => {
    const html = render(docOf(["navigation", { menuId: 7, layout: "column", overlay: "never" }]), context())
    expect(html).toContain('<div id="b-blk-site-000000" class="nav-block"><nav class="site-nav is-column" aria-label="Company"><a href="/privacy">Privacy</a></nav></div>')
    expect(html).not.toContain("<details")
  })

  it("navigation: nothing for a location with no menu, a deleted menu, a failed read or no choice", () => {
    for (const attrs of [{ location: "footer" }, { location: "sidebar" }, { menuId: 99 }, {}]) {
      expect(render(docOf(["navigation", attrs]), context()), JSON.stringify(attrs)).toBe('<div class="block-content"></div>')
    }
    expect(render(docOf(["navigation", { location: "primary" }]), context({ menusByLocation: { primary: { name: "Main", items: [] } } }))).toBe(
      '<div class="block-content"></div>'
    )
  })

  it("search: the theme's GET form to /search with its own texts", () => {
    const html = render(docOf(["search", { label: "Search the blog", placeholder: "Search the blog", button: "Go" }]), context())
    expect(html).toContain('<form id="b-blk-site-000000" role="search" class="search-form search-block" action="/search" method="get">')
    const forId = /<label for="(search-[^"]+)" class="sr-only">Search the blog<\/label>/.exec(html)![1]
    expect(html).toContain(`<input id="${forId}" type="search"`)
    expect(html).toContain('name="q"')
    expect(html).toContain('placeholder="Search the blog"')
    expect(html).toContain('<button type="submit" class="btn btn-primary">Go</button>')
    const plain = render(docOf(["search", {}]), context())
    expect(plain).toContain('class="sr-only">Search</label>')
    expect(plain).toContain(">Search</button>")
    // #498: the theme's SearchForm placeholder when the block sets none, and an empty field off the search page.
    expect(plain).toContain('placeholder="Search the blog"')
    expect(plain).toContain('value=""')
    // Text, never markup.
    expect(render(docOf(["search", { button: "<b>Go</b>" }]), context())).toContain("&lt;b&gt;Go&lt;/b&gt;")
  })

  it("search: a part rendered twice keeps its field ids unique", () => {
    const part = docOf(["search", {}])
    const html = render(docOf(["template_part", { slug: "header" }], ["template_part", { slug: "header" }]), context({ parts: { header: part } }))
    const ids = [...html.matchAll(/<input id="([^"]+)"/g)].map((m) => m[1])
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it("template part: its resolved part as a header, the part's site blocks alive inside", () => {
    const html = render(docOf(["template_part", { slug: "header" }]), context())
    expect(html).toMatch(/^<div class="block-content"><header id="b-blk-site-000000" class="template-part template-part--header"><div class="block-content">/)
    expect(html).toContain('class="site-title">GoLive Blog</a>')
    expect(html).toContain('<nav class="site-nav" aria-label="Main">')
  })

  it("template part: nothing for a slug with no part, an empty part, or inside a part (no recursion)", () => {
    expect(render(docOf(["template_part", { slug: "promo" }]), context())).toBe('<div class="block-content"></div>')
    expect(render(docOf(["template_part", {}]), context())).toBe('<div class="block-content"></div>')
    expect(render(docOf(["template_part", { slug: "header" }]), context({ parts: { header: docOf() } }))).toBe('<div class="block-content"></div>')
    // A stored part that holds a part anyway renders its other blocks, and the inner part nothing.
    const looping = docOf(["site_tagline", {}], ["template_part", { slug: "header" }])
    const html = render(docOf(["template_part", { slug: "header" }]), context({ parts: { header: looping } }))
    expect(html.match(/template-part--header/g)).toHaveLength(1)
    expect(html).toContain("site-tagline")
    expect(render(docOf(["template_part", { slug: "header" }]), context({ kind: "part" }))).toBe('<div class="block-content"></div>')
  })
})
