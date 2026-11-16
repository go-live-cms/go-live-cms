/**
 * A post's reading time (#345): words in its published blocks at 220 a minute. Core's, so the
 * default theme's byline and the `post_byline` site block's `readingTime` (#497) agree;
 * `themes/default/lib/posts.ts` re-exports it. Pure and browser-safe.
 */
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"

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