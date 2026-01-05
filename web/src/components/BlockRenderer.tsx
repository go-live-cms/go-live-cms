import React from "react"
import type { BlockDocV1, Block } from "@gl-admin/lib/blocks-spec"
import { blockRegistry } from "./blocks/registry"
import { renderContent, getBlockContent } from "./blocks/utils/contentRenderer"

interface BlockRendererProps {
  doc: BlockDocV1
}

/**
 * BlockRenderer - Thin orchestrator for rendering Block Spec v1 documents
 *
 * Uses the block registry to delegate rendering to individual block components.
 * WordPress-style architecture for easy extensibility.
 */
export default function BlockRenderer({ doc }: BlockRendererProps) {
  /**
   * Render a single block by ID using the registry
   */
  const renderBlock = (blockId: string): React.ReactElement | null => {
    const block = doc.blocks[blockId] as Block
    if (!block) return null

    // Look up the component from the registry
    const Component = blockRegistry.getComponent(block.type)

    if (!Component) {
      console.warn(`Unknown block type: ${block.type}`)
      return null
    }

    // WordPress-style shared props - every component gets the same interface
    return (
      <Component
        key={block.id}
        block={block}
        doc={doc}
        renderContent={renderContent}
        getBlockContent={getBlockContent}
        renderBlock={renderBlock}
      />
    )
  }

  // Deduplicate blocks_order to prevent duplicate rendering
  const uniqueBlockIds = Array.from(new Set(doc.blocks_order))

  return <div className="block-content">{uniqueBlockIds.map((blockId) => renderBlock(blockId))}</div>
}
