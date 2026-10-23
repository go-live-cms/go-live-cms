// onLoadDocument (#206): turn the API's collab record into the live Y.Doc.
//
//   - stored Yjs state at the post's current block_revision → apply it as is;
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
import type { BlockDocV1 } from "../gl-admin/lib/blocks-spec"
import { EDITOR_FRAGMENT, seedFragment, type DroppedBlocks } from "../gl-admin/lib/collaboration/fragmentBridge"
import type { CollabRecord } from "./api"

/**
 * Server-owned metadata, persisted inside the doc: `epoch` and `dropped`. (The old
 * client also keeps `restore_id` here; the keys don't collide.) The pre-Hocuspocus Block
 * Spec mirror (BlockDocManager's `blocks` map and `blocks_order` array) is emptied on load.
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

export type LoadOutcome =
  | { kind: "restored"; epoch: string }
  | { kind: "seeded"; epoch: string; dropped: number; reason: "no-state" | "revision-mismatch" }

// `{}` (a post that never had blocks) counts as empty, like null (#304). api.ts already
// normalizes it; this guard keeps a malformed doc from throwing here regardless.
const isEmptyBlockDoc = (doc: BlockDocV1 | null): boolean =>
  !doc || !Array.isArray(doc.blocks_order) || doc.blocks_order.length === 0

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
    Y.applyUpdate(doc, Buffer.from(record.ydoc_state as string, "base64"), SERVER_ORIGIN)
    const epoch = record.epoch as string
    doc.transact(() => {
      const meta = doc.getMap<unknown>(META_MAP)
      if (meta.get("epoch") !== epoch) meta.set("epoch", epoch)
      clearLegacyMaps(doc)
    }, SERVER_ORIGIN)
    return { kind: "restored", epoch }
  }

  const reason = record.ydoc_state ? "revision-mismatch" : "no-state"
  const epoch = newEpoch()
  let droppedCount = 0
  doc.transact(() => {
    let dropped: DroppedBlocks | null = null
    if (!isEmptyBlockDoc(record.block_doc)) {
      dropped = seedFragment(record.block_doc as BlockDocV1, doc.getXmlFragment(EDITOR_FRAGMENT), schema)
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
