import type * as Y from "yjs"
import { prosemirrorToYXmlFragment, yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap"
import type { Schema } from "prosemirror-model"
import type { Block, BlockDocV1, BlockID } from "../blocks-spec"
import { blockDocToPMWithReport, pmToBlockDoc, restoreDroppedBlocks, type DroppedBlock } from "./blockBridge"
import { schemaWithStandIns } from "./schema"

/**
 * Block Spec v1 ⇄ the editor's Yjs XmlFragment, without an editor. This is what the
 * Hocuspocus collab server runs (#206): it seeds a new doc from `posts.block_doc` and
 * derives `block_doc` from the live doc when it stores it. The client never seeds.
 *
 * Both directions use the same conversions as the editor (blockBridge.ts) on the same
 * schema (schema.ts), so the server writes exactly what the editor would have.
 */

/** The fragment TipTap's Collaboration extension binds to (no `field` option). Not "prosemirror". */
export const EDITOR_FRAGMENT = "default"

/**
 * The blocks seeding had to leave out, with their content (and list children), so a
 * later store can put them back. The server keeps this next to the doc: the source
 * block doc is gone by then.
 */
export interface DroppedBlocks {
  entries: DroppedBlock[]
  blocks: Record<BlockID, Block>
}

const pmRoots = (doc: BlockDocV1) =>
  Object.values(doc.blocks)
    .map((block) => (block.attrs as { pm?: unknown } | undefined)?.pm)
    .filter(Boolean)

/**
 * Write `doc` into an EMPTY fragment. Blocks that can't become a valid node are left
 * out and returned (#213), never thrown for the whole doc. Theme blocks are kept (see
 * schemaWithStandIns). Seeding a fragment that already has content would duplicate it.
 */
export function seedFragment(doc: BlockDocV1, fragment: Y.XmlFragment, base: Schema): DroppedBlocks {
  if (fragment.length > 0) throw new Error("seedFragment: the fragment is not empty")
  const schema = schemaWithStandIns(base, pmRoots(doc))
  const { node, dropped } = blockDocToPMWithReport(doc, schema)
  prosemirrorToYXmlFragment(node, fragment)
  return { entries: dropped, blocks: droppedTrees(doc, dropped) }
}

/**
 * The block doc the fragment holds, with the blocks seeding dropped merged back in at
 * their original positions (restoreDroppedBlocks), so a store never deletes content the
 * editors couldn't show.
 */
export function fragmentToBlockDoc(fragment: Y.XmlFragment, base: Schema, dropped?: DroppedBlocks): BlockDocV1 {
  const json = yXmlFragmentToProsemirrorJSON(fragment)
  const schema = schemaWithStandIns(base, [json])
  const doc = pmToBlockDoc(schema.nodeFromJSON(json))
  if (!dropped || dropped.entries.length === 0) return doc
  return restoreDroppedBlocks(doc, { doc_version: 1, blocks_order: [], blocks: dropped.blocks }, dropped.entries)
}

/** The dropped blocks and everything under them, taken from the doc they were dropped from. */
function droppedTrees(source: BlockDocV1, dropped: DroppedBlock[]): Record<BlockID, Block> {
  const blocks: Record<BlockID, Block> = {}
  const copy = (id: BlockID) => {
    const block = source.blocks[id]
    if (!block || blocks[id]) return
    blocks[id] = block
    block.children?.forEach(copy)
  }
  dropped.forEach(({ id }) => copy(id))
  return blocks
}
