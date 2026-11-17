/**
 * Site blocks (design: `docs/design/theme-builder.md` 4.1–4.5, 7.4). Site blocks I (#488):
 * `site_title`, `site_tagline`, `site_logo`, `navigation`, `search` and `template_part`. Site
 * blocks II (#489): the query loop (`query`, `post_template`, `query_pagination`,
 * `query_no_results`), `query_title`, `term_description` and the `post_*` blocks. Site blocks
 * III (#497): `related_posts`, `author_cards`, `table_of_contents`, `color_scheme_switch`, and
 * `readingTime` on `post_byline`, what converting the default theme (#498) needs. Site blocks IV
 * (#498): `query_total`, `author_avatar`, `search_results`, `post_facts`, `site_copyright` and
 * `golive_credit`, and the attrs that let the others render each piece of the default theme's
 * layouts (the header's phone menu and theme popover, the footer's columns, the home page's
 * featured post, the list end, the bylines with dates), so its block templates render what its
 * code layouts did.
 *
 * They are **core** Block Spec types (not namespaced, not a theme's). Most are flow atoms
 * that hold no text of their own; the query loop's three containers are rows of the nesting
 * table (`nesting.ts`), and `query_pagination` is an atom that only lives in a query. What they
 * show is the site's (Settings › General, the menus, the published parts, the route's post and
 * lists, a query's posts), read on the page from the `SiteRenderContext` SSR fills before the
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

/** The site blocks that are flow (they may sit wherever flow may): #488's six, then #489's. */
export const SITE_FLOW_BLOCK_TYPES = [
  "site_title",
  "site_tagline",
  "site_logo",
  "navigation",
  "search",
  "template_part",
  // #489
  "query_title",
  "term_description",
  "post_title",
  "post_content",
  "post_excerpt",
  "post_featured_image",
  "post_date",
  "post_byline",
  "post_terms",
  "post_navigation",
  // #497
  "related_posts",
  "author_cards",
  "table_of_contents",
  "color_scheme_switch",
  // #498
  "query_total",
  "author_avatar",
  "search_results",
  "post_facts",
  "site_copyright",
  "golive_credit",
] as const

/** An atom that only lives in a query (#489): neither flow nor a container, like a `footnote` in its list. */
export const SITE_QUERY_ATOM_TYPES = ["query_pagination"] as const

/** The query loop's containers (#489), rows of the nesting table (`nesting.ts`). */
export const SITE_CONTAINER_TYPES = ["query", "post_template", "query_no_results"] as const

/** The site blocks that are atoms (one node, no children): the flow ones and `query_pagination`. */
export const SITE_ATOM_TYPES = [...SITE_FLOW_BLOCK_TYPES, ...SITE_QUERY_ATOM_TYPES] as const

/** Every site block, by Block Spec type. */
export const SITE_BLOCK_TYPES = [...SITE_ATOM_TYPES, ...SITE_CONTAINER_TYPES] as const
export type SiteBlockType = (typeof SITE_BLOCK_TYPES)[number]
export type SiteAtomType = (typeof SITE_ATOM_TYPES)[number]
export type SiteContainerType = (typeof SITE_CONTAINER_TYPES)[number]

/** Block Spec type → ProseMirror node name. */
export const SITE_BLOCK_NODE_NAMES: Readonly<Record<SiteBlockType, string>> = {
  site_title: "siteTitle",
  site_tagline: "siteTagline",
  site_logo: "siteLogo",
  navigation: "navigation",
  search: "search",
  template_part: "templatePart",
  query_title: "queryTitle",
  term_description: "termDescription",
  post_title: "postTitle",
  post_content: "postContent",
  post_excerpt: "postExcerpt",
  post_featured_image: "postFeaturedImage",
  post_date: "postDate",
  post_byline: "postByline",
  post_terms: "postTerms",
  post_navigation: "postNavigation",
  related_posts: "relatedPosts",
  author_cards: "authorCards",
  table_of_contents: "tableOfContents",
  color_scheme_switch: "colorSchemeSwitch",
  query_total: "queryTotal",
  author_avatar: "authorAvatar",
  search_results: "searchResults",
  post_facts: "postFacts",
  site_copyright: "siteCopyright",
  golive_credit: "goliveCredit",
  query_pagination: "queryPagination",
  query: "query",
  post_template: "postTemplate",
  query_no_results: "queryNoResults",
}

/** The ProseMirror node names of the flow site blocks (`STANDALONE_FLOW_NODE_NAMES`). */
export const SITE_FLOW_NODE_NAMES: readonly string[] = SITE_FLOW_BLOCK_TYPES.map((type) => SITE_BLOCK_NODE_NAMES[type])
/** The ProseMirror node names of the atom site blocks (one placeholder view each). */
export const SITE_ATOM_NODE_NAMES: readonly string[] = SITE_ATOM_TYPES.map((type) => SITE_BLOCK_NODE_NAMES[type])

const SITE_TYPES = new Set<string>(SITE_BLOCK_TYPES)
const SITE_ATOMS = new Set<string>(SITE_ATOM_TYPES)
const SITE_CONTAINERS = new Set<string>(SITE_CONTAINER_TYPES)
const SITE_NODES = new Set<string>(Object.values(SITE_BLOCK_NODE_NAMES))
const TYPE_OF_NODE = new Map<string, SiteBlockType>(SITE_BLOCK_TYPES.map((type) => [SITE_BLOCK_NODE_NAMES[type], type]))

export function isSiteBlockType(type: unknown): type is SiteBlockType {
  return typeof type === "string" && SITE_TYPES.has(type)
}

export function isSiteAtomType(type: unknown): type is SiteAtomType {
  return typeof type === "string" && SITE_ATOMS.has(type)
}

export function isSiteContainerType(type: unknown): type is SiteContainerType {
  return typeof type === "string" && SITE_CONTAINERS.has(type)
}

export function isSiteBlockNode(nodeName: unknown): boolean {
  return typeof nodeName === "string" && SITE_NODES.has(nodeName)
}

export function siteBlockTypeOfNode(nodeName: unknown): SiteBlockType | undefined {
  return typeof nodeName === "string" ? TYPE_OF_NODE.get(nodeName) : undefined
}

/** What the menus call each one, and History's diff (the blocks canvas's names). */
export const SITE_BLOCK_LABELS: Readonly<Record<SiteBlockType, string>> = {
  site_title: "Site title",
  site_tagline: "Site tagline",
  site_logo: "Site logo",
  navigation: "Navigation",
  search: "Search",
  template_part: "Template part",
  query_title: "Query title",
  term_description: "Term description",
  post_title: "Post title",
  post_content: "Post content",
  post_excerpt: "Post excerpt",
  post_featured_image: "Featured image",
  post_date: "Post date",
  post_byline: "Post byline",
  post_terms: "Post terms",
  post_navigation: "Post navigation",
  related_posts: "Related posts",
  author_cards: "Author cards",
  table_of_contents: "Table of contents",
  color_scheme_switch: "Colour scheme switch",
  query_total: "Query total",
  author_avatar: "Author avatar",
  search_results: "Search results",
  post_facts: "Post details",
  site_copyright: "Copyright",
  golive_credit: "GoLive credit",
  query_pagination: "Pagination",
  query: "Query loop",
  post_template: "Post template",
  query_no_results: "No results",
}

/** Their 24×24 stroke icons (the catalog's and the editor placeholders'). */
export const SITE_BLOCK_ICONS: Readonly<Record<SiteBlockType, string>> = {
  site_title: "M4 7V5h10v2M9 5v12M7 17h4M16 13h4M16 17h4",
  site_tagline: "M4 9h16M4 15h10",
  site_logo: "M5 19C5 10 11 5 19 4c0 9-6 15-14 15zM5 19l8-8",
  navigation: "M4 6h16M4 12h16M4 18h16",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-3.5-3.5",
  template_part: "M4 4h16v6H4zM4 14h16v6H4z",
  query_title: "M5 5h14M12 5v14M8 19h8",
  term_description: "M4 6h16M4 11h16M4 16h10",
  post_title: "M4 7V5h16v2M12 5v14M9 19h6",
  post_content: "M4 4h16v16H4zM8 8h8M8 12h8M8 16h5",
  post_excerpt: "M4 7h16M4 12h16M4 17h9M17 17h.01M20 17h.01",
  post_featured_image: "M3 5h18v14H3zM8.5 10.5h.01M21 15l-5-5L5 19",
  post_date: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3 2",
  post_byline: "M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8M4 21c1-4 4-6 8-6s7 2 8 6",
  post_terms: "M3 12V4h8l10 10-8 8zM7.5 8.5h.01",
  post_navigation: "M9 6l-6 6 6 6M15 6l6 6-6 6",
  related_posts: "M3 4h8v7H3zM13 4h8v7h-8zM3 14h8M3 18h6M13 14h8M13 18h6",
  author_cards: "M8 5a3 3 0 1 0 0 6a3 3 0 1 0 0-6M3 19c.7-3 2.6-5 5-5s4.3 2 5 5M15 8h6M15 12h6M17 16h4",
  table_of_contents: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  color_scheme_switch: "M12 3a9 9 0 1 0 0 18zM12 3a9 9 0 0 1 0 18",
  query_total: "M4 6h16M4 12h10M4 18h6M17 15v6M14 18h6",
  author_avatar: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7a3 3 0 1 0 0 6a3 3 0 1 0 0-6M6.5 18c1.2-2 3.2-3 5.5-3s4.3 1 5.5 3",
  search_results: "M10 4a6 6 0 1 0 0 12a6 6 0 1 0 0-12M18 18l-3.5-3.5M4 20h16",
  post_facts: "M4 5h6M4 9h10M4 14h6M4 18h10M17 4v16",
  site_copyright: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M15 9.5a3.5 3.5 0 1 0 0 5",
  golive_credit: "M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z",
  query_pagination: "M4 12h.01M9 12h.01M15 12h.01M20 12h.01M3 7h18M3 17h18",
  query: "M4 4h16v4H4zM4 10h16v4H4zM4 16h16v4H4z",
  post_template: "M4 4h16v16H4zM8 9h8M8 13h5",
  query_no_results: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M5.6 5.6l12.8 12.8",
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
  // #489. A part may hold a query (they count towards the page's four, 4.3) and the post
  // blocks (a header showing the post's title), never the post's body: a header holding it
  // would render it twice (4.2).
  query_title: ["template", "part"],
  term_description: ["template", "part"],
  post_title: ["template", "part"],
  post_content: ["template"],
  post_excerpt: ["template", "part"],
  post_featured_image: ["template", "part"],
  post_date: ["template", "part"],
  post_byline: ["template", "part"],
  post_terms: ["template", "part"],
  post_navigation: ["template", "part"],
  // #497. The colour scheme switch belongs in a header part as much as anywhere.
  related_posts: ["template", "part"],
  author_cards: ["template", "part"],
  table_of_contents: ["template", "part"],
  color_scheme_switch: ["template", "part"],
  // #498. A copyright line and the credit belong in a footer part; the rest wherever a page needs them.
  query_total: ["template", "part"],
  author_avatar: ["template", "part"],
  search_results: ["template", "part"],
  post_facts: ["template", "part"],
  site_copyright: ["template", "part"],
  golive_credit: ["template", "part"],
  query_pagination: ["template", "part"],
  query: ["template", "part"],
  post_template: ["template", "part"],
  query_no_results: ["template", "part"],
}

export interface SiteBlockKindIssue {
  path: (string | number)[]
  message: string
}

/**
 * The placement rules of design 4.2 that depend on the doc's kind, in a stable order (the
 * blocks' keys, sorted; then the template-wide count); empty when it is fine. The API runs the
 * same (`checkSiteBlockPlacement`); `siteBlockVectors.json` pins both.
 *
 * - **In a post, site blocks are inert, never an error**: refusing one would make every
 *   later store of that post `kept-invalid` until someone deleted the block.
 * - **`template_part` never sits in a part**: a part can't hold a part, so parts are never
 *   recursive and a cycle can't happen. Anywhere in the doc, referenced or not (a block left
 *   unreferenced could be referenced again by the next store).
 * - **`post_content` never sits in a part** (a header holding the post would render it
 *   twice), the same way, **nor inside a query's `post_template`**, at any depth (a list item
 *   carries no body, and the block would render the route's post once per item; `post_excerpt`
 *   is the list's block), **and at most one per template**, referenced or not.
 */
export function siteBlockKindIssues(doc: unknown, kind: BlockDocKind): SiteBlockKindIssue[] {
  if (kind === "post") return []
  const blocks = (doc as { blocks?: unknown } | null)?.blocks
  if (!blocks || typeof blocks !== "object") return []
  const map = blocks as Record<string, unknown>
  const issues: SiteBlockKindIssue[] = []
  const typeOf = (id: string) => {
    const block = Object.prototype.hasOwnProperty.call(map, id) ? (map[id] as { type?: unknown } | null) : null
    return block && typeof block === "object" ? block.type : undefined
  }
  // Each block's parent, from the children lists (the first one that names it: a block
  // under two parents is the nesting check's error, not this one's).
  const parentOf = new Map<string, string>()
  for (const key of Object.keys(map).sort()) {
    const children = (map[key] as { children?: unknown } | null)?.children
    if (!Array.isArray(children)) continue
    for (const child of children) if (typeof child === "string" && !parentOf.has(child)) parentOf.set(child, key)
  }
  const inPostTemplate = (id: string) => {
    const seen = new Set<string>([id])
    for (let at = parentOf.get(id); at !== undefined && !seen.has(at); at = parentOf.get(at)) {
      if (typeOf(at) === "post_template") return true
      seen.add(at)
    }
    return false
  }
  const contents: string[] = []
  for (const key of Object.keys(map).sort()) {
    const type = typeOf(key)
    if (kind === "part" && type === "template_part") {
      issues.push({ path: ["blocks", key], message: "a template_part can't be in a part" })
    } else if (type === "post_content") {
      contents.push(key)
      if (kind === "part") issues.push({ path: ["blocks", key], message: "a post_content can't be in a part" })
      else if (inPostTemplate(key)) issues.push({ path: ["blocks", key], message: "a post_content can't be in a post_template" })
    }
  }
  if (kind === "template" && contents.length > 1) {
    issues.push({ path: ["blocks", contents[1]], message: "a template holds at most one post_content" })
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

/**
 * `row` (the default), `column`, or `columns` (#498): the default theme footer's link columns, a
 * column per top-level link with children (headed by it) and the "Site" column (the other links and
 * the site's RSS feed).
 */
export const NAVIGATION_LAYOUTS = ["row", "column", "columns"] as const
export type NavigationLayout = (typeof NAVIGATION_LAYOUTS)[number]
/**
 * `phone` (the default): at phone width the links fold into a `<details>` menu button. `never`.
 * `menu` (#498): the theme header's menu button and phone menu (a `<dialog>` with the site's title,
 * Home and the links, a search field and the colour scheme switch), which the theme's script opens.
 */
export const NAVIGATION_OVERLAYS = ["phone", "never", "menu"] as const
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

/** `form` (the default): the field and its button. `icon` (#498): the header's search link, an icon to the search page. */
export const SEARCH_VARIANTS = ["form", "icon"] as const
export type SearchVariant = (typeof SEARCH_VARIANTS)[number]

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
  layout?: "column" | "columns"
  overlay?: "never" | "menu"
}
export interface SearchAttrs {
  label?: string
  placeholder?: string
  button?: string
  variant?: "icon"
}
export interface TemplatePartAttrs {
  slug?: string
}

// ── #489: the query loop and the post blocks ────────────────────────────────────────

/** A query's page size (design 4.1: 1–24, `/public/posts`' `per_page` cap) and its default. */
export const QUERY_MIN_PER_PAGE = 1
export const QUERY_MAX_PER_PAGE = 24
export const QUERY_DEFAULT_PER_PAGE = 10
/** At most this many terms in one query (`/public/posts`' `terms`). */
export const QUERY_MAX_TERMS = 10
export const QUERY_DEFAULT_POST_TYPE = "post"
export const QUERY_ORDER_BYS = ["date", "title"] as const
export type QueryOrderBy = (typeof QUERY_ORDER_BYS)[number]
export const QUERY_ORDERS = ["desc", "asc"] as const
export type QueryOrder = (typeof QUERY_ORDERS)[number]

/** A post type's or a taxonomy's name, as the API's `identifier` rule allows it (at most 64). */
const CONTENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isContentName(value: unknown): value is string {
  return typeof value === "string" && CONTENT_NAME_PATTERN.test(value)
}

/** A database id: a positive whole JSON number the web keeps exactly (a user, a term). */
export function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER
}

/**
 * A query's terms as stored: valid ids, each once, ascending, at most `QUERY_MAX_TERMS`; null
 * for none. Takes the node's comma list ("3,5") or an array. A comma list because a node attr
 * must be a scalar: y-tiptap compares attrs by identity, so an array would be written to the
 * shared doc on every sync of the node.
 */
export function normalizeTermIds(value: unknown): number[] | null {
  const raw = typeof value === "string" ? value.split(",").map((part) => (/^\s*\d+\s*$/.test(part) ? Number(part) : NaN)) : Array.isArray(value) ? value : []
  const ids = [...new Set(raw.filter(isPositiveId))].sort((a, b) => a - b).slice(0, QUERY_MAX_TERMS)
  return ids.length > 0 ? ids : null
}

/** A query's page size: a number rounded and clamped to 1–24, else the default. */
export function normalizeQueryPerPage(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return QUERY_DEFAULT_PER_PAGE
  return Math.min(QUERY_MAX_PER_PAGE, Math.max(QUERY_MIN_PER_PAGE, Math.round(value)))
}

/** `post_title`'s levels: absent is "as the page needs it" (an H1 for the page's post, an H3 in a list). */
export const POST_TITLE_LEVELS = [1, 2, 3, 4] as const
/** `query_title`'s levels: 1 (the default) or 2. */
export const QUERY_TITLE_LEVELS = [1, 2] as const

/** `post_excerpt`'s length in words, and its default (the canvas's "35 words"). */
export const POST_EXCERPT_MIN_WORDS = 5
export const POST_EXCERPT_MAX_WORDS = 100
export const POST_EXCERPT_DEFAULT_WORDS = 35

/** `post_featured_image`'s shapes: `auto` keeps the image's own (the default). */
export const POST_FEATURED_IMAGE_ASPECTS = ["auto", "16-9", "3-2", "1-1"] as const
export type PostFeaturedImageAspect = (typeof POST_FEATURED_IMAGE_ASPECTS)[number]

export const POST_DATE_WHICH = ["published", "modified"] as const
export const POST_DATE_FORMATS = ["long", "short"] as const

export const POST_TERMS_DEFAULT_TAXONOMY = "category"

/**
 * #498: `post_featured_image`'s and `post_content`'s width in the page, the default theme's
 * `post-featured--column|wide|full` and image `sizes`: `column` (the default), `wide`, `full` (the
 * featured image only).
 */
export const POST_FEATURED_IMAGE_WIDTHS = ["column", "wide", "full"] as const
export const POST_CONTENT_WIDTHS = ["column", "wide"] as const

/** #498: a query's list: `list` (the default, a post template's rows) or `links` (titles only, `ul.link-list`). */
export const QUERY_LAYOUTS = ["list", "links"] as const

/** #498: `related_posts`' looks: `cards` (the default, "More to read") or `list` (the sidebar's "In <category>"). */
export const RELATED_POSTS_LAYOUTS = ["cards", "list"] as const

/** An excerpt's length in words: a number rounded and clamped to 5–100, else the default. */
export function normalizePostExcerptLength(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return POST_EXCERPT_DEFAULT_WORDS
  return Math.min(POST_EXCERPT_MAX_WORDS, Math.max(POST_EXCERPT_MIN_WORDS, Math.round(value)))
}

export interface QueryAttrs {
  /** Use the route's own list (archive, term, author, search, home), with its pages. */
  inherit?: true
  /** Absent: "post". */
  postType?: string
  /** 1–24; absent: 10. */
  perPage?: number
  orderBy?: "title"
  order?: "asc"
  /** Both or neither: the terms (of one taxonomy) a post must have one of. */
  taxonomy?: string
  termIds?: number[]
  /** Credited in the post's published byline. */
  authorId?: number
  /** #498: the first post of the list's first page as the featured post, the rest under "More posts". */
  feature?: true
  /** #498: titles only. */
  layout?: "links"
}
export interface QueryTitleAttrs {
  level?: 2
  /** #498: the kind of page as a label (`span.eyebrow`: "Category", "Author", "Error 404") instead of the title. */
  label?: true
}
export interface QueryPaginationAttrs {
  /** #498: on a list of one page, the line that says it is all ("That's every post by …"). */
  end?: true
}
export interface PostContentAttrs {
  width?: "wide"
}
export interface PostTitleAttrs {
  level?: 1 | 2 | 3 | 4
  /** Absent: a link in a list, none for the page's own post. */
  link?: boolean
}
export interface PostExcerptAttrs {
  length?: number
}
export interface PostFeaturedImageAttrs {
  aspect?: "16-9" | "3-2" | "1-1"
  link?: true
  /** #498: absent is `column`. */
  width?: "wide" | "full"
}
export interface PostDateAttrs {
  which?: "modified"
  format?: "short"
}
export interface PostBylineAttrs {
  avatars?: false
  /** #497: " · 4 min read" after the names, as the theme's byline. */
  readingTime?: true
  /** #498: the published date in the byline, as the theme's (long on the page, short in a list). */
  date?: true
}
export interface PostTermsAttrs {
  taxonomy?: string
  /** #498: every taxonomy's terms as chips (the theme's `PostTerms`); `taxonomy` is then left out. */
  all?: true
}

// ── #497: related posts, author cards, table of contents, colour scheme switch ──────

/**
 * `related_posts`' count (the default theme's "More to read" shows 3, `RELATED_POSTS_LIMIT`).
 * At most 6: two rows of the theme's card grid, under `/public/posts/:id/related`'s cap of 12.
 */
export const RELATED_POSTS_MIN_COUNT = 1
export const RELATED_POSTS_MAX_COUNT = 6
export const RELATED_POSTS_DEFAULT_COUNT = 3

/**
 * `color_scheme_switch`'s looks, the theme's `ThemeSwitch` variants: `segmented` (the default) or
 * `menu`; `popover` (#498) is the header's icon button that opens the `menu` list.
 */
export const COLOR_SCHEME_SWITCH_VARIANTS = ["segmented", "menu", "popover"] as const
export type ColorSchemeSwitchVariant = (typeof COLOR_SCHEME_SWITCH_VARIANTS)[number]

/** Related posts' count: a number rounded and clamped to 1–6, else the default. */
export function normalizeRelatedPostsCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return RELATED_POSTS_DEFAULT_COUNT
  return Math.min(RELATED_POSTS_MAX_COUNT, Math.max(RELATED_POSTS_MIN_COUNT, Math.round(value)))
}

export interface RelatedPostsAttrs {
  /** 1–6; absent: 3. */
  count?: number
  /** Only posts sharing a term of this taxonomy (`/related`'s `taxonomy`); absent: any shared term, latest posts filling in. */
  taxonomy?: string
  /**
   * #498: `list` is the sidebar's "In <term>": the other posts of the post's first term of
   * `taxonomy` (the category when absent), as links, with "All <term> →".
   */
  layout?: "list"
}
export interface ColorSchemeSwitchAttrs {
  variant?: "menu" | "popover"
}
export interface PostFactsAttrs {
  /** #498: only when the page shows no table of contents and no "In <term>" list (the theme sidebar's rule). */
  fallback?: true
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
 * - `query` (#489): `inherit: true`; `postType` a type's name ("post" is the default);
 *   `perPage` rounded, clamped to 1–24 (10 is the default); `orderBy: "title"`; `order: "asc"`;
 *   `taxonomy` and `termIds` both or neither (`normalizeTermIds`); `authorId` a user id.
 * - `query_title`: `level: 2`. `post_title`: `level` 1–4, `link` a boolean.
 * - `post_excerpt`: `length` in words, rounded, clamped to 5–100 (35 is the default).
 * - `post_featured_image`: `aspect` "16-9", "3-2" or "1-1"; `link: true`.
 * - `post_date`: `which: "modified"`, `format: "short"`. `post_byline`: `avatars: false`,
 *   `readingTime: true` (#497).
 * - `post_terms`: `taxonomy` a taxonomy's name ("category" is the default).
 * - `related_posts` (#497): `count` rounded, clamped to 1–6 (3 is the default); `taxonomy` a
 *   taxonomy's name. `color_scheme_switch`: `variant: "menu"`.
 * - #498: `navigation`'s `layout: "columns"` and `overlay: "menu"`; `search`'s `variant: "icon"`;
 *   `query`'s `feature: true` and `layout: "links"`; `query_title`'s `label: true`;
 *   `query_pagination`'s `end: true`; `post_content`'s `width: "wide"`; `post_featured_image`'s
 *   `width` "wide" or "full"; `post_byline`'s `date: true`; `post_terms`' `all: true` (which
 *   leaves `taxonomy` out); `related_posts`' `layout: "list"`; `color_scheme_switch`'s
 *   `variant: "popover"`; `post_facts`' `fallback: true`.
 * - `term_description`, `post_navigation`, `post_template`, `query_no_results`,
 *   `author_cards`, `table_of_contents`, `query_total`, `author_avatar`, `search_results`,
 *   `site_copyright`, `golive_credit`: none.
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
      if (a.layout === "column" || a.layout === "columns") out.layout = a.layout
      if (a.overlay === "never" || a.overlay === "menu") out.overlay = a.overlay
      break
    }
    case "search": {
      const label = normalizeSiteText(a.label, SEARCH_LABEL_MAX_LENGTH)
      const placeholder = normalizeSiteText(a.placeholder, SEARCH_PLACEHOLDER_MAX_LENGTH)
      const button = normalizeSiteText(a.button, SEARCH_BUTTON_MAX_LENGTH)
      if (label !== null) out.label = label
      if (placeholder !== null) out.placeholder = placeholder
      if (button !== null) out.button = button
      if (a.variant === "icon") out.variant = "icon"
      break
    }
    case "template_part":
      if (isTemplatePartSlug(a.slug)) out.slug = a.slug
      break
    case "query": {
      if (a.inherit === true) out.inherit = true
      if (isContentName(a.postType) && a.postType !== QUERY_DEFAULT_POST_TYPE) out.postType = a.postType
      if (typeof a.perPage === "number" && Number.isFinite(a.perPage)) {
        const perPage = normalizeQueryPerPage(a.perPage)
        if (perPage !== QUERY_DEFAULT_PER_PAGE) out.perPage = perPage
      }
      if (a.orderBy === "title") out.orderBy = "title"
      if (a.order === "asc") out.order = "asc"
      const termIds = normalizeTermIds(a.termIds)
      if (termIds && isContentName(a.taxonomy)) {
        out.taxonomy = a.taxonomy
        out.termIds = termIds
      }
      if (isPositiveId(a.authorId)) out.authorId = a.authorId
      if (a.feature === true) out.feature = true
      if (a.layout === "links") out.layout = "links"
      break
    }
    case "query_title":
      if (a.level === 2) out.level = 2
      if (a.label === true) out.label = true
      break
    case "query_pagination":
      if (a.end === true) out.end = true
      break
    case "post_content":
      if (a.width === "wide") out.width = "wide"
      break
    case "post_title":
      if ((POST_TITLE_LEVELS as readonly unknown[]).includes(a.level)) out.level = a.level
      if (typeof a.link === "boolean") out.link = a.link
      break
    case "post_excerpt":
      if (typeof a.length === "number" && Number.isFinite(a.length)) {
        const length = normalizePostExcerptLength(a.length)
        if (length !== POST_EXCERPT_DEFAULT_WORDS) out.length = length
      }
      break
    case "post_featured_image":
      if (a.aspect === "16-9" || a.aspect === "3-2" || a.aspect === "1-1") out.aspect = a.aspect
      if (a.link === true) out.link = true
      if (a.width === "wide" || a.width === "full") out.width = a.width
      break
    case "post_date":
      if (a.which === "modified") out.which = "modified"
      if (a.format === "short") out.format = "short"
      break
    case "post_byline":
      if (a.avatars === false) out.avatars = false
      if (a.readingTime === true) out.readingTime = true
      if (a.date === true) out.date = true
      break
    case "related_posts": {
      if (typeof a.count === "number" && Number.isFinite(a.count)) {
        const count = normalizeRelatedPostsCount(a.count)
        if (count !== RELATED_POSTS_DEFAULT_COUNT) out.count = count
      }
      if (isContentName(a.taxonomy)) out.taxonomy = a.taxonomy
      if (a.layout === "list") out.layout = "list"
      break
    }
    case "color_scheme_switch":
      if (a.variant === "menu" || a.variant === "popover") out.variant = a.variant
      break
    case "post_terms":
      if (a.all === true) out.all = true
      else if (isContentName(a.taxonomy) && a.taxonomy !== POST_TERMS_DEFAULT_TAXONOMY) out.taxonomy = a.taxonomy
      break
    case "post_facts":
      if (a.fallback === true) out.fallback = true
      break
    case "term_description":
    case "post_navigation":
    case "post_template":
    case "query_no_results":
    case "author_cards":
    case "table_of_contents":
    case "query_total":
    case "author_avatar":
    case "search_results":
    case "site_copyright":
    case "golive_credit":
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
      return { label: stored.label ?? null, placeholder: stored.placeholder ?? null, button: stored.button ?? null, variant: stored.variant ?? "form" }
    case "template_part":
      return { slug: stored.slug ?? null }
    case "query":
      return {
        inherit: stored.inherit === true,
        postType: stored.postType ?? QUERY_DEFAULT_POST_TYPE,
        perPage: stored.perPage ?? QUERY_DEFAULT_PER_PAGE,
        orderBy: stored.orderBy ?? "date",
        order: stored.order ?? "desc",
        taxonomy: stored.taxonomy ?? null,
        // A comma list, never an array (normalizeTermIds).
        termIds: Array.isArray(stored.termIds) ? (stored.termIds as number[]).join(",") : null,
        authorId: stored.authorId ?? null,
        feature: stored.feature === true,
        layout: stored.layout ?? "list",
      }
    case "query_title":
      return { level: stored.level ?? 1, label: stored.label === true }
    case "query_pagination":
      return { end: stored.end === true }
    case "post_content":
      return { width: stored.width ?? "column" }
    case "post_title":
      return { level: stored.level ?? null, link: stored.link ?? null }
    case "post_excerpt":
      return { length: stored.length ?? POST_EXCERPT_DEFAULT_WORDS }
    case "post_featured_image":
      return { aspect: stored.aspect ?? "auto", link: stored.link === true, width: stored.width ?? "column" }
    case "post_date":
      return { which: stored.which ?? "published", format: stored.format ?? "long" }
    case "post_byline":
      return { avatars: stored.avatars !== false, readingTime: stored.readingTime === true, date: stored.date === true }
    case "related_posts":
      return { count: stored.count ?? RELATED_POSTS_DEFAULT_COUNT, taxonomy: stored.taxonomy ?? null, layout: stored.layout ?? "cards" }
    case "color_scheme_switch":
      return { variant: stored.variant ?? "segmented" }
    case "post_terms":
      return { taxonomy: stored.taxonomy ?? POST_TERMS_DEFAULT_TAXONOMY, all: stored.all === true }
    case "post_facts":
      return { fallback: stored.fallback === true }
    case "term_description":
    case "post_navigation":
    case "post_template":
    case "query_no_results":
    case "author_cards":
    case "table_of_contents":
    case "query_total":
    case "author_avatar":
    case "search_results":
    case "site_copyright":
    case "golive_credit":
      return {}
  }
}

/** The editor's line on a site block that sits in a post (the canvas's "In a post" state). */
export const SITE_BLOCK_INERT_NOTE = "only works in the Site editor. In a post it shows nothing on the page. You can remove it."
