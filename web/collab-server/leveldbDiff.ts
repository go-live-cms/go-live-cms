// The comparison behind scripts/collab/leveldb-diff.mjs (#206 P4, #284): before the
// cutover, does each y-websocket LevelDB doc hold the same content as `posts.block_doc`?
//
// Hocuspocus never imports LevelDB state: it seeds every doc from `block_doc`. So a doc
// whose `"default"` fragment holds something `block_doc` doesn't (an autosave that never
// caught up) would lose that content at the cutover. This finds those docs. Read-only:
// it works on a scratch Y.Doc built from the exported update and never writes anywhere.
// Deleted with the y-websocket path in P5.
import * as Y from "yjs"
import type { Schema } from "prosemirror-model"
import type { Block, BlockDocV1, BlockID } from "../gl-admin/lib/blocks-spec"
import { EDITOR_FRAGMENT, fragmentToBlockDoc, seedFragment } from "../gl-admin/lib/collaboration/fragmentBridge"
import { canonicalJSON } from "./store"

export type DiffStatus =
  /** Same blocks, same ids. */
  | "match"
  /** Same content, but some block ids differ. Harmless: Hocuspocus seeds block_doc's ids. */
  | "ids-differ"
  /** The content differs: the cutover would lose whatever only LevelDB has. */
  | "differs"
  /** LevelDB holds no editor content for it (only the old maps, or nothing). Harmless. */
  | "empty"
  /** No such post in Postgres (deleted). Harmless: nothing will load that doc again. */
  | "no-post"
  /** The doc name isn't `post-<id>`. Ignored. */
  | "not-a-post"
  /** Gapped update log; the old server would have quarantined it too. */
  | "corrupt"

export interface DiffResult {
  doc: string
  postId: number | null
  status: DiffStatus
  /** Top-level block counts (blocks_order). */
  leveldbBlocks?: number
  postgresBlocks?: number
  /** For "differs": where the two first part ways. */
  firstDifference?: string
  /** Nodes fragmentToBlockDoc couldn't convert (they keep block_doc's version). */
  unconvertible?: number
}

export interface LeveldbDoc {
  doc: string
  /** Y.encodeStateAsUpdate of the persisted doc, or null if its log is gapped. */
  update: Uint8Array | null
}

const POST_DOC = /^post-([1-9][0-9]*)$/

/** One LevelDB doc against its post's block_doc (`undefined`: the post doesn't exist). */
export function compareDoc(entry: LeveldbDoc, blockDoc: BlockDocV1 | undefined, schema: Schema): DiffResult {
  const match = POST_DOC.exec(entry.doc)
  if (!match) return { doc: entry.doc, postId: null, status: "not-a-post" }
  const postId = Number(match[1])
  if (entry.update === null) return { doc: entry.doc, postId, status: "corrupt" }

  const ydoc = new Y.Doc()
  try {
    Y.applyUpdate(ydoc, entry.update)
    const fragment = ydoc.getXmlFragment(EDITOR_FRAGMENT)
    if (fragment.length === 0) return { doc: entry.doc, postId, status: "empty" }
    if (!blockDoc) return { doc: entry.doc, postId, status: "no-post" }

    // Compare what Hocuspocus will seed with what LevelDB holds, both as the store would
    // write them: block_doc → fragment (seedFragment, as load.ts does) → block_doc. A
    // block_doc the editor never saved (seed data: attrs without `pm`) then compares by
    // content, not by format. The blocks the editor couldn't show (#213) were never in
    // the fragment; the old client merged them back into every save, and so do both sides.
    const scratch = new Y.Doc()
    let seeded: BlockDocV1
    let dropped: ReturnType<typeof seedFragment>
    try {
      const seededFragment = scratch.getXmlFragment(EDITOR_FRAGMENT)
      dropped = seedFragment(blockDoc, seededFragment, schema)
      seeded = fragmentToBlockDoc(seededFragment, schema, { dropped, previous: blockDoc })
    } finally {
      scratch.destroy()
    }

    let unconvertible = 0
    const derived = fragmentToBlockDoc(fragment, schema, {
      dropped,
      previous: blockDoc,
      onUnconvertible: () => unconvertible++,
    })

    const result: DiffResult = {
      doc: entry.doc,
      postId,
      status: "match",
      leveldbBlocks: derived.blocks_order.length,
      postgresBlocks: seeded.blocks_order.length,
    }
    if (unconvertible > 0) result.unconvertible = unconvertible

    if (canonicalJSON(tree(derived, false)) === canonicalJSON(tree(seeded, false))) return result
    const a = tree(derived, true)
    const b = tree(seeded, true)
    if (canonicalJSON(a) === canonicalJSON(b)) return { ...result, status: "ids-differ" }
    return { ...result, status: "differs", firstDifference: firstDifference(a, b) }
  } finally {
    ydoc.destroy()
  }
}

interface TreeBlock {
  id: string
  type: string
  block: unknown
  children: TreeBlock[]
}

/**
 * The doc as the reader sees it: blocks reachable from blocks_order, in order, with
 * children nested. With `anonymous`, every block id (wherever it appears, e.g. inside
 * a theme block's `attrs.pm`) becomes its position in that walk, so two docs that differ
 * only in ids compare equal.
 */
function tree(doc: BlockDocV1, anonymous: boolean): TreeBlock[] {
  const ids = new Map<BlockID, string>()
  const seen = new Set<BlockID>()
  const collect = (order: BlockID[] | undefined) => {
    for (const id of order ?? []) {
      if (seen.has(id) || !doc.blocks[id]) continue
      seen.add(id)
      ids.set(id, `#${ids.size}`)
      collect(doc.blocks[id].children)
    }
  }
  collect(doc.blocks_order)

  const rename = (value: unknown): unknown => {
    if (typeof value === "string") return anonymous ? (ids.get(value) ?? value) : value
    if (Array.isArray(value)) return value.map(rename)
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rename(v)]))
    }
    return value
  }

  const visited = new Set<BlockID>()
  const build = (order: BlockID[] | undefined): TreeBlock[] =>
    (order ?? [])
      .filter((id) => doc.blocks[id] && !visited.has(id) && visited.add(id))
      .map((id) => {
        const { id: _id, children, ...rest } = doc.blocks[id] as Block & { children?: BlockID[] }
        return {
          id: String(rename(id)),
          type: doc.blocks[id].type,
          block: rename(rest),
          children: build(children),
        }
      })
  return build(doc.blocks_order)
}

/** "block 3 (paragraph): content differs" style pointer, top level first. */
function firstDifference(a: TreeBlock[], b: TreeBlock[], path = "block"): string {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    const where = `${path} ${i + 1}`
    if (!x) return `${where}: only in Postgres (${y.type})`
    if (!y) return `${where}: only in LevelDB (${x.type})`
    if (x.type !== y.type) return `${where}: LevelDB ${x.type}, Postgres ${y.type}`
    if (canonicalJSON(x.block) !== canonicalJSON(y.block)) return `${where} (${x.type}): content differs`
    if (canonicalJSON(x.children) !== canonicalJSON(y.children)) {
      return firstDifference(x.children, y.children, `${where} (${x.type}) > item`)
    }
  }
  return "order differs"
}
