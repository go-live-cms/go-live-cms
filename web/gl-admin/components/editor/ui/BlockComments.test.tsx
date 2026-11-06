import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import type { CommentThread, PostComments } from "@gl-admin/lib/api/comments"
import { PostCommentsStore } from "@gl-admin/lib/commentsStore"
import BlockComments from "./BlockComments"

// The editor's side of block comments (#192): a marker with the open count on each
// block with open threads (click: the panel opens on them), a hover "Comment" button for
// those who may comment, and the doc's block ids reported to the store after every
// change, without changing the doc.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const A = "blk-aaaa-000001"
const B = "blk-bbbb-000001"
const content = {
  type: "doc",
  content: [
    { type: "paragraph", attrs: { "data-block-id": A }, content: [{ type: "text", text: "alpha" }] },
    { type: "paragraph", attrs: { "data-block-id": B }, content: [{ type: "text", text: "beta" }] },
  ],
}

const thread = (id: number, blockId: string, resolved = false): CommentThread => ({
  id,
  post_id: 7,
  block_id: blockId,
  created_by: null,
  created_at: "2026-11-06T10:00:00Z",
  resolved_at: resolved ? "2026-11-06T11:00:00Z" : null,
  resolved_by: null,
  can_resolve: true,
  comments: [],
})

let state: PostComments
const api = {
  getPostComments: vi.fn(async () => structuredClone(state)),
  startCommentThread: vi.fn(),
  replyToCommentThread: vi.fn(),
  setCommentThreadResolved: vi.fn(),
  editComment: vi.fn(),
  deleteComment: vi.fn(),
}

let editor: Editor
let container: HTMLDivElement
let root: Root
let store: PostCommentsStore

beforeEach(async () => {
  state = { post_id: 7, can_comment: true, threads: [thread(1, A), thread(2, A), thread(3, B, true)] }
  editor = new Editor({ element: document.createElement("div"), extensions: Object.values(schemaExtensions({ collaborating: false })), content })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  store = new PostCommentsStore(7, api)
  await store.refresh()
  await act(async () =>
    root.render(
      <BlockComments editor={editor} store={store}>
        <div
          className="content"
          ref={(el) => {
            if (el && !el.contains(editor.view.dom)) el.appendChild(editor.view.dom)
          }}
        />
      </BlockComments>
    )
  )
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  editor.destroy()
  vi.restoreAllMocks()
})

const markers = () => [...container.querySelectorAll<HTMLButtonElement>(".editor-comment-marker")]
const hover = async (id: string) => {
  const el = editor.view.dom.querySelector(`[data-block-id="${id}"]`)!
  await act(async () => el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })))
}

describe("BlockComments (#192)", () => {
  it("marks blocks with open threads, with the count", () => {
    expect(markers().map((m) => m.getAttribute("aria-label"))).toEqual(["2 comments open on this block"])
  })

  it("opens the panel on a marker's block", async () => {
    await act(async () => markers()[0].click())
    expect(store.getSnapshot().focus).toMatchObject({ blockId: A, compose: false })
  })

  it("offers Comment on a hovered block without a marker", async () => {
    await hover(B)
    const add = container.querySelector<HTMLButtonElement>(".editor-comment-add")!
    expect(add.getAttribute("aria-label")).toBe("Comment on this block")
    await act(async () => add.click())
    expect(store.getSnapshot().focus).toMatchObject({ blockId: B, compose: true })
  })

  it("offers nothing to hover for a reader who may not comment", async () => {
    state.can_comment = false
    await act(async () => store.refresh())
    await hover(B)
    expect(container.querySelector(".editor-comment-add")).toBeNull()
    // The markers stay: they can still read the threads.
    expect(markers()).toHaveLength(1)
  })

  it("reports the doc's blocks, and follows changes without touching the doc", async () => {
    expect(store.getSnapshot().blocks.map((b) => b.id)).toEqual([A, B])
    const before = JSON.stringify(editor.state.doc.toJSON())
    await act(async () => store.refresh())
    expect(JSON.stringify(editor.state.doc.toJSON())).toBe(before)

    // B deleted (by anyone): its id is gone, so its threads become orphans.
    await act(async () => {
      const end = editor.state.doc.content.size
      editor.view.dispatch(editor.state.tr.delete(editor.state.doc.child(0).nodeSize, end))
    })
    await vi.waitFor(() => expect(store.getSnapshot().blocks.map((b) => b.id)).toEqual([A]))
  })

  it("forgets the blocks when it unmounts, so nothing is taken for an orphan meanwhile", async () => {
    expect(store.getSnapshot().blocksKnown).toBe(true)
    act(() => root.render(<div />))
    expect(store.getSnapshot()).toMatchObject({ blocks: [], blocksKnown: false })
  })
})
