import React from "react"
import { blockAnchorId, blocksInReadingOrder, embedTargetOf, footnoteIndex, type BlockDocV1, type Block } from "@gl-admin/lib/blocks-spec"
import { blockRegistry } from "./blocks/registry"
import { isExtensionBlockType, pluginOfBlockType } from "@gl-admin/lib/blocks-spec/themeBlocks"
import { PluginBlockBoundary, PluginBlockChecksContext, probePluginBlocks } from "./blocks/PluginBlockBoundary"
import { renderContent, getBlockContent, isBlankParagraph } from "./blocks/utils/contentRenderer"
import { ImageSizesContext, BLOCK_IMAGE_SIZES } from "./blocks/utils/responsiveImage"
import { HeadingIdsContext, headingAnchors, type HeadingAnchor } from "./blocks/utils/headingAnchors"
import { FootnotesContext } from "./blocks/utils/footnotes"
// Browser-safe: the admin's revision preview renders this component too.
import { log } from "../lib/log"

const unknownTypesLogged = new Set<string>()

/** public/gl-embeds.js: builds an embed's player when a reader clicks Load (#425). */
export const EMBED_LOADER_SRC = "/gl-embeds.js"

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

/** Whether this build draws `block`: its type has a component, and it isn't from a newer build of its theme or plugin. */
function rendersBlock(block: Block): boolean {
  if (!blockRegistry.getComponent(block.type)) return false
  return !(isExtensionBlockType(block.type) && block.version > (blockRegistry.get(block.type)?.version ?? 1))
}

/**
 * BlockRenderer - Thin orchestrator for rendering Block Spec v1 documents
 *
 * Uses the block registry to delegate rendering to individual block components.
 * WordPress-style architecture for easy extensibility.
 */
export default function BlockRenderer({ doc, imageSizes = BLOCK_IMAGE_SIZES, headings }: BlockRendererProps) {
  const headingIds = new Map((headings ?? headingAnchors(doc)).map((h) => [h.blockId, h.id]))
  const renderBlock = blockRendererFor(doc, { anchors: true })

  // Deduplicate blocks_order to prevent duplicate rendering
  const uniqueBlockIds = Array.from(new Set(doc.blocks_order))
  // Drop blank paragraphs at the end. The editor appends an empty paragraph after a final
  // image, list, quote or heading (TipTap's TrailingNode), and the author never typed it;
  // rendering it would add space at the bottom of every such post. Blank lines anywhere
  // else are the author's spacing and render as one line (ParagraphBlock, #306).
  // The footnotes list (#422) is the last block; the blank line before it goes the same way.
  const last = uniqueBlockIds[uniqueBlockIds.length - 1]
  const list = (doc.blocks[last] as Block | undefined)?.type === "footnotes" ? uniqueBlockIds.pop() : undefined
  while (uniqueBlockIds.length > 0 && isBlankParagraph(doc.blocks[uniqueBlockIds[uniqueBlockIds.length - 1]] as Block)) {
    uniqueBlockIds.pop()
  }
  if (list) uniqueBlockIds.push(list)

  // The script that builds an embed's player on click (#425), for a post that has one. It
  // is ours, on this site: nothing is asked of a provider until a reader clicks.
  const readingOrder = blocksInReadingOrder(doc)
  const hasEmbed = readingOrder.some((id) => {
    const block = doc.blocks[id] as Block | undefined
    return block?.type === "embed" && embedTargetOf(block.attrs) !== null
  })

  // On the server, every plugin block is rendered on its own first (#456): one whose renderer
  // throws is left out, and so are its footnote references (no number, no back link to an
  // anchor that isn't on the page). null in a browser, where each block's boundary catches.
  const unguarded = blockRendererFor(doc, { guard: false })
  const failedPluginBlocks = probePluginBlocks(
    readingOrder.map((id) => doc.blocks[id] as Block).filter((block) => !!block && rendersBlock(block)),
    unguarded,
    { imageSizes, headingIds },
  )
  const footnotes = footnoteIndex(doc, (block) => rendersBlock(block as Block) && !failedPluginBlocks?.has((block as Block).id))

  return (
    <ImageSizesContext.Provider value={imageSizes}>
      <HeadingIdsContext.Provider value={headingIds}>
        <FootnotesContext.Provider value={footnotes}>
          <PluginBlockChecksContext.Provider value={failedPluginBlocks}>
            <div className="block-content">{uniqueBlockIds.map((blockId) => renderBlock(blockId))}</div>
          </PluginBlockChecksContext.Provider>
        </FootnotesContext.Provider>
        {hasEmbed && <script src={EMBED_LOADER_SRC} defer />}
      </HeadingIdsContext.Provider>
    </ImageSizesContext.Provider>
  )
}

/**
 * Renders one block of `doc` by id, as BlockRenderer does (children through the same
 * function); null for a block nothing in this build renders. The admin's History
 * comparison (#355) renders blocks one at a time with it. With `anchors`, the block it
 * returns renders with its `b-<id>` element id (#356, "Copy link to block"): the public
 * page's top-level blocks; their children (rendered through `renderBlock`) get none.
 * `guard: false` leaves a plugin block's element without its PluginBlockBoundary (for
 * BlockRenderer's server probe, #456).
 */
export function blockRendererFor(
  doc: BlockDocV1,
  { anchors = false, guard = true }: { anchors?: boolean; guard?: boolean } = {},
): (blockId: string) => React.ReactElement | null {
  const render = (blockId: string, topLevel: boolean): React.ReactElement | null => {
    const block = doc.blocks[blockId] as Block
    if (!block) return null

    // Look up the component from the registry
    const Component = blockRegistry.getComponent(block.type)

    if (!Component) {
      // A block nothing in this build renders: a theme or plugin block whose extension
      // was removed (#376, #452), or a type from an older build. It stays in the stored doc (the editor
      // keeps it hidden, not deleted); here it renders nothing. Logged once per type, not
      // on every request.
      if (!unknownTypesLogged.has(block.type)) {
        unknownTypesLogged.add(block.type)
        log.warn("unknown_block_type", { type: block.type })
      }
      return null
    }

    // A theme or plugin block written by a newer build of its extension than this one
    // (e.g. after a rollback, #376): its attrs may mean something this renderer doesn't
    // know, so it renders nothing, like a block of a removed one. It stays in the stored doc.
    if (!rendersBlock(block)) return null

    // WordPress-style shared props - every component gets the same interface
    const element = (
      <Component
        key={block.id}
        block={block}
        doc={doc}
        renderContent={renderContent}
        getBlockContent={getBlockContent}
        renderBlock={renderBlock}
        anchorId={topLevel ? (blockAnchorId(block.id) ?? undefined) : undefined}
      />
    )
    // A plugin's renderer that throws hides its own block only, logged, never the page
    // (#456, PluginBlockBoundary). Theme and core blocks render as they always have.
    if (!guard || pluginOfBlockType(block.type) === null) return element
    return (
      <PluginBlockBoundary key={block.id} type={block.type} blockId={block.id}>
        {element}
      </PluginBlockBoundary>
    )
  }
  const renderBlock = (blockId: string) => render(blockId, false)
  return anchors ? (blockId: string) => render(blockId, true) : renderBlock
}
