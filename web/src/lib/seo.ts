// SEO helpers for the public site (#137): the site URL, post URLs, meta
// descriptions, robots.txt and sitemap.xml. Pure functions (no Astro, no fetch)
// so they are unit-tested in seo.test.ts; the routes and SeoHead.astro wire them up.

import type { Post } from "../../gl-admin/lib/api/types"

export type UrlStructure = "id" | "slug"

// What a page hands SeoHead.astro (and theme base layouts) beyond title/description.
export interface SeoMeta {
  canonical?: string
  image?: string | null
  type?: "website" | "article"
  noindex?: boolean
  siteName?: string
  publishedTime?: string
  modifiedTime?: string
}

export interface SitemapEntry {
  loc: string
  lastmod?: string
}

// Public origin of the site, without a trailing slash. SITE_URL (read from
// process.env at runtime, like SERVER_API_URL, so the value set in compose
// applies to a prebuilt image) wins; behind a proxy the request origin can be
// an internal host. Without it, fall back to the request's own origin.
export function resolveSiteUrl(
  requestUrl: URL | string,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): string {
  const configured = env.SITE_URL?.trim()
  if (configured) {
    try {
      const url = new URL(configured)
      if (url.protocol === "http:" || url.protocol === "https:") {
        return `${url.origin}${url.pathname}`.replace(/\/+$/, "")
      }
    } catch {
      // Invalid SITE_URL: fall through to the request origin.
    }
  }
  return new URL(requestUrl).origin
}

export function normalizeUrlStructure(value: unknown): UrlStructure {
  return value === "slug" ? "slug" : "id"
}

// Public path of a post, matching src/pages/[post_type]/[id].astro: the slug
// when the site uses slug URLs and the post has one, else the id.
export function postPath(post: Pick<Post, "id" | "slug" | "post_type">, structure: UrlStructure): string {
  const type = post.post_type || "post"
  const segment = structure === "slug" && post.slug ? post.slug : String(post.id)
  return `/${encodeURIComponent(type)}/${encodeURIComponent(segment)}`
}

export function absoluteUrl(siteUrl: string, path: string): string {
  return new URL(path, `${siteUrl}/`).toString()
}

// Featured images are stored as whatever URL the admin had (often
// http://localhost:8080/uploads/... or http://api:8080/uploads/...). The web
// origin serves /uploads itself (Vite proxy in dev, apiProxy.ts in prod), so
// rewrite those onto the public site URL; leave other absolute URLs (a CDN) alone.
export function publicImageUrl(siteUrl: string, image: string | null | undefined): string | undefined {
  if (!image) return undefined
  try {
    const url = new URL(image, `${siteUrl}/`)
    if (url.pathname.startsWith("/uploads/")) {
      return absoluteUrl(siteUrl, `${url.pathname}${url.search}`)
    }
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " }

// Plain-text meta description from a post excerpt that may contain HTML:
// tags stripped, whitespace collapsed, cut at a word boundary.
export function metaDescription(text: string | null | undefined, maxLength = 160): string {
  const plain = (text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => ENTITIES[name])
    .replace(/\s+/g, " ")
    .trim()
  if (plain.length <= maxLength) return plain
  const cut = plain.slice(0, maxLength - 1)
  const lastSpace = cut.lastIndexOf(" ")
  return `${(lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!?-]+$/, "")}…`
}

// Pages that must not be indexed even when a crawler ignores robots.txt: the
// admin SPA, the login page and the old demo pages. Error responses are
// handled by status in shouldNoindex.
const NOINDEX_PREFIXES = ["/gl-admin", "/login", "/users", "/taxonomies", "/test-theme"]

export function isNonPublicPath(pathname: string): boolean {
  return NOINDEX_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

// Whether a response should carry X-Robots-Tag: noindex (set by the middleware,
// so it also covers theme error layouts that don't emit the meta tag).
export function shouldNoindex(pathname: string, status: number): boolean {
  return status >= 400 || isNonPublicPath(pathname)
}

export function buildRobotsTxt(siteUrl: string): string {
  return [
    "User-agent: *",
    "Disallow: /gl-admin",
    "Disallow: /login",
    "Disallow: /api/",
    "",
    `Sitemap: ${absoluteUrl(siteUrl, "/sitemap.xml")}`,
    "",
  ].join("\n")
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

export function toW3cDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  // Before 1970 is Go's zero time (0001-01-01, e.g. seeded rows), not a real date.
  return Number.isNaN(date.getTime()) || date.getTime() <= 0 ? undefined : date.toISOString()
}

// lastmod of a post: changed_at, or created_at when changed_at is unset/zero.
export function postLastmod(post: Pick<Post, "changed_at" | "created_at">): string | undefined {
  return toW3cDate(post.changed_at) ?? toW3cDate(post.created_at)
}

export function buildSitemapXml(entries: SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const lastmod = toW3cDate(entry.lastmod)
    return [
      "  <url>",
      `    <loc>${escapeXml(entry.loc)}</loc>`,
      ...(lastmod ? [`    <lastmod>${lastmod}</lastmod>`] : []),
      "  </url>",
    ].join("\n")
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n")
}

export interface SitemapSource {
  getPublicPostTypeNames(): Promise<string[]>
  getUrlStructure(): Promise<UrlStructure>
  // One page of published posts of a type, newest first.
  getPublishedPosts(type: string, limit: number, offset: number): Promise<Post[]>
}

const PAGE_SIZE = 100 // the API caps limit at 100
// The sitemap protocol allows 50,000 URLs per file. Beyond that this needs a
// sitemap index; stop rather than emit an invalid file.
export const MAX_SITEMAP_URLS = 50_000

// Sitemap entries: the homepage, each public type's archive that has posts,
// and every published post at its canonical URL with lastmod from changed_at.
// Only public types are listed, so admin routes never appear, and only
// published posts (drafts, including unpublished posts, and archived posts are
// skipped even if the API returned them).
export async function collectSitemapEntries(siteUrl: string, source: SitemapSource): Promise<SitemapEntry[]> {
  const [types, structure] = await Promise.all([source.getPublicPostTypeNames(), source.getUrlStructure()])
  const entries: SitemapEntry[] = [{ loc: absoluteUrl(siteUrl, "/") }]

  for (const type of types) {
    const postEntries: SitemapEntry[] = []
    let newest: string | undefined
    for (let offset = 0; entries.length + postEntries.length < MAX_SITEMAP_URLS; offset += PAGE_SIZE) {
      const page = await source.getPublishedPosts(type, PAGE_SIZE, offset)
      for (const post of page) {
        if (post.post_status !== "published" || (post.post_type && post.post_type !== type)) continue
        const lastmod = postLastmod(post)
        if (lastmod && (!newest || lastmod > newest)) newest = lastmod
        postEntries.push({ loc: absoluteUrl(siteUrl, postPath({ ...post, post_type: type }, structure)), lastmod })
      }
      if (page.length < PAGE_SIZE) break
    }
    if (postEntries.length > 0) {
      entries.push({ loc: absoluteUrl(siteUrl, `/${encodeURIComponent(type)}`), lastmod: newest }, ...postEntries)
    }
  }

  return entries.slice(0, MAX_SITEMAP_URLS)
}
