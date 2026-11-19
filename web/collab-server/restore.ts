// Server-side restore of a stored version (#286; plan: #206 P6).
//
// The API's POST /posts/:id/versions/:no/restore sends the version's block_doc to the
// internal listener (POST /internal/documents/post-<id>/restore), and `restore` in
// server.ts puts it into the live doc through a direct connection (openDirectConnection),
// so a restore works whether or not anyone has the post open. Open editors receive it as
// an ordinary remote update. Rule 11 holds: the collab server is still the only writer of
// the Yjs state and of block_doc.
//
// Two pure halves live here:
//   - `planRestore`: the version → a ProseMirror doc with THIS server's schema and no
//     stand-ins, as the editor's own restore (liveRestore.ts) converts it with the editor's
//     schema. The fingerprint guard (#416) makes every connected editor's schema equal to
//     this one, so every node the restore writes is one they can all build (rule 10: an
//     element y-tiptap can't build is deleted for every peer). Blocks this schema can't
//     build (an uninstalled theme's or plugin's, #453; an empty code block; a pre-#376
//     custom type) are left out and kept in meta.dropped (#213), never deleted;
//   - `applyRestore`: one Yjs transaction that writes it into the "default" fragment with
//     y-tiptap's own diff (`prosemirrorToYXmlFragment` on the existing fragment is
//     `updateYFragment`, what the editor's ySyncPlugin runs for a local change). Unchanged
//     nodes keep their Y elements, so a peer typing in a block the version doesn't change
//     keeps those keystrokes; text the version changes is replaced like any concurrent
//     edit; keystrokes inside a block the version removes go with it.
//
// Must stay free of logging the doc's content.
import * as Y from "yjs"
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap"
import type { Node as PMNode, Schema } from "prosemirror-model"
import type { Block, BlockDocV1, BlockID } from "../gl-admin/lib/blocks-spec"
import { blockDocToPMWithReport, walkBlockTree } from "../gl-admin/lib/collaboration/blockBridge"
import { EDITOR_FRAGMENT, type DroppedBlocks } from "../gl-admin/lib/collaboration/fragmentBridge"
import { normalizeBlockDoc } from "./api"
import { META_MAP } from "./load"

export interface RestorePlan {
  /** The version as the editor would show it. */
  node: PMNode
  /** Its blocks the schema can't build, kept hidden (meta.dropped) and merged back by every store. */
  dropped: DroppedBlocks
}

/** A version the restore can't use: not a Block Spec v1 document. Nothing was changed. */
export class InvalidVersionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidVersionError"
  }
}

const EMPTY_DOC: BlockDocV1 = { doc_version: 1, blocks_order: [], blocks: {} }

/**
 * The version (`raw`, as the API sends it) as a ProseMirror doc of `schema`, and the blocks
 * left out. `{}` or null is an empty version (#304). Throws `InvalidVersionError` for
 * anything that isn't shaped like a Block Spec v1 document.
 */
export function planRestore(raw: unknown, schema: Schema): RestorePlan {
  let doc: BlockDocV1 | null
  try {
    doc = normalizeBlockDoc(raw)
  } catch {
    throw new InvalidVersionError("the version is not a Block Spec v1 document")
  }
  const source = doc ?? EMPTY_DOC
  const report = blockDocToPMWithReport(source, schema)
  // An empty version (or one whose every block was left out) is one empty paragraph, as
  // the editor shows an empty post: a doc with no children isn't valid for the schema.
  const node = report.node.childCount > 0 ? report.node : (schema.topNodeType.createAndFill() ?? report.node)
  const blocks: Record<BlockID, Block> = {}
  for (const { id } of report.dropped) {
    walkBlockTree(source, id, (block) => {
      blocks[block.id] = block
    })
  }
  return { node, dropped: { entries: report.dropped, blocks } }
}

/**
 * Writes the plan into `doc` in ONE transaction with `origin`: the fragment through
 * y-tiptap's diff, and the version's dropped-block record in place of the doc's (as
 * liveRestore does: the old record belonged to the content being replaced).
 */
export function applyRestore(doc: Y.Doc, plan: RestorePlan, origin: unknown): void {
  doc.transact(() => {
    prosemirrorToYXmlFragment(plan.node, doc.getXmlFragment(EDITOR_FRAGMENT))
    const meta = doc.getMap<unknown>(META_MAP)
    // Plain JSON, as the seed writes it (load.ts).
    if (plan.dropped.entries.length > 0) meta.set("dropped", JSON.parse(JSON.stringify(plan.dropped)))
    else if (meta.has("dropped")) meta.delete("dropped")
  }, origin)
}
