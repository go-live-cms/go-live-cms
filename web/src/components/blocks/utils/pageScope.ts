/**
 * One page, several block docs (#484, docs/design/theme-builder.md 3.4). A block template
 * (#491) renders its doc, and inside it the post's (`post_content`) and its parts', each with
 * a BlockRenderer. Two things must then hold for the page, not per doc:
 *
 * - **Heading ids (problem 4).** A heading in the template and one in the post it frames
 *   must not share an id. The template's headings get theirs first, and are reserved for
 *   the post's, as a theme's own element ids (`THEME_ELEMENT_IDS`) are today.
 * - **The embed loader (problem 5).** `/gl-embeds.js` is added once per page, however many
 *   of its docs have an embed.
 *
 * The outermost BlockRenderer provides a PageScope; a BlockRenderer rendered inside one of
 * its blocks reads it: its headings skip `reservedIds` (the page's reserved ids and every
 * outer renderer's heading ids), and instead of adding the loader itself it reports that it
 * needs it, and the outermost adds it once, after its blocks. A page with one doc renders as
 * it always has. A layout that renders docs side by side (not nested) gets the same ids with
 * `pageHeadingAnchors` and passes each list as the renderer's `headings`.
 */
import { createContext } from "react"
import { blockAnchorId, blocksInReadingOrder, embedTargetOf, FOOTNOTES_TITLE_ID, type Block, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { embedNoteId, headingAnchors, type HeadingAnchor } from "./headingAnchors"

export interface PageScope {
  // Ids a nested renderer's headings never take.
  readonly reservedIds: readonly (string | RegExp)[]
  // A nested renderer's doc has an embed. true: the outermost renderer adds the loader;
  // false: it already rendered its end (the nested one rendered late), so the nested one
  // adds the script itself. The script is never missing; it is twice only in that case.
  needEmbedLoader(): boolean
}

// null outside a BlockRenderer: the renderer is the outermost and owns the page's scope.
export const PageScopeContext = createContext<PageScope | null>(null)

/**
 * Whether the doc has an embed that renders (so the page needs `/gl-embeds.js`, #425).
 * `readingOrder` is `blocksInReadingOrder(doc)` when the caller already has it.
 */
export function docHasEmbed(doc: BlockDocV1 | null | undefined, readingOrder?: readonly string[]): boolean {
  if (!doc?.blocks || !Array.isArray(doc.blocks_order)) return false
  return (readingOrder ?? blocksInReadingOrder(doc)).some((id) => {
    const block = doc.blocks[id] as Block | undefined
    return block?.type === "embed" && embedTargetOf(block.attrs) !== null
  })
}

/**
 * The element ids a rendered doc puts on the page besides its headings: its top-level
 * blocks' `b-<id>` anchors (#356) and, with footnotes (#422), the list's title and the
 * `fn-N` / `ref-N` anchors, and every embed's note (`embed-note-<id>`, #481, at any depth). A
 * doc nested inside it reserves them, as headingAnchors does for the doc's own.
 */
export function docElementIds(doc: BlockDocV1 | null | undefined): (string | RegExp)[] {
  if (!doc?.blocks || !Array.isArray(doc.blocks_order)) return []
  const ids: (string | RegExp)[] = []
  for (const blockId of doc.blocks_order) {
    const anchor = blockAnchorId(blockId)
    if (anchor) ids.push(anchor)
  }
  if (doc.blocks_order.some((blockId) => doc.blocks[blockId]?.type === "footnotes")) {
    ids.push(FOOTNOTES_TITLE_ID, /^fn-\d+$/, /^ref-\d+(-\d+)?$/)
  }
  for (const blockId of blocksInReadingOrder(doc)) {
    const note = doc.blocks[blockId]?.type === "embed" ? embedNoteId(blockId) : null
    if (note) ids.push(note)
  }
  return ids
}

/**
 * The heading ids of docs rendered on one page, in the order given (a template first, then
 * the docs it frames): each list is unique within its doc, skips `reserved`, and skips every
 * id an earlier doc's headings took.
 */
export function pageHeadingAnchors(docs: readonly (BlockDocV1 | null | undefined)[], reserved: Iterable<string | RegExp> = []): HeadingAnchor[][] {
  const taken: (string | RegExp)[] = [...reserved]
  return docs.map((doc) => {
    const anchors = headingAnchors(doc, taken)
    for (const anchor of anchors) taken.push(anchor.id)
    return anchors
  })
}
