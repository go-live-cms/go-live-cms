// The block change tracker (#328; design: docs/design/block-map-yjs-schema.md, "Block
// change tracker" and "#328: per-block 'Last edited by'").
//
// Per loaded doc, it records which block element each authenticated user changed since
// the last store that wrote block_doc. Hocuspocus applies a client's update with that
// client's Connection as the Yjs transaction origin (its MessageReceiver: `readUpdate(
// decoder, document, connection)`, and `readSyncStep2` on a reconnect), and drops a
// read-only connection's update before applying it; the server's own writes (seed,
// legacy cleanup, id stamping) use SERVER_ORIGIN, a string with no context. So
// `tr.origin.context.userId` is the user who made the change, as authenticated by the
// ticket. The Yjs clientID is never used: it's per doc and chosen by the client.
//
// It only reads the doc and writes nothing into it: the worst a bug here can do is
// attribute a block to the wrong person, never lose content.
//
// At store time (after stampFragmentBlockIds, so every block has its id) `capture()`
// resolves elements to ids, and `blockEditsFor` attributes the blocks whose JSON
// changed against the previous block_doc. The entries captured are cleared only after a
// store that wrote block_doc succeeded (`clear`): a failed store keeps them for the
// retry, a state-only store (unchanged, kept-invalid, kept-empty) neither sends nor
// clears any, and edits made while a PUT is in flight stay for the next store.
//
// Must stay free of logging the doc's content.
import * as Y from "yjs"
import { isBlockNode, type BlockDocV1 } from "../gl-admin/lib/blocks-spec"
import type { CollabBlockEdit } from "./api"
import { canonicalJSON } from "./store"

/** Who touched a block element, and when (ms since the epoch). */
export interface BlockTouch {
  userId: string
  at: number
}

/** What a store was prepared with: the entries then, and the doc's blocks by id. */
export interface BlockEditCapture {
  /** The tracker's entries when the store was prepared (cleared after it succeeds). */
  entries: ReadonlyMap<Y.XmlElement, BlockTouch>
  /** The touched blocks, by the id they have in the live doc. */
  byId: ReadonlyMap<string, BlockTouch>
  /** Every block id in the fragment (blocks copied from `previous` or `meta.dropped` aren't). */
  fragmentIds: ReadonlySet<string>
}

/** The user id a transaction came from: a Connection's authenticated context, else none. */
function userIdOf(origin: unknown): string | null {
  if (!origin || typeof origin !== "object") return null
  const context = (origin as { context?: unknown }).context
  if (!context || typeof context !== "object") return null
  const userId = (context as { userId?: unknown }).userId
  return typeof userId === "string" && userId !== "" ? userId : null
}

/** The element's parent's node name for the block predicate (null at the top). */
function parentNameOf(element: Y.XmlElement): string | null {
  const parent = element.parent
  return parent instanceof Y.XmlElement ? parent.nodeName : null
}

/** Whether `element` is a block (`isBlockNode`, the shared predicate, #414). */
function isBlockElement(element: Y.XmlElement): boolean {
  return isBlockNode(element.nodeName, parentNameOf(element))
}

/** The nearest block at or above `type`, inside `fragment` (null for the fragment itself). */
function nearestBlock(type: Y.AbstractType<unknown> | null, fragment: Y.XmlFragment): Y.XmlElement | null {
  let current: Y.AbstractType<unknown> | null = type
  while (current && current !== fragment) {
    if (current instanceof Y.XmlElement && isBlockElement(current)) return current
    current = current.parent as Y.AbstractType<unknown> | null
  }
  return null
}

export class BlockChangeTracker {
  private readonly touched = new Map<Y.XmlElement, BlockTouch>()
  private readonly observer: (events: Y.YEvent<any>[], tr: Y.Transaction) => void

  constructor(
    private readonly fragment: Y.XmlFragment,
    private readonly now: () => number = Date.now,
  ) {
    this.observer = (events, tr) => this.observe(events, tr)
    fragment.observeDeep(this.observer)
  }

  /** How many block elements are waiting to be attributed. */
  get size(): number {
    return this.touched.size
  }

  private observe(events: Y.YEvent<any>[], tr: Y.Transaction) {
    const userId = userIdOf(tr.origin)
    if (!userId) return
    const touch: BlockTouch = { userId, at: this.now() }
    for (const event of events) {
      // An existing type changed (text, attributes, children; `tr.changed`): the nearest
      // block at or above it. Typing in a list item's paragraph is the item, in a
      // caption the image, a child added to a group or a list the container too.
      const block = nearestBlock(event.target as Y.AbstractType<unknown>, this.fragment)
      if (block) this.touched.set(block, touch)
      // New elements aren't in `tr.changed` (Yjs leaves types created in the
      // transaction out); they're in their parent's `changes.added`. A new block, and
      // every block inside it (a pasted or duplicated group).
      for (const item of event.changes.added) {
        for (const content of item.content.getContent()) {
          if (content instanceof Y.XmlElement) this.touchNew(content, touch)
        }
      }
    }
  }

  private touchNew(element: Y.XmlElement, touch: BlockTouch) {
    if (isBlockElement(element)) this.touched.set(element, touch)
    for (const child of element.toArray()) {
      if (child instanceof Y.XmlElement) this.touchNew(child, touch)
    }
  }

  /**
   * The entries now, resolved to the ids the blocks have in the live doc. Call it when
   * the store is prepared, after stampFragmentBlockIds.
   */
  capture(): BlockEditCapture {
    const entries = new Map(this.touched)
    const byId = new Map<string, BlockTouch>()
    const fragmentIds = new Set<string>()
    const walk = (parent: Y.XmlFragment | Y.XmlElement) => {
      for (const child of parent.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue
        if (isBlockElement(child)) {
          const id = child.getAttribute("data-block-id")
          if (typeof id === "string" && id !== "") {
            fragmentIds.add(id)
            const touch = entries.get(child)
            if (touch) byId.set(id, touch)
          }
        }
        walk(child)
      }
    }
    walk(this.fragment)
    return { entries, byId, fragmentIds }
  }

  /**
   * After a store that wrote block_doc succeeded: forget what it was prepared with. An
   * element touched again since (a new entry) stays for the next store.
   */
  clear(capture: BlockEditCapture) {
    for (const [element, touch] of capture.entries) {
      if (this.touched.get(element) === touch) this.touched.delete(element)
    }
  }

  destroy() {
    this.fragment.unobserveDeep(this.observer)
    this.touched.clear()
  }
}

/**
 * The attribution a store that writes `blockDoc` sends: every block that came from the
 * fragment (not one `restoreDroppedBlocks` or the unconvertible fallback copied in) and
 * whose JSON is new or differs from `previous`, attributed to its tracker entry, else to
 * `fallback` (the last editor, when a client edited the doc), so a gap in the tracker
 * never drops attribution. A move, or an edit undone before the store, changes no
 * block's JSON and attributes nothing.
 */
export function blockEditsFor(
  blockDoc: BlockDocV1,
  previous: BlockDocV1 | null,
  capture: BlockEditCapture,
  fallback: BlockTouch | null,
): CollabBlockEdit[] {
  const edits: CollabBlockEdit[] = []
  for (const [id, block] of Object.entries(blockDoc.blocks)) {
    if (!capture.fragmentIds.has(id)) continue
    const before = previous?.blocks?.[id]
    if (before !== undefined && canonicalJSON(before) === canonicalJSON(block)) continue
    const touch = capture.byId.get(id) ?? fallback
    if (!touch) continue
    const userId = Number(touch.userId)
    if (!Number.isSafeInteger(userId) || userId <= 0) continue
    edits.push({ block_id: id, user_id: userId, edited_at: new Date(touch.at).toISOString() })
  }
  return edits
}
