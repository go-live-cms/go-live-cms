import React, { useContext } from "react"
import { blockAnchorId, blocksInReadingOrder, footnoteIndex, type BlockDocV1, type Block } from "@gl-admin/lib/blocks-spec"
import { blockRegistry } from "./blocks/registry"
import { isExtensionBlockType, pluginOfBlockType } from "@gl-admin/lib/blocks-spec/themeBlocks"
import { PluginBlockBoundary, PluginBlockChecksContext, probePluginBlocks } from "./blocks/PluginBlockBoundary"
import { renderContent, getBlockContent, isBlankParagraph } from "./blocks/utils/contentRenderer"
import { ImageSizesContext, BLOCK_IMAGE_SIZES } from "./blocks/utils/responsiveImage"
import { HeadingIdsContext, headingAnchors, type HeadingAnchor } from "./blocks/utils/headingAnchors"
import { FootnotesContext } from "./blocks/utils/footnotes"
import { docElementIds, docHasEmbed, PageScopeContext, siteBlockTitleIds, SiteBlockTitleIdsContext, type PageScope } from "./blocks/utils/pageScope"
import { SiteContext, type SiteRenderContext } from "./blocks/utils/siteContext"
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
  // Ids the page already uses (e.g. a theme's own `content`), which computed heading ids
  // skip; ignored when `headings` is given. Inside another BlockRenderer's blocks, that
  // renderer's reserved and heading ids are skipped too (pageScope.ts, #484).
  reservedIds?: Iterable<string | RegExp>
  // What the site blocks read (#488, blocks/utils/siteContext.ts): set by a block template's
  // layout (#491), inherited by renderers nested in its blocks (a part). Absent: the one
  // around this renderer, if any; a post's body has none, so its site blocks render nothing.
  // `null` clears it, for a post's own body rendered inside a template (`post_content`, #489).
  site?: SiteRenderContext | null
  // Top-level blocks get their `b-<id>` element ids (#356, "Copy link to block"). false for a
  // block template and its parts (#491, design 3.4): the post rendered by `post_content` keeps
  // its anchors, so a copied link still points at the post's blocks.
  anchors?: boolean
  // "template": a block template's page body (#491). The template parts that open the doc
  // render before `<main id="content" class="site-main">`, the ones that close it after, and
  // every other block inside it, so the page has the landmarks a theme's base layout gives it.
  frame?: "template"
}

// The embed loader of the page's outermost renderer: added after its blocks if its own doc,
// or a renderer nested in its blocks, has an embed. Rendered after the blocks, so nested
// renderers have normally reported by then; one that renders later (e.g. resolved after a
// Suspense boundary) is told it's too late (`closed`) and adds its own, so the script is
// never missing.
type LoaderState = { needed: boolean; closed: boolean }
function EmbedLoader({ state }: { state: LoaderState }) {
  state.closed = true
  return state.needed ? <script src={EMBED_LOADER_SRC} defer /> : null
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
export default function BlockRenderer({ doc, imageSizes = BLOCK_IMAGE_SIZES, headings, reservedIds, site, anchors: withAnchors = true, frame }: BlockRendererProps) {
  // The page this doc is part of (#484): set when this renderer is inside another's blocks.
  const page = useContext(PageScopeContext)
  const inheritedSite = useContext(SiteContext)
  const siteContext = site === undefined ? inheritedSite : site
  // #497: the site blocks' section titles ("toc-title", …), for the whole page (the template and
  // its parts), only where they render. The outermost renderer of a template works them out and
  // reserves them, so its headings, its parts' and the post's (`post_content`) skip them; nested
  // renderers read the same map and have them in the page scope already.
  const inheritedTitleIds = useContext(SiteBlockTitleIdsContext)
  const ownTitleIds =
    inheritedTitleIds === null && siteContext?.inTemplate === true
      ? siteBlockTitleIds(doc, siteContext.kind === "template" ? { parts: siteContext.parts } : { partSlug: siteContext.partSlug })
      : null
  const titleIds = inheritedTitleIds ?? ownTitleIds
  const reserved = [...(page?.reservedIds ?? []), ...(reservedIds ?? []), ...(ownTitleIds?.values() ?? [])]
  const anchors = headings ?? headingAnchors(doc, reserved)
  const headingIds = new Map(anchors.map((h) => [h.blockId, h.id]))
  const renderBlock = blockRendererFor(doc, { anchors: withAnchors })

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
  // is ours, on this site: nothing is asked of a provider until a reader clicks. Once per
  // page (#484): a nested renderer reports it to the outermost, which adds it.
  const readingOrder = blocksInReadingOrder(doc)
  const hasEmbed = docHasEmbed(doc, readingOrder)
  const loader: LoaderState | null = page ? null : { needed: hasEmbed, closed: false }
  // A nested renderer adds the script itself only if the outermost can no longer.
  const ownLoader = page !== null && hasEmbed && !page.needEmbedLoader()
  // What renderers nested in this doc's blocks skip and report to: this doc's reserved,
  // anchor and heading ids.
  const scope: PageScope = {
    reservedIds: [...reserved, ...docElementIds(doc), ...anchors.map((h) => h.id)],
    needEmbedLoader: page
      ? () => page.needEmbedLoader()
      : () => {
          if (loader!.closed) return false
          loader!.needed = true
          return true
        },
  }

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
    <SiteContext.Provider value={siteContext}>
      <PageScopeContext.Provider value={scope}>
        <ImageSizesContext.Provider value={imageSizes}>
          <HeadingIdsContext.Provider value={headingIds}>
            <FootnotesContext.Provider value={footnotes}>
              <PluginBlockChecksContext.Provider value={failedPluginBlocks}>
                <SiteBlockTitleIdsContext.Provider value={titleIds}>
                  {frame === "template" ? (
                    templateFrame(doc, uniqueBlockIds, renderBlock)
                  ) : (
                    <div className="block-content">{uniqueBlockIds.map((blockId) => renderBlock(blockId))}</div>
                  )}
                </SiteBlockTitleIdsContext.Provider>
              </PluginBlockChecksContext.Provider>
            </FootnotesContext.Provider>
            {loader && <EmbedLoader state={loader} />}
            {ownLoader && <script src={EMBED_LOADER_SRC} defer />}
          </HeadingIdsContext.Provider>
        </ImageSizesContext.Provider>
      </PageScopeContext.Provider>
    </SiteContext.Provider>
  )
}

/**
 * A block template's body (#491): the template parts at the start of the doc (a header), then
 * the rest in `<main id="content" class="site-main" tabindex="-1">` (the skip link's target, as in
 * a theme's base layout), then the parts at the end (a footer). A part between other blocks stays
 * in `<main>` where it sits.
 */
function templateFrame(doc: BlockDocV1, ids: string[], renderBlock: (blockId: string) => React.ReactElement | null) {
  const isPart = (id: string) => (doc.blocks[id] as Block | undefined)?.type === "template_part"
  let start = 0
  while (start < ids.length && isPart(ids[start])) start++
  let end = ids.length
  while (end > start && isPart(ids[end - 1])) end--
  return (
    <>
      {ids.slice(0, start).map((id) => renderBlock(id))}
      <main id="content" className="site-main" tabIndex={-1}>
        <div className="block-content">{ids.slice(start, end).map((id) => renderBlock(id))}</div>
      </main>
      {ids.slice(end).map((id) => renderBlock(id))}
    </>
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
