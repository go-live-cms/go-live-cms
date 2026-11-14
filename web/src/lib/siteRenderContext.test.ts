import { describe, expect, it, vi } from "vitest"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { loadSiteRenderContext, siteBlockNeeds } from "./siteRenderContext"
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