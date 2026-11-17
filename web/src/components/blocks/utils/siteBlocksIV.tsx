import React from "react"
import { normalizeSiteBlockAttrs } from "@gl-admin/lib/blocks-spec"
import { safeAvatarSrc } from "@gl-admin/lib/presence"
import type { BlockComponentProps } from "../types"
import { avatarColor, initial } from "../../../lib/bylines"
import { readingMinutes } from "../../../lib/readingTime"
import { safeHighlight } from "../../../lib/searchHighlight"
import { DEFAULT_DATE_SETTINGS, formatSiteDate, siteDay } from "../../../lib/siteDates"
import { tableOfContents } from "./headingAnchors"
import { routePostBlocks, usePostContentHeadings } from "./postBlocks"
import { useSitePost, useSiteRenderContext } from "./siteContext"
import { PagerMarkup } from "./themeMarkup"

/**
 * Site blocks IV (#498, design `docs/design/theme-builder.md` 5.7's "As built (T17)"): the pieces of
 * the default theme's layouts the other site blocks didn't cover, so its block templates render
 * what its code layouts did. Each renders **the markup of the theme's own**, compared element by
 * element on the same data (`themes/default/siteBlocksMarkup.astro.test.ts`):
 *
 * - `query_total`: the list header's count (`p.meta`: "12 items", "Page 2 · 14 posts", "4 posts
 *   tagged Editor"), and on an author's page their website.
 * - `author_avatar`: the author page's avatar (`span.avatar.author-header__avatar`, 96 px).
 * - `search_results`: the search page's results (`search-summary`, the type chips, `ol.search-results`
 *   with the highlights, the pager) or, with none, what to try (`search-empty`, topics, recent posts).
 * - `post_facts`: the sidebar's dates and reading time (`dl.post-facts`).
 * - `site_copyright` and `golive_credit`: the footer's last row.
 *
 * Like every site block they read only the `SiteRenderContext`, and render nothing outside a template.
 */

/** `query_total`: how many the route lists (`route.count`), "Page N · " first on a later page; an author's website after it. */
export const QueryTotalBlock: React.FC<BlockComponentProps> = ({ anchorId }) => {
  const site = useSiteRenderContext()
  const route = site?.route
  const count = route?.count
  if (!count) return null
  const page = route.list?.page ?? 1
  const website = route.kind === "author" ? route.author?.website : null
  return (
    <p id={anchorId} className="meta">
      {page > 1 ? `Page ${page} · ${count}` : count}
      {website && (
        <>
          {" · "}
          <a href={website} rel="me noopener">
            {route.author?.websiteLabel ?? website}
          </a>
        </>
      )}
    </p>
  )
}

/** `author_avatar`: the author's photo (an API avatar path only, `safeAvatarSrc`), else their initial on their colour. */
export const AuthorAvatarBlock: React.FC<BlockComponentProps> = ({ anchorId }) => {
  const site = useSiteRenderContext()
  const author = site?.route?.kind === "author" ? site.route.author : null
  if (!author) return null
  const src = safeAvatarSrc(author.avatar ?? undefined)
  return (
    <span id={anchorId} className="avatar author-header__avatar" aria-hidden="true" style={{ background: avatarColor(author.username ?? author.name) }}>
      {src ? <img src={src} alt="" width="96" height="96" decoding="async" /> : initial(author.name)}
    </span>
  )
}

/**
 * `search_results`: the search page's results, as the default theme lists them. The highlights
 * go through `safeHighlight` again here, as the code layout does (only `<mark>` survives, #145), the only
 * markup the page takes from the API; the query itself is only ever text. Nothing for an empty query.
 */
export const SearchResultsBlock: React.FC<BlockComponentProps> = ({ anchorId }) => {
  const site = useSiteRenderContext()
  const search = site?.route?.kind === "search" ? site.route.search : null
  if (!search || !search.results) return null
  const { query, results } = search
  const total = search.total ?? 0
  const hasResults = results.length > 0
  const isEmpty = query !== "" && total === 0
  if (!hasResults && !isEmpty) return null
  return (
    <div id={anchorId} className="search-results-block">
      {hasResults && (
        <>
          <div className="search-summary">
            <p role="status" className="meta">
              <strong>{search.totalLabel}</strong>
              {` for “${query}”`}
              {(search.page ?? 1) > 1 && ` · Page ${search.page}`}
            </p>
            <nav aria-label="Filter results" className="search-chips">
              {(search.chips ?? []).map((chip) => (
                <a key={chip.type} href={chip.href} className="chip" aria-current={chip.current ? "page" : undefined}>
                  {`${chip.label} `}
                  <span className="chip-count">{chip.count}</span>
                </a>
              ))}
            </nav>
          </div>
          <ol className="search-results">
            {results.map((result, i) => (
              <li key={`${result.href}-${i}`} className="search-result">
                <span className="meta search-result-meta">
                  <span className="eyebrow">{result.typeLabel}</span>
                  {result.dateLabel && ` · ${result.dateLabel}`}
                </span>
                <h2 className="post-item-title search-result-title">
                  <a href={result.href} dangerouslySetInnerHTML={{ __html: safeHighlight(result.titleHtml) }} />
                </h2>
                {result.excerptHtml && <p className="search-result-excerpt" dangerouslySetInnerHTML={{ __html: safeHighlight(result.excerptHtml) }} />}
                <span className="search-result-path">{result.href}</span>
              </li>
            ))}
          </ol>
          <PagerMarkup page={search.page ?? 1} totalPages={search.totalPages ?? 1} basePath={search.basePath ?? "/search"} query={search.pageQuery ?? ""} previousLabel="Previous" nextLabel="Next" />
        </>
      )}
      {isEmpty && (
        <>
          <div role="status" className="search-empty">
            <h2 className="search-empty-title">{`No results for “${query}”`}</h2>
            <ul className="meta search-tips">
              <li>Check the spelling, or try fewer words.</li>
              <li>Search looks at the titles, text and tags of posts and pages.</li>
            </ul>
          </div>
          {(search.topics ?? []).length > 0 && (
            <section aria-labelledby="search-topics" className="search-section">
              <h2 id="search-topics" className="section-title">
                Browse by topic instead
              </h2>
              <div className="tag-row">
                {search.topics!.map((topic) => (
                  <a key={topic.href} href={topic.href} className="chip">
                    {topic.label}
                  </a>
                ))}
              </div>
            </section>
          )}
          {(search.recent ?? []).length > 0 && (
            <section aria-labelledby="search-recent" className="search-section">
              <h2 id="search-recent" className="section-title">
                Recent posts
              </h2>
              <ul className="link-list">
                {search.recent!.map((post) => (
                  <li key={post.href}>
                    <a href={post.href}>{post.label}</a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

/** A post's date, or null for none or one before 1970 (an unset zero date). */
function factDate(value: string | undefined): Date | null {
  const date = new Date(value ?? "")
  return Number.isNaN(date.getTime()) || date.getFullYear() < 1970 ? null : date
}

/**
 * `post_facts`: the route's post's published date, its updated date when it changed on a later day
 * (in the site's zone), and its reading time, as the default theme's sidebar lists them. With
 * `fallback` only when the page shows no table of contents with entries and no "In <term>" list, the
 * sidebar's rule (what else the page shows is `pageShows`, filled before the render). Nothing in a list.
 */
export const PostFactsBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const shown = useSitePost()
  const blocks = routePostBlocks(shown)
  const headings = usePostContentHeadings(blocks)
  if (!shown || shown.inList) return null
  const site = shown.site
  if (normalizeSiteBlockAttrs("post_facts", block.attrs).fallback === true) {
    const toc = site.pageShows?.tableOfContents === true && tableOfContents(headings).length > 0
    if (toc || site.pageShows?.categoryList === true) return null
  }
  const dates = site.dates ?? DEFAULT_DATE_SETTINGS
  const post = shown.item.post
  const published = factDate(post.created_at)
  const changed = factDate(post.changed_at)
  const updated = changed && published && siteDay(changed, dates) !== siteDay(published, dates) ? changed : null
  const minutes = readingMinutes(blocks ?? post.published_blocks)
  if (!published && !updated && !minutes) return null
  return (
    <dl id={anchorId} className="post-facts">
      {published && (
        <div>
          <dt className="section-title">Published</dt>
          <dd>
            <time dateTime={published.toISOString()}>{formatSiteDate(published, dates, "long")}</time>
          </dd>
        </div>
      )}
      {updated && (
        <div>
          <dt className="section-title">Updated</dt>
          <dd>
            <time dateTime={updated.toISOString()}>{formatSiteDate(updated, dates, "long")}</time>
          </dd>
        </div>
      )}
      {minutes && (
        <div>
          <dt className="section-title">Reading time</dt>
          <dd>{`${minutes} min`}</dd>
        </div>
      )}
    </dl>
  )
}

/** `site_copyright`: "© 2026 <the site's title>", the footer's line; the year is the server's, as the theme's. */
export const SiteCopyrightBlock: React.FC<BlockComponentProps> = ({ anchorId }) => {
  const site = useSiteRenderContext()
  if (!site) return null
  return (
    <span id={anchorId} className="site-copyright">
      {`© ${new Date().getFullYear()} ${site.site.title}`}
    </span>
  )
}

/** Where "Published with GoLive" links: the project's home. */
export const GOLIVE_CREDIT_HREF = "https://github.com/go-live-cms/go-live-cms"

/** `golive_credit`: "Published with GoLive", the only place GoLive's mark is on a site (the logo in the text colour). */
export const GoliveCreditBlock: React.FC<BlockComponentProps> = ({ anchorId }) => {
  const site = useSiteRenderContext()
  if (!site) return null
  return (
    <a id={anchorId} href={GOLIVE_CREDIT_HREF} className="golive-credit">
      {"Published with "}
      <svg width="16" height="16" viewBox="0 0 66 67" fill="currentColor" aria-hidden="true">
        <path
          fillOpacity="0.54"
          d="M56.2781 23.2597L56.2781 61.6391L44.6394 61.6391C44.6394 49.9296 44.6394 43.3646 44.6394 31.6552L27.307 31.6552L27.307 23.2597L56.2781 23.2597Z"
        ></path>
        <path d="M36.8942 19.2537C36.7128 18.5565 36.4267 17.9447 36.036 17.4185C35.6453 16.8791 35.1568 16.4252 34.5707 16.0568C33.9985 15.6753 33.3287 15.3924 32.5611 15.2083C31.8076 15.0109 30.9772 14.9122 30.0701 14.9122C28.1164 14.9122 26.4487 15.353 25.0672 16.2344C23.6995 17.1159 22.6529 18.3854 21.9272 20.0431C21.2155 21.7008 20.8596 23.7005 20.8596 26.0423C20.8596 28.4103 21.2015 30.4364 21.8854 32.1203C22.5692 33.8043 23.5879 35.0936 24.9416 35.9882C26.2952 36.8828 27.9768 37.3301 29.9864 37.3301C31.7587 37.3301 33.231 37.0867 34.4032 36.6C35.5894 36.1132 36.4756 35.4225 37.0617 34.5279C37.6478 33.6333 37.9409 32.5808 37.9409 31.3704L39.7441 31.6488H27.3041L27.3041 23.2718H49.1609V29.3576C49.1609 33.0413 48.3306 36.1921 46.6699 38.8102C45.0232 41.4151 42.7485 43.4148 39.8458 44.8093C36.9571 46.1907 33.6427 46.8814 29.9027 46.8814C25.73 46.8814 22.0668 46.046 18.9129 44.3752C15.759 42.7044 13.2959 40.3231 11.5236 37.2315C9.7652 34.1398 8.88602 30.4627 8.88602 26.2001C8.88602 22.8585 9.42329 19.8984 10.4979 17.3198C11.5864 14.7412 13.0935 12.5639 15.0194 10.7878C16.9452 8.99861 19.1711 7.65011 21.697 6.74234C24.2229 5.82142 26.9302 5.36096 29.8189 5.36096C32.3588 5.36096 34.7172 5.70302 36.8942 6.38713C39.0852 7.05809 41.018 8.01848 42.6927 9.2683C44.3813 10.505 45.7419 11.9719 46.7746 13.669C47.8073 15.3661 48.4353 17.2277 48.6585 19.2537H36.8942Z"></path>
      </svg>
      <span>GoLive</span>
    </a>
  )
}
