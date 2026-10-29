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

type Env = Record<string, string | undefined>
const processEnv = (): Env => (typeof process !== "undefined" ? process.env : {})

// SITE_URL as a normalized origin (+ optional base path), or undefined when
// unset or not an http(s) URL.
function configuredSiteUrl(env: Env): string | undefined {
  const configured = env.SITE_URL?.trim()
  if (!configured) return undefined
  try {
    const url = new URL(configured)
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.origin}${url.pathname}`.replace(/\/+$/, "")
    }
  } catch {
    // Invalid SITE_URL: treated as unset.
  }
  return undefined
}

// Whether SITE_URL is set. Without it the site URL comes from the request's
// Host header, which the client controls, so responses that embed it must not
// go into shared caches (see cacheControl).
export function isSiteUrlConfigured(env: Env = processEnv()): boolean {
  return configuredSiteUrl(env) !== undefined
}

// Public origin of the site, without a trailing slash. SITE_URL (read from
// process.env at runtime, like SERVER_API_URL, so the value set in compose
// applies to a prebuilt image) wins; behind a proxy the request origin can be
// an internal host. Without it, fall back to the request's own origin.
export function resolveSiteUrl(requestUrl: URL | string, env: Env = processEnv()): string {
  return configuredSiteUrl(env) ?? new URL(requestUrl).origin
}

// Cache-Control for responses whose body contains the site URL (robots.txt,
// sitemap.xml): public only when that URL is SITE_URL, never one taken from a
// spoofable Host header (cache poisoning).
export function cacheControl(maxAgeSeconds: number, env: Env = processEnv()): string {
  return isSiteUrlConfigured(env) ? `public, max-age=${maxAgeSeconds}` : "private, no-store"
}

export function normalizeUrlStructure(value: unknown): UrlStructure {
  return value === "slug" ? "slug" : "id"
}

// Public path of a post, matching src/pages/[post_type]/[id].astro: the slug
// when the site uses slug URLs and the post has one, else the id. An all-digit
// slug (older rows; the API no longer makes them) would be read as an id there,
// so it falls back to the id too.
export function postPath(post: Pick<Post, "id" | "slug" | "post_type">, structure: UrlStructure): string {
  const type = post.post_type || "post"
  const useSlug = structure === "slug" && !!post.slug && !/^\d+$/.test(post.slug)
  const segment = useSlug ? post.slug! : String(post.id)
  return `/${encodeURIComponent(type)}/${encodeURIComponent(segment)}`
}

export function absoluteUrl(siteUrl: string, path: string): string {
  return new URL(path, `${siteUrl}/`).toString()
}

// Hosts an admin-stored media URL may point at that are really this site's own
// /uploads: local dev hosts, the compose `api` service, and SERVER_API_URL's
// host. (Not PUBLIC_API_URL: server code doesn't read it, docs/operations/deploy.md.)
function ownMediaHosts(env: Env): Set<string> {
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]", "api"])
  try {
    if (env.SERVER_API_URL) hosts.add(new URL(env.SERVER_API_URL).hostname)
  } catch {
    // Not a URL: nothing to add.
  }
  return hosts
}

// Featured images are stored as whatever URL the admin had (often
// http://localhost:8080/uploads/... or http://api:8080/uploads/...). The web
// origin serves /uploads itself (Vite proxy in dev, apiProxy.ts in prod), so
// rewrite relative URLs and those hosts onto the public site URL; leave other
// absolute URLs (a CDN, even one with an /uploads/ path) alone.
export function publicImageUrl(
  siteUrl: string,
  image: string | null | undefined,
  env: Env = processEnv(),
): string | undefined {
  if (!image) return undefined
  try {
    const url = new URL(image, `${siteUrl}/`)
    const ownHost = !/^[a-z][a-z\d+.-]*:/i.test(image) || ownMediaHosts(env).has(url.hostname)
    if (ownHost && url.pathname.startsWith("/uploads/")) {
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
    .replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|#39|apos|nbsp));/gi, (match, dec, hex, name) => {
      if (name) return ENTITIES[name.toLowerCase()] ?? match
      const code = dec ? Number(dec) : parseInt(hex, 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    })
    .replace(/\s+/g, " ")
    .trim()
  if (plain.length <= maxLength) return plain
  const cut = plain.slice(0, maxLength - 1)
  const lastSpace = cut.lastIndexOf(" ")
  return `${(lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!?-]+$/, "")}…`
}

// The signed-out account pages (#148): they handle credentials and emailed tokens.
const ACCOUNT_PATHS = ["/login", "/forgot-password", "/reset-password", "/accept-invite"]

// Pages that must not be indexed even when a crawler ignores robots.txt: the
// admin SPA, the account pages and the old demo pages. Error responses are
// handled by status in shouldNoindex.
const NOINDEX_PREFIXES = ["/gl-admin", ...ACCOUNT_PATHS, "/users", "/taxonomies", "/test-theme"]

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
    ...ACCOUNT_PATHS.map((path) => `Disallow: ${path}`),
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
  // One page of published posts of a type, in a stable order (id ascending)
  // so offsets don't shift when a post is published mid-walk.
  getPublishedPosts(type: string, limit: number, offset: number): Promise<Post[]>
  // Every author with a page (#350) and their newest post's time. Optional: a source
  // without it lists no author pages.
  getAuthors?(): Promise<{ username: string; last_modified?: string }[]>
}

// An author's page (#350).
export function authorPath(username: string): string {
  return `/author/${encodeURIComponent(username)}`
}

const PAGE_SIZE = 100 // the API caps limit at 100
// The sitemap protocol allows 50,000 URLs per file. Beyond that this needs a
// sitemap index; stop rather than emit an invalid file.
export const MAX_SITEMAP_URLS = 50_000

// Sitemap entries: the homepage, each public type's archive that has posts,
// and every published post at its canonical URL with lastmod from changed_at.
// Only public types are listed, so admin routes never appear, and only
// published posts (drafts, including unpublished posts, and archived posts are
// skipped even if the API returned them). Author pages (#350) come last.
export async function collectSitemapEntries(siteUrl: string, source: SitemapSource): Promise<SitemapEntry[]> {
  const [types, structure] = await Promise.all([source.getPublicPostTypeNames(), source.getUrlStructure()])
  // Types are fetched in parallel (each still pages sequentially), then joined
  // in the API's type order.
  const perType = await Promise.all(
    types.map(async (type) => {
      const postEntries: SitemapEntry[] = []
      let newest: string | undefined
      for (let offset = 0; postEntries.length < MAX_SITEMAP_URLS; offset += PAGE_SIZE) {
        const page = await source.getPublishedPosts(type, PAGE_SIZE, offset)
        for (const post of page) {
          if (post.post_status !== "published" || (post.post_type && post.post_type !== type)) continue
          const lastmod = postLastmod(post)
          if (lastmod && (!newest || lastmod > newest)) newest = lastmod
          postEntries.push({ loc: absoluteUrl(siteUrl, postPath({ ...post, post_type: type }, structure)), lastmod })
        }
        if (page.length < PAGE_SIZE) break
      }
      return postEntries.length > 0
        ? [{ loc: absoluteUrl(siteUrl, `/${encodeURIComponent(type)}`), lastmod: newest }, ...postEntries]
        : []
    }),
  )

  const authors = (await source.getAuthors?.()) ?? []
  const authorEntries = authors.map((a) => ({ loc: absoluteUrl(siteUrl, authorPath(a.username)), lastmod: toW3cDate(a.last_modified) }))

  return [{ loc: absoluteUrl(siteUrl, "/") }, ...perType.flat(), ...authorEntries].slice(0, MAX_SITEMAP_URLS)
}
