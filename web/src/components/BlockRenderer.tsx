import React from "react"
import type { BlockDocV1, Block } from "@gl-admin/lib/blocks-spec"
import { blockRegistry } from "./blocks/registry"
import { isThemeBlockType } from "@gl-admin/lib/blocks-spec/themeBlocks"
import { renderContent, getBlockContent, isBlankParagraph } from "./blocks/utils/contentRenderer"
import { ImageSizesContext, BLOCK_IMAGE_SIZES } from "./blocks/utils/responsiveImage"
import { HeadingIdsContext, headingAnchors, type HeadingAnchor } from "./blocks/utils/headingAnchors"
// Browser-safe: the admin's revision preview renders this component too.
import { log } from "../lib/log"

const unknownTypesLogged = new Set<string>()

interface BlockRendererProps {
  doc: BlockDocV1
  // The `sizes` attribute for image blocks: how wide this layout renders
  // them (e.g. "(max-width: 760px) 100vw, 720px" for a text column, "100vw"
  // for full width). Defaults to BLOCK_IMAGE_SIZES.
  imageSizes?: string
  // The headings' ids (#351). A layout that also builds a table of contents passes the
  // list it built, so both use the same ids; otherwise they're computed from the doc.
  headings?: HeadingAnchor[]
}

/**
 * BlockRenderer - Thin orchestrator for rendering Block Spec v1 documents
 *
 * Uses the block registry to delegate rendering to individual block components.
 * WordPress-style architecture for easy extensibility.
 */
export default function BlockRenderer({ doc, imageSizes = BLOCK_IMAGE_SIZES, headings }: BlockRendererProps) {
  const headingIds = new Map((headings ?? headingAnchors(doc)).map((h) => [h.blockId, h.id]))
  const renderBlock = blockRendererFor(doc)

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
      <HeadingIdsContext.Provider value={headingIds}>
        <div className="block-content">{uniqueBlockIds.map((blockId) => renderBlock(blockId))}</div>
      </HeadingIdsContext.Provider>
    </ImageSizesContext.Provider>
  )
}

/**
 * Renders one block of `doc` by id, as BlockRenderer does (children through the same
 * function); null for a block nothing in this build renders. The admin's History
 * comparison (#355) renders blocks one at a time with it.
 */
export function blockRendererFor(doc: BlockDocV1): (blockId: string) => React.ReactElement | null {
  const renderBlock = (blockId: string): React.ReactElement | null => {
    const block = doc.blocks[blockId] as Block
    if (!block) return null

    // Look up the component from the registry
    const Component = blockRegistry.getComponent(block.type)

    if (!Component) {
      // A block nothing in this build renders: a theme block whose theme was removed
      // (#376), or a type from an older build. It stays in the stored doc (the editor
      // keeps it hidden, not deleted); here it renders nothing. Logged once per type, not
      // on every request.
      if (!unknownTypesLogged.has(block.type)) {
        unknownTypesLogged.add(block.type)
        log.warn("unknown_block_type", { type: block.type })
      }
      return null
    }

    // A theme block written by a newer build of its theme than this one (e.g. after a
    // rollback, #376): its attrs may mean something this renderer doesn't know, so it
    // renders nothing, like a block of a removed theme. It stays in the stored doc.
    if (isThemeBlockType(block.type) && block.version > (blockRegistry.get(block.type)?.version ?? 1)) return null

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
  return renderBlock
}
