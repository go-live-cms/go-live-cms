// onStoreDocument (#206): derive `block_doc` from the live doc and persist both.
//
//   1. stamp missing/duplicate block ids into the live doc (stampFragmentBlockIds), so
//      ids don't churn between stores;
//   2. fragment → ProseMirror → pmToBlockDoc, per top-level node (fragmentToBlockDoc),
//      with the blocks seeding dropped (meta.dropped) merged back (restoreDroppedBlocks);
//   3. validateBlockDoc (Zod) — #214 part 2. An invalid doc is NOT written: the Yjs
//      state is stored alone and `posts.block_doc` keeps its last valid version;
//   4. empty-doc guard: an empty result is written only if a client edited the doc since
//      it was loaded (someone deleted everything), never as the fallout of a failed seed;
//   5. PUT /internal/posts/:id/collab.
import * as Y from "yjs"
import type { Schema } from "prosemirror-model"
import { validateBlockDoc, type BlockDocV1 } from "../gl-admin/lib/blocks-spec"
import {
  EDITOR_FRAGMENT,
  fragmentToBlockDoc,
  stampFragmentBlockIds,
  type UnconvertibleBlock,
} from "../gl-admin/lib/collaboration/fragmentBridge"
import type { CollabStoreBody } from "./api"
import { readMeta, SERVER_ORIGIN } from "./load"

export interface StoreInput {
  /** The last valid block_doc (from the load, then from each successful store). */
  previous: BlockDocV1 | null
  /** Whether a client changed the doc since it was loaded. */
  clientEdited: boolean
  lastEditorId: string | null
}

export type BlockDocDecision =
  | { write: true; blockDoc: BlockDocV1 }
  | { write: false; reason: "invalid"; error: string }
  | { write: false; reason: "empty-without-edit" }
  | { write: false; reason: "unchanged" }

export interface PreparedStore {
  body: CollabStoreBody
  decision: BlockDocDecision
  unconvertible: UnconvertibleBlock[]
  /** How many block ids were stamped into the live doc. */
  stamped: number
}

/** A short, log-safe summary of a Zod (or other) validation error. */
function validationSummary(error: unknown): string {
  const issues = (error as { issues?: { path?: (string | number)[]; message?: string }[] })?.issues
  if (Array.isArray(issues) && issues.length > 0) {
    const shown = issues.slice(0, 3).map((issue) => `${(issue.path ?? []).join(".")}: ${issue.message}`)
    return `${issues.length} issue(s): ${shown.join("; ")}`
  }
  return error instanceof Error ? error.message : String(error)
}

/** JSON with object keys sorted: the stored doc comes back from Postgres jsonb, which reorders keys. */
const canonicalJSON = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )

const sameDoc = (a: BlockDocV1 | null, b: BlockDocV1): boolean => !!a && canonicalJSON(a) === canonicalJSON(b)

/** Steps 1–4. Mutates the doc only to stamp block ids (origin SERVER_ORIGIN). */
export function prepareStore(doc: Y.Doc, schema: Schema, input: StoreInput): PreparedStore {
  const fragment = doc.getXmlFragment(EDITOR_FRAGMENT)
  let stamped = 0
  doc.transact(() => {
    stamped = stampFragmentBlockIds(fragment)
  }, SERVER_ORIGIN)

  const { epoch, dropped } = readMeta(doc)
  if (!epoch) throw new Error("document has no epoch (it was not loaded by this server)")

  const unconvertible: UnconvertibleBlock[] = []
  const derived = fragmentToBlockDoc(fragment, schema, {
    dropped: dropped ?? undefined,
    previous: input.previous ?? undefined,
    onUnconvertible: (block) => unconvertible.push(block),
  })

  let decision: BlockDocDecision
  try {
    validateBlockDoc(derived)
    if (derived.blocks_order.length === 0 && !input.clientEdited && !isEmpty(input.previous)) {
      decision = { write: false, reason: "empty-without-edit" }
    } else if (sameDoc(input.previous, derived)) {
      decision = { write: false, reason: "unchanged" }
    } else {
      decision = { write: true, blockDoc: derived }
    }
  } catch (error) {
    decision = { write: false, reason: "invalid", error: validationSummary(error) }
  }

  const body: CollabStoreBody = {
    state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
    epoch,
  }
  if (decision.write) body.block_doc = decision.blockDoc
  const editor = input.lastEditorId ? Number(input.lastEditorId) : NaN
  if (Number.isSafeInteger(editor) && editor > 0) body.last_editor_id = editor
  return { body, decision, unconvertible, stamped }
}

const isEmpty = (doc: BlockDocV1 | null): boolean => !doc || doc.blocks_order.length === 0
