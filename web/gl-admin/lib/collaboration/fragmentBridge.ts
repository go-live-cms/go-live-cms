import * as Y from "yjs"
import { prosemirrorToYXmlFragment, yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap"
import type { Node as PMNode, Schema } from "prosemirror-model"
import type { Block, BlockDocV1, BlockID } from "../blocks-spec"
import {
  blockDocToPMWithReport,
  pmToBlockDoc,
  restoreDroppedBlocks,
  walkBlockTree,
  type DroppedBlock,
} from "./blockBridge"
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

/** The ProseMirror JSON stored in a block doc (each block's `attrs.pm`), for schemaWithStandIns. */
export const pmRoots = (doc: BlockDocV1): unknown[] =>
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
  const blocks: Record<BlockID, Block> = {}
  for (const { id } of dropped) {
    walkBlockTree(doc, id, (block) => {
      blocks[block.id] = block
    })
  }
  return { entries: dropped, blocks }
}

/** A top-level node of the live doc that `fragmentToBlockDoc` couldn't convert. */
export interface UnconvertibleBlock {
  /** Its `data-block-id`, if it had one. */
  id: BlockID | null
  type: string
  error: unknown
}

export interface FragmentToBlockDocOptions {
  /** What seedFragment dropped; merged back in at the original positions. */
  dropped?: DroppedBlocks
  /**
   * The last stored block doc. A top-level node that can't be converted keeps its
   * version from here instead of disappearing from `block_doc`.
   */
  previous?: BlockDocV1
  /** Called for each top-level node that couldn't be converted. */
  onUnconvertible?: (block: UnconvertibleBlock) => void
}

/**
 * The block doc the fragment holds. Each top-level node is converted on its own, so one
 * node that can't be built (a malformed element from a buggy or newer peer; unknown
 * node and mark types get stand-ins, and unknown attributes are dropped) doesn't fail
 * the whole store: it is reported, and keeps its version from `previous` if there is one.
 * The blocks seeding dropped are merged back in at their original positions
 * (restoreDroppedBlocks), so a store never deletes content the editors couldn't show.
 *
 * Nodes without a valid, unique `data-block-id` get a NEW random id on every call
 * (pmToBlockDoc). Run stampFragmentBlockIds on the live doc first so ids are stable.
 */
export function fragmentToBlockDoc(
  fragment: Y.XmlFragment,
  base: Schema,
  { dropped, previous, onUnconvertible }: FragmentToBlockDocOptions = {},
): BlockDocV1 {
  const json = yXmlFragmentToProsemirrorJSON(fragment) as { content?: any[] }
  const schema = schemaWithStandIns(base, [json])

  const nodes: PMNode[] = []
  const fallbacks: DroppedBlock[] = []
  let afterId: BlockID | null = null
  for (const child of json.content ?? []) {
    const id: BlockID | null = typeof child?.attrs?.["data-block-id"] === "string" ? child.attrs["data-block-id"] : null
    try {
      nodes.push(schema.nodeFromJSON(child))
    } catch (error) {
      onUnconvertible?.({ id, type: String(child?.type), error })
      if (id && previous?.blocks[id]) fallbacks.push({ id, parentId: null, afterId })
    }
    if (id) afterId = id
  }

  let doc = pmToBlockDoc(schema.topNodeType.create(null, nodes))
  if (previous && fallbacks.length > 0) doc = restoreDroppedBlocks(doc, previous, fallbacks)
  if (dropped && dropped.entries.length > 0) {
    doc = restoreDroppedBlocks(doc, { doc_version: 1, blocks_order: [], blocks: dropped.blocks }, dropped.entries)
  }
  return doc
}

const isList = (name: string) => name === "bulletList" || name === "orderedList"

/**
 * Give every node that becomes a block (top-level nodes, and list items of a list at any
 * depth) a valid, unique `data-block-id` in the live doc, by BlockIdExtension's rules:
 * missing, shorter than 10 characters, or a duplicate of an earlier one (doc order) gets
 * a new id. One transaction; returns how many ids it wrote (0 means no Yjs update).
 *
 * The collab server runs this before each store. Otherwise a node an editor didn't
 * stamp (a peer without BlockIdExtension, a race) gets a new random id from pmToBlockDoc
 * on every store, so `block_doc` churns and anything anchored to the id (dropped-block
 * positions, block comments #192) breaks. Editors don't re-stamp synced ids (rule 7),
 * so this converges.
 */
export function stampFragmentBlockIds(
  fragment: Y.XmlFragment,
  newId: () => BlockID = () => crypto.randomUUID(),
): number {
  const used = new Set<BlockID>()
  const unstamped: Y.XmlElement[] = []

  const walk = (parent: Y.XmlFragment | Y.XmlElement, parentName: string | null) => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue
      const isBlock = parentName === null || (child.nodeName === "listItem" && isList(parentName))
      if (isBlock) {
        const id = child.getAttribute("data-block-id")
        if (typeof id === "string" && id.length >= 10 && !used.has(id)) used.add(id)
        else unstamped.push(child)
      }
      walk(child, child.nodeName)
    }
  }
  walk(fragment, null)

  if (unstamped.length === 0) return 0
  const write = () =>
    unstamped.forEach((element) => {
      let id = newId()
      while (used.has(id)) id = newId()
      used.add(id)
      element.setAttribute("data-block-id", id)
    })
  if (fragment.doc) fragment.doc.transact(write)
  else write()
  return unstamped.length
}
