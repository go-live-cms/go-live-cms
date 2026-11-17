import { createContext, useContext } from "react"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import type { AuthorProfile, Post, TaxonomyTerm } from "@gl-admin/lib/api/types"
import type { DateSettings } from "../../../lib/siteDates"
import type { BlockMedia } from "./responsiveImage"

/**
 * What the site blocks (#488, design `docs/design/theme-builder.md` 4.1–4.3) read on the
 * page. SSR fills it **before** the synchronous render (`src/lib/siteRenderContext.ts`
 * `loadSiteRenderContext`): React's server render can't wait for data, so every menu, the
 * logo and every part a template names are loaded first, and a block only looks its data
 * up here. Browser-safe: no Node or fetch imports, so the admin's revision preview can
 * render site blocks too (as nothing).
 *
 * **Outside a template or a part there is none, and every site block renders nothing**: a
 * post's body never gets one, so a site block written into a post's Yjs doc stores and
 * shows nothing (design 4.2). `BlockTemplateLayout` (#491) provides it; a post's own body
 * rendered inside a template (`post_content`, #489) must clear it again (`site={null}` on
 * its `BlockRenderer`), or that post's site blocks would come alive there.
 */

/** A menu link as `src/lib/menus.ts` normalizes it (every href checked), current page marked. */
export interface SiteMenuLink {
  id: number
  label: string
  url: string
  children: SiteMenuLink[]
  current?: boolean
}

export interface SiteMenu {
  name: string
  items: SiteMenuLink[]
}

export interface SiteRenderContext {
  /** Always true: a context that isn't for a template or a part is no context. */
  inTemplate: true
  /** A block template, or a part rendered inside one (a part can't hold a part). */
  kind: "template" | "part"
  /** Settings › General: the title and the tagline ("" = none). */
  site: { title: string; tagline: string }
  /** The site logo (`settings.site_logo_media_id`) with its media, or null for none. */
  logo: { media: BlockMedia; alt: string } | null
  /** Menus by theme location (`/public/menus/:location`); null when none is assigned or it failed. */
  menusByLocation: Readonly<Record<string, SiteMenu | null>>
  /**
   * Menus by id, only the ones a published template or part names, attached by the resolve
   * route (#491, design 3.3): no public route serves an arbitrary menu by id. Missing = the
   * menu was deleted, and the block renders nothing.
   */
  menusById: Readonly<Record<string, SiteMenu | null>>
  /** The resolved parts by slug (#491): the published override, the theme's, or core's starter. */
  parts: Readonly<Record<string, BlockDocV1 | null>>
  /** The page being rendered (its path), for `aria-current`. */
  currentPath?: string
  /** #489: what the route renders (its post, its list, its term, author or search). */
  route?: SiteRoute
  /** #489: the site's date settings (Settings › General), for `post_date`. */
  dates?: DateSettings
  /**
   * #489: each query block's posts, by `queryKey`, filled before the render (at most four per
   * page, design 4.3): an inheriting query's is the route's own list, any other's was read from
   * `/public/posts/type/:type`. Missing or null: over the four, failed or no list here, and
   * the block renders nothing.
   */
  queries?: Readonly<Record<string, SitePostList | null>>
  /**
   * #497: each `related_posts` block's posts, by `queryKey`, read from
   * `/public/posts/:id/related` for the route's post before the render. They count towards the
   * page's four data-reading blocks with the queries (design 4.3). Missing or null: over the
   * four, failed, or no post here, and the block renders nothing.
   */
  related?: Readonly<Record<string, SitePostList | null>>
  /** #489: the part being rendered, so a query in it finds its posts (`queryKey`). */
  partSlug?: string
  /**
   * #498: the theme's image `sizes` for a post's body in a column and wide (`config.imageSizes`),
   * which `post_content` passes on by its `width`; absent: `BlockRenderer`'s default.
   */
  imageSizes?: { column?: string; wide?: string }
  /**
   * #498: what else the page shows, for `post_facts`' `fallback` (the theme sidebar's rule): a
   * table of contents block, and a "In <term>" list (`related_posts` with `layout: "list"`) with posts.
   */
  pageShows?: { tableOfContents: boolean; categoryList: boolean }
}

/** A term with its archive's link and its taxonomy's label (`src/lib/termPage.ts` `linkTerms`). */
export type SiteLinkedTerm = TaxonomyTerm & { href?: string; taxonomy_label?: string }

/**
 * A post a post block shows (#489): a row of a list, or the route's own post. `post` carries
 * the published title, excerpt, dates, byline (`authors`) and the category in its URL.
 */
export interface SitePostItem {
  post: Post
  href: string
  /** The featured image's URL on this site, or null. */
  image: string | null
  /** The published terms, linked. A list row carries none yet, so `post_terms` shows nothing in a list. */
  terms?: SiteLinkedTerm[]
}

/** A list of posts (#489): the route's own (with its pages), or a query's (one page). */
export interface SitePostList {
  items: SitePostItem[]
  page: number
  totalPages: number
  /**
   * Page 1's URL (#349's: `/`, `/post`, `/category/guides`, `/author/ana`, `/search`), or null
   * for a query that isn't the page's own list: it has no pager, since two pagers can't share
   * one `/page/N/` URL (4.3).
   */
  basePath: string | null
  /** A query string every page link keeps (search's `?q=…`). */
  pageQuery?: string
  /** #498: how many posts the whole list has (every page), for `query_total`; absent for a query's. */
  total?: number
  /**
   * #498: a related posts list's term (`related_posts` with `layout: "list"`: "In <term>"), with
   * its archive's link when its taxonomy is public.
   */
  term?: { name: string; href?: string } | null
}

/** The route's post (#489): the item, its published body and what its end shows. */
export interface SiteRoutePost extends SitePostItem {
  /** The published blocks `post_content` renders. */
  blocks?: BlockDocV1 | null
  /** The credited authors (#350); the row's byline otherwise. */
  authors?: AuthorProfile[]
  /** Older and newer posts (#351), for `post_navigation`; null when they failed or there are none. */
  adjacent?: { previous: SitePostItem | null; next: SitePostItem | null; archiveHref: string; archiveLabel: string } | null
}

/** What a block template renders (design 3.2's route kinds), as `query_title` and the post blocks read it. */
export interface SiteRoute {
  kind: "home" | "front-page" | "single" | "page" | "archive" | "term" | "author" | "search" | "404"
  post?: SiteRoutePost | null
  /** The route's own list (archive, term, author, search, home), for an inheriting query. */
  list?: SitePostList | null
  /**
   * The term (#489), and (#498) its kind ("Category", "Tag") for `query_title`'s label, and how
   * the theme says a post belongs to it ("in Guides", "tagged Editor") for the list's count and end.
   */
  term?: { name: string; description?: string; label?: string; phrase?: string; hierarchical?: boolean } | null
  /** The author (#489), and (#498) their username, avatar, bio and website for the author page's blocks. */
  author?: { name: string; username?: string; avatar?: string | null; bio?: string; website?: string | null; websiteLabel?: string } | null
  /** The search (#489), and (#498) the results page's data for `search_results`. */
  search?: ({ query: string } & Partial<SiteSearchResults>) | null
  /** The listed post type's name, for an archive's `query_title`. */
  postType?: { name: string; label: string } | null
  /** #498: how many posts the route lists ("12 posts", "4 posts tagged Editor", "12 items"), for `query_total`. */
  count?: string
}

/** #498: one search result as the default theme lists it; the `Html` fields are `safeHighlight`ed (only `<mark>`). */
export interface SiteSearchResult {
  href: string
  typeLabel: string
  dateLabel: string
  titleHtml: string
  excerptHtml: string
}

/** #498: what `search_results` renders: the summary, the type chips, the results and their pager, or what to try. */
export interface SiteSearchResults {
  total: number
  /** "1 result", "4 results". */
  totalLabel: string
  page: number
  totalPages: number
  basePath: string
  pageQuery: string
  chips: { type: string; label: string; count: number; href: string; current: boolean }[]
  results: SiteSearchResult[]
  topics: { label: string; href: string }[]
  recent: { label: string; href: string }[]
}

export const SiteContext = createContext<SiteRenderContext | null>(null)

/** The context a site block renders from, or null, in which case it renders nothing. */
export function useSiteRenderContext(): SiteRenderContext | null {
  const site = useContext(SiteContext)
  return site?.inTemplate === true ? site : null
}

/** Where a query block's posts are kept in `queries`: its id, prefixed by its part's slug. */
export function queryKey(partSlug: string | undefined, blockId: string): string {
  return partSlug ? `part:${partSlug}:${blockId}` : blockId
}

/**
 * The ids the template's own renderer reserves (its `PageScope.reservedIds`), set by a
 * `template_part` for the part it renders (#497). The post's body (`post_content`) sits in the
 * template, never in a part, so its heading ids skip exactly these; a `table_of_contents` in a
 * part reads them here to link to the same ids (`usePostContentHeadings`).
 */
export const TemplateScopeContext = createContext<readonly (string | RegExp)[] | null>(null)

/** The list item a post template is rendering (#489), or null outside a post template. */
export const SitePostItemContext = createContext<SitePostItem | null>(null)

/** The query a pager, a post template or "no results" sits in (#489): its posts and whether it is the page's list. */
export const SiteQueryContext = createContext<{ list: SitePostList; inherit: boolean; layout?: "list" | "links" } | null>(null)

/**
 * The post a post block shows (#489): the list item when it sits in a post template, else the
 * route's post; `inList` says which. Null outside a template, or with neither.
 */
export function useSitePost(): { site: SiteRenderContext; item: SitePostItem | SiteRoutePost; inList: boolean } | null {
  const site = useSiteRenderContext()
  const listed = useContext(SitePostItemContext)
  if (!site) return null
  if (listed) return { site, item: listed, inList: true }
  const own = site.route?.post
  return own ? { site, item: own, inList: false } : null
}

/** "/", without the query or hash: what the home link and `aria-current` compare. */
export function isHomePath(path: string | undefined): boolean {
  return typeof path === "string" && path.startsWith("/") && path.split(/[?#]/)[0].replace(/\/+$/, "") === ""
}
