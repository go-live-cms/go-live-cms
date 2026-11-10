import * as htmlSnippetsApi from "./api/htmlSnippets"
import type { BlockDocV1 } from "./blocks-spec"

// One open post's custom HTML (#428), for the blocks' views. In memory only (rule 0 in
// lib/collaboration/CLAUDE.md), and nothing in the Yjs doc: the markup is the API's.
//
// Read once a block asks for it, so a post without custom HTML costs no request; again
// when a block names a snippet this tab hasn't seen (another admin just added it), after a
// restore, and when the tab is shown again. A read never undoes a save made while it was
// in flight.

type Api = Pick<typeof htmlSnippetsApi, "listHtmlSnippets" | "createHtmlSnippet" | "updateHtmlSnippet">

export class PostHtmlSnippetsStore {
  readonly postId: number
  private snippets = new Map<string, string>()
  private loadedOnce = false
  private failedLast = false
  private started = false
  private inFlight: Promise<void> | null = null
  private again = false
  private savedDuringRead = false
  private destroyed = false
  private readonly askedFor = new Set<string>()
  private readonly listeners = new Set<() => void>()
  /** Blocks with an edit not sent yet: publishing waits for them. */
  private readonly pending = new Set<() => Promise<void>>()
  /** The server's copy changed: the form re-reads "Changes not published". */
  onSaved: (() => void) | null = null

  constructor(postId: number, private readonly api: Api = htmlSnippetsApi) {
    this.postId = postId
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify() {
    if (this.destroyed) return
    for (const listener of [...this.listeners]) listener()
  }

  get loaded(): boolean {
    return this.loadedOnce
  }

  get failed(): boolean {
    return this.failedLast && !this.loadedOnce
  }

  /** The sanitized markup of a snippet of this post, or undefined if it has none by that id. */
  get(id: string | null | undefined): string | undefined {
    return id ? this.snippets.get(id) : undefined
  }

  /** Reads them unless something already asked. */
  ensureLoaded() {
    if (!this.started) void this.refresh()
  }

  /** A block names `id`: read again, once per id, if this post doesn't have it yet. */
  requestUnknown(id: string) {
    if (!this.loadedOnce || this.snippets.has(id) || this.askedFor.has(id)) return
    this.askedFor.add(id)
    void this.refresh()
  }

  /** Only if a block has asked: a post without custom HTML never reads them. */
  refreshIfStarted() {
    if (this.started) void this.refresh()
  }

  refresh(): Promise<void> {
    if (this.destroyed) return Promise.resolve()
    this.started = true
    if (this.inFlight) {
      this.again = true
      return this.inFlight
    }
    this.inFlight = this.read().finally(() => {
      this.inFlight = null
      if (this.again) {
        this.again = false
        void this.refresh()
      }
    })
    return this.inFlight
  }

  private async read() {
    this.savedDuringRead = false
    try {
      const rows = await this.api.listHtmlSnippets(this.postId)
      if (this.destroyed) return
      if (this.savedDuringRead) {
        this.again = true
        return
      }
      this.snippets = new Map(rows.map((row) => [row.id, row.html]))
      this.loadedOnce = true
      this.failedLast = false
    } catch {
      this.failedLast = true
    }
    this.notify()
  }

  /**
   * Saves one block's markup and returns its snippet id: an update when this post has
   * `id`, otherwise a new snippet (a first save, or an id from another post, which the
   * API wouldn't accept and the block must not keep).
   */
  async save(id: string | null, html: string): Promise<string> {
    const saved =
      id && this.snippets.has(id)
        ? await this.api.updateHtmlSnippet(this.postId, id, html)
        : await this.api.createHtmlSnippet(this.postId, html)
    if (this.destroyed) return saved.id
    this.savedDuringRead = true
    this.snippets.set(saved.id, saved.html)
    this.notify()
    this.onSaved?.()
    return saved.id
  }

  track(flush: () => Promise<void>) {
    this.pending.add(flush)
  }

  untrack(flush: () => Promise<void>) {
    this.pending.delete(flush)
  }

  /** Sends every edit still waiting for its debounce, and waits; rejects if one can't be saved. */
  async flush(): Promise<void> {
    await Promise.all([...this.pending].map((flush) => flush()))
  }

  destroy() {
    this.destroyed = true
    this.listeners.clear()
    this.pending.clear()
  }
}

/** A working copy with each html block's markup added, for comparing it with a version. */
export function withWorkingHtml(doc: BlockDocV1, snippets: readonly htmlSnippetsApi.HtmlSnippet[]): BlockDocV1 {
  const markup = new Map(snippets.map((snippet) => [snippet.id, snippet.html]))
  const blocks = { ...doc.blocks }
  for (const [id, block] of Object.entries(blocks)) {
    if (block.type !== "html") continue
    const attrs = block.attrs as { snippetId?: string; html?: string }
    const html = attrs.snippetId ? markup.get(attrs.snippetId) : undefined
    if (html) blocks[id] = { ...block, attrs: { ...attrs, html } } as typeof block
  }
  return { ...doc, blocks }
}

/** Whether a document has any custom HTML block. */
export function hasHtmlBlock(doc: BlockDocV1): boolean {
  return Object.values(doc.blocks).some((block) => block.type === "html")
}
