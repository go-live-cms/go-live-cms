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
 * Render ProseMirror content array
 * Handles nested content like paragraphs inside blockquotes
 */
export function renderContent(content: PMNode[] | undefined): React.ReactNode {
  if (!content || content.length === 0) return null

  return content.map((node, index) => {
    if (node.type === "text") {
      return renderTextNode(node, index)
    }

    // Handle nested paragraph (e.g., inside blockquote or list item)
    if (node.type === "paragraph" && node.content) {
      return <React.Fragment key={index}>{renderContent(node.content)}</React.Fragment>
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
