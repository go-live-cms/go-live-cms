/**
 * What `src/layouts/BlockTemplateLayout.astro` (#491, design `docs/design/theme-builder.md` 3.4)
 * computes from the props of the code layout it replaces: the head (`SeoHead` gets exactly
 * what the theme's layout would give it), and the route a block template's site blocks read
 * (`SiteRoute`: the post, the list, the term, author or search). The route file computes
 * those props as it always has; nothing here fetches what it already loaded, so an inheriting
 * query reuses the route's own list and its pager keeps #349's URLs.
 */
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import type { AuthorProfile, Post } from "@gl-admin/lib/api/types"
import type { SitePostItem, SitePostList, SiteRoute, SiteRoutePost } from "@/components/blocks/utils/siteContext"
import { getAdjacentPosts } from "./api"
import { log } from "./log"
import { listSeo, toListedPost, type PostListData } from "./postList"
import type { SearchPageData } from "./search"
import { normalizeUrlStructure, postPath, type SeoMeta } from "./seo"
import type { LinkedTerm, PublicTerm } from "./termPage"
import type { TemplateRoute } from "./siteTemplates"
import type { ThemeTokenConfig } from "./themeTokens"

export type BlockTemplateKind = TemplateRoute["kind"]

/** Element ids the generic layout's own markup uses (`main#content`): no heading of a template or a post takes one. */
export const TEMPLATE_ELEMENT_IDS: readonly string[] = ["content"]

/** The props a route passes to the code layout of each kind (themes/README.md "Layout Props"). */
export interface PostLayoutProps {
  post: Post
  title: string
  description: string
  seo?: SeoMeta
  terms?: LinkedTerm[]
  authors?: AuthorProfile[]
  featuredImage?: string | null
  siteTitle?: string
  urlStructure?: string
}
export interface HomeLayoutProps {
  title: string
  description: string
  list: PostListData
}
export interface ArchiveLayoutProps extends HomeLayoutProps {
  heading: string
  postType: string
}
export interface TermLayoutProps extends HomeLayoutProps {
  term: PublicTerm
  postCount: number
  seo?: SeoMeta
}
export interface AuthorLayoutProps extends HomeLayoutProps {
  author: AuthorProfile
  postCount: number
  seo?: SeoMeta
}
export interface SearchLayoutProps extends SearchPageData {
  title: string
  description: string
  seo?: SeoMeta
}
export interface ErrorLayoutProps {
  status: number
  title: string
  message: string
  detail?: string
}

export type LayoutPropsOf<K extends BlockTemplateKind> = K extends "single" | "page" | "front-page"
  ? PostLayoutProps
  : K extends "home"
    ? HomeLayoutProps
    : K extends "archive"
      ? ArchiveLayoutProps
      : K extends "term"
        ? TermLayoutProps
        : K extends "author"
          ? AuthorLayoutProps
          : K extends "search"
            ? SearchLayoutProps
            : ErrorLayoutProps

export interface TemplateHead {
  title: string
  description: string
  seo: SeoMeta
}

/**
 * The head the theme's code layout of this kind gives `SeoHead` (the default theme's, which
 * every code theme's falls back to): the route's `seo` where the route computes it (posts,
 * pages, terms, authors, search), the list's canonical and neighbours where the layout does
 * (home, archive: `listSeo`), and the error layout's title and noindex for the 404.
 */
export function templateHead(kind: BlockTemplateKind, props: Record<string, unknown>, siteTitle: string): TemplateHead {
  switch (kind) {
    case "home":
    case "archive": {
      const p = props as unknown as HomeLayoutProps
      return { title: p.title, description: p.description, seo: listSeo(p.list) }
    }
    case "404": {
      const p = props as unknown as ErrorLayoutProps
      return { title: `${p.title} | ${siteTitle}`, description: p.message, seo: { noindex: true } }
    }
    default: {
      const p = props as { title: string; description: string; seo?: SeoMeta }
      return { title: p.title, description: p.description, seo: p.seo ?? {} }
    }
  }
}

/** A route's list (#349) as the site blocks read it. */
export function siteListOf(list: PostListData | null | undefined): SitePostList | null {
  if (!list) return null
  return {
    items: list.posts.map((item) => ({ post: item.post, href: item.href, image: item.image })),
    page: list.page,
    totalPages: list.totalPages,
    basePath: list.basePath,
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" }

/** A highlight's text: no `<mark>`, entities read (React escapes it again on the page). */
function plainHighlight(html: string): string {
  return html.replace(/<\/?mark>/g, "").replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, name: string) => ENTITIES[name])
}

/** Search results as a list (`query` with `inherit` on the search route), with the pager keeping `?q=`. */
export function searchListOf(data: SearchPageData): SitePostList {
  return {
    items: data.results.map((result) => ({
      post: {
        id: result.hit.id,
        title: plainHighlight(result.hit.title_html) || result.hit.title,
        slug: result.hit.slug,
        post_type: result.hit.post_type,
        created_at: result.hit.created_at,
        changed_at: result.hit.changed_at,
        description: plainHighlight(result.hit.excerpt_html),
      } as Post,
      href: result.href,
      image: null,
    })),
    page: data.page,
    totalPages: data.totalPages,
    basePath: data.basePath,
    pageQuery: data.pageQuery,
  }
}

/** Whether any of the docs has a block of this type (at any depth). */
export function docsUse(docs: Iterable<BlockDocV1 | null | undefined>, type: string): boolean {
  for (const doc of docs) {
    const blocks = doc?.blocks && typeof doc.blocks === "object" ? Object.values(doc.blocks) : []
    if (blocks.some((block) => block?.type === type)) return true
  }
  return false
}

/** The newest post's "Back to" link: its type's list (the default theme's `archiveLink`). */
export function archiveLinkOf(postType: string): { href: string; label: string } {
  return { href: `/${encodeURIComponent(postType)}`, label: postType === "post" ? "All posts" : `All ${postType}` }
}

/** What reads a post's older and newer posts (tests pass their own). */
export type AdjacentReader = typeof getAdjacentPosts

/**
 * Older and newer posts for `post_navigation` (#351), or null when the read fails (logged, the
 * block renders nothing) or there are none.
 */
export async function loadTemplateAdjacent(
  post: Post,
  postType: string,
  urlStructure: unknown,
  siteUrl: string,
  read: AdjacentReader = getAdjacentPosts,
): Promise<SiteRoutePost["adjacent"]> {
  try {
    const adjacent = await read(post.id)
    const structure = normalizeUrlStructure(urlStructure)
    const listed = async (row: Post | null | undefined): Promise<SitePostItem | null> => (row ? toListedPost(row, postType, structure, siteUrl) : null)
    const [previous, next] = await Promise.all([listed(adjacent?.previous), listed(adjacent?.next)])
    const archive = archiveLinkOf(postType)
    return { previous, next, archiveHref: archive.href, archiveLabel: archive.label }
  } catch (error) {
    log.warn("site_block_data_failed", { block_type: "post_navigation", count: 1, error })
    return null
  }
}

export interface TemplateRouteOptions {
  /** The template's and its parts' docs: what the route needs depends on the blocks they hold. */
  docs: readonly (BlockDocV1 | null | undefined)[]
  siteUrl: string
  /** The site's URL setting, when the props don't carry it. */
  urlStructure?: unknown
  readAdjacent?: AdjacentReader
}

/**
 * The route a block template's site blocks read (#489's `SiteRoute`), from the code layout's
 * props: nothing is fetched twice. The only read is a post's older and newer posts, and only
 * when a `post_navigation` block is there to show them.
 */
export async function templateSiteRoute(kind: BlockTemplateKind, props: Record<string, unknown>, options: TemplateRouteOptions): Promise<SiteRoute> {
  switch (kind) {
    case "single":
    case "page":
    case "front-page": {
      const p = props as unknown as PostLayoutProps
      const postType = p.post.post_type || (kind === "single" ? "post" : "page")
      const structure = p.urlStructure ?? options.urlStructure
      const href = kind === "front-page" ? "/" : postPath({ ...p.post, post_type: postType }, normalizeUrlStructure(structure))
      const adjacent = docsUse(options.docs, "post_navigation")
        ? await loadTemplateAdjacent(p.post, postType, structure, options.siteUrl, options.readAdjacent)
        : null
      return {
        kind,
        post: {
          post: p.post,
          href,
          image: p.featuredImage ?? null,
          terms: p.terms ?? [],
          blocks: p.post.published_blocks ?? null,
          authors: p.authors ?? [],
          adjacent,
        },
      }
    }
    case "home": {
      const p = props as unknown as HomeLayoutProps
      return { kind, list: siteListOf(p.list) }
    }
    case "archive": {
      const p = props as unknown as ArchiveLayoutProps
      return { kind, list: siteListOf(p.list), postType: { name: p.postType, label: p.heading } }
    }
    case "term": {
      const p = props as unknown as TermLayoutProps
      return { kind, list: siteListOf(p.list), term: { name: p.term.name, description: p.term.description } }
    }
    case "author": {
      const p = props as unknown as AuthorLayoutProps
      return { kind, list: siteListOf(p.list), author: { name: p.author.full_name?.trim() || p.author.username } }
    }
    case "search": {
      const p = props as unknown as SearchLayoutProps
      return { kind, list: searchListOf(p), search: { query: p.query } }
    }
    case "404":
      return { kind }
  }
}

// The themes' configs in this build, as the middleware loads them (THEME_CONFIGS).
const THEME_CONFIGS = import.meta.glob<Record<string, any>>("../../themes/*/theme.config.ts")

/** The active theme's `theme.config.ts`, or null when it isn't in this build (logged by the middleware already). */
export async function activeThemeConfig(themeSlug: string | undefined): Promise<ThemeTokenConfig | null> {
  const load = THEME_CONFIGS[`../../themes/${themeSlug || "default"}/theme.config.ts`]
  if (!load) return null
  try {
    const module = await load()
    return ((module.themeConfig || module.default) as ThemeTokenConfig | undefined) ?? null
  } catch (error) {
    log.warn("theme_config_load_failed", { theme: themeSlug, error })
    return null
  }
}
