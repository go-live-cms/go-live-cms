import React from "react"
import type { PMNode } from "../types"
import type { Block } from "@gl-admin/lib/blocks-spec"
import { safeHref, safeCssColor } from "./safeUrl"
import { blockColorClass } from "./blockColor"
import { calloutMarkup, plainText, pullQuoteMarkup, todoListMarkup } from "./textBlockMarkup"
import { CONTENT_LINK_NODE, DATE_CHIP_NODE, dateChipAttrs, MENTION_NODE, normalizeInlineLabel } from "@gl-admin/lib/blocks-spec/inlineNodes"
import { dateChipDateTime, formatDateChip } from "../../../lib/dateChips"
import { DEFAULT_DATE_SETTINGS } from "../../../lib/siteDates"

/**
 * Render a single text node with its marks (bold, italic, link, code, etc.)
 * Marks are applied in order, wrapping the content progressively
 */
export function renderTextNode(node: PMNode, index: number): React.ReactNode {
  if (node.type !== "text" || !node.text) return null
  return <React.Fragment key={index}>{applyMarks(node.text, node, index)}</React.Fragment>
}

/** `content` wrapped in `node`'s marks, in order (a text run's, or an inline node's, #320). */
function applyMarks(text: React.ReactNode, node: PMNode, index: number): React.ReactNode {
  let content: React.ReactNode = text

  // Apply marks in order (wrapping progressively)
  if (node.marks && node.marks.length > 0) {
    for (const mark of node.marks) {
      switch (mark.type) {
        case "bold":
          content = <strong key={`bold-${index}`}>{content}</strong>
          break
        case "italic":
          content = <em key={`italic-${index}`}>{content}</em>
          break
        case "code":
          content = <code key={`code-${index}`}>{content}</code>
          break
        case "strike":
          content = <s key={`strike-${index}`}>{content}</s>
          break
        case "underline":
          content = <u key={`underline-${index}`}>{content}</u>
          break
        case "link":
          content = (
            <a
              key={`link-${index}`}
              href={safeHref(mark.attrs?.href as string | undefined) ?? "#"}
              target={(mark.attrs?.target as string) || undefined}
              rel={mark.attrs?.target === "_blank" ? "noopener noreferrer" : undefined}
            >
              {content}
            </a>
          )
          break
        case "highlight":
          content = (
            <mark key={`highlight-${index}`} style={{ backgroundColor: safeCssColor(mark.attrs?.color as string | undefined) }}>
              {content}
            </mark>
          )
          break
        // Add more mark types as needed
      }
    }
  }

  return content
}

/**
 * The #320 inline nodes as the public API sends them (api/inline_nodes.go): a mention is
 * the member's current name and nothing else (no id, no email); a content link is a link to
 * the target's current URL, or its text alone when the target isn't published (no `href`);
 * a date chip is a `<time>` with the site's format (`label`, from `labelDateChips`) or the
 * default one. Only a path on this site is ever a link.
 */
export function renderInlineNode(node: PMNode, index: number): React.ReactNode {
  const attrs = (node.attrs ?? {}) as Record<string, unknown>
  const label = normalizeInlineLabel(attrs.label)
  if (node.type === MENTION_NODE) {
    if (!label) return null
    return <React.Fragment key={index}>{applyMarks(<span className="gl-mention">{label}</span>, node, index)}</React.Fragment>
  }
  if (node.type === CONTENT_LINK_NODE) {
    const text = label ?? ""
    if (!text) return null
    const href = typeof attrs.href === "string" && /^\/(?!\/)/.test(attrs.href) ? safeHref(attrs.href) : undefined
    const content = href ? <a className="gl-content-link" href={href}>{text}</a> : text
    return <React.Fragment key={index}>{applyMarks(content, node, index)}</React.Fragment>
  }
  if (node.type === DATE_CHIP_NODE) {
    const chip = dateChipAttrs(attrs)
    if (!chip) return null
    const text = (typeof attrs.label === "string" && attrs.label) || formatDateChip(chip, DEFAULT_DATE_SETTINGS, "long")
    return (
      <React.Fragment key={index}>
        {applyMarks(
          <time className="gl-date" dateTime={dateChipDateTime(chip)}>
            {text}
          </time>,
          node,
          index,
        )}
      </React.Fragment>
    )
  }
  return null
}

/**
 * Whether inline ProseMirror content shows nothing: no nodes, or only whitespace text.
 * Anything else (a hard break, an image, any other inline node) counts as content.
 */
export function isBlankInline(content: PMNode[] | undefined): boolean {
  if (!content || content.length === 0) return true
  return content.every((node) => node.type === "text" && !(node.text ?? "").trim())
}

/**
 * Whether a paragraph block shows nothing: an author's blank line (#306), or the empty
 * paragraph the editor appends after a final non-paragraph block (TipTap's TrailingNode).
 * Uses the stored ProseMirror content, falling back to the plain `text` attribute.
 */
export function isBlankParagraph(block: Block | undefined): boolean {
  if (!block || block.type !== "paragraph") return false
  const attrs = block.attrs as Record<string, unknown> | undefined
  const pm = attrs?.pm as { content?: PMNode[] } | undefined
  if (pm?.content) return isBlankInline(pm.content)
  return !String(attrs?.text ?? "").trim()
}

/**
 * Render ProseMirror content array
 * Handles nested content like paragraphs inside blockquotes
 */
export function renderContent(content: PMNode[] | undefined): React.ReactNode {
  if (!content || content.length === 0) return null

  let paragraphsSeen = 0
  return content.map((node, index) => {
    if (node.type === "text") {
      return renderTextNode(node, index)
    }

    // Nested paragraphs (inside a blockquote or list item) render inline, without <p>,
    // so list markup and theme spacing stay as they are. Consecutive ones are separated
    // by a line break (they used to run together), and an empty one adds its own break,
    // so a blank line inside a quote survives as in the editor (#306).
    if (node.type === "paragraph") {
      const separator = paragraphsSeen++ > 0 ? <br key={`${index}-br`} /> : null
      const inner = isBlankInline(node.content) ? null : renderContent(node.content)
      // A tinted paragraph inside a list item or quote (#356) keeps its colour.
      const color = blockColorClass(node.attrs?.blockColor)
      return (
        <React.Fragment key={index}>
          {separator}
          {color && inner ? <span className={color}>{inner}</span> : inner}
        </React.Fragment>
      )
    }

    // Handle hard break
    if (node.type === "hardBreak") {
      return <br key={index} />
    }

    if (node.type === MENTION_NODE || node.type === CONTENT_LINK_NODE || node.type === DATE_CHIP_NODE) {
      return renderInlineNode(node, index)
    }

    // The #419 blocks inside a quote or a list item (the schema lets them go there): the
    // same markup as at the top level, from their nested pm (attrs as the node has them).
    if (node.type === "callout") {
      return calloutMarkup({ tone: node.attrs?.tone, content: node.content, renderInline: renderContent, key: index })
    }
    if (node.type === "pullQuote") {
      return pullQuoteMarkup({ content: renderContent(node.content), cite: node.attrs?.cite, key: index })
    }
    if (node.type === "taskList") {
      const items = (node.content ?? [])
        .filter((item) => item?.type === "taskItem")
        .map((item, i) => ({
          key: i,
          checked: item.attrs?.checked === true,
          content: renderContent(item.content),
          label: plainText(item.content) || "To-do",
        }))
      return todoListMarkup({ items, key: index })
    }

    return null
  })
}

/**
 * Get renderable content from a block's ProseMirror data
 * Falls back to plain text if no PM content available
 */
export function getBlockContent(block: Block): React.ReactNode {
  const attrs = block.attrs as Record<string, unknown>
  const pm = attrs?.pm as { content?: PMNode[] } | undefined

  if (pm?.content) {
    return renderContent(pm.content)
  }

  // Fallback to plain text if no PM content
  if (attrs?.text) {
    return attrs.text as string
  }

  return null
}
