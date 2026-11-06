import * as blockEditsApi from "./api/blockEdits"
import type { BlockEditPerson, PostBlockEdits } from "./api/blockEdits"
import type { StoredBlockEdit } from "./collaboration/HocuspocusCollaboration"

// One open post's per-block "Last edited by" (#328), for the block menu. In memory only
// (rule 0 in lib/collaboration/CLAUDE.md), and nothing in the Yjs doc: the collab server
// writes attribution into the API's table with each store that writes block_doc.
//
// How it stays fresh: read from GET /posts/:id/block-edits when the editor binds and
// again after every reconnect (the `stored` messages sent while this tab was away are
// gone). In between, each `stored` message with `block_doc: "written"` carries the rows
// that store just wrote (`edits`), and they're merged in without a request, so the line
// follows collaborators live. Names come from the users the GET returned; an edit by a
// user this tab hasn't seen (a new collaborator) triggers one more read, which brings
// their name. A read answer never undoes an edit merged while it was in flight.

export interface BlockEditEntry {
  /** null: a member removed since (or not known yet). */
  userId: number | null
  editedAt: string
}

export interface BlockEditsSnapshot {
  edits: ReadonlyMap<string, BlockEditEntry>
  users: ReadonlyMap<number, BlockEditPerson>
  loaded: boolean
}

type Api = Pick<typeof blockEditsApi, "getPostBlockEdits">

const later = (a: string, b: string) => Date.parse(a) > Date.parse(b)

export class PostBlockEditsStore {
  readonly postId: number
  private snapshot: BlockEditsSnapshot = { edits: new Map(), users: new Map(), loaded: false }
  private readonly listeners = new Set<() => void>()
  private inFlight = false
  private again = false
  /** Edits merged while a read is in flight: they win over its answer when newer. */
  private mergedDuringRead: Map<string, BlockEditEntry> | null = null
  /** User ids a read was already asked for, so a removed member never loops. */
  private readonly askedFor = new Set<number>()
  private destroyed = false

  constructor(postId: number, private readonly api: Api = blockEditsApi) {
    this.postId = postId
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): BlockEditsSnapshot => this.snapshot

  private set(patch: Partial<BlockEditsSnapshot>) {
    if (this.destroyed) return
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  /** Reads them now; a read asked for while one runs runs once more after it. */
  async refresh(): Promise<void> {
    if (this.destroyed) return
    if (this.inFlight) {
      this.again = true
      return
    }
    this.inFlight = true
    this.mergedDuringRead = new Map()
    try {
      const data = await this.api.getPostBlockEdits(this.postId)
      this.show(data)
    } catch {
      // Not shown is the worst case: the menu has no line. The next reconnect reads again.
    } finally {
      this.inFlight = false
      this.mergedDuringRead = null
      if (this.again) {
        this.again = false
        void this.refresh()
      }
    }
  }

  private show(data: PostBlockEdits) {
    const edits = new Map<string, BlockEditEntry>()
    const users = new Map(this.snapshot.users)
    for (const [blockId, row] of Object.entries(data ?? {})) {
      edits.set(blockId, { userId: row.user?.id ?? null, editedAt: row.edited_at })
      if (row.user) users.set(row.user.id, row.user)
    }
    for (const [blockId, merged] of this.mergedDuringRead ?? []) {
      const read = edits.get(blockId)
      if (!read || later(merged.editedAt, read.editedAt)) edits.set(blockId, merged)
    }
    this.set({ edits, users, loaded: true })
  }

  /** The rows a `stored` message says the server just wrote. */
  applyStored(rows: readonly StoredBlockEdit[] | undefined) {
    if (!rows || rows.length === 0 || this.destroyed) return
    const edits = new Map(this.snapshot.edits)
    let unknown = false
    for (const row of rows) {
      if (typeof row?.block_id !== "string" || typeof row.edited_at !== "string") continue
      const entry: BlockEditEntry = { userId: typeof row.user_id === "number" ? row.user_id : null, editedAt: row.edited_at }
      const current = edits.get(row.block_id)
      if (current && later(current.editedAt, entry.editedAt)) continue
      edits.set(row.block_id, entry)
      this.mergedDuringRead?.set(row.block_id, entry)
      if (entry.userId !== null && !this.snapshot.users.has(entry.userId) && !this.askedFor.has(entry.userId)) {
        this.askedFor.add(entry.userId)
        unknown = true
      }
    }
    this.set({ edits })
    if (unknown) void this.refresh()
  }

  destroy() {
    this.destroyed = true
    this.listeners.clear()
  }
}
