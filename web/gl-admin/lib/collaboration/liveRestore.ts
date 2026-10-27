import type * as Y from "yjs"
import type { Editor } from "@tiptap/core"
import type { Block, BlockDocV1, BlockID } from "../blocks-spec"
import { blockDocToPMWithReport, setEditorBlockDoc, walkBlockTree } from "./blockBridge"
import { CollabStoreError, type CollabSaveStatus } from "./CollabSaveStatus"
import type { DroppedBlocks } from "./fragmentBridge"
import { META_MAP } from "./HocuspocusCollaboration"

/**
 * Restore a stored version (#136) through the live doc (#206). Rule 9 holds: it
 * goes through the editor, never around it. `setEditorBlockDoc` replaces the content,
 * the ySyncPlugin mirrors that into the shared fragment, and every peer gets it as an
 * ordinary edit. The collab server then stores it like any edit; there is no PUT.
 *
 * The version's blocks the editor can't show (#213) replace the doc's `meta.dropped`
 * record, which the server merges back into every stored block_doc, so they stay hidden,
 * never deleted. That happens only after the editor accepted the version: otherwise the
 * old content would be saved with the version's hidden blocks.
 *
 * Resolves `{ saved: true }` once the server reports a store that includes the restore,
 * `{ saved: false }` if none came within `timeoutMs` (the server stores it later; its
 * result shows in the save status). A failed store rejects.
 */
export async function restoreVersionLive(
  editor: Editor,
  doc: BlockDocV1,
  ydoc: Y.Doc,
  status: CollabSaveStatus,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {}
): Promise<{ saved: boolean; dropped: number }> {
  if (editor.isDestroyed) throw new Error("No editor to restore into")
  if (!editor.isEditable) throw new Error("This editor is read-only")

  const { node, dropped } = blockDocToPMWithReport(doc, editor.schema)
  if (!setEditorBlockDoc(editor, node)) {
    throw new Error("Failed to load the version into the editor")
  }

  const blocks: Record<BlockID, Block> = {}
  for (const { id } of dropped) {
    walkBlockTree(doc, id, (block) => {
      blocks[block.id] = block
    })
  }
  const record: DroppedBlocks = { entries: dropped, blocks }
  ydoc.transact(() => {
    const meta = ydoc.getMap(META_MAP)
    // Plain JSON, as the server writes it on seed (web/collab-server/load.ts).
    if (dropped.length > 0) meta.set("dropped", JSON.parse(JSON.stringify(record)))
    else if (meta.has("dropped")) meta.delete("dropped")
  })

  try {
    await status.waitForStored({ timeoutMs })
    return { saved: true, dropped: dropped.length }
  } catch (error) {
    // Not confirmed in time: the edit is in the live doc and the server stores it.
    if (error instanceof CollabStoreError && /hasn't/.test(error.message)) return { saved: false, dropped: dropped.length }
    throw error
  }
}
