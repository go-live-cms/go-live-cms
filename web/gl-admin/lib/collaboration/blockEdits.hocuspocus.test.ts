import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import type { Node as PMNode } from "prosemirror-model"
import * as Y from "yjs"
import type { BlockDocV1 } from "../blocks-spec"
import { PasteSanitizer } from "@gl-admin/components/editor/extensions/PasteSanitizer"
import { BlockNodeViews } from "@gl-admin/components/editor/extensions/BlockNodeViews"
import type { HocuspocusCollaboration, StoreMessage } from "./HocuspocusCollaboration"
import { EDITOR_FRAGMENT } from "./fragmentBridge"
import { schemaExtensions } from "./schema"
import { canonical } from "./fragmentBridge.fixtures"
import { startRelay, waitFor, POST_ID, type Relay } from "./hocuspocusRelay.testkit"

// Per-block "Last edited by" (#328) on the real collab server (hocuspocusRelay.testkit.ts),
// with the API's post_block_edits faked in memory (FakeCollabApi.blockEdits):
//   - the server's block change tracker (collab-server/blockEdits.ts) attributes each
//     block to the authenticated connection that changed it, through both ways Yjs
//     reports a change: an existing type in `tr.changed` (typing in a block) and a new
//     element in its parent's `changes.added` (a new, pasted or nested block). The tests
//     arrange for a *different* user to edit last before the store, so the store's
//     fallback (the last editor) would give the wrong answer if a path were missed;
//   - a block inside a Group is attributed itself (the nearest block, any depth), a move
//     or an undone edit attributes nothing, a paste attributes the new block;
//   - attribution goes only with a store that writes block_doc: a failed store keeps the
//     tracker's entries for its retry, a state-only store (unchanged, kept-invalid) sends
//     and clears nothing, and nothing adds a PUT or a revision;
//   - it survives a server restart (it lives in the API's table), and the `stored`
//     message carries what was just written to every open editor.

const POST = String(POST_ID)
const DOC_NAME = `post-${POST_ID}`
const ids = { alpha: "blk-0328-alpha-0001", beta: "blk-0328-beta-00001", gamma: "blk-0328-gamma-0001" }

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
  vi.spyOn(console, "error").mockImplementation(() => {})
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
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: true })),
      PasteSanitizer,
      BlockNodeViews,
      Collaboration.configure({ document: collab.doc }),
    ],
  })
  editors.push(editor)
  return editor
}

interface Peer {
  collab: HocuspocusCollaboration
  editor: Editor
  /** Every `stored` / `store_failed` message this client got. */
  messages: StoreMessage[]
}

async function peer(userId: string): Promise<Peer> {
  const collab = relay.client(userId)
  const messages: StoreMessage[] = []
  collab.onStore((message) => messages.push(message))
  await collab.whenSynced()
  return { collab, editor: bind(collab), messages }
}

const json = (editor: Editor) => JSON.stringify(editor.state.doc.toJSON())

/** Two editors (users 1 and 2) on the doc, converged. */
async function twoPeers(): Promise<{ a: Peer; b: Peer }> {
  const a = await peer("1")
  const b = await peer("2")
  await waitFor(() => json(a.editor) === json(b.editor) && a.editor.getText().includes("gamma"), { what: "both editors on the doc" })
  return { a, b }
}

/** The node with this block id at any depth, and its position. */
function find(editor: Editor, id: string): { node: PMNode; pos: number } {
  let found: { node: PMNode; pos: number } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (!found && node.attrs["data-block-id"] === id) found = { node, pos }
  })
  if (!found) throw new Error(`no block ${id}`)
  return found
}

/** Types `text` at the end of the block's text. */
function typeAtEnd(editor: Editor, id: string, text: string) {
  const { node, pos } = find(editor, id)
  editor.chain().setTextSelection(pos + node.nodeSize - 1).insertContent(text).run()
}

/** The server's live doc has `text` (its update was applied, with its connection as origin). */
const serverHas = (text: string) =>
  waitFor(() => !!relay.server.hocuspocus.documents.get(DOC_NAME)?.getXmlFragment(EDITOR_FRAGMENT).toString().includes(text), {
    what: `"${text}" on the server`,
  })

const editors328 = () => relay.api.editorsOf(POST)
const stored = () => relay.api.posts.get(POST)!.block_doc!

/** The stored block whose content includes `text`. */
function storedIdOf(text: string): string {
  const entry = Object.entries(stored().blocks).find(([, block]) => JSON.stringify(block).includes(text))
  if (!entry) throw new Error(`no stored block with "${text}"`)
  return entry[0]
}

const blockDocPuts = () => relay.api.puts.filter((p) => p.body.block_doc)

/** Whether a stored Yjs state (base64) has `text` in its fragment. */
function stateHas(state: string, text: string): boolean {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Buffer.from(state, "base64"))
  return doc.getXmlFragment(EDITOR_FRAGMENT).toString().includes(text)
}

describe("per-block attribution on the relay (#328)", () => {
  it("two users editing different blocks are each attributed; untouched blocks get nothing", async () => {
    const { a, b } = await twoPeers()
    typeAtEnd(a.editor, ids.alpha, " by one")
    typeAtEnd(b.editor, ids.gamma, " by two")
    await waitFor(() => editors328()[ids.alpha] === 1 && editors328()[ids.gamma] === 2, { what: "both attributed" })
    expect(editors328()).toEqual({ [ids.alpha]: 1, [ids.gamma]: 2 })

    // Every PUT that carried attribution carried block_doc, and the edit times are real.
    for (const put of relay.api.puts) if (put.body.block_edits) expect(put.body.block_doc).toBeDefined()
    const row = relay.api.blockEdits.get(POST)!.get(ids.alpha)!
    expect(Math.abs(Date.now() - Date.parse(row.edited_at))).toBeLessThan(30_000)

    // The `stored` messages told both editors (including the one who didn't type).
    await waitFor(() => b.messages.some((m) => m.type === "stored" && m.edits?.some((e) => e.block_id === ids.alpha && e.user_id === 1)), {
      what: "a's edit in b's stored message",
    })
    for (const m of [...a.messages, ...b.messages]) {
      if (m.type === "stored" && m.edits) expect(m.block_doc).toBe("written")
    }
  })

  it("pins both detection paths: an edited block (tr.changed) and a new block (changes.added), and a failed store keeps them for the retry", async () => {
    const { a, b } = await twoPeers()
    relay.api.failPut = true

    // User 1 edits alpha and adds a new block after beta.
    typeAtEnd(a.editor, ids.alpha, " edited")
    const beta = find(a.editor, ids.beta)
    a.editor.commands.insertContentAt(beta.pos + beta.node.nodeSize, { type: "paragraph", content: [{ type: "text", text: "brand new block" }] })
    await serverHas("brand new block")
    await waitFor(() => a.messages.some((m) => m.type === "store_failed"), { what: "a failed store" })

    // Then user 2 edits gamma: user 2 is now the last editor, which is what the fallback
    // would attribute everything to.
    typeAtEnd(b.editor, ids.gamma, " later")
    await serverHas("gamma three later")
    relay.api.failPut = false

    await waitFor(() => editors328()[ids.gamma] === 2, { what: "the retry to store" })
    const added = storedIdOf("brand new block")
    expect(editors328()).toEqual({ [ids.alpha]: 1, [added]: 1, [ids.gamma]: 2 })
  })

  it("attributes a block inside a group to its editor, not the group, and a new block in a group too", async () => {
    await relay.destroy()
    const GROUP = "blk-0328-group-00001"
    const ONE = "blk-0328-inner-00001"
    const AFTER = "blk-0328-after-00001"
    relay = await startRelay({
      revision: 3,
      blockDoc: canonical({
        doc_version: 1,
        blocks_order: [GROUP, AFTER],
        blocks: {
          [GROUP]: { id: GROUP, type: "group", version: 1, attrs: {}, children: [ONE] },
          [ONE]: { id: ONE, type: "paragraph", version: 1, attrs: { text: "inside one" } },
          [AFTER]: { id: AFTER, type: "paragraph", version: 1, attrs: { text: "after" } },
        },
      } as BlockDocV1),
    })
    const a = await peer("1")
    const b = await peer("2")
    await waitFor(() => b.editor.getText().includes("after") && json(a.editor) === json(b.editor), { what: "the group on both" })

    // Typing inside the group: the paragraph is the nearest block (any depth); the
    // group's own JSON (its children's ids) doesn't change.
    typeAtEnd(a.editor, ONE, " typed")
    await serverHas("inside one typed")
    typeAtEnd(b.editor, AFTER, " by two")
    await waitFor(() => editors328()[ONE] === 1 && editors328()[AFTER] === 2, { what: "the nested edit" })
    expect(editors328()).toEqual({ [ONE]: 1, [AFTER]: 2 })

    // User 2 adds a block inside the group (a new element under the group: the group's
    // children change too), then user 1 types after it.
    const one = find(b.editor, ONE)
    b.editor.commands.insertContentAt(one.pos + one.node.nodeSize, { type: "paragraph", content: [{ type: "text", text: "nested new" }] })
    await serverHas("nested new")
    typeAtEnd(a.editor, AFTER, " and one")
    await waitFor(() => editors328()[AFTER] === 1, { what: "the second store" })
    const nested = storedIdOf("nested new")
    expect(stored().blocks[GROUP]).toMatchObject({ children: [ONE, nested] })
    expect(editors328()).toEqual({ [ONE]: 1, [nested]: 2, [GROUP]: 2, [AFTER]: 1 })
  })

  it("inside a details (#421): a summary edit is the details', a child's edit the child's, a new child its author's", async () => {
    await relay.destroy()
    const DETAILS = "blk-0328-details-001"
    const ONE = "blk-0328-dinner-0001"
    const AFTER = "blk-0328-dafter-0001"
    relay = await startRelay({
      revision: 3,
      blockDoc: canonical({
        doc_version: 1,
        blocks_order: [DETAILS, AFTER],
        blocks: {
          [DETAILS]: { id: DETAILS, type: "details", version: 1, attrs: { summary: [{ type: "text", text: "Question" }], text: "Question" }, children: [ONE] },
          [ONE]: { id: ONE, type: "paragraph", version: 1, attrs: { text: "inside one" } },
          [AFTER]: { id: AFTER, type: "paragraph", version: 1, attrs: { text: "after" } },
        },
      } as BlockDocV1),
    })
    const a = await peer("1")
    const b = await peer("2")
    await waitFor(() => b.editor.getText().includes("after") && json(a.editor) === json(b.editor), { what: "the details on both" })

    // Typing in a block of the details: that block is the nearest block, not the details.
    typeAtEnd(a.editor, ONE, " typed")
    await serverHas("inside one typed")
    await waitFor(() => editors328()[ONE] === 1, { what: "the child's edit" })
    expect(editors328()).toEqual({ [ONE]: 1 })

    // Typing in the summary: the summary is a part, so the details is the block edited.
    b.editor.chain().setTextSelection(2).insertContent("The ").run()
    await waitFor(() => (stored().blocks[DETAILS]?.attrs as any)?.text === "The Question", { what: "the summary stored" })
    await waitFor(() => editors328()[DETAILS] === 2, { what: "the summary's edit" })
    expect(editors328()).toEqual({ [ONE]: 1, [DETAILS]: 2 })

    // User 1 adds a block inside the details.
    const one = find(a.editor, ONE)
    a.editor.commands.insertContentAt(one.pos + one.node.nodeSize, { type: "paragraph", content: [{ type: "text", text: "nested new" }] })
    await serverHas("nested new")
    await waitFor(() => Object.values(stored().blocks).some((block) => (block.attrs as any)?.text === "nested new"), { what: "the new child stored" })
    const nested = storedIdOf("nested new")
    await waitFor(() => editors328()[nested] === 1, { what: "the new child" })
    expect(stored().blocks[DETAILS]).toMatchObject({ children: [ONE, nested] })
    expect(editors328()).toMatchObject({ [ONE]: 1, [nested]: 1 })
  })

  it("a move attributes nothing; a paste attributes the new block to whoever pasted", async () => {
    const { a, b } = await twoPeers()
    typeAtEnd(a.editor, ids.alpha, " first")
    await waitFor(() => editors328()[ids.alpha] === 1, { what: "alpha stored" })
    const writes = blockDocPuts().length

    // User 2 moves alpha to the end (the drag handle's delete + insert, attrs kept): the
    // order changes, so block_doc is written, but no block's content does.
    const alpha = find(b.editor, ids.alpha)
    const tr = b.editor.state.tr.delete(alpha.pos, alpha.pos + alpha.node.nodeSize)
    tr.insert(tr.doc.content.size, alpha.node)
    b.editor.view.dispatch(tr)
    await waitFor(() => stored().blocks_order.at(-1) === ids.alpha, { what: "the move stored" })
    expect(blockDocPuts().length).toBe(writes + 1)
    expect(blockDocPuts().at(-1)!.body.block_edits).toBeUndefined()
    expect(editors328()).toEqual({ [ids.alpha]: 1 })

    // User 2 pastes a copy of alpha (its id is stripped, #128) on a new line at the end:
    // a new block, theirs. Alpha stays user 1's.
    b.editor.chain().setTextSelection(b.editor.state.doc.content.size - 1).splitBlock().run()
    b.editor.view.pasteHTML(`<p data-block-id="${ids.alpha}">pasted copy</p>`, new Event("paste") as ClipboardEvent)
    await waitFor(() => Object.values(editors328()).includes(2), { what: "the paste stored" })
    const pasted = storedIdOf("pasted copy")
    expect(pasted).not.toBe(ids.alpha)
    expect(editors328()).toMatchObject({ [ids.alpha]: 1, [pasted]: 2 })
  })

  it("a state-only store sends and clears nothing: an edit kept while the doc was invalid is still its author's", async () => {
    const { a, b } = await twoPeers()
    // User 2 makes gamma invalid (a heading level the validator refuses): from now on
    // every store keeps block_doc and stores the state only.
    const gamma = find(b.editor, ids.gamma)
    b.editor.chain().setTextSelection(gamma.pos + 1).setNode("heading", { level: 9 }).run()
    await waitFor(() => a.messages.some((m) => m.type === "stored" && m.block_doc === "kept-invalid"), { what: "a kept-invalid store" })

    // User 1 edits alpha, and a state-only store holds that edit.
    typeAtEnd(a.editor, ids.alpha, " kept")
    await waitFor(() => relay.api.puts.some((p) => !p.body.block_doc && stateHas(p.body.state, "alpha one kept")), {
      what: "a state-only store with alpha's edit",
    })
    const invalid = relay.api.puts.filter((p) => !p.body.block_doc)
    for (const put of invalid) expect(put.body.block_edits).toBeUndefined()
    expect(editors328()).toEqual({})

    // User 2 fixes gamma and is now the last editor. The store that writes block_doc
    // still gives alpha to user 1: the invalid store didn't clear their entry (the
    // fallback would have said user 2).
    b.editor.chain().setTextSelection(find(b.editor, ids.gamma).pos + 1).setNode("heading", { level: 2 }).run()
    await waitFor(() => editors328()[ids.gamma] === 2, { what: "the valid store" })
    // (A heading at the end makes TipTap's TrailingNode add an empty paragraph after it:
    // a new block of user 2's too.)
    expect(editors328()).toMatchObject({ [ids.alpha]: 1, [ids.gamma]: 2 })
    expect(Object.entries(editors328()).filter(([, user]) => user === 1)).toEqual([[ids.alpha, 1]])
  })

  it("revisions don't churn: an undone edit stores state only, with no attribution, and an idle doc stores nothing", async () => {
    const { a } = await twoPeers()
    typeAtEnd(a.editor, ids.alpha, "!")
    await waitFor(() => editors328()[ids.alpha] === 1, { what: "alpha stored" })
    const revision = relay.api.posts.get(POST)!.block_revision
    const puts = relay.api.puts.length

    // Typed and deleted before the store: the doc's state changed, its blocks didn't.
    typeAtEnd(a.editor, ids.beta, "x")
    const { node, pos } = find(a.editor, ids.beta)
    a.editor.commands.deleteRange({ from: pos + node.nodeSize - 2, to: pos + node.nodeSize - 1 })
    await waitFor(() => relay.api.puts.length > puts, { what: "the state-only store" })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const after = relay.api.puts.slice(puts)
    for (const put of after) {
      expect(put.body.block_doc).toBeUndefined()
      expect(put.body.block_edits).toBeUndefined()
    }
    expect(relay.api.posts.get(POST)!.block_revision).toBe(revision)
    expect(editors328()).toEqual({ [ids.alpha]: 1 })

    // Nothing changes: no store at all.
    const settled = relay.api.puts.length
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(relay.api.puts.length).toBe(settled)
  })

  it("survives a server restart: stored attribution stays, and the new server attributes new edits", async () => {
    const first = await peer("1")
    await waitFor(() => first.editor.getText().includes("gamma"), { what: "the doc" })
    typeAtEnd(first.editor, ids.alpha, " before restart")
    await waitFor(() => editors328()[ids.alpha] === 1, { what: "alpha stored" })

    await relay.restart()
    const next = await peer("2")
    await waitFor(() => next.editor.getText().includes("before restart"), { what: "the restored doc" })
    typeAtEnd(next.editor, ids.beta, " after restart")
    await waitFor(() => editors328()[ids.beta] === 2, { what: "beta stored by the new server" })
    expect(editors328()).toEqual({ [ids.alpha]: 1, [ids.beta]: 2 })
  })
})
