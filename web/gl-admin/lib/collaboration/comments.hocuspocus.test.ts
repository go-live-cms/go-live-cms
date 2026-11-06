import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { TextSelection } from "prosemirror-state"
import type { BlockDocV1 } from "../blocks-spec"
import type { CommentThread, PostComments } from "../api/comments"
import { docBlocks, groupThreads } from "../comments"
import { PostCommentsStore } from "../commentsStore"
import { PasteSanitizer } from "@gl-admin/components/editor/extensions/PasteSanitizer"
import { CollabSaveStatus } from "./CollabSaveStatus"
import type { HocuspocusCollaboration } from "./HocuspocusCollaboration"
import { restoreVersionLive } from "./liveRestore"
import { schemaExtensions } from "./schema"
import { canonical } from "./fragmentBridge.fixtures"
import { startRelay, waitFor, POST_ID, type Relay } from "./hocuspocusRelay.testkit"

// Block comments (#192) on the real collab server (hocuspocusRelay.testkit.ts):
//   - the "comments" nudge the API asks for reaches every open editor of the post, the
//     read-only ones included, and their stores refetch; nothing in the doc changes;
//   - threads stay anchored by block id through what the design's identity contract
//     lists (docs/design/block-map-yjs-schema.md): a move and a split keep the thread,
//     Enter at the very start leaves it on the new empty block above, a join, a cut and
//     paste and a turn-into across blocks orphan it, a restore orphans it and a later
//     restore reattaches it, and a reseed keeps it. The editor never stores a thread:
//     the anchoring is just which block ids the doc has.

const DOC_NAME = `post-${POST_ID}`
const ids = { alpha: "blk-alpha-000001", beta: "blk-beta-0000001", gamma: "blk-gamma-000001" }

const seedDoc = (): BlockDocV1 =>
  canonical({
    doc_version: 1,
    blocks_order: [ids.alpha, ids.beta, ids.gamma],
    blocks: {
      [ids.alpha]: { id: ids.alpha, type: "paragraph", version: 1, attrs: { text: "alpha one" } },
      [ids.beta]: { id: ids.beta, type: "paragraph", version: 1, attrs: { text: "beta two" } },
      [ids.gamma]: { id: ids.gamma, type: "paragraph", version: 1, attrs: { text: "gamma three" } },
    },
  } as BlockDocV1)

let relay: Relay
const editors: Editor[] = []

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  relay = await startRelay({ blockDoc: seedDoc(), revision: 3 })
})

afterEach(async () => {
  while (editors.length) editors.pop()!.destroy()
  await relay.destroy()
  vi.restoreAllMocks()
})

function bind(collab: HocuspocusCollaboration): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...Object.values(schemaExtensions({ collaborating: true })), PasteSanitizer, Collaboration.configure({ document: collab.doc })],
  })
  editors.push(editor)
  return editor
}

async function peer(userId: string) {
  const collab = relay.client(userId)
  await collab.whenSynced()
  return { collab, editor: bind(collab) }
}

let nextId = 1
const thread = (blockId: string, over: Partial<CommentThread> = {}): CommentThread => ({
  id: nextId++,
  post_id: POST_ID,
  block_id: blockId,
  created_by: null,
  created_at: new Date().toISOString(),
  resolved_at: null,
  resolved_by: null,
  can_resolve: true,
  comments: [],
  ...over,
})

/** Where each thread is, as the panel would group it from this editor's doc. */
function placement(editor: Editor, threads: CommentThread[]) {
  const groups = groupThreads(threads, docBlocks(editor.state.doc))
  return {
    anchored: groups.anchored.map((g) => ({ text: g.block.text, threads: g.threads.map((t) => t.block_id) })),
    orphaned: groups.orphaned.map((t) => t.block_id),
  }
}

const textOfBlock = (editor: Editor, id: string) => docBlocks(editor.state.doc).find((b) => b.id === id)?.text

/** Position just inside the start of the top-level block with this id. */
function startOf(editor: Editor, id: string): number {
  let pos = -1
  editor.state.doc.forEach((node, offset) => {
    if (node.attrs["data-block-id"] === id) pos = offset + 1
  })
  if (pos < 0) throw new Error(`no block ${id}`)
  return pos
}

const json = (editor: Editor) => JSON.stringify(editor.state.doc.toJSON())
const converged = (a: Editor, b: Editor, what: string) => waitFor(() => json(a) === json(b), { what })

/** The API's side of comments, in memory: every write nudges the collab server. */
class FakeCommentsApi {
  threads: CommentThread[] = []
  reads = 0
  state(): PostComments {
    return { post_id: POST_ID, can_comment: true, threads: structuredClone(this.threads) }
  }
  getPostComments = async () => {
    this.reads++
    return this.state()
  }
  startCommentThread = async (_postId: number, blockId: string, body: string) => {
    const t = thread(blockId, {
      comments: [{ id: nextId++, thread_id: 0, author: null, body, created_at: new Date().toISOString(), edited_at: null, deleted: false, can_edit: true, can_delete: true }],
    })
    this.threads.push(t)
    // What the API's afterCommentWrite does, after the response.
    queueMicrotask(() => relay.server.notifyComments(DOC_NAME))
    return { ...this.state(), thread_id: t.id }
  }
  replyToCommentThread = async () => this.state()
  setCommentThreadResolved = async (_postId: number, threadId: number, resolved: boolean) => {
    const t = this.threads.find((x) => x.id === threadId)!
    t.resolved_at = resolved ? new Date().toISOString() : null
    queueMicrotask(() => relay.server.notifyComments(DOC_NAME))
    return this.state()
  }
  editComment = async () => this.state()
  deleteComment = async () => this.state()
}

/** A store wired to a connection the way Editor.tsx wires it. */
function storeFor(collab: HocuspocusCollaboration, api: FakeCommentsApi) {
  const store = new PostCommentsStore(POST_ID, api)
  collab.onComments(() => void store.refresh())
  return store
}

describe("the comments nudge (#192)", () => {
  it("reaches the other editors, read-only ones included, and their stores refetch", async () => {
    const api = new FakeCommentsApi()
    const writer = await peer("2") // editor: read-write
    const viewer = await peer("3") // contributor on someone else's post: read-only
    expect(viewer.collab.readOnly).toBe(true)
    const writerStore = storeFor(writer.collab, api)
    const viewerStore = storeFor(viewer.collab, api)
    await Promise.all([writerStore.refresh(), viewerStore.refresh()])
    expect(viewerStore.getSnapshot().data?.threads).toEqual([])

    const nudges = { writer: 0, viewer: 0 }
    writer.collab.onComments(() => nudges.writer++)
    viewer.collab.onComments(() => nudges.viewer++)
    let docUpdates = 0
    const countUpdate = () => docUpdates++
    writer.collab.doc.on("update", countUpdate)
    viewer.collab.doc.on("update", countUpdate)

    await writerStore.startThread(ids.beta, "Can we cite a source here?")
    await waitFor(() => viewerStore.getSnapshot().data?.threads.length === 1, { what: "the viewer's store to refetch" })

    expect(nudges).toEqual({ writer: 1, viewer: 1 })
    expect(viewerStore.getSnapshot().data!.threads[0].block_id).toBe(ids.beta)
    // A stateless message: no Yjs update anywhere, nothing for the server to store.
    expect(docUpdates).toBe(0)

    // Resolving nudges too, and the other side follows.
    await viewerStore.setResolved(viewerStore.getSnapshot().data!.threads[0].id, true)
    await waitFor(() => writerStore.getSnapshot().data?.threads[0].resolved_at !== null, { what: "the writer's store to see it resolved" })
  })

  it("tells nobody about a post that isn't open (it never loads it)", async () => {
    expect(relay.server.notifyComments("post-999")).toBe(0)
    expect(relay.server.hocuspocus.documents.has("post-999")).toBe(false)
  })

  it("counts every connection to the post", async () => {
    await peer("1")
    await peer("3")
    expect(relay.server.notifyComments(DOC_NAME)).toBe(2)
  })
})

describe("thread anchoring by block id (#192, the identity contract)", () => {
  async function twoEditors() {
    const a = await peer("1")
    const b = await peer("2")
    await converged(a.editor, b.editor, "both editors on the seeded doc")
    return { a, b }
  }

  it("a move keeps the thread on its block", async () => {
    const { a, b } = await twoEditors()
    const threads = [thread(ids.alpha)]
    // The drag handle's move: delete and insert in one transaction, attrs kept.
    const { state } = a.editor
    let alpha: { pos: number; node: any } | null = null
    state.doc.forEach((node, pos) => {
      if (node.attrs["data-block-id"] === ids.alpha) alpha = { pos, node }
    })
    const tr = state.tr.delete(alpha!.pos, alpha!.pos + alpha!.node.nodeSize)
    tr.insert(tr.doc.content.size, alpha!.node)
    a.editor.view.dispatch(tr)
    await converged(a.editor, b.editor, "the move to reach b")

    expect(docBlocks(b.editor.state.doc).map((x) => x.id)).toEqual([ids.beta, ids.gamma, ids.alpha])
    expect(placement(b.editor, threads)).toEqual({ anchored: [{ text: "alpha one", threads: [ids.alpha] }], orphaned: [] })
  })

  it("a split mid-block keeps the thread on the first half", async () => {
    const { a, b } = await twoEditors()
    const at = startOf(a.editor, ids.alpha) + "alpha".length
    a.editor.chain().setTextSelection(at).splitBlock().run()
    await converged(a.editor, b.editor, "the split to reach b")
    expect(textOfBlock(b.editor, ids.alpha)).toBe("alpha")
    expect(placement(b.editor, [thread(ids.alpha)]).anchored).toEqual([{ text: "alpha", threads: [ids.alpha] }])
  })

  it("Enter at the very start leaves the thread on the new empty block above", async () => {
    // The design's "surprising case": the content moves to a node with a new id.
    const { a, b } = await twoEditors()
    a.editor.chain().setTextSelection(startOf(a.editor, ids.beta)).splitBlock().run()
    await converged(a.editor, b.editor, "the split to reach b")
    expect(textOfBlock(b.editor, ids.beta)).toBe("")
    const blocks = docBlocks(b.editor.state.doc)
    const moved = blocks.find((x) => x.text === "beta two")!
    expect(moved.id).not.toBe(ids.beta)
    expect(placement(b.editor, [thread(ids.beta)])).toEqual({ anchored: [{ text: "", threads: [ids.beta] }], orphaned: [] })
  })

  it("a join keeps the absorbing block's thread and orphans the absorbed one's", async () => {
    const { a, b } = await twoEditors()
    a.editor.chain().setTextSelection(startOf(a.editor, ids.gamma)).joinBackward().run()
    await converged(a.editor, b.editor, "the join to reach b")
    expect(textOfBlock(b.editor, ids.beta)).toBe("beta twogamma three")
    expect(placement(b.editor, [thread(ids.beta), thread(ids.gamma)])).toEqual({
      anchored: [{ text: "beta twogamma three", threads: [ids.beta] }],
      orphaned: [ids.gamma],
    })
  })

  it("a cut and paste gives the block a new id, so its thread is orphaned", async () => {
    const { a, b } = await twoEditors()
    const { state } = a.editor
    let range: [number, number] = [0, 0]
    state.doc.forEach((node, pos) => {
      if (node.attrs["data-block-id"] === ids.alpha) range = [pos, pos + node.nodeSize]
    })
    a.editor.view.dispatch(state.tr.delete(range[0], range[1]))
    // Pasted on a new line at the end. The copied HTML carries the id; PasteSanitizer
    // strips it (#128/#264).
    a.editor.chain().setTextSelection(a.editor.state.doc.content.size - 1).splitBlock().run()
    a.editor.view.pasteHTML(`<p data-block-id="${ids.alpha}">alpha one</p>`, new Event("paste") as ClipboardEvent)
    await converged(a.editor, b.editor, "the paste to reach b")

    const pasted = docBlocks(b.editor.state.doc).find((x) => x.text === "alpha one")!
    expect(pasted.id).not.toBe(ids.alpha)
    expect(placement(b.editor, [thread(ids.alpha)]).orphaned).toEqual([ids.alpha])
  })

  it("a turn-into across several blocks gives them new ids", async () => {
    const { a, b } = await twoEditors()
    const from = startOf(a.editor, ids.alpha)
    const to = startOf(a.editor, ids.beta) + 2
    a.editor.view.dispatch(a.editor.state.tr.setSelection(TextSelection.create(a.editor.state.doc, from, to)))
    a.editor.commands.setNode("heading", { level: 2 })
    await converged(a.editor, b.editor, "the turn-into to reach b")
    const p = placement(b.editor, [thread(ids.alpha), thread(ids.beta), thread(ids.gamma)])
    expect(p.orphaned).toEqual([ids.alpha, ids.beta])
    expect(p.anchored).toEqual([{ text: "gamma three", threads: [ids.gamma] }])
  })

  it("a restore orphans the thread of a block the version lacks, and a later restore reattaches it", async () => {
    const { a, b } = await twoEditors()
    const status = new CollabSaveStatus(a.collab)
    const original = relay.api.posts.get(String(POST_ID))!.block_doc!
    const threads = [thread(ids.beta)]

    const withoutBeta = structuredClone(original)
    withoutBeta.blocks_order = withoutBeta.blocks_order.filter((id) => id !== ids.beta)
    delete withoutBeta.blocks[ids.beta]
    await restoreVersionLive(a.editor, withoutBeta, a.collab.doc, status)
    await converged(a.editor, b.editor, "the restore to reach b")
    expect(placement(b.editor, threads)).toEqual({ anchored: [], orphaned: [ids.beta] })

    // Nothing was deleted: restoring the version that has the block brings the thread back.
    await restoreVersionLive(a.editor, original, a.collab.doc, status)
    await converged(a.editor, b.editor, "the second restore to reach b")
    expect(placement(b.editor, threads)).toEqual({ anchored: [{ text: "beta two", threads: [ids.beta] }], orphaned: [] })
    status.destroy()
  })

  it("a reseed keeps the threads anchored (the ids come from block_doc)", async () => {
    const first = await peer("2")
    await waitFor(() => docBlocks(first.editor.state.doc).length === 3, { what: "the seeded doc" })
    const threads = [thread(ids.alpha), thread(ids.gamma, { resolved_at: new Date().toISOString() })]

    // block_doc written around the collab server (a restored backup): the API withholds
    // the stale state, and the server seeds a new doc under a new epoch.
    await relay.restart(() => relay.api.writeAround(String(POST_ID), seedDoc()))
    const next = await peer("1")
    await waitFor(() => docBlocks(next.editor.state.doc).length === 3, { what: "the reseeded doc" })
    expect(placement(next.editor, threads)).toEqual({
      anchored: [
        { text: "alpha one", threads: [ids.alpha] },
        { text: "gamma three", threads: [ids.gamma] },
      ],
      orphaned: [],
    })
  })
})
