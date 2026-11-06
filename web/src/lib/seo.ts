// SEO helpers for the public site (#137): the site URL, post URLs, meta
// descriptions, robots.txt and sitemap.xml. Pure functions (no Astro, no fetch)
// so they are unit-tested in seo.test.ts; the routes and SeoHead.astro wire them up.

import type { Post } from "../../gl-admin/lib/api/types"
import type { BlockDocV1 } from "../../gl-admin/lib/blocks-spec"
// The table only (no Zod): seo.ts stays a light import.
import { blocksInReadingOrder } from "../../gl-admin/lib/blocks-spec/nesting"

// Settings › General's post URL structure (api/settings_bindings.go). "category" (#331) is
// /{category-slug}/{post-slug} for posts of type "post".
export type UrlStructure = "id" | "slug" | "category"

// What a page hands SeoHead.astro (and theme base layouts) beyond title/description.
export interface SeoMeta {
  canonical?: string
  // Paged lists (#349): the previous and next page, as <link rel="prev"/"next">.
  prev?: string
  next?: string
  image?: string | null
  // The image's size and alt text, for og:image:width/height/alt (#357).
  imageWidth?: number
  imageHeight?: number
  imageAlt?: string
  type?: "website" | "article"
  // A page that isn't public (sign-in, errors, search): "noindex, nofollow", no
  // canonical, and no site settings lookup.
  noindex?: boolean
  // A public page its author hid from search engines (#357, a post's "Hide from
  // search engines"): `robots` noindex and nothing else, it renders like any page.
  hideFromSearch?: boolean
  siteName?: string
  publishedTime?: string
  modifiedTime?: string
  // schema.org JSON-LD for the page (a post's Article, articleJsonLd).
  jsonLd?: Record<string, unknown>
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
  return value === "slug" || value === "category" ? value : "id"
}

// Public path of a post, matching src/pages/[post_type]/[id].astro (and the API's
// postHref, api/category_urls.go): the slug when the site uses slug URLs and the post
// has one, else the id. An all-digit slug (older rows; the API no longer makes them)
// would be read as an id there, so it falls back to the id too. Under the category
// structure (#331) a post of type "post" with a category (the API's category_slug: the
// published one on /public rows) is /{category}/{slug}; anything else is as for slugs.
export function postPath(
  post: Pick<Post, "id" | "slug" | "post_type"> & { category_slug?: string },
  structure: UrlStructure,
): string {
  const type = post.post_type || "post"
  const useSlug = structure !== "id" && !!post.slug && !/^\d+$/.test(post.slug)
  const segment = useSlug ? post.slug! : String(post.id)
  const first = structure === "category" && useSlug && type === "post" && post.category_slug ? post.category_slug : type
  return `/${encodeURIComponent(first)}/${encodeURIComponent(segment)}`
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

// Post SEO (#357) -----------------------------------------------------------------

// The admin's soft limits (never enforced): what search results usually show.
export const SEO_TITLE_GUIDE = 60
export const SEO_DESCRIPTION_GUIDE = 160

// A published post's SEO, as /public/posts/:id answers it: "" means "use the
// post's own" (title; excerpt, then first paragraph), and the image is already
// the social image or the featured image, as its 1200 x 630 crop when it has one.
export interface PostSeo {
  title: string
  description: string
  noindex: boolean
  canonical_url: string
  image: { url: string; width: number; height: number; alt: string } | null
}

// <title> (#357, decision 2): "<SEO title or post title> · <site name>". The
// 60-character guide counts the first part only.
export function pageTitle(title: string, siteName?: string | null): string {
  const name = (siteName || "").trim()
  const own = title.trim()
  if (!own) return name
  return name && name !== own ? `${own} · ${name}` : own
}

// The home page's <title>: the site name, with the tagline (#330) when it has one.
export function homeTitle(siteName: string, tagline?: string | null): string {
  const line = (tagline || "").trim()
  return line ? `${siteName} · ${line}` : siteName
}

// The plain text of a block's PM JSON: its text runs, in order.
function pmText(node: unknown): string {
  if (!node || typeof node !== "object") return ""
  const { text, content } = node as { text?: unknown; content?: unknown }
  if (typeof text === "string") return text
  return Array.isArray(content) ? content.map(pmText).join("") : ""
}

// The text of a post's first non-empty paragraph (in reading order, #414), what themes show
// when the post has no excerpt (#357). "" when it has none.
export function firstParagraphText(doc: BlockDocV1 | null | undefined): string {
  if (!doc?.blocks || !Array.isArray(doc.blocks_order)) return ""
  // Reading order at any depth: a post that opens with a group finds its paragraph (#414).
  for (const id of blocksInReadingOrder(doc)) {
    const block = doc.blocks[id]
    if (block?.type !== "paragraph") continue
    const attrs = (block.attrs || {}) as { text?: unknown; pm?: unknown }
    const text = (typeof attrs.text === "string" && attrs.text.trim() ? attrs.text : pmText(attrs.pm)).replace(/\s+/g, " ").trim()
    if (text) return text
  }
  return ""
}

// A post's excerpt for lists and previews (#357: the excerpt is optional): the
// excerpt (cut at maxLength), else its first paragraph cut at a word before 160
// characters. On the post's own page a theme shows only a real excerpt as its
// dek: the first paragraph is right below it.
export function postExcerpt(post: Pick<Post, "description" | "published_blocks">, maxLength = SEO_DESCRIPTION_GUIDE): string {
  return metaDescription(post.description, maxLength) || metaDescription(firstParagraphText(post.published_blocks))
}

// A post's meta description: the SEO description, else the excerpt, else the first
// paragraph. All three plain text, cut at a word before 160 characters.
export function postDescription(post: Pick<Post, "description" | "published_blocks">, seo?: Pick<PostSeo, "description"> | null): string {
  return metaDescription(seo?.description) || postExcerpt(post)
}

// The canonical URL of a post: its SEO canonical URL when set (an absolute
// http(s) URL, checked by the API; checked again here), else its own path.
export function postCanonical(ownPath: string, seo?: Pick<PostSeo, "canonical_url"> | null): string {
  const custom = seo?.canonical_url?.trim()
  if (custom) {
    try {
      const url = new URL(custom)
      if ((url.protocol === "http:" || url.protocol === "https:") && !/\s/.test(custom)) return url.toString()
    } catch {
      // Not a URL: the post's own address.
    }
  }
  return ownPath
}

// schema.org Article for a post page (#357): headline, dates, authors and image.
export function articleJsonLd(input: {
  headline: string
  description?: string
  url: string
  image?: string
  datePublished?: string
  dateModified?: string
  authors?: { name: string; url?: string }[]
  publisher?: string
}): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.headline,
    mainEntityOfPage: input.url,
  }
  if (input.description) ld.description = input.description
  if (input.image) ld.image = [input.image]
  if (input.datePublished) ld.datePublished = input.datePublished
  if (input.dateModified) ld.dateModified = input.dateModified
  const authors = (input.authors || []).filter((a) => a.name)
  if (authors.length > 0) {
    ld.author = authors.map((a) => ({ "@type": "Person", name: a.name, ...(a.url ? { url: a.url } : {}) }))
  }
  if (input.publisher) ld.publisher = { "@type": "Organization", name: input.publisher }
  return ld
}

// JSON-LD as the text of a <script type="application/ld+json">: "<" escaped, so
// no value can close the element.
export function jsonLdText(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, "\\u003c")
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
const ACCOUNT_PATHS = ["/login", "/forgot-password", "/reset-password", "/accept-invite", "/confirm-email", "/register", "/verify-email"]

// Pages that must not be indexed even when a crawler ignores robots.txt: the
// admin SPA, the account pages, search results (#145; never in the sitemap
// either) and the old demo pages. Error responses are handled by status in
// shouldNoindex.
const NOINDEX_PREFIXES = ["/gl-admin", ...ACCOUNT_PATHS, "/search", "/users", "/taxonomies", "/test-theme"]

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
  // Every term archive with a post (#348) and that post's newest change. Optional too.
  getTerms?(): Promise<{ taxonomy: string; slug: string; last_modified?: string }[]>
  // The front page's id (#336): it lives at /, which the sitemap always lists, so its
  // own URL (whose canonical is /) is left out. Optional; null = none.
  getFrontPageId?(): Promise<number | null>
}

// An author's page (#350).
export function authorPath(username: string): string {
  return `/author/${encodeURIComponent(username)}`
}

// A term's archive (#348), /{taxonomy}/{slug}: the URL the API's menus build too.
export function termPath(taxonomy: string, slug: string): string {
  return `/${encodeURIComponent(taxonomy)}/${encodeURIComponent(slug)}`
}

const PAGE_SIZE = 100 // the API caps limit at 100
// The sitemap protocol allows 50,000 URLs per file. Beyond that this needs a
// sitemap index; stop rather than emit an invalid file.
export const MAX_SITEMAP_URLS = 50_000

// Sitemap entries: the homepage, each public type's archive that has posts,
// and every published post at its canonical URL with lastmod from changed_at.
// Only public types are listed, so admin routes never appear, and only
// published posts (drafts, including unpublished posts, and archived posts are
// skipped even if the API returned them). A post hidden from search engines
// (#357: its published noindex) is left out. Term archives (#348), then author
// pages (#350), come last.
export async function collectSitemapEntries(siteUrl: string, source: SitemapSource): Promise<SitemapEntry[]> {
  // Independent of the posts walk, so they run alongside it.
  const authorsPromise = source.getAuthors?.() ?? Promise.resolve([])
  const termsPromise = source.getTerms?.() ?? Promise.resolve([])
  // If the posts walk fails first, its error is the one reported; don't leave these
  // rejections unhandled meanwhile (awaiting them below still rethrows).
  authorsPromise.catch(() => {})
  termsPromise.catch(() => {})
  const [types, structure, frontPageId] = await Promise.all([
    source.getPublicPostTypeNames(),
    source.getUrlStructure(),
    source.getFrontPageId?.() ?? Promise.resolve(null),
  ])
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
          if (post.noindex) continue
          if (type === "page" && frontPageId != null && post.id === frontPageId) continue
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

  const terms = await termsPromise
  const termEntries = terms.map((t) => ({ loc: absoluteUrl(siteUrl, termPath(t.taxonomy, t.slug)), lastmod: toW3cDate(t.last_modified) }))
  const authors = await authorsPromise
  const authorEntries = authors.map((a) => ({ loc: absoluteUrl(siteUrl, authorPath(a.username)), lastmod: toW3cDate(a.last_modified) }))

  return [{ loc: absoluteUrl(siteUrl, "/") }, ...perType.flat(), ...termEntries, ...authorEntries].slice(0, MAX_SITEMAP_URLS)
}
