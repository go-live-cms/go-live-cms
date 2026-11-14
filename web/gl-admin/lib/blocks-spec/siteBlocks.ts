/**
 * Site blocks I (#488, design: `docs/design/theme-builder.md` 4.1–4.5, 7.4): `site_title`,
 * `site_tagline`, `site_logo`, `navigation`, `search` and `template_part`.
 *
 * They are **core** Block Spec types (not namespaced, not a theme's), flow atoms that hold
 * no text of their own. What they show is the site's (Settings › General, the menus, the
 * published parts), read on the page from the `SiteRenderContext` SSR fills before the
 * synchronous render (`src/components/blocks/utils/siteContext.ts`). **Outside a template or
 * a part they render nothing**: they are in the one schema (7.4), so a client can write one
 * into a post's Yjs doc, and that post still stores (4.2's inert rule). The post catalog
 * doesn't offer them and no parse rule creates them, so paste can't.
 *
 * Every attr is canonical on the block, with its default left out, through
 * `normalizeSiteBlockAttrs`. The API's sanitizer applies the same rules
 * (`api/post_blocks_site.go`); `siteBlockVectors.json` pins that both agree, and also where
 * each may sit (`siteBlockKindIssues`, `validateBlockDoc(doc, { kind })`).
 *
 * Pure data and functions: no ProseMirror, DOM or Zod, so the collab server reads it too.
 */

export const SITE_BLOCK_VERSION = 1

/** The site blocks of #488, by Block Spec type. T7 (#489) adds the query and post blocks. */
export const SITE_BLOCK_TYPES = ["site_title", "site_tagline", "site_logo", "navigation", "search", "template_part"] as const
export type SiteBlockType = (typeof SITE_BLOCK_TYPES)[number]

/** Block Spec type → ProseMirror node name. */
export const SITE_BLOCK_NODE_NAMES: Readonly<Record<SiteBlockType, string>> = {
  site_title: "siteTitle",
  site_tagline: "siteTagline",
  site_logo: "siteLogo",
  navigation: "navigation",
  search: "search",
  template_part: "templatePart",
}

const SITE_TYPES = new Set<string>(SITE_BLOCK_TYPES)
const SITE_NODES = new Set<string>(Object.values(SITE_BLOCK_NODE_NAMES))
const TYPE_OF_NODE = new Map<string, SiteBlockType>(SITE_BLOCK_TYPES.map((type) => [SITE_BLOCK_NODE_NAMES[type], type]))

export function isSiteBlockType(type: unknown): type is SiteBlockType {
  return typeof type === "string" && SITE_TYPES.has(type)
}

export function isSiteBlockNode(nodeName: unknown): boolean {
  return typeof nodeName === "string" && SITE_NODES.has(nodeName)
}

export function siteBlockTypeOfNode(nodeName: unknown): SiteBlockType | undefined {
  return typeof nodeName === "string" ? TYPE_OF_NODE.get(nodeName) : undefined
}

/** What the menus call each one, and History's diff. */
export const SITE_BLOCK_LABELS: Readonly<Record<SiteBlockType, string>> = {
  site_title: "Site title",
  site_tagline: "Site tagline",
  site_logo: "Site logo",
  navigation: "Navigation",
  search: "Search",
  template_part: "Template part",
}

/** Their 24×24 stroke icons (the catalog's and the editor placeholders'). */
export const SITE_BLOCK_ICONS: Readonly<Record<SiteBlockType, string>> = {
  site_title: "M4 7V5h10v2M9 5v12M7 17h4M16 13h4M16 17h4",
  site_tagline: "M4 9h16M4 15h10",
  site_logo: "M5 19C5 10 11 5 19 4c0 9-6 15-14 15zM5 19l8-8",
  navigation: "M4 6h16M4 12h16M4 18h16",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-3.5-3.5",
  template_part: "M4 4h16v6H4zM4 14h16v6H4z",
}

// ── Where a block doc lives (design 4.2) ────────────────────────────────────────────

/** What a block doc is: a post's body, a block template or a template part. */
export const BLOCK_DOC_KINDS = ["post", "template", "part"] as const
export type BlockDocKind = (typeof BLOCK_DOC_KINDS)[number]

export function isBlockDocKind(kind: unknown): kind is BlockDocKind {
  return typeof kind === "string" && (BLOCK_DOC_KINDS as readonly string[]).includes(kind)
}

/**
 * The catalog's `contexts` default (design 4.4): a block with none is offered everywhere.
 * Site blocks are offered in templates and parts only, and `template_part` in templates only.
 */
export const SITE_BLOCK_CONTEXTS: Readonly<Record<SiteBlockType, readonly BlockDocKind[]>> = {
  site_title: ["template", "part"],
  site_tagline: ["template", "part"],
  site_logo: ["template", "part"],
  navigation: ["template", "part"],
  search: ["template", "part"],
  template_part: ["template"],
}

export interface SiteBlockKindIssue {
  path: (string | number)[]
  message: string
}

/**
 * The placement rules of design 4.2 that depend on the doc's kind, in a stable order (the
 * blocks' keys, sorted); empty when it is fine. The API runs the same
 * (`checkSiteBlockPlacement`); `siteBlockVectors.json` pins both.
 *
 * - **In a post, site blocks are inert, never an error**: refusing one would make every
 *   later store of that post `kept-invalid` until someone deleted the block.
 * - **`template_part` never sits in a part**: a part can't hold a part, so parts are never
 *   recursive and a cycle can't happen. Anywhere in the doc, referenced or not (a block left
 *   unreferenced could be referenced again by the next store).
 *
 * T7 (#489) adds `post_content`'s rules here.
 */
export function siteBlockKindIssues(doc: unknown, kind: BlockDocKind): SiteBlockKindIssue[] {
  if (kind !== "part") return []
  const blocks = (doc as { blocks?: unknown } | null)?.blocks
  if (!blocks || typeof blocks !== "object") return []
  const issues: SiteBlockKindIssue[] = []
  for (const key of Object.keys(blocks).sort()) {
    const block = (blocks as Record<string, unknown>)[key] as { type?: unknown } | null
    if (block && typeof block === "object" && block.type === "template_part") {
      issues.push({ path: ["blocks", key], message: "a template_part can't be in a part" })
    }
  }
  return issues
}

// ── Attrs ────────────────────────────────────────────────────────────────────────────

/** `site_title`'s levels: 0 = a paragraph (the default), 1 and 2 = a heading. */
export const SITE_TITLE_LEVELS = [0, 1, 2] as const
export type SiteTitleLevel = (typeof SITE_TITLE_LEVELS)[number]

/** `site_logo`'s width in CSS px, and its default. */
export const SITE_LOGO_MIN_WIDTH = 32
export const SITE_LOGO_MAX_WIDTH = 600
export const SITE_LOGO_DEFAULT_WIDTH = 48

export const NAVIGATION_LAYOUTS = ["row", "column"] as const
export type NavigationLayout = (typeof NAVIGATION_LAYOUTS)[number]
/** `phone`: at phone width the links fold into a menu button (the theme header's). */
export const NAVIGATION_OVERLAYS = ["phone", "never"] as const
export type NavigationOverlay = (typeof NAVIGATION_OVERLAYS)[number]

/** A menu location's name, as a theme's `menuLocations` and `/public/menus/:location` use it. */
const MENU_LOCATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** A template part's slug, as `site_templates.slug`'s CHECK allows it (`src/lib/templateParts.ts`). */
export const TEMPLATE_PART_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/

/** The search block's texts, in code points (the API's runes). The canvas: "Up to 40 characters." */
export const SEARCH_LABEL_MAX_LENGTH = 80
export const SEARCH_PLACEHOLDER_MAX_LENGTH = 80
export const SEARCH_BUTTON_MAX_LENGTH = 40

/** What the search block shows for a text left out. */
export const SEARCH_DEFAULTS = { label: "Search", button: "Search" } as const

export function isMenuLocation(value: unknown): value is string {
  return typeof value === "string" && MENU_LOCATION_PATTERN.test(value)
}

export function isTemplatePartSlug(value: unknown): value is string {
  return typeof value === "string" && TEMPLATE_PART_SLUG_PATTERN.test(value)
}

/** A menu id: a positive whole JSON number (the API's `menus.id`). */
export function isMenuId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER
}

/**
 * Plain text as the API's `sanitizePlainText` makes it: control characters as spaces,
 * trimmed, at most `max` code points, null when empty.
 */
export function normalizeSiteText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  let text = value.replace(/\p{Cc}/gu, " ").trim()
  const points = [...text]
  if (points.length > max) text = points.slice(0, max).join("").trim()
  return text === "" ? null : text
}

/** The site logo's width: a number rounded and clamped to 32–600, else the default. */
export function normalizeSiteLogoWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return SITE_LOGO_DEFAULT_WIDTH
  return Math.min(SITE_LOGO_MAX_WIDTH, Math.max(SITE_LOGO_MIN_WIDTH, Math.round(value)))
}

export function normalizeSiteTitleLevel(value: unknown): SiteTitleLevel {
  return value === 1 || value === 2 ? value : 0
}

export interface SiteTitleAttrs {
  level?: 1 | 2
  link?: false
}
export interface SiteLogoAttrs {
  width?: number
  link?: false
}
export interface NavigationAttrs {
  location?: string
  menuId?: number
  layout?: "column"
  overlay?: "never"
}
export interface SearchAttrs {
  label?: string
  placeholder?: string
  button?: string
}
export interface TemplatePartAttrs {
  slug?: string
}

/**
 * A site block's attrs as stored: only the attrs its type has, each valid, defaults left
 * out. From anything (a node's attrs, a stored block's, a client's Yjs update), so the
 * bridge writes these and the API's sanitizer keeps exactly these.
 *
 * - `site_title`: `level` 1 or 2 (0, a paragraph, is the default); `link: false` (it links
 *   home by default).
 * - `site_tagline`: none.
 * - `site_logo`: `width` rounded, clamped to 32–600 (48 is the default); `link: false`.
 * - `navigation`: **exactly one** of `menuId` (any menu, a positive integer) or `location` (a
 *   theme location's name). Both set (two people picking at once) keeps `menuId`. Neither is
 *   a block not set up yet. `layout: "column"`, `overlay: "never"`.
 * - `search`: `label`, `placeholder`, `button` as plain text, capped.
 * - `template_part`: `slug`, a part's slug.
 */
export function normalizeSiteBlockAttrs(type: SiteBlockType, attrs: unknown): Record<string, unknown> {
  const a = (attrs && typeof attrs === "object" ? attrs : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  switch (type) {
    case "site_title": {
      const level = normalizeSiteTitleLevel(a.level)
      if (level !== 0) out.level = level
      if (a.link === false) out.link = false
      break
    }
    case "site_tagline":
      break
    case "site_logo": {
      if (typeof a.width === "number" && Number.isFinite(a.width)) {
        const width = normalizeSiteLogoWidth(a.width)
        if (width !== SITE_LOGO_DEFAULT_WIDTH) out.width = width
      }
      if (a.link === false) out.link = false
      break
    }
    case "navigation": {
      if (isMenuId(a.menuId)) out.menuId = a.menuId
      else if (isMenuLocation(a.location)) out.location = a.location
      if (a.layout === "column") out.layout = "column"
      if (a.overlay === "never") out.overlay = "never"
      break
    }
    case "search": {
      const label = normalizeSiteText(a.label, SEARCH_LABEL_MAX_LENGTH)
      const placeholder = normalizeSiteText(a.placeholder, SEARCH_PLACEHOLDER_MAX_LENGTH)
      const button = normalizeSiteText(a.button, SEARCH_BUTTON_MAX_LENGTH)
      if (label !== null) out.label = label
      if (placeholder !== null) out.placeholder = placeholder
      if (button !== null) out.button = button
      break
    }
    case "template_part":
      if (isTemplatePartSlug(a.slug)) out.slug = a.slug
      break
  }
  return out
}

/**
 * The node attrs for a stored site block: every attr its node has, defaults filled in
 * (null where "none"), so the editor and the bridge agree on one shape.
 */
export function siteBlockNodeAttrs(type: SiteBlockType, attrs: unknown): Record<string, unknown> {
  const stored = normalizeSiteBlockAttrs(type, attrs)
  switch (type) {
    case "site_title":
      return { level: stored.level ?? 0, link: stored.link !== false }
    case "site_tagline":
      return {}
    case "site_logo":
      return { width: stored.width ?? SITE_LOGO_DEFAULT_WIDTH, link: stored.link !== false }
    case "navigation":
      return {
        location: stored.location ?? null,
        menuId: stored.menuId ?? null,
        layout: stored.layout ?? "row",
        overlay: stored.overlay ?? "phone",
      }
    case "search":
      return { label: stored.label ?? null, placeholder: stored.placeholder ?? null, button: stored.button ?? null }
    case "template_part":
      return { slug: stored.slug ?? null }
  }
}

/** The editor's line on a site block that sits in a post (the canvas's "In a post" state). */
export const SITE_BLOCK_INERT_NOTE = "only works in the Site editor. In a post it shows nothing on the page. You can remove it."
