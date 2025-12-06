import React from "react"
import type { BlockDocV1, Block } from "@gl-admin/lib/blocks-spec"

interface BlockRendererProps {
  doc: BlockDocV1
}

// ProseMirror content node type
interface PMNode {
  type: string
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, any> }>
  content?: PMNode[]
  attrs?: Record<string, any>
}

export default function BlockRenderer({ doc }: BlockRendererProps) {
  // Render a single text node with its marks (bold, italic, link, code, etc.)
  const renderTextNode = (node: PMNode, index: number): React.ReactNode => {
    if (node.type !== "text" || !node.text) return null

    let content: React.ReactNode = node.text

    // Apply marks in reverse order (innermost first)
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
                href={mark.attrs?.href || "#"}
                target={mark.attrs?.target || undefined}
                rel={mark.attrs?.target === "_blank" ? "noopener noreferrer" : undefined}
              >
                {content}
              </a>
            )
            break
          case "highlight":
            content = (
              <mark key={`highlight-${index}`} style={{ backgroundColor: mark.attrs?.color }}>
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

  // Render ProseMirror content array (handles nested content like paragraphs inside blockquotes)
  const renderContent = (content: PMNode[] | undefined): React.ReactNode => {
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

  // Get renderable content from a block's ProseMirror data
  const getBlockContent = (block: Block): React.ReactNode => {
    const attrs = block.attrs as any
    if (attrs.pm?.content) {
      return renderContent(attrs.pm.content)
    }
    // Fallback to plain text if no PM content
    if (attrs.text) {
      return attrs.text
    }
    return null
  }

  const renderBlock = (blockId: string): React.ReactElement | null => {
    const block = doc.blocks[blockId] as Block
    if (!block) return null

    switch (block.type) {
      case "paragraph": {
        const content = getBlockContent(block)
        return content ? <p key={block.id}>{content}</p> : null
      }

      case "heading": {
        const attrs = block.attrs as any
        const level = attrs.level || 1
        const content = getBlockContent(block)

        // Dynamically render heading based on level
        if (level === 1) return <h1 key={block.id}>{content}</h1>
        if (level === 2) return <h2 key={block.id}>{content}</h2>
        if (level === 3) return <h3 key={block.id}>{content}</h3>
        return <h1 key={block.id}>{content}</h1>
      }

      case "blockquote": {
        const attrs = block.attrs as any
        // Blockquote may have nested paragraph content
        const content = attrs.pm?.content ? renderContent(attrs.pm.content) : getBlockContent(block)
        return <blockquote key={block.id}>{content}</blockquote>
      }

      case "code_block": {
        const attrs = block.attrs as any
        return (
          <pre key={block.id}>
            <code className={`language-${attrs.language || "text"}`}>{attrs.code || ""}</code>
          </pre>
        )
      }

      case "divider":
        return <hr key={block.id} />

      case "image": {
        const attrs = block.attrs as any
        return <img key={block.id} src={attrs.src || ""} alt={attrs.alt || ""} title={attrs.title} />
      }

      case "bullet_list":
        return (
          <ul key={block.id}>
            {block.children?.map((childId) => {
              const child = doc.blocks[childId] as Block
              if (!child) return null
              const content = getBlockContent(child)
              return <li key={childId}>{content}</li>
            })}
          </ul>
        )

      case "ordered_list":
        return (
          <ol key={block.id}>
            {block.children?.map((childId) => {
              const child = doc.blocks[childId] as Block
              if (!child) return null
              const content = getBlockContent(child)
              return <li key={childId}>{content}</li>
            })}
          </ol>
        )

      default:
        console.warn(`Unknown block type: ${(block as any).type}`)
        return null
    }
  }

  // Deduplicate blocks_order to prevent duplicate rendering
  const uniqueBlockIds = Array.from(new Set(doc.blocks_order))

  return <div className="block-content">{uniqueBlockIds.map((blockId) => renderBlock(blockId))}</div>
}
