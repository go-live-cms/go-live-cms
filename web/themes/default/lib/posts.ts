/**
 * Pure helpers the default theme's lists and post headers use (#345). Tested in
 * posts.test.ts.
 */
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import type { Post } from "@gl-admin/lib/api/types"

// Names for the byline: every credited author (user_posts) when the API sent them
// (list rows fetched with with_meta), else the post's owner.
export function authorNames(post: Pick<Post, "authors" | "username">): string[] {
  const names = (post.authors ?? []).map((a) => a.full_name?.trim() || a.username).filter(Boolean)
  return names.length > 0 ? names : post.username ? [post.username] : []
}

// "Ana", "Ana and Luan", "Ana, Luan and Priya"
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

type TextNode = { type?: string; text?: string; content?: TextNode[] }

function nodeText(node: TextNode | undefined): string {
  if (!node) return ""
  if (typeof node.text === "string") return node.text
  return (node.content ?? []).map(nodeText).join(" ")
}

// Words in a published doc: paragraph, heading, list and quote text, and code.
export function wordCount(doc: BlockDocV1 | undefined | null): number {
  if (!doc?.blocks) return 0
  let words = 0
  for (const block of Object.values(doc.blocks) as { attrs?: Record<string, unknown> }[]) {
    const attrs = block?.attrs ?? {}
    const pm = attrs.pm as TextNode | undefined
    const text = pm ? nodeText(pm) : typeof attrs.text === "string" ? attrs.text : typeof attrs.code === "string" ? attrs.code : ""
    words += text.split(/\s+/).filter(Boolean).length
  }
  return words
}

// Minutes at 220 words a minute, at least 1; null when there is no text to time.
export function readingMinutes(doc: BlockDocV1 | undefined | null): number | null {
  const words = wordCount(doc)
  return words > 0 ? Math.max(1, Math.round(words / 220)) : null
}

// Element ids the theme's own markup uses (base layout, header, footer, post end). A
// heading's anchor never takes one of these (headingAnchors' reserved ids, #351).
export const THEME_ELEMENT_IDS = ["content", "site-menu", "theme-menu", "footer-site", "more-posts", "recent-404", "toc-title", "in-category", "more-to-read"]

// The "Back to" link of the newest post: the post type's list.
export function archiveLink(postType: string): { href: string; label: string } {
  return { href: `/${encodeURIComponent(postType)}`, label: postType === "post" ? "All posts" : `All ${postType}` }
}
