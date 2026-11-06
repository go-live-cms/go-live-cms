import * as commentsApi from "./api/comments"
import type { PostComments } from "./api/comments"
import type { CommentBlock } from "./comments"

// One open post's block comments (#192), shared by the editor (the indicators on blocks,
// the hover "Comment" button, Ctrl M) and the comments panel. In memory only: nothing on
// the device (rule 0 in lib/collaboration/CLAUDE.md), and nothing in the Yjs doc.
//
// The comments come from the API. They're read when the post opens and again whenever
// something says they changed: the collab server's "comments" nudge (another editor
// wrote one), a reconnect, the tab being shown again, and this tab's own writes, whose
// answers carry the whole state. Reads and writes are numbered, and an answer older than
// the one shown is dropped, so a slow read never undoes a newer write.
//
// The editor reports which blocks its doc has (`setBlocks`); the panel works out the
// orphans from that.

export interface CommentsSnapshot {
  data: PostComments | null
  error: unknown
  loading: boolean
  /** The doc's blocks, in order (set by the editor; [] until it has bound). */
  blocks: CommentBlock[]
  /**
   * Whether `blocks` comes from a bound editor. Until then (connecting, the static
   * read-only view) nobody knows which threads are orphans, so none is called one.
   */
  blocksKnown: boolean
  /** Block ids the editor can't show but the post keeps (meta.dropped, #213). */
  hiddenIds: ReadonlySet<string>
  /** The block the user asked to comment on or to see, most recent first. */
  focus: { blockId: string; compose: boolean; seq: number } | null
  /** The block whose threads the panel shows highlighted (hover or focus). */
  activeBlockId: string | null
}

type Api = Pick<
  typeof commentsApi,
  "getPostComments" | "startCommentThread" | "replyToCommentThread" | "setCommentThreadResolved" | "editComment" | "deleteComment"
>

export class PostCommentsStore {
  readonly postId: number
  private snapshot: CommentsSnapshot = { data: null, error: null, loading: false, blocks: [], blocksKnown: false, hiddenIds: new Set(), focus: null, activeBlockId: null }
  private readonly listeners = new Set<() => void>()
  private seq = 0
  private shownSeq = 0
  private inFlight = false
  private again = false
  private focusSeq = 0
  private destroyed = false

  constructor(postId: number, private readonly api: Api = commentsApi) {
    this.postId = postId
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): CommentsSnapshot => this.snapshot

  private set(patch: Partial<CommentsSnapshot>) {
    if (this.destroyed) return
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  /** Reads the comments now; a read asked for while one runs runs once more after it. */
  async refresh(): Promise<void> {
    if (this.destroyed) return
    if (this.inFlight) {
      this.again = true
      return
    }
    this.inFlight = true
    const seq = ++this.seq
    if (!this.snapshot.data) this.set({ loading: true })
    try {
      const data = await this.api.getPostComments(this.postId)
      this.show(seq, data)
    } catch (error) {
      if (seq > this.shownSeq) this.set({ error, loading: false })
    } finally {
      this.inFlight = false
      if (this.again) {
        this.again = false
        void this.refresh()
      }
    }
  }

  private show(seq: number, data: PostComments) {
    if (seq <= this.shownSeq) return
    this.shownSeq = seq
    this.set({ data, error: null, loading: false })
  }

  /** Runs a write; its answer (the whole state) replaces what's shown. Throws its error. */
  private async write(run: () => Promise<PostComments>): Promise<PostComments> {
    const seq = ++this.seq
    const data = await run()
    this.show(seq, data)
    return data
  }

  startThread(blockId: string, body: string) {
    return this.write(() => this.api.startCommentThread(this.postId, blockId, body))
  }
  reply(threadId: number, body: string) {
    return this.write(() => this.api.replyToCommentThread(this.postId, threadId, body))
  }
  setResolved(threadId: number, resolved: boolean) {
    return this.write(() => this.api.setCommentThreadResolved(this.postId, threadId, resolved))
  }
  edit(commentId: number, body: string) {
    return this.write(() => this.api.editComment(this.postId, commentId, body))
  }
  remove(commentId: number) {
    return this.write(() => this.api.deleteComment(this.postId, commentId))
  }

  /** The editor's blocks now (after every doc change). */
  setBlocks(blocks: CommentBlock[]) {
    const current = this.snapshot.blocks
    if (!this.snapshot.blocksKnown) {
      this.set({ blocks, blocksKnown: true })
      return
    }
    if (current.length === blocks.length && current.every((b, i) => b.id === blocks[i].id && b.type === blocks[i].type && b.text === blocks[i].text)) return
    this.set({ blocks })
  }

  /** The bound editor went away (remount, static view): the blocks aren't known now. */
  forgetBlocks() {
    if (this.snapshot.blocksKnown) this.set({ blocks: [], blocksKnown: false })
  }

  /** Open threads (the top bar's count). */
  openCount = (): number => this.snapshot.data?.threads.filter((t) => t.resolved_at === null).length ?? 0

  setHiddenIds(ids: Iterable<string>) {
    const next = new Set(ids)
    const current = this.snapshot.hiddenIds
    if (next.size === current.size && [...next].every((id) => current.has(id))) return
    this.set({ hiddenIds: next })
  }

  /** Asks the panel to open on a block: its threads, or (compose) a new one. */
  focusBlock(blockId: string, compose: boolean) {
    this.set({ focus: { blockId, compose, seq: ++this.focusSeq }, activeBlockId: blockId })
  }

  setActiveBlock(blockId: string | null) {
    if (this.snapshot.activeBlockId !== blockId) this.set({ activeBlockId: blockId })
  }

  /**
   * Reads again when the tab is shown again (a nudge may have been missed while the
   * socket was asleep). Returns the cleanup.
   */
  watchVisibility(): () => void {
    if (typeof document === "undefined") return () => {}
    const onVisible = () => {
      if (document.visibilityState === "visible") void this.refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }

  destroy() {
    this.destroyed = true
    this.listeners.clear()
  }
}
