import { afterEach, describe, expect, it, vi } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { log } from "./log"
import {
  builderWins,
  codeLayoutRank,
  parseSiteDesignResolve,
  readPublishedSiteDesign,
  resolveTemplate,
  templatePartOverride,
  templateRanks,
  templateSlugs,
  themeLayoutPath,
  type SiteDesignResolve,
  type TemplateRoute,
} from "./siteTemplates"

// Which template a route renders (#491, design 3.2 and 3.3).

const doc = (text = "x") => ({ doc_version: 1, blocks_order: ["p"], blocks: { p: { id: "p", type: "paragraph", version: 1, attrs: { text } } } }) as unknown as BlockDocV1

// The layouts of a build: the default theme's, the example theme's own product and post
// layouts, and a theme with only a term layout and an archive.
const LAYOUTS = [
  "default/layouts/post/default.astro",
  "default/layouts/page/default.astro",
  "default/layouts/page/fullwidth.astro",
  "default/layouts/home/default.astro",
  "default/layouts/archive/default.astro",
  "default/layouts/term/default.astro",
  "default/layouts/author/default.astro",
  "default/layouts/search/default.astro",
  "default/layouts/error/default.astro",
  "example/layouts/post/default.astro",
  "example/layouts/page/default.astro",
  "example/layouts/product/default.astro",
  "lists/layouts/archive/default.astro",
  "lists/layouts/error/500.astro",
]

afterEach(() => vi.restoreAllMocks())

describe("templateRanks (design 3.2)", () => {
  it("lists every route kind's slugs, most specific first", () => {
    const cases: [TemplateRoute, string[]][] = [
      [{ kind: "home" }, ["front-page", "home"]],
      [{ kind: "front-page", template: "" }, ["front-page", "page"]],
      [{ kind: "front-page", template: "fullwidth" }, ["front-page", "page-fullwidth", "page"]],
      [{ kind: "archive", postType: "post" }, ["archive-post", "archive"]],
      [{ kind: "single", postType: "post" }, ["single-post", "single"]],
      [{ kind: "single", postType: "case_study" }, ["single-case_study", "single"]],
      // #498: the type's layout variant picks the default theme's single-sidebar / single-wide.
      [{ kind: "single", postType: "post", variant: "sidebar" }, ["single-post", "single-sidebar", "single"]],
      [{ kind: "single", postType: "post", variant: "default" }, ["single-post", "single"]],
      [{ kind: "single", postType: "wide", variant: "wide" }, ["single-wide", "single"]],
      [{ kind: "page", variant: "fullwidth" }, ["page-fullwidth", "page"]],
      [{ kind: "page", template: "landing", variant: "fullwidth" }, ["page-landing", "page-fullwidth", "page"]],
      [{ kind: "page", template: "fullwidth", variant: "fullwidth" }, ["page-fullwidth", "page"]],
      [{ kind: "front-page", template: "", variant: "fullwidth" }, ["front-page", "page-fullwidth", "page"]],
      [{ kind: "page" }, ["page"]],
      [{ kind: "page", template: "default" }, ["page"]],
      [{ kind: "page", template: "landing" }, ["page-landing", "page"]],
      [{ kind: "page", template: "block:promo" }, ["custom-promo", "page"]],
      [{ kind: "term", taxonomy: "category" }, ["taxonomy-category", "taxonomy", "archive"]],
      [{ kind: "author" }, ["author", "archive"]],
      [{ kind: "search" }, ["search"]],
      [{ kind: "404" }, ["404"]],
    ]
    for (const [route, slugs] of cases) expect(templateSlugs(route), JSON.stringify(route)).toEqual(slugs)
  })

  it("skips a rank whose slug a template could never have", () => {
    expect(templateSlugs({ kind: "page", template: "Landing" })).toEqual(["page"])
    expect(templateSlugs({ kind: "single", postType: "Bad" })).toEqual(["single"])
    expect(templateSlugs({ kind: "page", template: "block:Bad" })).toEqual(["page"])
  })

  it("puts post's own layouts at `single`, and a type's own at `single-{type}`", () => {
    expect(templateRanks({ kind: "single", postType: "post" })).toEqual([
      { slug: "single-post", code: [] },
      { slug: "single", code: ["layouts/post/"] },
    ])
    expect(templateRanks({ kind: "single", postType: "product" })[0]).toEqual({ slug: "single-product", code: ["layouts/product/"] })
    // A type named like a page kind's folder never takes that folder's layouts.
    expect(templateRanks({ kind: "single", postType: "archive" })[0].code).toEqual([])
  })
})

describe("the rank comparison (design 3.3)", () => {
  const wins = (route: TemplateRoute, theme: string, templateSlug: string) => {
    const ranks = templateRanks(route)
    return builderWins(templateSlugs(route).indexOf(templateSlug), codeLayoutRank(ranks, theme, LAYOUTS))
  }

  it("a builder `single` replaces layouts/post, but not a theme's own layouts/product", () => {
    expect(wins({ kind: "single", postType: "post" }, "example", "single")).toBe(true)
    expect(wins({ kind: "single", postType: "product" }, "example", "single")).toBe(false)
    expect(wins({ kind: "single", postType: "product" }, "example", "single-product")).toBe(true)
  })

  it("a builder `archive` beats the default theme's term layout when the active theme has none", () => {
    expect(codeLayoutRank(templateRanks({ kind: "term", taxonomy: "category" }), "lists", LAYOUTS)).toBe(2)
    expect(wins({ kind: "term", taxonomy: "category" }, "lists", "archive")).toBe(true)
    expect(wins({ kind: "term", taxonomy: "category" }, "example", "archive")).toBe(true)
    // On the default theme its own term layout is at the more specific rank (#498: `taxonomy`'s).
    expect(codeLayoutRank(templateRanks({ kind: "term", taxonomy: "category" }), "default", LAYOUTS)).toBe(1)
    expect(wins({ kind: "term", taxonomy: "category" }, "default", "archive")).toBe(false)
    expect(wins({ kind: "term", taxonomy: "category" }, "default", "taxonomy")).toBe(true)
    expect(wins({ kind: "term", taxonomy: "category" }, "default", "taxonomy-category")).toBe(true)
  })

  it("a variant's template (#498) has no code layout of its own: a builder `single` still replaces a code theme's variant layout", () => {
    const sidebar: TemplateRoute = { kind: "single", postType: "post", variant: "sidebar" }
    expect(codeLayoutRank(templateRanks(sidebar), "default", LAYOUTS)).toBe(2)
    expect(wins(sidebar, "default", "single-sidebar")).toBe(true)
    expect(wins(sidebar, "default", "single")).toBe(true)
    expect(wins({ kind: "page", variant: "fullwidth" }, "default", "page-fullwidth")).toBe(true)
    expect(wins({ kind: "page", variant: "fullwidth" }, "default", "page")).toBe(true)
  })

  it("compares a page's template file, and the 404's error layouts", () => {
    expect(codeLayoutRank(templateRanks({ kind: "page", template: "fullwidth" }), "default", LAYOUTS)).toBe(0)
    expect(codeLayoutRank(templateRanks({ kind: "page", template: "landing" }), "default", LAYOUTS)).toBe(1)
    expect(codeLayoutRank(templateRanks({ kind: "404" }), "default", LAYOUTS)).toBe(0)
    // A theme with only a 500 layout has nothing at the 404's rank.
    expect(codeLayoutRank(templateRanks({ kind: "404" }), "lists", LAYOUTS)).toBe(-1)
    expect(builderWins(0, -1)).toBe(true)
    expect(builderWins(1, 0)).toBe(false)
  })

  it("reads glob keys", () => {
    expect(themeLayoutPath("../../themes/default/layouts/post/default.astro")).toBe("default/layouts/post/default.astro")
    expect(themeLayoutPath("../../../themes/my-themes/layouts/home/a.astro")).toBe("my-themes/layouts/home/a.astro")
  })
})

describe("parseSiteDesignResolve", () => {
  it("keeps what is well formed and leaves out the rest", () => {
    const parsed = parseSiteDesignResolve({
      theme: "default",
      template: { slug: "single", rank: 1, source: "override", title: "Single", doc: doc() },
      parts: {
        header: { source: "starter", title: "Header", doc: doc() },
        footer: { source: "bogus", doc: doc() },
        "Bad Slug": { source: "override", doc: doc() },
        sidebar: { source: "theme", doc: { blocks: [] } },
      },
      menus: {
        "5": { name: "Main", location: "", items: [{ id: 1, label: "Home", url: "/", children: [] }, { id: 2, label: "Bad", url: "javascript:alert(1)", children: [] }] },
        x: { name: "No", items: [{ id: 1, label: "Home", url: "/", children: [] }] },
      },
    })
    expect(parsed.template?.slug).toBe("single")
    expect(Object.keys(parsed.parts)).toEqual(["header"])
    expect(Object.keys(parsed.menus)).toEqual(["5"])
    expect(parsed.menus["5"].items.map((item) => item.url)).toEqual(["/"])
    expect(parseSiteDesignResolve({ template: { slug: "x", rank: 0, source: "starter", doc: doc() } }).template).toBeNull()
    expect(parseSiteDesignResolve(null)).toEqual({ theme: "", template: null, parts: {}, menus: {} })
  })
})

describe("readPublishedSiteDesign", () => {
  it("asks the resolve route for the theme and the slugs, and reads a 404 as nothing", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ theme: "default", template: null, parts: {}, menus: {} }), { status: 200 }))
    expect(await readPublishedSiteDesign("default", ["single-post", "single"], fetcher)).toEqual({ theme: "default", template: null, parts: {}, menus: {} })
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toMatch(/\/public\/site-templates\/resolve\?theme=default&slugs=single-post%2Csingle$/)
    expect(await readPublishedSiteDesign("default", ["single"], async () => new Response("{}", { status: 404 }))).toBeNull()
    await expect(readPublishedSiteDesign("default", ["single"], async () => new Response("{}", { status: 500 }))).rejects.toThrow("HTTP 500")
  })

  it("gives up after its timeout", async () => {
    const never = vi.fn(() => new Promise<Response>(() => {}))
    await expect(readPublishedSiteDesign("default", ["single"], never, 10)).rejects.toThrow("timed out")
  })
})

describe("resolveTemplate", () => {
  const design = (template: SiteDesignResolve["template"], parts: SiteDesignResolve["parts"] = {}): SiteDesignResolve => ({ theme: "example", template, parts, menus: {} })

  it("renders the builder template when it wins, with its parts, and keeps the override parts for <TemplatePart>", async () => {
    const locals = { activeTheme: "example" } as App.Locals
    const read = vi.fn(async () =>
      design({ slug: "single", rank: 1, source: "override", title: "Single", doc: doc("tpl") }, {
        header: { source: "starter", title: "Header", doc: doc("starter") },
        banner: { source: "override", title: "Banner", doc: doc("banner") },
      }),
    )
    const choice = await resolveTemplate(locals, { kind: "single", postType: "post" }, { read, layoutPaths: LAYOUTS })
    expect(read).toHaveBeenCalledWith("example", ["single-post", "single"])
    expect(choice?.template.slug).toBe("single")
    expect(Object.keys(choice!.parts).sort()).toEqual(["banner", "header"])
    expect(templatePartOverride(locals, "banner")?.doc).toEqual(doc("banner"))
    expect(templatePartOverride(locals, "header")).toBeNull()

    // The same route again in the request reads nothing more.
    await resolveTemplate(locals, { kind: "single", postType: "post" }, { read, layoutPaths: LAYOUTS })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("renders the code layout when the theme's own layout is more specific, or nothing was customized", async () => {
    const locals = { activeTheme: "example" } as App.Locals
    const read = vi.fn(async () => design({ slug: "single", rank: 1, source: "override", title: "Single", doc: doc() }))
    expect(await resolveTemplate(locals, { kind: "single", postType: "product" }, { read, layoutPaths: LAYOUTS })).toBeNull()
    expect(await resolveTemplate(locals, { kind: "search" }, { read: async () => design(null), layoutPaths: LAYOUTS })).toBeNull()
    expect(await resolveTemplate(locals, { kind: "search" }, { read: async () => null, layoutPaths: LAYOUTS })).toBeNull()
  })

  it("renders the code layout when the resolve fails, logged with the route kind only", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {})
    const locals = { activeTheme: "default" } as App.Locals
    const choice = await resolveTemplate(locals, { kind: "home" }, { read: async () => Promise.reject(new Error("HTTP 502")), layoutPaths: LAYOUTS })
    expect(choice).toBeNull()
    expect(warn).toHaveBeenCalledWith("site_template_resolve_failed", expect.objectContaining({ route_kind: "home" }))
    expect(locals.templatePartOverrides).toBeUndefined()
    expect(templatePartOverride(locals, "header")).toBeNull()
  })
})
