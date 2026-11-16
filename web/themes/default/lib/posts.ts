/**
 * Pure helpers the default theme's lists and post headers use (#345). Tested in
 * posts.test.ts.
 */
// The byline's names and the reading time are core's (src/lib/bylines.ts, readingTime.ts),
// shared with the site blocks (#497), so a block template and this theme agree.
export { authorNames, joinNames } from "@/lib/bylines"
export { readingMinutes, wordCount } from "@/lib/readingTime"

// Element ids the theme's own markup uses (base layout, header, footer, post end). A
// heading's anchor never takes one of these (headingAnchors' reserved ids, #351). The
// patterns are the menus' numbered ids (#347): footer columns and header submenus.
export const THEME_ELEMENT_IDS: (string | RegExp)[] = ["content", "site-menu", "theme-menu", "footer-site", "more-posts", "recent-404", "toc-title", "in-category", "written-by", "more-to-read", /^footer-col-\d+$/, /^nav-sub-\d+$/]

// The "Back to" link of the newest post: the post type's list.
export function archiveLink(postType: string): { href: string; label: string } {
  return { href: `/${encodeURIComponent(postType)}`, label: postType === "post" ? "All posts" : `All ${postType}` }
}
