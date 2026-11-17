import React, { useContext } from "react"
import { normalizeSiteBlockAttrs, type ColorSchemeSwitchVariant } from "@gl-admin/lib/blocks-spec"
import { safeAvatarSrc } from "@gl-admin/lib/presence"
import type { BlockComponentProps } from "../types"
import { authorNames, avatarColor, displayName, initial, joinNames } from "../../../lib/bylines"
import { authorPath } from "../../../lib/seo"
import { DEFAULT_DATE_SETTINGS, formatSiteDate } from "../../../lib/siteDates"
import { tableOfContents } from "./headingAnchors"
import { SITE_BLOCK_TITLE_IDS, SiteBlockTitleIdsContext } from "./pageScope"
import { routePostBlocks, usePostContentHeadings } from "./postBlocks"
import { queryKey, SitePostItemContext, useSitePost, useSiteRenderContext, type SiteRoutePost } from "./siteContext"
import { ThemeChoices } from "./themeMarkup"

/**
 * Site blocks III (#497, design `docs/design/theme-builder.md` 4.1, 5.7): what converting the
 * default theme to block templates (#498) needs. Each renders **the markup of the default theme
 * component it replaces**, so the theme styles a block template and its code layouts the same
 * way; `themes/default/siteBlocksMarkup.astro.test.ts` renders both and compares them:
 *
 * - `related_posts`: `RelatedPosts.astro` ("More to read", `section.related-posts`).
 * - `author_cards`: `AuthorCards.astro` ("Written by", `section.author-cards`).
 * - `table_of_contents`: `TableOfContents.astro` ("On this page", `nav.toc-block`).
 * - `color_scheme_switch`: `ThemeSwitch.astro` (`div.theme-choices`), in a labelled group.
 *
 * Like the other site blocks they read only the `SiteRenderContext`, and outside a template they
 * render nothing (design 4.2). The three post ones show the route's post: inside a post template
 * (a list) they render nothing, as `post_content` doesn't. Their section titles carry the
 * theme's ids ("more-to-read", …), a second block of a type on the page "-2"
 * (`siteBlockTitleIds`); headings skip them.
 */

/** The id of this block's section title (#497): the theme's, or "-2" for a second one on the page. */
function useTitleId(blockId: string, type: keyof typeof SITE_BLOCK_TITLE_IDS): string {
  const site = useSiteRenderContext()
  return useContext(SiteBlockTitleIdsContext)?.get(queryKey(site?.partSlug, blockId)) ?? SITE_BLOCK_TITLE_IDS[type]
}

/**
 * `related_posts`: "More to read", up to `count` related posts as cards (image, title, the
 * byline's names and the short date), read for the route's post from `/public/posts/:id/related`
 * before the render (`loadSiteRenderContext`). It counts towards the page's four data-reading
 * blocks. Nothing without posts, over the four, when the read failed, or in a list.
 */
export const RelatedPostsBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const site = useSiteRenderContext()
  const listed = useContext(SitePostItemContext)
  const titleId = useTitleId(block.id, "related_posts")
  const list = site && !listed ? site.related?.[queryKey(site.partSlug, block.id)] : null
  if (!site || !list || list.items.length === 0) return null
  // #498: the default theme sidebar's "In <term>": the term's other posts as links, and its archive.
  if (normalizeSiteBlockAttrs("related_posts", block.attrs).layout === "list") {
    const term = list.term
    if (!term) return null
    return (
      <section id={anchorId} className="aside-list" aria-labelledby={titleId}>
        <h2 id={titleId} className="section-title">{`In ${term.name}`}</h2>
        <ul className="aside-links">
          {list.items.map((item) => (
            <li key={item.post.id}>
              <a href={item.href}>{item.post.title}</a>
            </li>
          ))}
        </ul>
        {term.href && <a className="aside-all" href={term.href}>{`All ${term.name} →`}</a>}
      </section>
    )
  }
  const dates = site.dates ?? DEFAULT_DATE_SETTINGS
  const meta = (post: (typeof list.items)[number]["post"]) => [joinNames(authorNames(post)), formatSiteDate(post.created_at, dates, "short")].filter(Boolean).join(" · ")
  return (
    <section id={anchorId} className="related-posts" aria-labelledby={titleId}>
      <h2 id={titleId} className="section-title">
        More to read
      </h2>
      <div className="card-grid">
        {list.items.map((item) => (
          <article key={item.post.id} className="card">
            {item.image && (
              <a href={item.href} tabIndex={-1} aria-hidden="true">
                <img className="media" src={item.image} alt="" loading="lazy" decoding="async" />
              </a>
            )}
            <h3 className="card-title">
              <a href={item.href}>{item.post.title}</a>
            </h3>
            <span className="meta">{meta(item.post)}</span>
          </article>
        ))}
      </div>
    </section>
  )
}

/**
 * `author_cards`: "Written by", one card per credited author of the route's post (#350), in
 * byline order, each linking to their author page, with their bio. Nothing when the post credits
 * nobody (an owner shown as a fallback has no page), or in a list.
 */
export const AuthorCardsBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const shown = useSitePost()
  const titleId = useTitleId(block.id, "author_cards")
  const authors = shown && !shown.inList ? ((shown.item as SiteRoutePost).authors ?? []) : []
  if (authors.length === 0) return null
  return (
    <section id={anchorId} className="author-cards" aria-labelledby={titleId}>
      <h2 id={titleId} className="section-title">
        Written by
      </h2>
      {authors.map((author, i) => {
        const avatar = safeAvatarSrc(author.avatar)
        return (
          <div key={author.username + i} className="author-card">
            <span className="avatar" aria-hidden="true" style={{ width: "56px", height: "56px", fontSize: "20px", background: avatarColor(author.username) }}>
              {avatar ? <img src={avatar} alt="" width="56" height="56" loading="lazy" decoding="async" /> : initial(displayName(author))}
            </span>
            <div>
              <h3>
                <a href={authorPath(author.username)}>{displayName(author)}</a>
              </h3>
              {author.bio && <p className="author-bio">{author.bio}</p>}
            </div>
          </div>
        )
      })}
    </section>
  )
}

/**
 * `table_of_contents`: "On this page", the route's post's H2s with their H3s nested
 * (`tableOfContents`: from three headings, else nothing), linking to **the ids `post_content`
 * gives them** (`usePostContentHeadings`: the template's reserved and heading ids skipped, #484;
 * a level-1 heading listed as the h2 it renders as, #481). Nothing without a post or in a list.
 */
export const TableOfContentsBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const blocks = routePostBlocks(useSitePost())
  const headings = usePostContentHeadings(blocks)
  const titleId = useTitleId(block.id, "table_of_contents")
  const entries = tableOfContents(headings)
  if (entries.length === 0) return null
  return (
    <nav id={anchorId} className="toc-block" aria-labelledby={titleId}>
      <h2 id={titleId} className="section-title">
        On this page
      </h2>
      <ol className="toc">
        {entries.map((entry) => (
          <li key={entry.id}>
            <a href={`#${entry.id}`}>{entry.text}</a>
            {entry.children.length > 0 && (
              <ol className="toc toc--nested">
                {entry.children.map((child) => (
                  <li key={child.id}>
                    <a href={`#${child.id}`}>{child.text}</a>
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

/**
 * `color_scheme_switch`: Light, Dark and System, `ThemeSwitch`'s buttons (`segmented`, the phone
 * menu's control, or `menu`, the header popover's list) in a group labelled "Theme". **No script
 * of its own and no inline handler:** the theme's `theme-init.js`, a plain `<script src>` the
 * theme registers (#484, so it works under `script-src 'self'`), applies a click on any
 * `[data-theme-choice]` and keeps every copy's `aria-pressed` in step. Without JavaScript it is
 * hidden (the theme's `:root:not([data-js])` rule) and the page follows the system's scheme.
 *
 * `popover` (#498) is the theme header's control: an icon button (sun, moon or screen, as the
 * preference) that opens the `menu` list in `div#theme-menu.theme-popover`, `SiteHeader`'s markup;
 * the theme's script opens it (`data-theme-menu-toggle`) and its id is the theme's, so one per page.
 * Hidden at phone width (`hide-mobile`), where the header's phone menu holds the switch.
 */
export const ColorSchemeSwitchBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const site = useSiteRenderContext()
  if (!site) return null
  const variant = normalizeSiteBlockAttrs("color_scheme_switch", block.attrs).variant as ColorSchemeSwitchVariant | undefined
  if (variant === "popover") {
    return (
      <div id={anchorId} className="theme-menu hide-mobile">
        <button type="button" className="icon-btn" aria-label="Theme" aria-expanded="false" aria-controls="theme-menu" data-theme-menu-toggle="">
          <svg className="icon-light" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4"></circle>
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>
          </svg>
          <svg className="icon-dark" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"></path>
          </svg>
          <svg className="icon-system" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="12" rx="2"></rect>
            <path d="M8 20h8M12 16v4"></path>
          </svg>
        </button>
        <div id="theme-menu" className="theme-popover" role="group" aria-label="Theme" hidden>
          <ThemeChoices variant="menu" />
        </div>
      </div>
    )
  }
  return (
    <div id={anchorId} className="color-scheme-switch" role="group" aria-label="Theme">
      <ThemeChoices variant={variant === "menu" ? "menu" : "segmented"} />
    </div>
  )
}
