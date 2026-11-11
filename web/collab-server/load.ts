// onLoadDocument (#206): turn the API's collab record into the live Y.Doc.
//
//   - stored Yjs state at the post's current block_revision → apply it as is, unless it
//     holds a block of an extension this build doesn't have, or meta.dropped holds one it
//     now has back (#453: RESEED, see reseedFromState);
//   - otherwise (no state yet, or `block_doc` was written around the collab server) →
//     SEED: block_doc → ProseMirror (blockDocToPMWithReport, via seedFragment) → the
//     "default" XmlFragment, with what couldn't be built kept in meta.dropped and a NEW
//     meta.epoch, so a tab holding the old doc's structs is refused (stale-epoch) instead
//     of merging them in and duplicating everything.
//
// This is the ONLY place anything seeds a collab doc. The client never does.
import { randomUUID } from "node:crypto"
import * as Y from "yjs"
import type { Schema } from "prosemirror-model"
import { dedupeBlockRefs, type Block, type BlockDocV1, type BlockID } from "../gl-admin/lib/blocks-spec"
import { isExtensionBlockType } from "../gl-admin/lib/blocks-spec/themeBlocks"
import {
  EDITOR_FRAGMENT,
  fragmentToBlockDoc,
  repairColumnsFragment,
  repairEmptyContainers,
  repairFootnotesFragment,
  seedFragment,
  seedPlan,
  stampFragmentBlockIds,
  type DroppedBlocks,
} from "../gl-admin/lib/collaboration/fragmentBridge"
import { normalizeBlockDoc, type CollabRecord } from "./api"

/**
 * Server-owned metadata, persisted inside the doc: `epoch` and `dropped`. (The client
 * before #206 kept `restore_id` here too; the keys don't collide.) That client's Block
 * Spec mirror (the `blocks` map and `blocks_order` array) is emptied on load, if a doc
 * still has one.
 */
export const META_MAP = "meta"

/** Transaction origin for the server's own writes (seeding, legacy cleanup, id stamping). */
export const SERVER_ORIGIN = "golive-collab-server"

export interface DocMeta {
  epoch: string | null
  dropped: DroppedBlocks | null
}

export function readMeta(doc: Y.Doc): DocMeta {
  const meta = doc.getMap<unknown>(META_MAP)
  const epoch = meta.get("epoch")
  const dropped = meta.get("dropped") as DroppedBlocks | undefined
  return {
    epoch: typeof epoch === "string" && epoch ? epoch : null,
    dropped: dropped && Array.isArray(dropped.entries) && dropped.blocks ? dropped : null,
  }
}

export type SeedReason = "no-state" | "revision-mismatch" | "uninstalled-blocks"

export type LoadOutcome =
  /** `reseedError`: the reseed check (#453) threw, so the state was applied as it was. */
  | { kind: "restored"; epoch: string; reseedError?: string }
  | { kind: "seeded"; epoch: string; dropped: number; reason: SeedReason }

// Only called on a normalizeBlockDoc result: null or a well-shaped doc.
const isEmptyBlockDoc = (doc: BlockDocV1 | null): boolean => !doc || doc.blocks_order.length === 0

/** Whether the record's stored Yjs state may be used: present, with an epoch, and produced at the current revision. */
export function usableState(record: CollabRecord): boolean {
  if (!record.ydoc_state || !record.epoch) return false
  return record.ydoc_block_revision == null || record.ydoc_block_revision === record.block_revision
}

/**
 * Fills `doc` (fresh and empty, as Hocuspocus hands it to onLoadDocument) from `record`.
 * Throws if the stored state can't be decoded: better to refuse the connection than to
 * reseed over state that may hold edits block_doc doesn't have.
 */
export function loadIntoDoc(
  doc: Y.Doc,
  record: CollabRecord,
  schema: Schema,
  newEpoch: () => string = randomUUID,
): LoadOutcome {
  if (usableState(record)) {
    const update = Buffer.from(record.ydoc_state as string, "base64")
    // A scratch doc first (#453): the real one gets the state only when it needs no reseed.
    const scratch = new Y.Doc()
    let reseed: BlockDocV1 | null = null
    let reseedError: string | undefined
    try {
      Y.applyUpdate(scratch, update, SERVER_ORIGIN)
      try {
        reseed = reseedFromState(scratch, record, schema)
      } catch (error) {
        // Never worse than before #453: the state as it is (the editor may open it read-only).
        reseedError = error instanceof Error ? error.message : String(error)
      }
    } finally {
      scratch.destroy()
    }
    if (reseed) return seed(doc, reseed, schema, newEpoch(), "uninstalled-blocks")

    Y.applyUpdate(doc, update, SERVER_ORIGIN)
    const epoch = record.epoch as string
    doc.transact(() => {
      const meta = doc.getMap<unknown>(META_MAP)
      if (meta.get("epoch") !== epoch) meta.set("epoch", epoch)
      clearLegacyMaps(doc)
    }, SERVER_ORIGIN)
    return reseedError ? { kind: "restored", epoch, reseedError } : { kind: "restored", epoch }
  }

  // `{}` (a post that never had blocks, #304) → null; any other malformed doc throws, so the
  // load fails instead of seeding an empty editor whose next store would overwrite it.
  // api.ts already normalizes; this repeats it for callers that don't go through it
  // (the in-memory FakeCollabApi).
  const blockDoc = normalizeBlockDoc(record.block_doc)
  return seed(doc, blockDoc, schema, newEpoch(), record.ydoc_state ? "revision-mismatch" : "no-state")
}

function seed(doc: Y.Doc, blockDoc: BlockDocV1 | null, schema: Schema, epoch: string, reason: SeedReason): LoadOutcome {
  let droppedCount = 0
  doc.transact(() => {
    let dropped: DroppedBlocks | null = null
    if (!isEmptyBlockDoc(blockDoc)) {
      dropped = seedFragment(blockDoc as BlockDocV1, doc.getXmlFragment(EDITOR_FRAGMENT), schema)
      droppedCount = dropped.entries.length
    }
    const meta = doc.getMap<unknown>(META_MAP)
    meta.set("epoch", epoch)
    // JSON in a Y.Map value: stored with the doc, so it survives restarts, and every
    // store merges these blocks back (restoreDroppedBlocks) instead of deleting them.
    if (dropped && dropped.entries.length > 0) meta.set("dropped", JSON.parse(JSON.stringify(dropped)))
    else meta.delete("dropped")
    clearLegacyMaps(doc)
  }, SERVER_ORIGIN)
  return { kind: "seeded", epoch, dropped: droppedCount, reason }
}

/**
 * The block doc to reseed a usable stored state from, or null to apply the state as is
 * (#453, design `docs/design/plugin-system.md` 4.4). `scratch` holds the state; it is
 * repaired and stamped as a store would, then thrown away.
 *
 * Reseed when:
 *   (a) the fragment holds a namespaced node (`theme:` / `plugin:`) the schema lacks, at
 *       any depth: its extension was removed from the build, and the editor's rule 10 gate
 *       couldn't bind the post at all. The seed drops and keeps that block (seedPlan makes
 *       no stand-in for it), so the next load finds nothing to reseed;
 *   (b) meta.dropped holds a namespaced block (or one whose `pm` holds such a node) the
 *       schema now has, and a dry-run seed drops fewer blocks than meta.dropped has: its
 *       extension is back, and so is the block, in place. The dry run stops a block dropped
 *       for another reason (bad content, a newer version) from reseeding on every load.
 *
 * Derived from the STATE, not from block_doc: a post whose last store was kept-invalid has
 * edits block_doc doesn't.
 */
function reseedFromState(scratch: Y.Doc, record: CollabRecord, schema: Schema): BlockDocV1 | null {
  const fragment = scratch.getXmlFragment(EDITOR_FRAGMENT)
  const { dropped } = readMeta(scratch)
  const missing = holdsMissingExtensionNode(fragment, schema)
  if (!missing && !(dropped && droppedHoldsKnownExtension(dropped, schema))) return null

  const previous = normalizeBlockDoc(record.block_doc) ?? undefined
  scratch.transact(() => {
    repairColumnsFragment(fragment)
    repairFootnotesFragment(fragment)
    repairEmptyContainers(fragment)
    stampFragmentBlockIds(fragment)
  }, SERVER_ORIGIN)
  const derived = dedupeBlockRefs(fragmentToBlockDoc(fragment, schema, { dropped: dropped ?? undefined, previous }))
  // The dropped blocks merged back in are exactly as stored: leave them alone. (A previous
  // version a fallback copied is block_doc's already, so taking it again changes nothing.)
  const blockDoc = withExtensionBlockShape(derived, new Set(Object.keys(dropped?.blocks ?? {})), previous, schema)
  if (missing) return blockDoc
  return seedPlan(blockDoc, schema).dropped.entries.length < (dropped as DroppedBlocks).entries.length ? blockDoc : null
}

const isMissingExtension = (type: unknown, schema: Schema): boolean =>
  typeof type === "string" && isExtensionBlockType(type) && !schema.nodes[type]

/** Whether any element of the fragment, at any depth, is a namespaced type `schema` doesn't have. */
function holdsMissingExtensionNode(parent: Y.XmlFragment | Y.XmlElement, schema: Schema): boolean {
  return parent
    .toArray()
    .some((child) => child instanceof Y.XmlElement && (isMissingExtension(child.nodeName, schema) || holdsMissingExtensionNode(child, schema)))
}

/** Whether a dropped block is, or its `pm` holds, a namespaced type `schema` now has. */
function droppedHoldsKnownExtension(dropped: DroppedBlocks, schema: Schema): boolean {
  const known = (type: unknown) => typeof type === "string" && isExtensionBlockType(type) && !!schema.nodes[type]
  const pmHolds = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false
    const { type, content } = node as { type?: unknown; content?: unknown }
    return known(type) || (Array.isArray(content) && content.some(pmHolds))
  }
  return Object.values(dropped.blocks).some((block) => known(block.type) || pmHolds((block.attrs as { pm?: unknown } | undefined)?.pm))
}

/**
 * A block of a missing extension read from the fragment went through a stand-in, which
 * stores it as a generic custom block, with its declared attrs inside `pm` too: the wrong
 * shape for a reinstall (an installed block reads them from the block's attrs only). Each
 * one takes its stored version from block_doc by id when it has one, else has its attrs
 * lifted out of `pm` onto the block, as an installed block stores them.
 */
function withExtensionBlockShape(doc: BlockDocV1, asStored: Set<BlockID>, previous: BlockDocV1 | undefined, schema: Schema): BlockDocV1 {
  let blocks: Record<BlockID, Block> | null = null
  for (const [id, block] of Object.entries(doc.blocks)) {
    if (asStored.has(id) || !isMissingExtension(block.type, schema)) continue
    const stored = previous?.blocks[id]
    blocks ??= { ...doc.blocks }
    blocks[id] = stored && stored.type === block.type ? stored : liftedAttrs(block)
  }
  return blocks ? { ...doc, blocks } : doc
}

function liftedAttrs(block: Block): Block {
  const { pm, text } = block.attrs as { pm?: { attrs?: Record<string, unknown>; content?: unknown[] }; text?: unknown }
  const declared = Object.fromEntries(
    Object.entries(pm?.attrs ?? {}).filter(([name, value]) => name !== "data-block-id" && value !== null && value !== undefined),
  )
  return {
    ...block,
    attrs: {
      ...declared,
      pm: pm?.content ? { type: block.type, content: pm.content } : { type: block.type },
      ...(typeof text === "string" && text ? { text } : {}),
    },
  } as Block
}

// A root type can't be removed from a Y.Doc, only emptied. Nothing reads these any more.
function clearLegacyMaps(doc: Y.Doc): void {
  if (doc.share.has("blocks")) {
    const blocks = doc.getMap("blocks")
    if (blocks.size > 0) blocks.clear()
  }
  if (doc.share.has("blocks_order")) {
    const order = doc.getArray("blocks_order")
    if (order.length > 0) order.delete(0, order.length)
  }
}
