import { describe, expect, it, vi } from "vitest"
import type { PostComments } from "./api/comments"
import { PostCommentsStore } from "./commentsStore"

// The per-post comments store (#192): reads are coalesced, an older answer never
// replaces a newer one, writes show their answer, and focus requests are numbered.

const state = (n: number): PostComments => ({
  post_id: 7,
  can_comment: true,
  threads: Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    post_id: 7,
    block_id: `blk-block-${i}-000`,
    created_by: null,
    created_at: "2026-11-06T10:00:00Z",
    resolved_at: null,
    resolved_by: null,
    can_resolve: true,
    comments: [],
  })),
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeApi() {
  return {
    getPostComments: vi.fn(async () => state(0)),
    startCommentThread: vi.fn(async () => state(1)),
    replyToCommentThread: vi.fn(async () => state(1)),
    setCommentThreadResolved: vi.fn(async () => state(1)),
    editComment: vi.fn(async () => state(1)),
    deleteComment: vi.fn(async () => state(0)),
  }
}

describe("PostCommentsStore", () => {
  it("loads, and runs a read asked for during one once more afterwards", async () => {
    const api = fakeApi()
    const first = deferred<PostComments>()
    api.getPostComments.mockReturnValueOnce(first.promise).mockResolvedValueOnce(state(2))
    const store = new PostCommentsStore(7, api)
    const done = store.refresh()
    expect(store.getSnapshot().loading).toBe(true)
    void store.refresh()
    void store.refresh()
    first.resolve(state(1))
    await done
    await vi.waitFor(() => expect(store.getSnapshot().data?.threads).toHaveLength(2))
    expect(api.getPostComments).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().loading).toBe(false)
  })

  it("never lets a read that started before a write undo it", async () => {
    const api = fakeApi()
    const slow = deferred<PostComments>()
    api.getPostComments.mockReturnValueOnce(slow.promise)
    const store = new PostCommentsStore(7, api)
    const read = store.refresh()
    await store.startThread("blk-block-0-000", "Hello")
    expect(store.getSnapshot().data?.threads).toHaveLength(1)
    slow.resolve(state(0))
    await read
    expect(store.getSnapshot().data?.threads).toHaveLength(1)
  })

  it("keeps what it shows when a refetch fails, and reports a failed first load", async () => {
    const api = fakeApi()
    api.getPostComments.mockRejectedValueOnce(new Error("down"))
    const store = new PostCommentsStore(7, api)
    await store.refresh()
    expect(store.getSnapshot().error).toBeInstanceOf(Error)
    expect(store.getSnapshot().data).toBeNull()
    api.getPostComments.mockResolvedValueOnce(state(1))
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ error: null, loading: false })
    expect(store.getSnapshot().data?.threads).toHaveLength(1)
  })

  it("passes write errors to the caller and changes nothing", async () => {
    const api = fakeApi()
    api.replyToCommentThread.mockRejectedValueOnce(new Error("refused"))
    const store = new PostCommentsStore(7, api)
    await store.refresh()
    await expect(store.reply(1, "x")).rejects.toThrow("refused")
    expect(store.getSnapshot().data?.threads).toEqual([])
  })

  it("notifies on blocks only when they changed, and numbers focus requests", () => {
    const store = new PostCommentsStore(7, fakeApi())
    const listener = vi.fn()
    store.subscribe(listener)
    store.setBlocks([{ id: "blk-a-0000000", type: "paragraph", text: "a" }])
    store.setBlocks([{ id: "blk-a-0000000", type: "paragraph", text: "a" }])
    store.setHiddenIds(["blk-h-0000000"])
    store.setHiddenIds(["blk-h-0000000"])
    expect(listener).toHaveBeenCalledTimes(2)
    store.focusBlock("blk-a-0000000", true)
    const first = store.getSnapshot().focus!
    store.focusBlock("blk-a-0000000", true)
    expect(store.getSnapshot().focus!.seq).toBe(first.seq + 1)
    expect(store.getSnapshot().activeBlockId).toBe("blk-a-0000000")
  })

  it("refetches when the tab is shown again, until destroyed", async () => {
    const api = fakeApi()
    const store = new PostCommentsStore(7, api)
    const stop = store.watchVisibility()
    document.dispatchEvent(new Event("visibilitychange"))
    await vi.waitFor(() => expect(api.getPostComments).toHaveBeenCalledTimes(1))
    stop()
    store.destroy()
    document.dispatchEvent(new Event("visibilitychange"))
    await store.refresh()
    expect(api.getPostComments).toHaveBeenCalledTimes(1)
  })
})
