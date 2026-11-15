import { describe, expect, it, vi } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import {
  collectTemplateNeeds,
  loadSiteRenderContext,
  MAX_QUERIES_PER_PAGE,
  queryRequestParams,
  readQueryPosts,
  SITE_QUERY_TIMEOUT_MS,
  siteBlockNeeds,
} from "./siteRenderContext"
import { log } from "./log"
import { normalizeSiteLogo, type SiteSettings } from "./siteSettings"
import type { Menu } from "./menus"

// Filling the site blocks' context before the render (#488, design theme-builder.md 4.3).

const doc = (blocks: Record<string, { type: string; attrs: Record<string, unknown> }>): BlockDocV1 =>
  ({
    doc_version: 1,
    blocks_order: Object.keys(blocks),
    blocks: Object.fromEntries(Object.entries(blocks).map(([id, b]) => [id, { id, version: 1, ...b }])),
  }) as unknown as BlockDocV1

const template = doc({
  "nav-000001": { type: "navigation", attrs: { location: "primary" } },
  "nav-000002": { type: "navigation", attrs: { location: "primary", layout: "column" } },
  "nav-000003": { type: "navigation", attrs: { menuId: 7 } },
  "part-00001": { type: "template_part", attrs: { slug: "header" } },
  "para-00001": { type: "paragraph", attrs: { text: "x" } },
})
const header = doc({ "nav-000004": { type: "navigation", attrs: { location: "secondary" } }, "bad-000001": { type: "navigation", attrs: { location: "../x" } } })

const settings: SiteSettings = {
  title: "GoLive Blog",
  tagline: "Notes",
  postsPerPage: 10,
  urlStructure: "slug",
  allowSignup: false,
  frontPageId: null,
  allowedEmbeds: [],
  logo: { id: 7, media: { media_path: "/uploads/media/logo.png", width: 64, height: 64 }, alt: "Leaf" },
  language: "en-US",
  timeZone: "UTC",
  dateFormat: "month_day_year",
} as SiteSettings

const menu = (name: string): Menu => ({ name, location: name.toLowerCase(), items: [{ id: 1, label: "Home", url: "/", children: [] }, { id: 2, label: "About", url: "/about", children: [] }] })

describe("siteBlockNeeds", () => {
  it("names each location, menu id and part once, valid ones only", () => {
    expect(siteBlockNeeds([template, header, null])).toEqual({ locations: ["primary", "secondary"], menuIds: [7], parts: ["header"] })
    expect(siteBlockNeeds([doc({ "para-00001": { type: "paragraph", attrs: {} } })])).toEqual({ locations: [], menuIds: [], parts: [] })
  })
})

describe("loadSiteRenderContext", () => {
  it("reads the settings once per request, each location once, and marks the current page", async () => {
    const locals = { siteSettings: Promise.resolve(settings) } as unknown as App.Locals
    const readMenu = vi.fn(async (location: string) => (location === "primary" ? menu("Primary") : null))
    const site = await loadSiteRenderContext(locals, {
      docs: [template],
      parts: { header },
      menusById: { "7": menu("Company") },
      currentPath: "/about",
      readMenu,
    })
    expect(readMenu.mock.calls.map(([location]) => location).sort()).toEqual(["primary", "secondary"])
    expect(site).toMatchObject({ inTemplate: true, kind: "template", site: { title: "GoLive Blog", tagline: "Notes" }, currentPath: "/about" })
    expect(site.logo).toEqual({ media: settings.logo!.media, alt: "Leaf" })
    expect(site.menusByLocation.secondary).toBeNull()
    expect(site.menusByLocation.primary!.items.find((link) => link.url === "/about")!.current).toBe(true)
    expect(site.menusById["7"]!.name).toBe("Company")
    expect(site.parts.header).toBe(header)
  })

  it("a menu read that throws fails soft: that location has no menu", async () => {
    const locals = { siteSettings: Promise.resolve({ ...settings, logo: null }) } as unknown as App.Locals
    const site = await loadSiteRenderContext(locals, { docs: [template], readMenu: async () => Promise.reject(new Error("down")) })
    expect(site.menusByLocation.primary).toBeNull()
    expect(site.logo).toBeNull()
  })
})

describe("normalizeSiteLogo", () => {
  it("reads the API's site_logo, or null", () => {
    expect(normalizeSiteLogo({ id: 7, media_path: "/uploads/media/l.png", width: 512.4, height: 0, alt: " Leaf ", variants: {} })).toEqual({
      id: 7,
      media: { media_path: "/uploads/media/l.png", width: 512, height: 0, variants: {} },
      alt: "Leaf",
    })
    for (const value of [null, undefined, "x", {}, { id: 0, media_path: "/x" }, { id: 7, media_path: "" }, { id: "7", media_path: "/x" }]) {
      expect(normalizeSiteLogo(value), JSON.stringify(value)).toBeNull()
    }
  })
})

// #489: the query blocks' posts, filled before the render (design 4.3).
const query = (id: string, attrs: Record<string, unknown> = {}) => ({ [id]: { type: "query", attrs } })
const listOf = (title: string) => ({ items: [{ post: { id: 1, title } as never, href: "/post/x", image: null }], page: 1, totalPages: 1, basePath: null })
const quiet = () => vi.spyOn(log, "warn").mockImplementation(() => undefined)

describe("collectTemplateNeeds (#489)", () => {
  it("lists the query blocks in reading order, a part's where the template places it, each part once, then the logo", () => {
    const sidebar = doc({ ...query("q-part-0001"), "logo-00001": { type: "site_logo", attrs: {} } })
    const page = doc({
      ...query("q-tmpl-0001", { inherit: true }),
      "part-00001": { type: "template_part", attrs: { slug: "sidebar" } },
      "part-00002": { type: "template_part", attrs: { slug: "sidebar" } },
      ...query("q-tmpl-0002", { perPage: 3 }),
    })
    const needs = collectTemplateNeeds(page, { sidebar, unused: doc(query("q-unused-01")) })
    expect(needs.queries.map((q) => q.key)).toEqual(["q-tmpl-0001", "part:sidebar:q-part-0001", "q-tmpl-0002", "part:unused:q-unused-01"])
    expect(needs.queries[0].attrs).toEqual({ inherit: true })
    expect(needs.queries[2].attrs).toEqual({ perPage: 3 })
    expect(needs.skippedQueries).toBe(0)
    expect(needs.logo).toBe(true)
    expect(needs.parts).toEqual(["sidebar"])
  })

  it("keeps the first four, counting parts", () => {
    const header = doc({ ...query("q-head-0001"), ...query("q-head-0002") })
    const page = doc({ ...query("q-tmpl-0001"), "part-00001": { type: "template_part", attrs: { slug: "header" } }, ...query("q-tmpl-0002"), ...query("q-tmpl-0003") })
    const needs = collectTemplateNeeds(page, { header })
    expect(needs.queries.map((q) => q.key)).toEqual(["q-tmpl-0001", "part:header:q-head-0001", "part:header:q-head-0002", "q-tmpl-0002"])
    expect(needs.skippedQueries).toBe(1)
    expect(MAX_QUERIES_PER_PAGE).toBe(4)
  })
})

describe("the query blocks' data (#489, design 4.3)", () => {
  const locals = () => ({ siteSettings: Promise.resolve({ ...settings, urlStructure: "slug" }) }) as unknown as App.Locals

  it("5 queries on a page: 4 are read, the fifth renders nothing, logged once", async () => {
    const warn = quiet()
    const readQuery = vi.fn(async () => listOf("A post"))
    const five = doc({ ...query("q-00000001"), ...query("q-00000002"), ...query("q-00000003"), ...query("q-00000004"), ...query("q-00000005") })
    const site = await loadSiteRenderContext(locals(), { docs: [five], readQuery, siteUrl: "https://blog.example" })
    expect(readQuery).toHaveBeenCalledTimes(4)
    expect(Object.keys(site.queries!)).toEqual(["q-00000001", "q-00000002", "q-00000003", "q-00000004"])
    expect(warn.mock.calls.filter(([msg]) => msg === "site_block_query_limit")).toEqual([["site_block_query_limit", { limit: 4, count: 5 }]])
    warn.mockRestore()
  })

  it("an inheriting query reuses the route's list: no second fetch", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch")
    const readQuery = vi.fn()
    const list = { items: [], page: 3, totalPages: 7, basePath: "/category/guides" }
    const site = await loadSiteRenderContext(locals(), { docs: [doc(query("q-inherit1", { inherit: true }))], route: { kind: "term", list }, readQuery, readMenu: async () => null })
    expect(site.queries!["q-inherit1"]).toBe(list)
    expect(readQuery).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    fetcher.mockRestore()
  })

  it("a failed query renders nothing, the others render, and it is logged once with the block type, never the query", async () => {
    const warn = quiet()
    const readQuery = vi.fn(async (attrs: { perPage?: number }) => {
      if (attrs.perPage) throw new Error("HTTP 500")
      return listOf("Fine")
    })
    const page = doc({ ...query("q-fails-001", { perPage: 3 }), ...query("q-fails-002", { perPage: 4 }), ...query("q-works-001") })
    const site = await loadSiteRenderContext(locals(), { docs: [page], readQuery })
    expect(site.queries).toMatchObject({ "q-fails-001": null, "q-fails-002": null, "q-works-001": listOf("Fine") })
    const failed = warn.mock.calls.filter(([msg]) => msg === "site_block_data_failed")
    expect(failed).toHaveLength(1)
    expect(failed[0][1]).toMatchObject({ block_type: "query", count: 2 })
    expect(JSON.stringify(failed[0][1])).not.toContain("per_page")
    warn.mockRestore()
  })

  it("an inheriting query on a route without a list has no posts (it renders nothing), and nothing is read", async () => {
    const readQuery = vi.fn()
    const site = await loadSiteRenderContext(locals(), { docs: [doc(query("q-inherit1", { inherit: true }))], route: { kind: "single" }, readQuery })
    expect(site.queries!["q-inherit1"]).toBeNull()
    expect(readQuery).not.toHaveBeenCalled()
  })
})

describe("queryRequestParams (#489)", () => {
  it("maps a query's attrs one to one onto the route's parameters, nothing else", () => {
    expect(queryRequestParams({}).toString()).toBe("per_page=10")
    expect(queryRequestParams({ postType: "product", perPage: 3, orderBy: "title", order: "asc", taxonomy: "category", termIds: [3, 7], authorId: 12, inherit: true }).toString()).toBe(
      "per_page=3&order_by=title&order=asc&terms=3%2C7&author_id=12"
    )
  })
})

describe("readQueryPosts (#489)", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

  it("reads one page of /public/posts/type/:type with the query's filters, the rows as list items", async () => {
    const fetcher = vi.fn(async () => json(200, { posts: [{ id: 4, title: "Four", slug: "four", post_type: "product", meta: { _thumbnail_url: "/uploads/media/four.jpg" } }] }))
    const list = await readQueryPosts({ postType: "product", perPage: 3 }, { structure: "slug", siteUrl: "https://blog.example" }, fetcher as never)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/public\/posts\/type\/product\?per_page=3$/)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(list).toEqual({ items: [{ post: expect.objectContaining({ id: 4 }), href: "/product/four", image: "https://blog.example/uploads/media/four.jpg" }], page: 1, totalPages: 1, basePath: null })
  })

  it("a type the site doesn't serve is an empty list; any other answer throws", async () => {
    await expect(readQueryPosts({}, { structure: "slug", siteUrl: "" }, (async () => json(404, {})) as never)).resolves.toMatchObject({ items: [] })
    await expect(readQueryPosts({}, { structure: "slug", siteUrl: "" }, (async () => json(500, {})) as never)).rejects.toThrow("HTTP 500")
  })

  it("gives up after its timeout, even on a request that never answers", async () => {
    const hung = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))))
    const started = Date.now()
    await expect(readQueryPosts({}, { structure: "slug", siteUrl: "" }, hung as never, 50)).rejects.toThrow(/timed out|aborted/)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(SITE_QUERY_TIMEOUT_MS).toBe(2000)
  })
})