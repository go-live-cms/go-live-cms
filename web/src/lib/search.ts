/**
 * The public search page, /search?q= (#145): data from the API's /public/search
 * (Postgres full-text search over published posts and pages, best match first,
 * posts_per_page at a time), URLs in #349's clean form with the query kept:
 * /search?q=alt, /search/page/2/?q=alt&type=post. Tested in search.test.ts.
 *
 * The query is never put in markup as HTML: pages render it as text (Astro escapes
 * it). The highlighted title and excerpt are the only HTML from the API, escaped
 * there with <mark> added; safeHighlight checks that again before set:html.
 */
import type { Post } from "@gl-admin/lib/api/types"
import { SERVER_API_URL, SERVER_MEDIA_URL } from "@gl-admin/lib/server-api-url"
import { getPostsByType } from "./api"
import { pagePath, type Pagination } from "./pagination"
import { normalizeUrlStructure, postPath, type UrlStructure } from "./seo"
import { getSiteSettings } from "./siteSettings"

export const SEARCH_PATH = "/search"

export type SearchType = "all" | "post" | "page"

export interface SearchCounts {
  all: number
  post: number
  page: number
}

// One hit as the API sends it (api/search_handlers_read.go).
export interface SearchHit {
  id: number
  title: string
  slug: string
  post_type: string
  created_at: string
  changed_at: string
  title_html: string
  excerpt_html: string
}

export interface SearchResult {
  hit: SearchHit
  href: string
  // "Post · Oct 15, 2026" / "Page · Updated Sep 30, 2026"
  typeLabel: string
  dateLabel: string
  titleHtml: string
  excerptHtml: string
}

export interface SearchChip {
  type: SearchType
  label: string
  count: number
  href: string
  current: boolean
}

export interface SearchLink {
  label: string
  href: string
}

export interface SearchPageData {
  query: string
  type: SearchType
  results: SearchResult[]
  counts: SearchCounts
  chips: SearchChip[]
  total: number
  page: number
  totalPages: number
  // The pager's base path and the query string every page link keeps.
  basePath: string
  pageQuery: string
  siteTitle: string
  // The empty state's suggestions; filled only when nothing matched.
  topics: SearchLink[]
  recent: SearchLink[]
}

// The longest query the page sends; the API cuts at the same length.
export const MAX_QUERY_LENGTH = 200

// ?q= as the page uses it: whitespace collapsed, at most MAX_QUERY_LENGTH characters.
export function normalizeQuery(raw: string | null | undefined): string {
  const query = (raw ?? "").replace(/\s+/g, " ").trim()
  return Array.from(query).slice(0, MAX_QUERY_LENGTH).join("").trim()
}

export function parseSearchType(raw: string | null | undefined): SearchType | null {
  if (raw === null || raw === undefined || raw === "" || raw === "all") return "all"
  if (raw === "post" || raw === "page") return raw
  return null
}

// The query string a search URL carries: q, and type unless it's "all".
export function searchQueryString(query: string, type: SearchType = "all"): string {
  const params = new URLSearchParams()
  if (query) params.set("q", query)
  if (type !== "all") params.set("type", type)
  const value = params.toString()
  return value ? `?${value}` : ""
}

// The URL of page n of a search: /search?q=… or /search/page/N/?q=….
export function searchUrl(query: string, type: SearchType = "all", page = 1): string {
  return `${pagePath(SEARCH_PATH, page)}${searchQueryString(query, type)}`
}

const MARK_TOKEN = /<\/?mark>/g

/**
 * The API's highlight HTML, made safe for set:html whatever it holds: the only tags
 * kept are <mark> and </mark>, every other < and > is escaped, and so is any & that
 * doesn't start an entity. The API already sends exactly that; this keeps one bug
 * there from becoming markup on the page.
 */
export function safeHighlight(html: string | null | undefined): string {
  if (!html) return ""
  let open = false
  const parts = html.split(/(<\/?mark>)/)
  const out = parts.map((part) => {
    if (part === "<mark>") {
      if (open) return ""
      open = true
      return part
    }
    if (part === "</mark>") {
      if (!open) return ""
      open = false
      return part
    }
    return part
      .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});)/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  })
  return out.join("") + (open ? "</mark>" : "")
}

// The plain text of a highlight (for a title attribute or a test).
export function highlightText(html: string): string {
  return html.replace(MARK_TOKEN, "")
}

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })

function formatDate(value: string | undefined): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1900) return ""
  return dateFormat.format(date)
}

// The line above a result's title: its type, and the date (a page's last update).
export function resultLabels(hit: Pick<SearchHit, "post_type" | "created_at" | "changed_at">): { typeLabel: string; dateLabel: string } {
  if (hit.post_type === "page") {
    const updated = formatDate(hit.changed_at) || formatDate(hit.created_at)
    return { typeLabel: "Page", dateLabel: updated ? `Updated ${updated}` : "" }
  }
  return { typeLabel: "Post", dateLabel: formatDate(hit.created_at) }
}

export function toSearchResult(hit: SearchHit, structure: UrlStructure): SearchResult {
  return {
    hit,
    href: postPath({ id: hit.id, slug: hit.slug, post_type: hit.post_type }, structure),
    ...resultLabels(hit),
    titleHtml: safeHighlight(hit.title_html),
    excerptHtml: safeHighlight(hit.excerpt_html),
  }
}

export function searchChips(query: string, type: SearchType, counts: SearchCounts): SearchChip[] {
  const chips: Array<[SearchType, string]> = [
    ["all", "All"],
    ["post", "Posts"],
    ["page", "Pages"],
  ]
  return chips.map(([chipType, label]) => ({
    type: chipType,
    label,
    count: counts[chipType],
    href: searchUrl(query, chipType),
    current: chipType === type,
  }))
}

export interface PublicSearchResponse {
  query: string
  type: SearchType
  results: SearchHit[]
  counts: SearchCounts
  pagination: Pagination
}

const PUBLIC_API_TIMEOUT_MS = 5000

// GET /public/search: the body, or null for a 404 (a page past the end). Anything
// else throws.
export async function getPublicSearch(query: string, type: SearchType, page: number): Promise<PublicSearchResponse | null> {
  const params = new URLSearchParams({ q: query })
  if (type !== "all") params.set("type", type)
  if (page > 1) params.set("page", String(page))
  const response = await fetch(`${SERVER_MEDIA_URL}/public/search?${params}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(PUBLIC_API_TIMEOUT_MS),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GET /public/search: HTTP ${response.status}`)
  return (await response.json()) as PublicSearchResponse
}

// The empty state's topic chips: the most used categories, each a search for its name
// (term names are indexed, weight B). They can point at the term archive,
// /{taxonomy}/{slug}, once #348's route exists; until then that URL is a 404. Fails soft.
export async function getTopics(limit = 6): Promise<SearchLink[]> {
  try {
    const response = await fetch(`${SERVER_API_URL}/taxonomy/terms/popular?type=category&limit=${limit}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PUBLIC_API_TIMEOUT_MS),
    })
    if (!response.ok) return []
    const body = (await response.json()) as { taxonomy_terms?: Array<{ name?: string; slug?: string }> }
    return (body.taxonomy_terms ?? [])
      .filter((term) => term.name?.trim())
      .map((term) => ({ label: term.name as string, href: searchUrl(normalizeQuery(term.name)) }))
  } catch (error) {
    console.warn("[search] Could not fetch topics:", error)
    return []
  }
}

// The empty state's recent posts. Fails soft.
export async function getRecentPosts(structure: UrlStructure, limit = 3): Promise<SearchLink[]> {
  try {
    const posts: Post[] = (await getPostsByType("post", { status: "published", sort: "date_desc", limit })).data
    return posts.map((post) => ({ label: post.title, href: postPath({ ...post, post_type: post.post_type || "post" }, structure) }))
  } catch (error) {
    console.warn("[search] Could not fetch recent posts:", error)
    return []
  }
}

const NO_COUNTS: SearchCounts = { all: 0, post: 0, page: 0 }

/**
 * The search page's data, or null when the page is past the end (the route 404s).
 * An empty query is the page with just the form; one with no matches gets the
 * empty state's topics and recent posts.
 */
export async function loadSearchPage(query: string, type: SearchType, page: number): Promise<SearchPageData | null> {
  const [site, found] = await Promise.all([
    getSiteSettings(),
    query ? getPublicSearch(query, type, page) : Promise.resolve(null),
  ])
  if (!found && (query || page > 1)) return null

  const structure = normalizeUrlStructure(site.urlStructure)
  const counts = found?.counts ?? NO_COUNTS
  const total = found?.pagination.total ?? 0
  const results = (found?.results ?? []).map((hit) => toSearchResult(hit, structure))
  const [topics, recent] = query && total === 0 ? await Promise.all([getTopics(), getRecentPosts(structure)]) : [[], []]

  return {
    query,
    type,
    results,
    counts,
    chips: searchChips(query, type, counts),
    total,
    page,
    totalPages: found?.pagination.total_pages ?? 0,
    basePath: SEARCH_PATH,
    pageQuery: searchQueryString(query, type),
    siteTitle: site.title,
    topics,
    recent,
  }
}

// "4 results" / "1 result"
export function resultCountLabel(total: number): string {
  return `${total} ${total === 1 ? "result" : "results"}`
}
