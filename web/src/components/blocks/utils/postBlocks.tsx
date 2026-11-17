import React, { useContext } from "react"
import { normalizeSiteBlockAttrs, normalizePostExcerptLength, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import BlockRenderer from "../../BlockRenderer"
import type { BlockComponentProps } from "../types"
import { bylinePeople } from "../../../lib/bylines"
import { firstParagraphText, metaDescription, postExcerpt } from "../../../lib/seo"
import { DEFAULT_DATE_SETTINGS, formatSiteDate } from "../../../lib/siteDates"
import { readingMinutes } from "../../../lib/readingTime"
import { HeadingIdsContext, headingAnchors, type HeadingAnchor } from "./headingAnchors"
import { PageScopeContext, SiteBlockTitleIdsContext } from "./pageScope"
import { PagerMarkup, ThemeByline } from "./themeMarkup"
import {
  queryKey,
  SitePostItemContext,
  SiteQueryContext,
  TemplateScopeContext,
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

const NO_HEADING_IDS: ReadonlyMap<string, string> = new Map()

// ── The query loop ─────────────────────────────────────────────────────────────────

/**
 * `query`: its post template, pager and "no results", for the posts the context holds for it.
 *
 * With `feature` (#498, the default theme's front page) the first post of the list's first page is
 * the featured post (`article.feature`: its image, "Latest", the title, a longer excerpt and the
 * byline), and the post template lists the rest under "More posts" ("Posts" on later pages), in a
 * section labelled by that heading. The pager and "no results" read the whole list.
 */
export const QueryBlock: React.FC<BlockComponentProps> = ({ block, doc, renderBlock, anchorId }) => {
  const site = useSiteRenderContext()
  const titleIds = useContext(SiteBlockTitleIdsContext)
  const list = site?.queries?.[queryKey(site.partSlug, block.id)]
  if (!site || !list) return null
  const attrs = normalizeSiteBlockAttrs("query", block.attrs)
  const value = { list, inherit: attrs.inherit === true, layout: attrs.layout === "links" ? ("links" as const) : ("list" as const) }
  const children = block.children ?? []
  if (attrs.feature !== true) {
    return (
      <div id={anchorId} className="query-loop">
        <SiteQueryContext.Provider value={value}>{children.map((id) => renderBlock(id))}</SiteQueryContext.Provider>
      </div>
    )
  }
  const [feature, ...rest] = list.page === 1 ? list.items : [undefined, ...list.items]
  const headingId = titleIds?.get(queryKey(site.partSlug, block.id)) ?? "more-posts"
  const restValue = { ...value, list: { ...list, items: rest.filter((item): item is SitePostItem => !!item) } }
  return (
    <div id={anchorId} className="query-loop">
      <SiteQueryContext.Provider value={value}>
        {children.map((id) =>
          doc.blocks[id]?.type === "post_template" ? (
            <React.Fragment key={id}>
              {feature && <FeaturedPost item={feature} />}
              {restValue.list.items.length > 0 && (
                <section aria-labelledby={headingId}>
                  <h2 id={headingId} className="section-title list-heading">
                    {list.page === 1 ? "More posts" : "Posts"}
                  </h2>
                  <SiteQueryContext.Provider value={restValue}>{renderBlock(id)}</SiteQueryContext.Provider>
                </section>
              )}
            </React.Fragment>
          ) : (
            renderBlock(id)
          ),
        )}
      </SiteQueryContext.Provider>
    </div>
  )
}

/** The front page's featured post (#498): the default theme's `article.feature`. */
function FeaturedPost({ item }: { item: SitePostItem }) {
  const site = useSiteRenderContext()
  const excerpt = postExcerpt(item.post, 260)
  return (
    <article className={item.image ? "feature has-media" : "feature"}>
      {item.image && (
        <a href={item.href} tabIndex={-1} aria-hidden="true">
          <img className="media" src={item.image} alt="" fetchPriority="high" decoding="async" />
        </a>
      )}
      <div className="feature-body">
        <span className="eyebrow">Latest</span>
        <h2 className="title feature-title">
          <a href={item.href}>{item.post.title}</a>
        </h2>
        {excerpt && <p className="post-item-excerpt feature-excerpt">{excerpt}</p>}
        <ThemeByline post={item.post} variant="list" minutes={readingMinutes(item.post.published_blocks)} dates={site?.dates} />
      </div>
    </article>
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
  // #498: titles only, the default theme's `ul.link-list` (the 404 page's recent posts).
  if (query.layout === "links") {
    return (
      <ul className="link-list">
        {query.list.items.map((item) => (
          <li key={item.post.id}>
            <a href={item.href}>{item.post.title}</a>
          </li>
        ))}
      </ul>
    )
  }
  const children = block.children ?? []
  const isMedia = (id: string) => doc.blocks[id]?.type === "post_featured_image"
  const body = children.filter((id) => !isMedia(id))
  const media = children.filter(isMedia)
  return (
    <ul className="post-list">
      {query.list.items.map((item) => (
        <li key={item.post.id} className={`post-item${media.length > 0 && item.image ? " has-media" : ""}`}>
          <SitePostItemContext.Provider value={item}>
            {/* The row's blocks repeat once per post, so a heading in them gets no id: one id per row would repeat. */}
            <HeadingIdsContext.Provider value={NO_HEADING_IDS}>
              <div className="post-item-body">{body.map((id) => renderBlock(id))}</div>
              {media.map((id) => renderBlock(id))}
            </HeadingIdsContext.Provider>
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
 *
 * With `end` (#498), a list of one page ends with the default theme's line that says it is all
 * ("That’s every post in Guides.", "… tagged Editor.", "… by Ana Costa.") and a link back to all posts.
 */
export const QueryPaginationBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const query = useContext(SiteQueryContext)
  const site = useSiteRenderContext()
  const list = query?.inherit ? query.list : null
  if (!list || list.basePath === null) return null
  if (list.totalPages <= 1) {
    const route = site?.route
    const phrase = route?.kind === "term" ? route.term?.phrase : route?.kind === "author" && route.author?.name ? `by ${route.author.name}` : undefined
    if (normalizeSiteBlockAttrs("query_pagination", block.attrs).end !== true || !phrase || list.items.length === 0) return null
    return (
      <p id={anchorId} className="meta list-end">
        {`That’s every post ${phrase}. `}
        <a href="/">Back to all posts</a>
      </p>
    )
  }
  return <PagerMarkup page={list.page} totalPages={list.totalPages} basePath={list.basePath} query={list.pageQuery ?? ""} anchorId={anchorId} />
}

// ── What the page lists ────────────────────────────────────────────────────────────

type SiteRouteOf = NonNullable<ReturnType<typeof useSiteRenderContext>>["route"]

/** The 404 page's title and line (#498), the default theme's. */
export const NOT_FOUND_TITLE = "This page isn’t here"
export const NOT_FOUND_TEXT = "The link may be old, or the post may have moved. Search for it, or start again from the front page."

/**
 * The page title `query_title` shows for the route (the default theme's, #498): the term's name, the
 * author's, "Search", the post type's, the site's title on the front page, the 404's line; null for
 * a route that has none of its own (a post's title is `post_title`'s).
 */
export function queryTitleText(route: SiteRouteOf, siteTitle = ""): string | null {
  if (!route) return null
  switch (route.kind) {
    case "term":
      return route.term?.name || null
    case "author":
      return route.author?.name || null
    case "search":
      return "Search"
    case "archive":
      return route.postType?.label || null
    case "home":
      return route.postType?.label || siteTitle || null
    case "404":
      return NOT_FOUND_TITLE
    default:
      return null
  }
}

/** The kind of page `query_title` shows as a label (#498): "Category", "Tag", "Author", "Error 404"; null elsewhere. */
export function queryLabelText(route: SiteRouteOf): string | null {
  switch (route?.kind) {
    case "term":
      return route.term?.label || null
    case "author":
      return "Author"
    case "404":
      return "Error 404"
    default:
      return null
  }
}

/**
 * `query_title`: the page's title (`h1.title`; on the search page `h1.title.search-title`), or with
 * `label` (#498) the kind of page above it (`span.eyebrow`; the 404's in the mono face).
 */
export const QueryTitleBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const site = useSiteRenderContext()
  const attrs = normalizeSiteBlockAttrs("query_title", block.attrs)
  if (attrs.label === true) {
    const label = site ? queryLabelText(site.route) : null
    if (!label) return null
    return (
      <span id={anchorId} className={site?.route?.kind === "404" ? "eyebrow eyebrow--mono" : "eyebrow"}>
        {label}
      </span>
    )
  }
  const text = site ? queryTitleText(site.route, site.site.title) : null
  if (!text) return null
  const Heading = attrs.level === 2 ? "h2" : "h1"
  return (
    <Heading id={anchorId} className={site?.route?.kind === "search" ? "title search-title" : "title"}>
      {text}
    </Heading>
  )
}

/**
 * `term_description`: the page's description (`p.dek`), as the default theme writes it (#498): the
 * term's, the author's bio (`p.dek.author-bio`, as written), the site's tagline on the front page
 * ("Page 2" on its later pages), the 404's line. Nothing where there is none.
 */
export const TermDescriptionBlock: React.FC<BlockComponentProps> = ({ anchorId }) => {
  const site = useSiteRenderContext()
  const route = site?.route
  if (!site || !route) return null
  if (route.kind === "author") {
    const bio = route.author?.bio
    return bio ? (
      <p id={anchorId} className="dek author-bio">
        {bio}
      </p>
    ) : null
  }
  const text =
    route.kind === "home"
      ? (route.list?.page ?? 1) > 1
        ? `Page ${route.list!.page}`
        : site.site.tagline
      : route.kind === "404"
        ? NOT_FOUND_TEXT
        : metaDescription(route.term?.description, 2000)
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

/** The route's post's published blocks (#489), or null in a list or without a post. */
export function routePostBlocks(shown: ReturnType<typeof useSitePost>): BlockDocV1 | null {
  const blocks = shown && !shown.inList ? (shown.item as SiteRoutePost).blocks : null
  return blocks && Array.isArray(blocks.blocks_order) && blocks.blocks_order.length > 0 ? blocks : null
}

/**
 * The heading ids `post_content` gives the post's body (#497), so a `table_of_contents` links to
 * exactly them: the body's headings skip the template's ids (its reserved ids, its own headings'
 * and the site blocks' titles: the page scope, #484), and a level-1 heading is an h2 (#481,
 * `headingLevel`). Both blocks read the template's scope: the one they sit in, or, in a part,
 * the template's (`TemplateScopeContext`), since `post_content` never sits in a part.
 */
export function usePostContentHeadings(blocks: BlockDocV1 | null): HeadingAnchor[] {
  const template = useContext(TemplateScopeContext)
  const page = useContext(PageScopeContext)
  return blocks ? headingAnchors(blocks, template ?? page?.reservedIds ?? []) : []
}

/**
 * `post_content`: the route's post's published blocks, with their own `b-<id>` anchors, in
 * `div.prose`. Rendered with **no** site context (`site={null}`), or the post's own site blocks
 * would come alive inside the template (design 4.2, 4.5). Its headings skip the ids the
 * template's already use (the page scope, #484), as `usePostContentHeadings` gives them. Nothing
 * in a list (a post template can't hold it) or without a post.
 */
export const PostContentBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const shown = useSitePost()
  const blocks = routePostBlocks(shown)
  const headings = usePostContentHeadings(blocks)
  if (!blocks) return null
  // #498: the theme's image `sizes` for the column the body sits in (`width`), as its layouts give them.
  const sizes = shown?.site.imageSizes
  const imageSizes = normalizeSiteBlockAttrs("post_content", block.attrs).width === "wide" ? sizes?.wide : sizes?.column
  return (
    <div id={anchorId} className="prose">
      <BlockRenderer doc={blocks} site={null} headings={headings} {...(imageSizes ? { imageSizes } : {})} />
    </div>
  )
}

/** The excerpt in `words` words: the post's excerpt, else its first paragraph, cut with "…". */
export function excerptWords(post: SitePostItem["post"], words: number): string {
  const text = metaDescription(post.description, 100_000) || metaDescription(firstParagraphText(post.published_blocks), 100_000)
  const all = text.split(/\s+/).filter(Boolean)
  return all.length <= words ? all.join(" ") : `${all.slice(0, words).join(" ")}…`
}

/**
 * `post_excerpt`. In a list (`p.post-item-excerpt`): `length` words when it is set, else the default
 * theme's (#498: the excerpt or the first paragraph, cut before 220 characters, `postExcerpt`). For
 * the page's own post (#498): its excerpt as the dek under the title (`p.dek`, up to 400
 * characters), only when it has one, as the theme's `PostHeader`.
 */
export const PostExcerptBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const shown = useSitePost()
  if (!shown) return null
  if (!shown.inList) {
    const dek = metaDescription(shown.item.post.description, 400)
    return dek ? (
      <p id={anchorId} className="dek">
        {dek}
      </p>
    ) : null
  }
  const length = normalizeSiteBlockAttrs("post_excerpt", block.attrs).length
  const text = typeof length === "number" ? excerptWords(shown.item.post, normalizePostExcerptLength(length)) : postExcerpt(shown.item.post, 220)
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
  // #498: the page's own image as the theme's `FeaturedImage` (`post-featured--column|wide|full`),
  // loaded first (`fetchpriority`): it is the top of the page.
  const width = typeof attrs.width === "string" ? attrs.width : "column"
  const img = <img className={aspect.trim() || undefined} src={image} alt="" fetchPriority="high" decoding="async" />
  return (
    <figure id={anchorId} className={`post-featured post-featured--${width}`}>
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

/**
 * `post_byline`: the default theme's `PostByline` (#498), `div.byline.meta.byline--post` for the page's
 * post ("By <names>" over the date and the reading time) and `byline--list` in a list (the names,
 * the short date and the reading time on one line). The credited names link to their pages; with
 * avatars unless set not to; with `date` (#498) the published date; with `readingTime` (#497)
 * " · 4 min read" (the published body's words at 220 a minute; nothing for a post without text).
 * Nothing when there is neither a name nor a date nor a reading time to show.
 */
export const PostBylineBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const shown = useSitePost()
  if (!shown) return null
  const credited = !shown.inList && (shown.item as SiteRoutePost).authors?.length ? (shown.item as SiteRoutePost).authors : shown.item.post.authors
  const attrs = normalizeSiteBlockAttrs("post_byline", block.attrs)
  const body = (!shown.inList ? (shown.item as SiteRoutePost).blocks : null) ?? shown.item.post.published_blocks
  const minutes = attrs.readingTime === true ? readingMinutes(body) : null
  const date = attrs.date === true
  if (bylinePeople(credited, shown.item.post).length === 0 && !date && !minutes) return null
  return (
    <ThemeByline
      anchorId={anchorId}
      post={shown.item.post}
      credited={credited}
      variant={shown.inList ? "list" : "post"}
      avatars={attrs.avatars !== false}
      date={date}
      minutes={minutes}
      dates={shown.site.dates}
    />
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
  const attrs = normalizeSiteBlockAttrs("post_terms", block.attrs)
  // #498: every taxonomy's chips, one group each in the order they come, as the theme's `PostTerms`.
  if (attrs.all === true) {
    const groups = new Map<string, SiteLinkedTerm[]>()
    for (const term of shown.item.terms ?? []) {
      const type = term.taxonomy_type_name || "terms"
      groups.set(type, [...(groups.get(type) ?? []), term])
    }
    if (groups.size === 0) return null
    return (
      <dl id={anchorId} className="post-terms">
        {[...groups].map(([type, list]) => (
          <div key={type} className={`tag-row post-terms__group post-terms__group--${type}`}>
            <dt className="section-title">{list.find((term) => term.taxonomy_label)?.taxonomy_label ?? type}</dt>
            {list.map((term) => termChip(term))}
          </div>
        ))}
      </dl>
    )
  }
  const taxonomy = (attrs.taxonomy as string | undefined) ?? "category"
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
        {terms.map((term) => termChip(term))}
      </div>
    </dl>
  )
}

/** One term as `PostTerms`' chip: a link to its archive when its taxonomy is public, else plain. */
function termChip(term: SiteLinkedTerm) {
  return term.href ? (
    <dd key={term.id} className="post-terms__term" data-slug={term.slug}>
      <a className="chip" href={term.href}>
        {term.name}
      </a>
    </dd>
  ) : (
    <dd key={term.id} className="chip post-terms__term" data-slug={term.slug}>
      {term.name}
    </dd>
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
