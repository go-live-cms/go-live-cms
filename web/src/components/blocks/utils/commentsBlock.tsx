import React, { useContext } from "react"
import { normalizeSiteBlockAttrs } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { PostCommentsSection } from "../../comments/PostCommentsSection"
import { commentsView, COMMENTS_SCRIPT_SRC, COMMENTS_TITLE } from "../../../lib/postComments"
import { DEFAULT_DATE_SETTINGS } from "../../../lib/siteDates"
import { SitePostItemContext, SiteQueryContext, useSiteRenderContext } from "./siteContext"

/**
 * The comments site block (#500, docs/design/reader-comments.md 11.1; theme-builder 4.1): the
 * route's post's reader comments. It renders **core's `PostCommentsSection`**, the markup code
 * layouts render through `PostComments.astro`, from the same view (`commentsView`) on the same
 * inputs: the thread answer the collector read with the post route's loader
 * (`loadSiteRenderContext`'s `comments`), the page's URL, the clock taken when the context was
 * loaded, Settings › Discussion and the site's dates. So a block template and a code layout give
 * the same HTML for the same post (`themes/default/theme.astro.test.ts`, "block templates").
 *
 * - `title`: the section's heading ("Comments" by default); the count follows it (16.1).
 * - Nothing outside a template (a post's body, design 4.2), in a part, in a query, on a route
 *   without a post, with comments off, closed with none, or when the read failed.
 * - Nothing about the reader: the page stays the same for everyone and cacheable (section 10).
 *   A comment's text is text (React children and attributes, never raw HTML).
 * - With a form, `/gl-comments.js` after the section, as the code layout adds it: one comments
 *   block per template (the store's rule), so once per page.
 */
export const CommentsBlock: React.FC<BlockComponentProps> = ({ block }) => {
  const site = useSiteRenderContext()
  const listed = useContext(SitePostItemContext)
  const query = useContext(SiteQueryContext)
  const comments = site?.comments
  if (!site || site.partSlug || listed || query || !comments) return null
  const title = (normalizeSiteBlockAttrs("comments", block.attrs).title as string | undefined) ?? COMMENTS_TITLE
  const url = new URL(comments.url)
  const view = commentsView(comments.data, comments.postId, { path: url.pathname, url, now: new Date(comments.now) }, comments.settings, site.dates ?? DEFAULT_DATE_SETTINGS, title)
  return view ? <PostCommentsSection view={view} script={COMMENTS_SCRIPT_SRC} /> : null
}
