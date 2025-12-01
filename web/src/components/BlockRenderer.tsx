import React from "react"
import type { BlockDocV1, Block } from "@gl-admin/lib/blocks-spec"

interface BlockRendererProps {
  doc: BlockDocV1
}

export default function BlockRenderer({ doc }: BlockRendererProps) {
  // Extract text from ProseMirror content structure
  const extractText = (block: Block): string => {
    const attrs = block.attrs as any
    if (attrs.text) return attrs.text
    if (attrs.pm?.content) {
      return attrs.pm.content
        .filter((node: any) => node.type === "text")
        .map((node: any) => node.text)
        .join("")
    }
    return ""
  }

  const renderBlock = (blockId: string): React.ReactElement | null => {
    const block = doc.blocks[blockId] as Block
    if (!block) return null

    switch (block.type) {
      case "paragraph": {
        const text = extractText(block)
        return text ? <p key={block.id}>{text}</p> : null
      }

      case "heading": {
        const attrs = block.attrs as any
        const level = attrs.level || 1
        const text = extractText(block)

        // Dynamically render heading based on level
        if (level === 1) return <h1 key={block.id}>{text}</h1>
        if (level === 2) return <h2 key={block.id}>{text}</h2>
        if (level === 3) return <h3 key={block.id}>{text}</h3>
        return <h1 key={block.id}>{text}</h1>
      }

      case "blockquote": {
        const text = extractText(block)
        return <blockquote key={block.id}>{text}</blockquote>
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
              const text = extractText(child)
              return <li key={childId}>{text}</li>
            })}
          </ul>
        )

      case "ordered_list":
        return (
          <ol key={block.id}>
            {block.children?.map((childId) => {
              const child = doc.blocks[childId] as Block
              if (!child) return null
              const text = extractText(child)
              return <li key={childId}>{text}</li>
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
