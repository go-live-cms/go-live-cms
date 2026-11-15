/**
 * Filling the site blocks' render context before the synchronous render (#488, design
 * `docs/design/theme-builder.md` 4.3). A block template's layout (#491) calls
 * `loadSiteRenderContext` with the template's doc and its resolved parts, then hands the
 * result to `BlockRenderer`'s `site`; the blocks only look their data up in it
 * (`src/components/blocks/utils/siteContext.ts`).
 *
 * - The title, tagline and logo are the request's one `/settings` read (`getSiteSettings`).
 * - A menu by **location** is read from `/public/menus/:location` (`getMenu`: 2 s, `null` on a
 *   404 or a failure, logged `menu_fetch_failed`), once per location, whatever number of
 *   blocks name it. A menu by **id** isn't fetched here: no public route serves any menu by
 *   id. The resolve route attaches the ones a published template or part names (#491, 3.3),
 *   and the caller passes them as `menusById`.
 * - #489: the query blocks (`collectTemplateNeeds`), **at most four per page**, parts counted,
 *   in reading order. An inheriting query takes the route's own list (`route.list`, already
 *   loaded and passed by the route): no second fetch, and its pager's URLs are #349's. Any
 *   other reads one page of `/public/posts/type/:type` with its filters (`queryRequestParams`),
 *   all in parallel, each within 2 s. A fifth query renders nothing, logged once
 *   (`site_block_query_limit`).
 * - Failures fail soft: that block renders nothing, the rest of the page renders. A failed
 *   query is logged once per request (`site_block_data_failed`, the block type and a count,
 *   never the query string).
 */
import {
  blocksInReadingOrder,
  isMenuLocation,
  isSiteBlockType,
  normalizeQueryPerPage,
  normalizeSiteBlockAttrs,
  QUERY_DEFAULT_POST_TYPE,
  type BlockDocV1,
  type QueryAttrs,
} from "@gl-admin/lib/blocks-spec"
import type { Post } from "@gl-admin/lib/api/types"
import { SERVER_MEDIA_URL } from "@gl-admin/lib/server-api-url"
import { queryKey, type SiteMenu, type SitePostList, type SiteRenderContext, type SiteRoute } from "@/components/blocks/utils/siteContext"
import { log, requestIdHeaders } from "./log"
import { getMenu, withCurrent, type Menu } from "./menus"
import { toListedPosts } from "./postList"
import { normalizeUrlStructure, type UrlStructure } from "./seo"
import { getSiteSettings } from "./siteSettings"

/** At most this many query blocks per rendered page, counting parts (design 4.3). */
export const MAX_QUERIES_PER_PAGE = 4
/** A query's read gives up after this long, as a menu's does. */
export const SITE_QUERY_TIMEOUT_MS = 2000

/** What the site blocks of some docs need loaded: the theme locations, menu ids and part slugs they name. */
export interface SiteBlockNeeds {
  locations: string[]
  menuIds: number[]
  parts: string[]
}

/** Every location, menu id and part slug that `docs`' site blocks name, each once, sorted. */
export function siteBlockNeeds(docs: Iterable<BlockDocV1 | null | undefined>): SiteBlockNeeds {
  const locations = new Set<string>()
  const menuIds = new Set<number>()
  const parts = new Set<string>()
  for (const doc of docs) {
    const blocks = doc?.blocks && typeof doc.blocks === "object" ? Object.values(doc.blocks) : []
    for (const block of blocks) {
      if (!block || typeof block !== "object" || !isSiteBlockType(block.type)) continue
      const attrs = normalizeSiteBlockAttrs(block.type, block.attrs)
      if (block.type === "navigation") {
        if (typeof attrs.menuId === "number") menuIds.add(attrs.menuId)
        else if (isMenuLocation(attrs.location)) locations.add(attrs.location)
      } else if (block.type === "template_part" && typeof attrs.slug === "string") {
        parts.add(attrs.slug)
      }
    }
  }
  return { locations: [...locations].sort(), menuIds: [...menuIds].sort((a, b) => a - b), parts: [...parts].sort() }
}

/** A query block a page renders (#489): where its posts go (`queryKey`) and what it asks for. */
export interface TemplateQueryNeed {
  key: string
  blockId: string
  /** The part it sits in, or none for the template's own. */
  part?: string
  attrs: QueryAttrs
}

/** What a block template's render needs loaded first (design 3.4, step 1). */
export interface TemplateNeeds extends SiteBlockNeeds {
  /** The query blocks that render, in reading order (parts where the template places them), at most four. */
  queries: TemplateQueryNeed[]
  /** How many more there were: they render nothing. */
  skippedQueries: number
  /** Whether a site logo block is used (the logo comes with the settings). */
  logo: boolean
}

/**
 * Walks the template and its parts (design 3.4's `collectTemplateNeeds`): the menus and parts
 * the site blocks name, whether the logo is used, and the query blocks in reading order, a part's
 * at the place the template puts it (each part once), then any part the template doesn't place
 * (a code layout's `<TemplatePart>`), by slug. Only the first `MAX_QUERIES_PER_PAGE` are kept.
 */
export function collectTemplateNeeds(template: BlockDocV1 | null | undefined, parts: Readonly<Record<string, BlockDocV1 | null>> = {}): TemplateNeeds {
  const base = siteBlockNeeds([template, ...Object.values(parts)])
  const all: TemplateQueryNeed[] = []
  const visited = new Set<string>()
  let logo = false
  const visit = (doc: BlockDocV1 | null | undefined, part?: string) => {
    if (!doc?.blocks) return
    for (const id of blocksInReadingOrder(doc)) {
      const block = doc.blocks[id]
      if (!block) continue
      if (block.type === "site_logo") logo = true
      else if (block.type === "query") all.push({ key: queryKey(part, id), blockId: id, ...(part ? { part } : {}), attrs: normalizeSiteBlockAttrs("query", block.attrs) as QueryAttrs })
      else if (block.type === "template_part" && part === undefined) {
        const slug = normalizeSiteBlockAttrs("template_part", block.attrs).slug
        if (typeof slug === "string" && !visited.has(slug)) {
          visited.add(slug)
          visit(parts[slug], slug)
        }
      }
    }
  }
  visit(template)
  for (const slug of Object.keys(parts).sort()) {
    if (visited.has(slug)) continue
    visited.add(slug)
    visit(parts[slug], slug)
  }
  return { ...base, queries: all.slice(0, MAX_QUERIES_PER_PAGE), skippedQueries: Math.max(0, all.length - MAX_QUERIES_PER_PAGE), logo }
}

/**
 * The `/public/posts/type/:type` parameters for a query's attrs, one to one (design 4.3): the
 * page size always, the order, the terms and the author when set. Nothing else reaches the
 * request, so no attr can ask for a status, another route or anything `/public` doesn't serve.
 */
export function queryRequestParams(attrs: QueryAttrs): URLSearchParams {
  const params = new URLSearchParams({ per_page: String(normalizeQueryPerPage(attrs.perPage)) })
  if (attrs.orderBy === "title") params.set("order_by", "title")
  if (attrs.order === "asc") params.set("order", "asc")
  if (attrs.termIds?.length) params.set("terms", attrs.termIds.join(","))
  if (attrs.authorId) params.set("author_id", String(attrs.authorId))
  return params
}

/** What reads a non-inheriting query's posts (tests pass their own). */
export type QueryReader = (attrs: QueryAttrs, options: { structure: UrlStructure; siteUrl: string }) => Promise<SitePostList>

/**
 * Page 1 of a query's posts (#489), within `SITE_QUERY_TIMEOUT_MS`. A 404 (the type isn't
 * public, or no longer exists) is an empty list, so "no results" shows; anything else throws.
 * One page only: a query of chosen posts has no pager (4.3).
 */
export async function readQueryPosts(
  attrs: QueryAttrs,
  { structure, siteUrl }: { structure: UrlStructure; siteUrl: string },
  fetcher: typeof fetch = fetch,
  timeoutMs = SITE_QUERY_TIMEOUT_MS,
): Promise<SitePostList> {
  const postType = attrs.postType ?? QUERY_DEFAULT_POST_TYPE
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // As getMenu: the abort alone doesn't end a DNS lookup that hangs, so the timer settles it too.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  const load = async (): Promise<SitePostList> => {
    const url = `${SERVER_MEDIA_URL}/public/posts/type/${encodeURIComponent(postType)}?${queryRequestParams(attrs)}`
    const response = await fetcher(url, { headers: requestIdHeaders(), signal: controller.signal })
    if (response.status === 404) return { items: [], page: 1, totalPages: 0, basePath: null }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = (await response.json()) as { posts?: unknown }
    const rows = (Array.isArray(body?.posts) ? body.posts : []) as Post[]
    return { items: await toListedPosts(rows, postType, structure, siteUrl), page: 1, totalPages: 1, basePath: null }
  }
  try {
    return await Promise.race([load(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Each query's posts by key: an inheriting query's is the route's own list (no fetch), any
 * other's is read (`read`), all at once. A failure is null for that query and logged once for
 * the request, with how many failed.
 */
export async function loadQueries(
  queries: readonly TemplateQueryNeed[],
  { route, structure, siteUrl, read = readQueryPosts }: { route?: SiteRoute; structure: UrlStructure; siteUrl: string; read?: QueryReader },
): Promise<Record<string, SitePostList | null>> {
  const failures: unknown[] = []
  const entries = await Promise.all(
    queries.map(async (query): Promise<[string, SitePostList | null]> => {
      if (query.attrs.inherit) return [query.key, route?.list ?? null]
      try {
        return [query.key, await read(query.attrs, { structure, siteUrl })]
      } catch (error) {
        failures.push(error)
        return [query.key, null]
      }
    }),
  )
  if (failures.length > 0) log.warn("site_block_data_failed", { block_type: "query", count: failures.length, error: failures[0] })
  return Object.fromEntries(entries)
}

function siteMenu(menu: Menu | null, currentPath: string | undefined): SiteMenu | null {
  if (!menu) return null
  return { name: menu.name, items: currentPath ? withCurrent(menu.items, currentPath) : menu.items }
}

export interface LoadSiteRenderContextOptions {
  /** The template's doc (and anything else rendered with the context but its parts). */
  docs: Iterable<BlockDocV1 | null | undefined>
  /** The resolved parts by slug (#491). */
  parts?: Readonly<Record<string, BlockDocV1 | null>>
  /** The menus a published template or part names by id, from the resolve route (#491). */
  menusById?: Readonly<Record<string, Menu | null>>
  /** The page's path, for `aria-current`. */
  currentPath?: string
  /** For tests: what reads a menu by location. */
  readMenu?: (location: string) => Promise<Menu | null>
  /** #489: what the route renders: its post, its own list (for an inheriting query), its term, author or search. */
  route?: SiteRoute
  /** #489: the site's URL (`resolveSiteUrl`), for the featured images of a query's posts. */
  siteUrl?: string
  /** For tests: what reads a non-inheriting query's posts. */
  readQuery?: QueryReader
}

/**
 * The context for a block template's render. `locals` is the request's (`Astro.locals`), so
 * the settings are read once per request; the locations of the template's and its parts'
 * navigation blocks are read once each, in parallel.
 */
export async function loadSiteRenderContext(locals: App.Locals | undefined, options: LoadSiteRenderContextOptions): Promise<SiteRenderContext> {
  const parts = options.parts ?? {}
  const own = [...options.docs]
  const docs = [...own, ...Object.values(parts)]
  const { locations } = siteBlockNeeds(docs)
  // The template's queries first (the first doc is the template; the others render with it),
  // its parts where it places them; at most four.
  const needs = collectTemplateNeeds(mergedDoc(own), parts)
  if (needs.skippedQueries > 0) {
    log.warn("site_block_query_limit", { limit: MAX_QUERIES_PER_PAGE, count: needs.queries.length + needs.skippedQueries })
  }
  const readMenu = options.readMenu ?? ((location: string) => getMenu(location))
  const settingsRead = getSiteSettings(locals)
  const [settings, menus, queries] = await Promise.all([
    settingsRead,
    Promise.all(locations.map(async (location) => [location, await readMenu(location).catch(() => null)] as const)),
    needs.queries.length === 0
      ? Promise.resolve({})
      : settingsRead.then((site) =>
          loadQueries(needs.queries, { route: options.route, structure: normalizeUrlStructure(site.urlStructure), siteUrl: options.siteUrl ?? "", read: options.readQuery }),
        ),
  ])
  const menusById = Object.fromEntries(Object.entries(options.menusById ?? {}).map(([id, menu]) => [id, siteMenu(menu, options.currentPath)]))
  return {
    inTemplate: true,
    kind: "template",
    site: { title: settings.title, tagline: settings.tagline },
    logo: settings.logo ? { media: settings.logo.media, alt: settings.logo.alt } : null,
    menusByLocation: Object.fromEntries(menus.map(([location, menu]) => [location, siteMenu(menu, options.currentPath)])),
    menusById,
    parts,
    currentPath: options.currentPath,
    dates: { language: settings.language, timeZone: settings.timeZone, dateFormat: settings.dateFormat },
    ...(options.route ? { route: options.route } : {}),
    queries,
  }
}

/**
 * The docs rendered with the template as one doc, in order, for the walk (`collectTemplateNeeds`):
 * their blocks keyed as the template's, since they render outside any part.
 */
function mergedDoc(docs: (BlockDocV1 | null | undefined)[]): BlockDocV1 | null {
  const present = docs.filter((doc): doc is BlockDocV1 => !!doc?.blocks)
  if (present.length <= 1) return present[0] ?? null
  return {
    doc_version: 1,
    blocks_order: present.flatMap((doc) => doc.blocks_order ?? []),
    blocks: Object.assign({}, ...present.map((doc) => doc.blocks)),
  }
}
