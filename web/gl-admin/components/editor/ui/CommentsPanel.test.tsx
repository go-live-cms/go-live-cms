import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BlockComment, CommentThread, PostComments } from "@gl-admin/lib/api/comments"
import { PostCommentsStore } from "@gl-admin/lib/commentsStore"
import CommentsPanel from "./CommentsPanel"

// The comments panel (#192): threads grouped by block in document order, Open and
// Resolved, "On hidden blocks" and "On deleted blocks", a new thread from a block the
// editor asked for, replies, resolve and reopen, edit and delete for whom the API allows.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ana = { id: 1, username: "ana", full_name: "Ana Costa", avatar: null }
const kenji = { id: 2, username: "kenji", full_name: "Kenji T.", avatar: null }

const comment = (id: number, threadId: number, over: Partial<BlockComment> = {}): BlockComment => ({
  id,
  thread_id: threadId,
  author: ana,
  body: `Comment ${id}`,
  created_at: new Date().toISOString(),
  edited_at: null,
  deleted: false,
  can_edit: true,
  can_delete: true,
  ...over,
})

const thread = (id: number, blockId: string, over: Partial<CommentThread> = {}): CommentThread => ({
  id,
  post_id: 7,
  block_id: blockId,
  created_by: ana,
  created_at: new Date().toISOString(),
  resolved_at: null,
  resolved_by: null,
  can_resolve: true,
  comments: [comment(id * 10, id)],
  ...over,
})

const BLOCKS = [
  { id: "blk-first-00001", type: "paragraph", text: "First paragraph" },
  { id: "blk-second-0001", type: "heading", text: "Second heading" },
]

let state: PostComments
const api = {
  getPostComments: vi.fn(async () => structuredClone(state)),
  startCommentThread: vi.fn(async (_p: number, blockId: string, body: string) => {
    state.threads.push(thread(99, blockId, { comments: [comment(990, 99, { body })] }))
    return structuredClone(state)
  }),
  replyToCommentThread: vi.fn(async (_p: number, threadId: number, body: string) => {
    state.threads.find((t) => t.id === threadId)!.comments.push(comment(555, threadId, { body, author: kenji }))
    return structuredClone(state)
  }),
  setCommentThreadResolved: vi.fn(async (_p: number, threadId: number, resolved: boolean) => {
    const t = state.threads.find((x) => x.id === threadId)!
    t.resolved_at = resolved ? new Date().toISOString() : null
    t.resolved_by = resolved ? kenji : null
    return structuredClone(state)
  }),
  editComment: vi.fn(async (_p: number, commentId: number, body: string) => {
    for (const t of state.threads) for (const c of t.comments) if (c.id === commentId) Object.assign(c, { body, edited_at: new Date().toISOString() })
    return structuredClone(state)
  }),
  deleteComment: vi.fn(async (_p: number, commentId: number) => {
    for (const t of state.threads) for (const c of t.comments) if (c.id === commentId) Object.assign(c, { body: "", deleted: true, can_edit: false, can_delete: false })
    return structuredClone(state)
  }),
}

let container: HTMLDivElement
let root: Root
let store: PostCommentsStore

beforeEach(async () => {
  state = {
    post_id: 7,
    can_comment: true,
    threads: [
      thread(2, "blk-second-0001"),
      thread(1, "blk-first-00001", { comments: [comment(10, 1), comment(11, 1, { author: kenji, can_edit: false, can_delete: false })] }),
      thread(3, "blk-gone-000001"),
      thread(4, "blk-hidden-0001"),
      thread(5, "blk-first-00001", { resolved_at: new Date().toISOString(), resolved_by: kenji }),
    ],
  }
  Object.values(api).forEach((f) => f.mockClear())
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  store = new PostCommentsStore(7, api)
  store.setBlocks(BLOCKS)
  store.setHiddenIds(["blk-hidden-0001"])
  await store.refresh()
  await act(async () => root.render(<CommentsPanel store={store} isVisible onClose={vi.fn()} sidebarWidth="320px" />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const text = () => container.textContent ?? ""
const button = (label: string, within: ParentNode = container) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label)
const groups = () => [...container.querySelectorAll<HTMLElement>(".post-comments__group")]
const typeInto = async (textarea: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
  await act(async () => {
    setter.call(textarea, value)
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const submit = async (form: HTMLFormElement) => {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  })
}

describe("CommentsPanel (#192)", () => {
  it("groups open threads by block in document order, then hidden and deleted blocks", () => {
    const labels = groups().map((g) => g.querySelector(".post-comments__block, .post-comments__section-title")?.textContent)
    expect(labels).toEqual(["First paragraph", "Second heading", "On hidden blocks", "On deleted blocks"])
    expect(text()).toContain("If a restore brings a block back")
    // The resolved thread isn't under Open.
    expect(groups()[0].querySelectorAll(".post-comments__thread")).toHaveLength(1)
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("Open")
  })

  it("shows resolved threads under Resolved, with who resolved them, and reopens them", async () => {
    const resolvedTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.startsWith("Resolved"))!
    await act(async () => resolvedTab.click())
    expect(groups()).toHaveLength(1)
    expect(text()).toContain("Resolved by Kenji T.")
    await act(async () => button("Reopen")!.click())
    expect(api.setCommentThreadResolved).toHaveBeenCalledWith(7, 5, false)
    expect(text()).toContain("No resolved comments")
  })

  it("resolves a thread", async () => {
    const first = groups()[0]
    await act(async () => button("Resolve", first)!.click())
    expect(api.setCommentThreadResolved).toHaveBeenCalledWith(7, 1, true)
    expect(groups()[0].querySelector(".post-comments__block")?.textContent).toBe("Second heading")
  })

  it("starts a thread on the block the editor asked for", async () => {
    await act(async () => store.focusBlock("blk-second-0001", true))
    await act(async () => vi.waitFor(() => expect(container.querySelector("textarea")).not.toBeNull()))
    const form = container.querySelector<HTMLFormElement>(".post-comments__composer")!
    expect(form.closest(".post-comments__group")!.textContent).toContain("Second heading")
    await submit(form)
    expect(text()).toContain("Write a comment first")
    expect(api.startCommentThread).not.toHaveBeenCalled()
    await typeInto(form.querySelector("textarea")!, "  Needs a source  ")
    await submit(form)
    expect(api.startCommentThread).toHaveBeenCalledWith(7, "blk-second-0001", "Needs a source")
    expect(text()).toContain("Needs a source")
    expect(container.querySelector(".post-comments__composer")).toBeNull()
  })

  it("replies", async () => {
    await act(async () => button("Reply", groups()[0])!.click())
    const form = groups()[0].querySelector<HTMLFormElement>(".post-comments__composer")!
    await typeInto(form.querySelector("textarea")!, "Done, thanks")
    await submit(form)
    expect(api.replyToCommentThread).toHaveBeenCalledWith(7, 1, "Done, thanks")
    expect(groups()[0].textContent).toContain("Done, thanks")
  })

  it("offers Edit and Delete only where the API allows, and shows a deleted comment's place", async () => {
    const first = groups()[0]
    expect(first.querySelectorAll('button[aria-label^="Actions for"]')).toHaveLength(1)
    await act(async () => first.querySelector<HTMLButtonElement>('button[aria-label="Actions for Ana Costa\'s comment"]')!.click())
    const edit = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Edit")!
    await act(async () => edit.click())
    const form = groups()[0].querySelector<HTMLFormElement>(".post-comments__composer")!
    expect(form.querySelector("textarea")!.value).toBe("Comment 10")
    await typeInto(form.querySelector("textarea")!, "Comment 10, fixed")
    await submit(form)
    expect(api.editComment).toHaveBeenCalledWith(7, 10, "Comment 10, fixed")
    expect(groups()[0].textContent).toContain("(edited)")

    await act(async () => groups()[0].querySelector<HTMLButtonElement>('button[aria-label="Actions for Ana Costa\'s comment"]')!.click())
    const del = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Delete")!
    await act(async () => del.click())
    expect(api.deleteComment).toHaveBeenCalledWith(7, 10)
    expect(groups()[0].textContent).toContain("Comment deleted")
  })

  it("a reader who may not comment gets no Reply", async () => {
    state.can_comment = false
    state.threads.forEach((t) => (t.can_resolve = false))
    await act(async () => store.refresh())
    expect(button("Reply")).toBeUndefined()
    expect(button("Resolve")).toBeUndefined()
  })

  it("updates when the store refetches (a collaborator's comment)", async () => {
    state.threads.push(thread(6, "blk-second-0001", { comments: [comment(60, 6, { body: "From Kenji", author: kenji })] }))
    await act(async () => store.refresh())
    expect(groups()[1].textContent).toContain("From Kenji")
  })

  it("before the editor has bound, lists threads without calling them orphans", async () => {
    store.forgetBlocks()
    await act(async () => store.refresh())
    expect(text()).not.toContain("On deleted blocks")
    expect(text()).toContain("They show on their blocks once the post has loaded.")
    expect(container.querySelectorAll(".post-comments__thread")).toHaveLength(4)
  })

  it("keeps a new comment being written when another block's threads are shown", async () => {
    await act(async () => store.focusBlock("blk-second-0001", true))
    await act(async () => vi.waitFor(() => expect(container.querySelector("textarea")).not.toBeNull()))
    await act(async () => store.focusBlock("blk-first-00001", false))
    expect(container.querySelector(".post-comments__composer")).not.toBeNull()
  })

  it("says when there's nothing open", async () => {
    state.threads = []
    await act(async () => store.refresh())
    expect(text()).toContain("No open comments")
    expect(text()).toContain("Ctrl M")
  })
})
