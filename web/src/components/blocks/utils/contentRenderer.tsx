import React from "react"
import type { PMNode } from "../types"
import type { Block } from "@gl-admin/lib/blocks-spec"
import { safeHref, safeCssColor } from "./safeUrl"

/**
 * Render a single text node with its marks (bold, italic, link, code, etc.)
 * Marks are applied in order, wrapping the content progressively
 */
export function renderTextNode(node: PMNode, index: number): React.ReactNode {
  if (node.type !== "text" || !node.text) return null

  let content: React.ReactNode = node.text

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

  return <React.Fragment key={index}>{content}</React.Fragment>
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
      return (
        <React.Fragment key={index}>
          {separator}
          {inner}
        </React.Fragment>
      )
    }

    // Handle hard break
    if (node.type === "hardBreak") {
      return <br key={index} />
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
