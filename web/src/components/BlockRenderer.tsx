import React from "react"
import type { BlockDocV1, Block } from "@gl-admin/lib/blocks-spec"
import { blockRegistry } from "./blocks/registry"
import { renderContent, getBlockContent, isBlankParagraph } from "./blocks/utils/contentRenderer"
import { ImageSizesContext, BLOCK_IMAGE_SIZES } from "./blocks/utils/responsiveImage"

interface BlockRendererProps {
  doc: BlockDocV1
  // The `sizes` attribute for image blocks: how wide this layout renders
  // them (e.g. "(max-width: 760px) 100vw, 720px" for a text column, "100vw"
  // for full width). Defaults to BLOCK_IMAGE_SIZES.
  imageSizes?: string
}

/**
 * BlockRenderer - Thin orchestrator for rendering Block Spec v1 documents
 *
 * Uses the block registry to delegate rendering to individual block components.
 * WordPress-style architecture for easy extensibility.
 */
export default function BlockRenderer({ doc, imageSizes = BLOCK_IMAGE_SIZES }: BlockRendererProps) {
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
  // Drop blank paragraphs at the end. The editor appends an empty paragraph after a final
  // image, list, quote or heading (TipTap's TrailingNode), and the author never typed it;
  // rendering it would add space at the bottom of every such post. Blank lines anywhere
  // else are the author's spacing and render as one line (ParagraphBlock, #306).
  while (uniqueBlockIds.length > 0 && isBlankParagraph(doc.blocks[uniqueBlockIds[uniqueBlockIds.length - 1]] as Block)) {
    uniqueBlockIds.pop()
  }

  return (
    <ImageSizesContext.Provider value={imageSizes}>
      <div className="block-content">{uniqueBlockIds.map((blockId) => renderBlock(blockId))}</div>
    </ImageSizesContext.Provider>
  )
}
