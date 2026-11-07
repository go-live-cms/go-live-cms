import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { isBlockNode, validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { resetMediaLookups } from "@gl-admin/lib/mediaLookup"
import { BlockNodeViews } from "./BlockNodeViews"

// Video, audio and file with two users on the real collab server (#423): one inserts a
// block and chooses its file while the other types the caption and a file's label; both
// converge, every block keeps a unique id, the stored block_doc holds only media ids,
// captions and labels, and a restart reseeds the same doc.

const api = vi.hoisted(() => ({ getMediaById: vi.fn() }))
vi.mock("@gl-admin/lib/api/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gl-admin/lib/api/media")>()),
  getMediaById: api.getMediaById,
}))

const editors: Editor[] = []
let relay: Relay

function makeEditor(doc: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [...Object.values(schemaExtensions({ collaborating: true })), BlockNodeViews, Collaboration.configure({ document: doc })],
  })
  editors.push(editor)
  return editor
}

const VIDEO = "blk-0423-video-000001"
const FILE = "blk-0423-file-0000001"
const AFTER = "blk-0423-after-000001"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [VIDEO, FILE, AFTER],
  blocks: {
    [VIDEO]: { id: VIDEO, type: "video", version: 1, attrs: { mediaId: 12 } },
    [FILE]: { id: FILE, type: "file", version: 1, attrs: { mediaId: 14 } },
    [AFTER]: { id: AFTER, type: "paragraph", version: 1, attrs: { text: "after" } },
  },
}

function blockIds(doc: PMNode): unknown[] {
  const ids: unknown[] = []
  const walk = (node: PMNode, parentName: string | null) =>
    node.forEach((child) => {
      if (isBlockNode(child.type.name, parentName)) ids.push(child.attrs["data-block-id"])
      if (!child.isTextblock) walk(child, child.type.name)
    })
  walk(doc, null)
  return ids
}

const unique = (ids: unknown[]) => ids.every((id) => typeof id === "string" && id.length >= 10) && new Set(ids).size === ids.length

function find(editor: Editor, id: string): { node: PMNode; pos: number } {
  let found: { node: PMNode; pos: number } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (!found && node.attrs["data-block-id"] === id) found = { node, pos }
  })
  if (!found) throw new Error(`no ${id}`)
  return found
}

/** The position of the (one) audio block. */
function audioPos(editor: Editor): number {
  let at = -1
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === "audio") at = offset
  })
  return at
}

const same = (a: Editor, b: Editor) => JSON.stringify(a.state.doc.toJSON()) === JSON.stringify(b.state.doc.toJSON())

describe("video, audio and file with two users on the relay (#423)", () => {
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    resetMediaLookups()
    api.getMediaById.mockImplementation(async (id: number) => ({
      media: { id: Number(id), name: `m-${id}`, media_path: `/uploads/media/m-${id}.mp4`, mime_type: "video/mp4", file_size: 1, original_filename: `m-${id}.mp4` },
    }))
    relay = await startRelay({ blockDoc: canonical(seed), revision: 2 })
  })
  afterEach(async () => {
    while (editors.length) {
      const editor = editors.pop()!
      const element = editor.options.element as HTMLElement
      editor.destroy()
      element.remove()
    }
    await relay.destroy()
    vi.restoreAllMocks()
  })

  it("their edits merge, ids stay unique, and the stored block_doc keeps ids, captions and labels only", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("after"), { what: "b to load" })
    expect(a.state.doc.child(0).type.name).toBe("video")
    expect(a.state.doc.child(1).type.name).toBe("file")

    // At the same time: A inserts an audio block after "after" and gives it a file, and
    // replaces the video's; B captions the video and types the file's label.
    a.commands.insertContentAt(a.state.doc.content.size, { type: "audio" })
    a.commands.setBlockMedia(audioPos(a), 21)
    a.commands.setBlockMedia(find(a, VIDEO).pos, 13)

    b.view.dispatch(b.state.tr.setSelection(NodeSelection.create(b.state.doc, find(b, VIDEO).pos)))
    b.commands.toggleMediaCaption()
    b.commands.insertContent("Launch walkthrough")
    const file = find(b, FILE)
    b.view.dispatch(b.state.tr.setNodeMarkup(file.pos, undefined, { ...file.node.attrs, label: "Import checklist" }))

    await waitFor(() => same(a, b) && a.getText().includes("Launch walkthrough") && b.state.doc.nodeAt(audioPos(b))?.attrs.mediaId === 21, { what: "convergence" })
    expect(a.state.doc.child(0).attrs.mediaId).toBe(13)
    expect(a.state.doc.child(1).attrs.label).toBe("Import checklist")
    expect(unique(blockIds(a.state.doc))).toBe(true)
    expect(blockIds(a.state.doc)).toEqual(blockIds(b.state.doc))

    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(
      () =>
        Object.values(stored().blocks).some((block) => block.type === "audio" && (block.attrs as any).mediaId === 21) &&
        (stored().blocks[VIDEO]?.attrs as any)?.mediaId === 13 &&
        (stored().blocks[VIDEO]?.attrs as any)?.caption?.length === 1 &&
        (stored().blocks[FILE]?.attrs as any)?.label === "Import checklist",
      { what: "the store" },
    )
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(doc.blocks[VIDEO]).toEqual({ id: VIDEO, type: "video", version: 1, attrs: { mediaId: 13, caption: [{ type: "text", text: "Launch walkthrough" }] } })
    expect(doc.blocks[FILE]).toEqual({ id: FILE, type: "file", version: 1, attrs: { mediaId: 14, label: "Import checklist" } })
    expect(doc.blocks_order.slice(0, 3)).toEqual([VIDEO, FILE, AFTER])
    const added = doc.blocks[doc.blocks_order[3]]
    expect(added).toMatchObject({ type: "audio", version: 1, attrs: { mediaId: 21 } })

    // A third user opening the post later gets the same doc from the server.
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.getText().includes("Launch walkthrough"), { what: "c to load" })
    expect(c.state.doc.toJSON()).toEqual(a.state.doc.toJSON())
  })

  it("survives a collab server restart: the reseeded doc has the same blocks and values", async () => {
    const pa = relay.client("1")
    await pa.whenSynced()
    const a = makeEditor(pa.doc)
    await waitFor(() => a.getText().includes("after"), { what: "a to load" })
    const file = find(a, FILE)
    a.view.dispatch(a.state.tr.setNodeMarkup(file.pos, undefined, { ...file.node.attrs, label: "Checklist" }))
    a.commands.setBlockMedia(find(a, VIDEO).pos, 40)
    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(() => (stored().blocks[FILE]?.attrs as any)?.label === "Checklist" && (stored().blocks[VIDEO]?.attrs as any)?.mediaId === 40, {
      what: "the store",
    })

    await relay.restart()
    const pb = relay.client("2")
    await pb.whenSynced()
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("after"), { what: "b to load after the restart" })
    expect(b.state.doc.child(0).attrs).toMatchObject({ "data-block-id": VIDEO, mediaId: 40 })
    expect(b.state.doc.child(1).attrs).toMatchObject({ "data-block-id": FILE, mediaId: 14, label: "Checklist" })
    expect(unique(blockIds(b.state.doc))).toBe(true)
  })
})
