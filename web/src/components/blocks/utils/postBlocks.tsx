import React, { useContext } from "react"
import { normalizeSiteBlockAttrs, normalizePostExcerptLength } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../../BlockRenderer"
import type { BlockComponentProps } from "../types"
import { bylinePeople, nameSeparator, avatarColor, initial } from "../../../lib/bylines"
import { pageLinks, pagePath, pageWindow } from "../../../lib/pagination"
import { firstParagraphText, metaDescription } from "../../../lib/seo"
import { DEFAULT_DATE_SETTINGS, formatSiteDate } from "../../../lib/siteDates"
import {
  queryKey,
  SitePostItemContext,
  SiteQueryContext,
  useSitePost,
  useSiteRenderContext,
  type SiteLinkedTerm,
  type SitePostItem,
  type SiteRoutePost,
} from "./siteContext"

/**
 * Site blocks II (#489, design `docs/design/theme-builder.md` 4.1-4.3; the blocks canvas's
 * "Published site blocks" and the default theme canvas's "Site blocks" boards): the query loop
 * and the post blocks. Each renders the markup of the default theme component it stands for
 * (`PostListItem`, `Pagination.astro`, `PostByline`, `PostTerms`, `PostNav`, `FeaturedImage`), so
 * the theme styles a block template and its own layouts the same way (3.5).
 *
 * They read only the `SiteRenderContext` (`siteContext.ts`), filled before the synchronous
 * render (`src/lib/siteRenderContext.ts`): the route's post and list, each query's posts.
 * **Outside a template they render nothing**, so in a post's body they are inert (4.2). A query
 * whose posts aren't in the context (it failed, or it is over the page's four) renders nothing
 * at all, pager and "no results" included: the rest of the page renders.
 */

// ── The query loop ─────────────────────────────────────────────────────────────────

/** `query`: its post template, pager and "no results", for the posts the context holds for it. */
export const QueryBlock: React.FC<BlockComponentProps> = ({ block, renderBlock, anchorId }) => {
  const site = useSiteRenderContext()
  const list = site?.queries?.[queryKey(site.partSlug, block.id)]
  if (!site || !list) return null
  const inherit = normalizeSiteBlockAttrs("query", block.attrs).inherit === true
  return (
    <div id={anchorId} className="query-loop">
      <SiteQueryContext.Provider value={{ list, inherit }}>{(block.children ?? []).map((id) => renderBlock(id))}</SiteQueryContext.Provider>
    </div>
  )
}

/**
 * `post_template`: one `li.post-item` per post, its blocks rendered for that post. A featured
 * image placed directly in it goes in the row's media slot, after the body (`a.post-item-media`,
 * as `PostListItem` puts it), and the row gets `has-media` when that post has an image.
 */
export const PostTemplateBlock: React.FC<BlockComponentProps> = ({ block, doc, renderBlock }) => {
  const query = useContext(SiteQueryContext)
  if (!query || query.list.items.length === 0) return null
  const children = block.children ?? []
  const isMedia = (id: string) => doc.blocks[id]?.type === "post_featured_image"
  const body = children.filter((id) => !isMedia(id))
  const media = children.filter(isMedia)
  return (
    <ul className="post-list">
      {query.list.items.map((item) => (
        <li key={item.post.id} className={`post-item${media.length > 0 && item.image ? " has-media" : ""}`}>
          <SitePostItemContext.Provider value={item}>
            <div className="post-item-body">{body.map((id) => renderBlock(id))}</div>
            {media.map((id) => renderBlock(id))}
          </SitePostItemContext.Provider>
        </li>
      ))}
    </ul>
  )
}

/** `query_no_results`: its blocks, only when the query found no posts. */
export const QueryNoResultsBlock: React.FC<BlockComponentProps> = ({ block, renderBlock }) => {
  const query = useContext(SiteQueryContext)
  if (!query || query.list.items.length > 0) return null
  return <div className="query-no-results">{(block.children ?? []).map((id) => renderBlock(id))}</div>
}

/**
 * `query_pagination`: #349's pager, the markup and URLs of `Pagination.astro` (page 1 is the
 * list's own URL, page N `<base>/page/N/`). Only for a query that uses the page's own list: a
 * query of chosen posts has no pager, since two pagers can't share one `/page/N/` URL (4.3).
 */
export const QueryPaginationBlock: React.FC<BlockComponentProps> = ({ anchorId }) => {
  const query = useContext(SiteQueryContext)
  const list = query?.inherit ? query.list : null
  if (!list || list.basePath === null || list.totalPages <= 1) return null
  const { page, totalPages, basePath } = list
  const withQuery = (href: string) => `${href}${list.pageQuery ?? ""}`
  const links = pageLinks(basePath, page, totalPages)
  return (
    <nav id={anchorId} className="pagination" aria-label="Pages">
      {links.newer ? (
        <a href={withQuery(links.newer)} className="page-link" rel="prev">
          <span aria-hidden="true">←</span> Newer
        </a>
      ) : (
        <span className="page-link is-disabled" aria-hidden="true">
          ← Newer
        </span>
      )}
      {pageWindow(page, totalPages).map((slot, i) =>
        slot === "gap" ? (
          <span key={`gap-${i}`} className="page-link page-num" aria-hidden="true">
            …
          </span>
        ) : (
          <a key={slot} href={withQuery(pagePath(basePath, slot))} className="page-link page-num" aria-label={`Page ${slot}`} aria-current={slot === page ? "page" : undefined}>
            {slot}
          </a>
        ),
      )}
      <span className="page-status">
        Page {page} of {totalPages}
      </span>
      {links.older ? (
        <a href={withQuery(links.older)} className="page-link" rel="next">
          Older <span aria-hidden="true">→</span>
        </a>
      ) : (
        <span className="page-link is-disabled" aria-hidden="true">
          Older →
        </span>
      )}
    </nav>
  )
}

// ── What the page lists ────────────────────────────────────────────────────────────

/** The heading `query_title` shows for the route, or null for a route that lists nothing. */
export function queryTitleText(route: NonNullable<ReturnType<typeof useSiteRenderContext>>["route"]): string | null {
  if (!route) return null
  switch (route.kind) {
    case "term":
      return route.term?.name || null
    case "author":
      return route.author?.name ? `Posts by ${route.author.name}` : null
    case "search":
      return route.search?.query ? `Search results for “${route.search.query}”` : "Search results"
    case "archive":
    case "home":
      return route.postType?.label || null
    default:
      return null
  }
}

/** `query_title`: "Guides", "Posts by Ana Costa", "Search results for “alt text”", a type's name (`h1.title`). */
export const QueryTitleBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const site = useSiteRenderContext()
  const text = site ? queryTitleText(site.route) : null
  if (!text) return null
  const Heading = normalizeSiteBlockAttrs("query_title", block.attrs).level === 2 ? "h2" : "h1"
  return (
    <Heading id={anchorId} className="title">
      {text}
    </Heading>
  )
}

/** `term_description`: the route's term's description (`p.dek`); nothing for a term without one. */
export const TermDescriptionBlock: React.FC<BlockComponentProps> = ({ anchorId }) => {
  const site = useSiteRenderContext()
  const text = metaDescription(site?.route?.term?.description, 2000)
  if (!text) return null
  return (
    <p id={anchorId} className="dek">
      {text}
    </p>
  )
}

// ── The post blocks: the route's post, or each post of a post template ─────────────

/** `post_title`: an H1 for the page's own post (`h1.title`), an H3 linking to it in a list (`h3.post-item-title`). */
export const PostTitleBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const shown = useSitePost()
  if (!shown || !shown.item.post.title) return null
  const attrs = normalizeSiteBlockAttrs("post_title", block.attrs)
  const level = (attrs.level as number | undefined) ?? (shown.inList ? 3 : 1)
  const link = (attrs.link as boolean | undefined) ?? shown.inList
  const Heading = `h${level}` as "h1" | "h2" | "h3" | "h4"
  const title = shown.item.post.title
  return (
    <Heading id={anchorId} className={shown.inList ? "post-item-title" : "title"}>
      {link ? <a href={shown.item.href}>{title}</a> : title}
    </Heading>
  )
}

/**
 * `post_content`: the route's post's published blocks, with their own `b-<id>` anchors, in
 * `div.prose`. Rendered with **no** site context (`site={null}`), or the post's own site blocks
 * would come alive inside the template (design 4.2, 4.5). Its headings skip the ids the
 * template's already use (the page scope, #484). Nothing in a list (a post template can't
 * hold it) or without a post.
 */
export const PostContentBlock: React.FC<BlockComponentProps> = ({ anchorId }) => {
  const shown = useSitePost()
  const blocks = shown && !shown.inList ? (shown.item as SiteRoutePost).blocks : null
  if (!blocks || !Array.isArray(blocks.blocks_order) || blocks.blocks_order.length === 0) return null
  return (
    <div id={anchorId} className="prose">
      <BlockRenderer doc={blocks} site={null} />
    </div>
  )
}

/** The excerpt in `words` words: the post's excerpt, else its first paragraph, cut with "…". */
export function excerptWords(post: SitePostItem["post"], words: number): string {
  const text = metaDescription(post.description, 100_000) || metaDescription(firstParagraphText(post.published_blocks), 100_000)
  const all = text.split(/\s+/).filter(Boolean)
  return all.length <= words ? all.join(" ") : `${all.slice(0, words).join(" ")}…`
}

/** `post_excerpt` (`p.post-item-excerpt`). */
export const PostExcerptBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const shown = useSitePost()
  if (!shown) return null
  const text = excerptWords(shown.item.post, normalizePostExcerptLength(normalizeSiteBlockAttrs("post_excerpt", block.attrs).length))
  if (!text) return null
  return (
    <p id={anchorId} className="post-item-excerpt">
      {text}
    </p>
  )
}

/**
 * `post_featured_image`: in a list the row's media (`a.post-item-media`, as `PostListItem`), on
 * the page `figure.post-featured`. Decorative (`alt=""`), beside the title it illustrates, as
 * the theme's. A shape crops it (`is-aspect-16-9`, …). Nothing for a post without one.
 */
export const PostFeaturedImageBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const shown = useSitePost()
  if (!shown?.item.image) return null
  const attrs = normalizeSiteBlockAttrs("post_featured_image", block.attrs)
  const aspect = typeof attrs.aspect === "string" ? ` is-aspect-${attrs.aspect}` : ""
  const { href, image } = shown.item
  if (shown.inList) {
    const img = <img className={`media${aspect}`} src={image} alt="" loading="lazy" decoding="async" />
    return attrs.link === true ? (
      <a id={anchorId} href={href} tabIndex={-1} aria-hidden="true" className="post-item-media">
        {img}
      </a>
    ) : (
      <div id={anchorId} className="post-item-media">
        {img}
      </div>
    )
  }
  const img = <img className={aspect.trim() || undefined} src={image} alt="" decoding="async" />
  return (
    <figure id={anchorId} className="post-featured">
      {attrs.link === true ? (
        <a href={href} tabIndex={-1} aria-hidden="true">
          {img}
        </a>
      ) : (
        img
      )}
    </figure>
  )
}

/** A post's date, published or last changed (a never-changed post's is its published one). */
export function postDateOf(post: SitePostItem["post"], which: "published" | "modified"): Date | null {
  const published = new Date(post.created_at)
  if (which === "modified") {
    const changed = new Date(post.changed_at)
    if (!Number.isNaN(changed.getTime()) && changed.getUTCFullYear() > 1 && !(changed < published)) return changed
  }
  return Number.isNaN(published.getTime()) ? null : published
}

/** `post_date`: the site's date format (`formatSiteDate`), `p.meta > time`; "Updated …" for the modified date. */
export const PostDateBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const shown = useSitePost()
  if (!shown) return null
  const attrs = normalizeSiteBlockAttrs("post_date", block.attrs)
  const which = attrs.which === "modified" ? "modified" : "published"
  const date = postDateOf(shown.item.post, which)
  if (!date) return null
  const label = formatSiteDate(date, shown.site.dates ?? DEFAULT_DATE_SETTINGS, attrs.format === "short" ? "short" : "long")
  return (
    <p id={anchorId} className="meta post-date">
      {which === "modified" && "Updated "}
      <time dateTime={date.toISOString()}>{label}</time>
    </p>
  )
}

/** `post_byline`: `div.byline.meta`, the credited names linking to their pages, with avatars unless set not to. */
export const PostBylineBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const shown = useSitePost()
  if (!shown) return null
  const credited = !shown.inList && (shown.item as SiteRoutePost).authors?.length ? (shown.item as SiteRoutePost).authors : shown.item.post.authors
  const people = bylinePeople(credited, shown.item.post)
  if (people.length === 0) return null
  const avatars = normalizeSiteBlockAttrs("post_byline", block.attrs).avatars !== false
  const size = shown.inList ? 28 : 36
  const names = people.map((p, i) => (
    <React.Fragment key={p.key + i}>
      {nameSeparator(i, people.length)}
      {p.href ? <a href={p.href}>{p.name}</a> : p.name}
    </React.Fragment>
  ))
  return (
    <div id={anchorId} className="byline meta">
      {avatars && (
        <span className="avatars" aria-hidden="true">
          {people.slice(0, 3).map((p, i) => (
            <span key={p.key + i} className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.4), background: avatarColor(p.key) }}>
              {p.avatar ? <img src={p.avatar} alt="" width={size} height={size} loading="lazy" decoding="async" /> : initial(p.name)}
            </span>
          ))}
        </span>
      )}
      <span>{avatars ? names : <>By {names}</>}</span>
    </div>
  )
}

/**
 * `post_terms`: the category as the eyebrow (`a.eyebrow`, `PostHeader`'s), any other taxonomy as
 * `dl.post-terms` chips (`PostTerms`'). Nothing for a post without terms of it (a list row
 * carries no terms yet).
 */
export const PostTermsBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const shown = useSitePost()
  if (!shown) return null
  const taxonomy = (normalizeSiteBlockAttrs("post_terms", block.attrs).taxonomy as string | undefined) ?? "category"
  const terms: SiteLinkedTerm[] = (shown.item.terms ?? []).filter((term) => term.taxonomy_type_name === taxonomy)
  if (terms.length === 0) return null
  if (taxonomy === "category") {
    const term = terms[0]
    return term.href ? (
      <a id={anchorId} className="eyebrow" href={term.href}>
        {term.name}
      </a>
    ) : (
      <span id={anchorId} className="eyebrow">
        {term.name}
      </span>
    )
  }
  return (
    <dl id={anchorId} className="post-terms">
      <div className={`tag-row post-terms__group post-terms__group--${taxonomy}`}>
        <dt className="section-title">{terms[0].taxonomy_label ?? taxonomy}</dt>
        {terms.map((term) =>
          term.href ? (
            <dd key={term.id} className="post-terms__term" data-slug={term.slug}>
              <a className="chip" href={term.href}>
                {term.name}
              </a>
            </dd>
          ) : (
            <dd key={term.id} className="chip post-terms__term" data-slug={term.slug}>
              {term.name}
            </dd>
          ),
        )}
      </div>
    </dl>
  )
}

/** `post_navigation`: older and newer posts (`nav.post-nav`, `PostNav`'s); the newest links back to its list. */
export const PostNavigationBlock: React.FC<BlockComponentProps> = ({ anchorId }) => {
  const shown = useSitePost()
  const adjacent = shown && !shown.inList ? (shown.item as SiteRoutePost).adjacent : null
  if (!adjacent) return null
  const { previous, next } = adjacent
  return (
    <nav id={anchorId} className="post-nav" aria-label="More posts">
      {previous && (
        <a href={previous.href} className="post-nav-link" rel="prev">
          <span>← Older post</span>
          {previous.post.title}
        </a>
      )}
      {next ? (
        <a href={next.href} className="post-nav-link is-next" rel="next">
          <span>Newer post →</span>
          {next.post.title}
        </a>
      ) : (
        <a href={adjacent.archiveHref} className="post-nav-link is-next">
          <span>Back to</span>
          {adjacent.archiveLabel} →
        </a>
      )}
    </nav>
  )
}
