/**
 * Public term archives (#348): /{taxonomy}/{slug} (e.g. /category/guides), the links a
 * post's categories and tags get, and the sitemap's term URLs. The data comes from the
 * API's /public/taxonomies/:taxonomy/terms/:slug/posts, which 404s an unknown slug and
 * any term of a non-public taxonomy alike, and lists a parent category's children's
 * posts with its own. Tested in termPage.test.ts.
 *
 * Routing: /{x}/{y} is [post_type]/[id].astro. A registered public post type keeps that
 * URL; otherwise, when {x} is a public taxonomy, the route hands over to the term page
 * (termRouteFor). Page N is /{taxonomy}/{slug}/page/N/ (#349).
 */
import type { Post, TaxonomyTerm, TaxonomyType } from "@gl-admin/lib/api/types"
import { getTaxonomyTypes } from "./api"
import { pageLinks, type Pagination } from "./pagination"
import { toListedPosts, type PostListData } from "./postList"
import { getPublic } from "./publicApi"
import { normalizeUrlStructure, termPath } from "./seo"
import { getSiteSettings } from "./siteSettings"

export { termPath }

// What the API sends as the archive's header (api/terms_public_handlers_read.go).
export interface PublicTerm {
  id: number
  name: string
  slug: string
  description: string
  taxonomy: string
  taxonomy_label: string
  hierarchical: boolean
}

export interface TermPageData {
  term: PublicTerm
  postCount: number
  list: PostListData
}

// A post's term with its taxonomy's label and the URL of its archive, when it has one
// (a public taxonomy).
export type LinkedTerm = TaxonomyTerm & { href?: string; taxonomy_label?: string }

// The internal route the term page renders at (src/pages/term.archive.astro). A dot
// can't be in a post type name, so no post type list shadows it, and it 404s unless
// a public route handed over in Astro.locals.termArchive.
export const TERM_ARCHIVE_ROUTE = "/term.archive"

// The taxonomy list changes rarely, but every unknown /{x}/{y} URL and every post
// page asks for it: keep it for a minute, one request shared by concurrent callers,
// so 404 probes and post renders don't each cost an API call (#190 rate limit). A
// taxonomy made public or private takes up to a minute to show.
const TAXONOMY_TYPES_TTL_MS = 60_000
let taxonomyTypesCache: { types: Promise<TaxonomyType[]>; expires: number } | null = null

export function getCachedTaxonomyTypes(now = Date.now()): Promise<TaxonomyType[]> {
  if (!taxonomyTypesCache || taxonomyTypesCache.expires <= now) {
    const types = getTaxonomyTypes()
    const entry = { types, expires: now + TAXONOMY_TYPES_TTL_MS }
    taxonomyTypesCache = entry
    // Don't keep a failure: the next caller retries.
    types.catch(() => {
      if (taxonomyTypesCache === entry) taxonomyTypesCache = null
    })
  }
  return taxonomyTypesCache.types
}

// Names of the taxonomies with public archives.
export function publicTaxonomyNames(types: Pick<TaxonomyType, "name" | "public">[]): Set<string> {
  return new Set(types.filter((t) => t.public !== false).map((t) => t.name))
}

export async function getPublicTaxonomyNames(): Promise<Set<string>> {
  return publicTaxonomyNames(await getCachedTaxonomyTypes())
}

// Whether /{segment}/{slug} is a term archive: only when no public post type has the
// name (post types keep their URLs) and a public taxonomy does. publicTypes is null when
// the post types couldn't be fetched; the taxonomy still decides then. A failed taxonomy
// lookup is "no", so the post route carries on as before.
export async function isTermRoute(
  segment: string,
  publicTypes: string[] | null,
  getNames: () => Promise<Set<string>> = getPublicTaxonomyNames,
): Promise<boolean> {
  if (publicTypes?.includes(segment)) return false
  try {
    return (await getNames()).has(segment)
  } catch (error) {
    console.warn("Could not fetch taxonomy types:", error)
    return false
  }
}

// The post's terms with their taxonomy's label, each public one with its archive's URL.
// Order is kept. Without the taxonomy list (types empty) they stay unlinked.
export function linkTerms(terms: TaxonomyTerm[], types: Pick<TaxonomyType, "name" | "label" | "public">[]): LinkedTerm[] {
  const byName = new Map(types.map((t) => [t.name, t]))
  return terms.map((term) => {
    const type = term.taxonomy_type_name ? byName.get(term.taxonomy_type_name) : undefined
    if (!type) return { ...term }
    const linked: LinkedTerm = { ...term, taxonomy_label: type.label }
    if (type.public !== false) linked.href = termPath(type.name, term.slug)
    return linked
  })
}

// One page of a term's posts, with the term: null when the term has no page or the
// page is past the end.
export async function getTermPosts(
  taxonomy: string,
  slug: string,
  page: number,
): Promise<{ term: PublicTerm; posts: Post[]; pagination: Pagination } | null> {
  const query = page > 1 ? `?page=${page}` : ""
  return getPublic(`/taxonomies/${encodeURIComponent(taxonomy)}/terms/${encodeURIComponent(slug)}/posts${query}`)
}

// Every term archive with a post, for the sitemap, one request per 1000.
export async function getPublicTerms(): Promise<{ taxonomy: string; slug: string; last_modified: string }[]> {
  type Entry = { taxonomy: string; slug: string; last_modified: string }
  const all: Entry[] = []
  const limit = 1000
  for (let offset = 0; ; offset += limit) {
    const body = await getPublic<{ terms?: Entry[] }>(`/terms?limit=${limit}&offset=${offset}`)
    const page = body?.terms ?? []
    all.push(...page)
    if (page.length < limit) return all
  }
}

// The term page's data, or null when there is no such page: the route 404s. The API
// pages the list (posts_per_page at a time) and counts it, children's posts included.
export async function loadTermPage(taxonomy: string, slug: string, page: number, siteUrl: string): Promise<TermPageData | null> {
  const [site, result] = await Promise.all([getSiteSettings(), getTermPosts(taxonomy, slug, page)])
  if (!result) return null
  const structure = normalizeUrlStructure(site.urlStructure)
  const posts = await toListedPosts(result.posts ?? [], "post", structure, siteUrl)
  const { total, total_pages: totalPages } = result.pagination
  const basePath = termPath(result.term.taxonomy, result.term.slug)
  return {
    term: result.term,
    postCount: total,
    list: { posts, total, page, totalPages, basePath, links: pageLinks(basePath, page, totalPages), siteTitle: site.title },
  }
}

// The built-in taxonomies' singular names, for the eyebrow.
const SINGULAR_LABELS: Record<string, string> = { category: "Category", tag: "Tag", page_category: "Page category" }

// The eyebrow above the term's name: "Category" or "Tag" as the design shows it, any
// other taxonomy's label as configured (guessing singulars goes wrong: "Series").
export function termKindLabel(term: Pick<PublicTerm, "taxonomy" | "taxonomy_label">): string {
  return SINGULAR_LABELS[term.taxonomy] ?? (term.taxonomy_label?.trim() || term.taxonomy)
}

// "in Guides" for a category-like (hierarchical) taxonomy, "tagged Editor" otherwise:
// the count line's and the list end's wording.
export function termPhrase(term: Pick<PublicTerm, "name" | "hierarchical">): string {
  return term.hierarchical ? `in ${term.name}` : `tagged ${term.name}`
}
