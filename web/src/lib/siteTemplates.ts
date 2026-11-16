/**
 * Which template a route renders (#491, design `docs/design/theme-builder.md` 3.2 and 3.3):
 * the one branch of plugin-system 8.7.
 *
 * Every route has a ranked list of template **slugs**, most specific first (`templateRanks`),
 * each with the code layouts that sit at its rank. `resolveTemplate` asks the API once for the
 * route (`GET /public/site-templates/resolve`, published only, cached by #185): the first slug
 * with a published builder override or a block template the active theme ships, with its parts
 * (override, theme, starter), their media and the menus their navigation blocks name by id.
 * The route then compares that rank with the **active theme's** first code layout in the build
 * (`codeLayoutRank`, a synchronous look at the glob): the builder wins at the same rank or a
 * more specific one, so a builder `single` replaces `layouts/post` but not a theme's own
 * `layouts/product`. The default theme's layouts never take part: they are the last resort
 * after every rank, as today, so a builder `archive` beats `default/layouts/term` when the
 * active theme has no term layout.
 *
 * **Failures never break the page.** A resolve that fails or times out (not a 404) renders the
 * code layout, logged `site_template_resolve_failed` (the route kind, never a URL). The 500
 * page never resolves: the API is likely down.
 *
 * The answer also carries every published override part, which a code layout's
 * `<TemplatePart slug>` renders in place of the theme's own markup (`templatePartOverride`).
 *
 * **Preview (#486, #492).** A previewed request reads the published templates here; the
 * draft global styles still apply. #492 adds templates and parts to `GET /site-design/draft`;
 * `templateReaderFor` is the seam where a previewed request then reads those instead.
 */
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { SERVER_MEDIA_URL } from "@gl-admin/lib/server-api-url"
import { log, requestIdHeaders } from "./log"
import { normalizeMenu, type Menu } from "./menus"
import { RESERVED_LAYOUT_KINDS } from "./themeLayout"
import { isTemplatePartSlug, TEMPLATE_PART_SLUG } from "./templateParts"

/** A route kind of design 3.2's table (never the 500 page). */
export type TemplateRoute =
  | { kind: "home" }
  /** `/` with a front page (#336): `front-page`, then the page's own list. */
  | { kind: "front-page"; template?: string | null }
  | { kind: "archive"; postType: string }
  | { kind: "single"; postType: string }
  /** A page: its template (#336) when it has one, `block:<name>` for a builder page template (#494). */
  | { kind: "page"; template?: string | null }
  | { kind: "term"; taxonomy: string }
  | { kind: "author" }
  | { kind: "search" }
  | { kind: "404" }

/**
 * One rank of a route's list: the slug, and the active theme's code layouts at that rank
 * (paths under the theme's folder: a directory ending in `/` counts when it holds a layout,
 * a file when it exists). Empty when no code layout sits there (`front-page`, `archive-{type}`).
 */
export interface TemplateRank {
  slug: string
  code: readonly string[]
}

// A page template's name (#336, api/page_templates.go) and a builder page template's (#494).
const PAGE_TEMPLATE_NAME = /^[A-Za-z0-9_-]{1,64}$/
const BUILDER_PAGE_TEMPLATE = /^block:([a-z0-9-]{1,64})$/

const slugRank = (slug: string, code: readonly string[] = []): TemplateRank[] => (TEMPLATE_PART_SLUG.test(slug) ? [{ slug, code }] : [])

/** A page's ranks: `page-{template}` (`custom-{name}` for a builder one), then `page`. */
function pageRanks(template: string | null | undefined): TemplateRank[] {
  const builder = typeof template === "string" ? BUILDER_PAGE_TEMPLATE.exec(template) : null
  const own = builder
    ? slugRank(`custom-${builder[1]}`)
    : typeof template === "string" && template !== "default" && PAGE_TEMPLATE_NAME.test(template)
      ? slugRank(`page-${template}`, [`layouts/page/${template}.astro`])
      : []
  return [...own, { slug: "page", code: ["layouts/page/"] }]
}

/** Design 3.2's ranked slugs for a route, most specific first, each with its code layouts. */
export function templateRanks(route: TemplateRoute): TemplateRank[] {
  switch (route.kind) {
    case "home":
      return [{ slug: "front-page", code: [] }, { slug: "home", code: ["layouts/home/"] }]
    case "front-page":
      return [{ slug: "front-page", code: [] }, ...pageRanks(route.template)]
    case "archive":
      return [...slugRank(`archive-${route.postType}`), { slug: "archive", code: ["layouts/archive/"] }]
    case "single": {
      // A type's own layouts (never home, archive and the other page kinds' folders); `post`'s
      // own layouts are `single`'s, so a builder `single` replaces them.
      const own = !RESERVED_LAYOUT_KINDS.has(route.postType) && route.postType !== "post"
      return [...slugRank(`single-${route.postType}`, own ? [`layouts/${route.postType}/`] : []), { slug: "single", code: ["layouts/post/"] }]
    }
    case "page":
      return pageRanks(route.template)
    case "term":
      return [...slugRank(`taxonomy-${route.taxonomy}`, ["layouts/term/"]), { slug: "archive", code: ["layouts/archive/"] }]
    case "author":
      return [{ slug: "author", code: ["layouts/author/"] }, { slug: "archive", code: ["layouts/archive/"] }]
    case "search":
      return [{ slug: "search", code: ["layouts/search/"] }]
    case "404":
      return [{ slug: "404", code: ["layouts/error/404.astro", "layouts/error/default.astro"] }]
  }
}

/** The slugs alone, in rank order: what the resolve route is asked. */
export function templateSlugs(route: TemplateRoute): string[] {
  return templateRanks(route).map((rank) => rank.slug)
}

/** A glob key (`../../themes/default/layouts/post/default.astro`) as `default/layouts/post/default.astro`. */
export function themeLayoutPath(globKey: string): string {
  return /^(?:\.\.?\/)*themes\/(.*)$/.exec(globKey)?.[1] ?? globKey
}

// Every theme layout in this build, by its path under themes/. Only the keys are read: nothing
// is loaded here.
const BUILD_LAYOUTS: readonly string[] = Object.keys(import.meta.glob("../../themes/*/layouts/**/*.astro")).map(themeLayoutPath)

/**
 * The rank of the active theme's first code layout for these ranks, or -1 when it has none at
 * any of them (the default theme's are the last resort after every rank, design 3.3).
 */
export function codeLayoutRank(ranks: readonly TemplateRank[], themeSlug: string, layoutPaths: readonly string[] = BUILD_LAYOUTS): number {
  const own = layoutPaths.filter((path) => path.startsWith(`${themeSlug}/`)).map((path) => path.slice(themeSlug.length + 1))
  return ranks.findIndex((rank) =>
    rank.code.some((code) => (code.endsWith("/") ? own.some((path) => path.startsWith(code) && path.endsWith(".astro")) : own.includes(code))),
  )
}

/** Whether a builder template at `templateRank` beats the code layout at `codeRank` (same rank or more specific). */
export function builderWins(templateRank: number, codeRank: number): boolean {
  return codeRank < 0 || templateRank <= codeRank
}

/** Where a resolved template or part comes from. */
export type SiteDesignSource = "override" | "theme" | "starter"

export interface ResolvedTemplate {
  slug: string
  rank: number
  source: Exclude<SiteDesignSource, "starter">
  title: string
  doc: BlockDocV1
}

export interface ResolvedPart {
  source: SiteDesignSource
  title: string
  doc: BlockDocV1
}

/** The resolve route's answer, read. */
export interface SiteDesignResolve {
  theme: string
  template: ResolvedTemplate | null
  parts: Record<string, ResolvedPart>
  /** The menus navigation blocks name by id, keyed by id; a deleted one is absent. */
  menus: Record<string, Menu>
}

/** What a route renders when its builder template wins: the template, its parts by slug, the menus by id. */
export interface BlockTemplateChoice {
  template: ResolvedTemplate
  parts: Record<string, BlockDocV1>
  menusById: Record<string, Menu>
}

/** The published override parts a code layout's `<TemplatePart>` renders, kept on the request. */
export interface TemplatePartOverrides {
  parts: Record<string, BlockDocV1>
  menusById: Record<string, Menu>
}

/** A resolve gives up after this long, as a menu's read does; the page then renders its code layout. */
export const SITE_TEMPLATE_RESOLVE_TIMEOUT_MS = 2000

function isBlockDoc(value: unknown): value is BlockDocV1 {
  if (!value || typeof value !== "object") return false
  const doc = value as { blocks_order?: unknown; blocks?: unknown }
  return Array.isArray(doc.blocks_order) && !!doc.blocks && typeof doc.blocks === "object" && !Array.isArray(doc.blocks)
}

const SOURCES = new Set<SiteDesignSource>(["override", "theme", "starter"])

/** Reads the resolve route's body; anything malformed is left out (a template that isn't a doc is none). */
export function parseSiteDesignResolve(body: unknown): SiteDesignResolve {
  const data = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const rawTemplate = data.template as Record<string, unknown> | null | undefined
  const template: ResolvedTemplate | null =
    rawTemplate &&
    typeof rawTemplate.slug === "string" &&
    Number.isInteger(rawTemplate.rank) &&
    (rawTemplate.source === "override" || rawTemplate.source === "theme") &&
    isBlockDoc(rawTemplate.doc)
      ? {
          slug: rawTemplate.slug,
          rank: rawTemplate.rank as number,
          source: rawTemplate.source as ResolvedTemplate["source"],
          title: typeof rawTemplate.title === "string" ? rawTemplate.title : "",
          doc: rawTemplate.doc,
        }
      : null
  const parts: Record<string, ResolvedPart> = {}
  const rawParts = data.parts && typeof data.parts === "object" ? (data.parts as Record<string, unknown>) : {}
  for (const [slug, raw] of Object.entries(rawParts)) {
    const part = raw as Record<string, unknown> | null
    if (!isTemplatePartSlug(slug) || !part || !SOURCES.has(part.source as SiteDesignSource) || !isBlockDoc(part.doc)) continue
    parts[slug] = { source: part.source as SiteDesignSource, title: typeof part.title === "string" ? part.title : "", doc: part.doc }
  }
  const menus: Record<string, Menu> = {}
  const rawMenus = data.menus && typeof data.menus === "object" ? (data.menus as Record<string, unknown>) : {}
  for (const [id, raw] of Object.entries(rawMenus)) {
    // Every href re-checked, as for a menu by location.
    const menu = /^[1-9]\d{0,17}$/.test(id) ? normalizeMenu(raw) : null
    if (menu) menus[id] = menu
  }
  return { theme: typeof data.theme === "string" ? data.theme : "", template, parts, menus }
}

/** What reads a route's design: the published one (`/public`), or, while previewing, the draft (#492). */
export type SiteTemplateReader = (theme: string, slugs: readonly string[]) => Promise<SiteDesignResolve | null>

/**
 * The published design for these slugs, within `timeoutMs`. null on a 404 (no active theme,
 * or another theme is active): nothing to render but the code. Throws on anything else.
 */
export async function readPublishedSiteDesign(
  theme: string,
  slugs: readonly string[],
  fetcher: typeof fetch = fetch,
  timeoutMs = SITE_TEMPLATE_RESOLVE_TIMEOUT_MS,
): Promise<SiteDesignResolve | null> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // As getMenu: the abort alone doesn't end a DNS lookup that hangs, so the timer settles it too.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  const load = async () => {
    const query = new URLSearchParams({ theme, slugs: slugs.join(",") })
    const response = await fetcher(`${SERVER_MEDIA_URL}/public/site-templates/resolve?${query}`, { headers: requestIdHeaders(), signal: controller.signal })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return parseSiteDesignResolve(await response.json())
  }
  try {
    return await Promise.race([load(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The reader a request uses. The published one, also while previewing: #492 adds templates and
 * parts to the draft read (`GET /site-design/draft?slugs=`, design 8.3), and returns its reader
 * here when `locals.designPreview?.state === "previewing"`.
 */
export function templateReaderFor(_locals: App.Locals | undefined, fetcher: typeof fetch = fetch): SiteTemplateReader {
  return (theme, slugs) => readPublishedSiteDesign(theme, slugs, fetcher)
}

export interface ResolveTemplateOptions {
  /** The build's theme layouts (tests pass their own). */
  layoutPaths?: readonly string[]
  /** What reads the design (tests pass their own). */
  read?: SiteTemplateReader
}

/** The override parts of an answer, for `<TemplatePart>`: only the published overrides, never the theme's or a starter. */
function overridesOf(design: SiteDesignResolve): TemplatePartOverrides {
  const parts: Record<string, BlockDocV1> = {}
  for (const [slug, part] of Object.entries(design.parts)) if (part.source === "override") parts[slug] = part.doc
  return { parts, menusById: design.menus }
}

/**
 * The route's block template, or null to render its code layout (design 3.3). One read per
 * route and request (memoized on `locals`: a rewrite or an error page in the same request
 * reuses it). Keeps the published override parts on `locals.templatePartOverrides` for a code
 * layout's `<TemplatePart>`. Never throws.
 */
export async function resolveTemplate(locals: App.Locals | undefined, route: TemplateRoute, options: ResolveTemplateOptions = {}): Promise<BlockTemplateChoice | null> {
  const theme = locals?.activeTheme || "default"
  const ranks = templateRanks(route)
  const slugs = ranks.map((rank) => rank.slug)
  const read = options.read ?? templateReaderFor(locals)
  const memo = locals ? (locals.siteTemplateResolves ??= new Map<string, Promise<SiteDesignResolve | null>>()) : new Map<string, Promise<SiteDesignResolve | null>>()
  const key = `${theme}\n${slugs.join(",")}`
  let pending = memo.get(key)
  if (!pending) {
    pending = read(theme, slugs)
    memo.set(key, pending)
  }
  let design: SiteDesignResolve | null
  try {
    design = await pending
  } catch (error) {
    log.warn("site_template_resolve_failed", { route_kind: route.kind, error })
    return null
  }
  if (!design) return null
  if (locals) locals.templatePartOverrides = overridesOf(design)
  const template = design.template
  if (!template || !builderWins(template.rank, codeLayoutRank(ranks, theme, options.layoutPaths))) return null
  const parts: Record<string, BlockDocV1> = {}
  for (const [slug, part] of Object.entries(design.parts)) parts[slug] = part.doc
  return { template, parts, menusById: design.menus }
}

/** The published override of a part, for a code layout's `<TemplatePart slug>`, or null to render the theme's markup. */
export function templatePartOverride(locals: App.Locals | undefined, slug: string): { doc: BlockDocV1; menusById: Record<string, Menu> } | null {
  const overrides = locals?.templatePartOverrides
  const doc = overrides?.parts[slug]
  if (!overrides || !doc || !Array.isArray(doc.blocks_order) || doc.blocks_order.length === 0) return null
  return { doc, menusById: overrides.menusById }
}
