import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { NodeSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { EDITOR_FRAGMENT } from "@gl-admin/lib/collaboration/fragmentBridge"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { resetMediaLookups } from "@gl-admin/lib/mediaLookup"
import type { Media } from "@gl-admin/lib/api/types"
import { BlockNodeViews } from "./BlockNodeViews"
import { BlockSelectionKeys } from "./BlockNavigation"
import { EmptyContainerFill } from "./CoverMediaBlocks"
import { deleteBlockTr, editorBlockById } from "../utils/blockTree"

// Two users on the real collab server (#427's acceptance: "nested blocks edited by two users"):
// typing in one block of a cover, changing its settings at the same moment, the stored block_doc
// and a third user. And the race the schema allows for: both deleting its last blocks at once.

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
    extensions: [...Object.values(schemaExtensions({ collaborating: true })), BlockNodeViews, BlockSelectionKeys, EmptyContainerFill, Collaboration.configure({ document: doc })],
  })
  editors.push(editor)
  return editor
}

const C = "blk-0427-cover-000001"
const M = "blk-0427-media-000001"
const H = "blk-0427-head-0000001"
const P = "blk-0427-para-0000001"
const MP = "blk-0427-para-0000002"
const AFTER = "blk-0427-after-000001"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [C, M, AFTER],
  blocks: {
    [C]: { id: C, type: "cover", version: 1, attrs: { mediaId: 1, decorative: true, overlay: 55 }, children: [H, P] },
    [H]: { id: H, type: "heading", version: 1, attrs: { level: 2, text: "Notes" } },
    [P]: { id: P, type: "paragraph", version: 1, attrs: { text: "Updates" } },
    [M]: { id: M, type: "media_text", version: 1, attrs: { mediaId: 2, decorative: false }, children: [MP] },
    [MP]: { id: MP, type: "paragraph", version: 1, attrs: { text: "More" } },
    [AFTER]: { id: AFTER, type: "paragraph", version: 1, attrs: { text: "after" } },
  },
} as BlockDocV1

const posOf = (editor: Editor, id: string) => {
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.attrs["data-block-id"] === id) at = pos
  })
  if (at === -1) throw new Error(`no ${id}`)
  return at
}
const nodeOf = (editor: Editor, id: string) => editor.state.doc.nodeAt(posOf(editor, id))!
const same = (a: Editor, b: Editor) => JSON.stringify(a.state.doc.toJSON()) === JSON.stringify(b.state.doc.toJSON())
const stored = () => relay.api.posts.get("12")!.block_doc as BlockDocV1
const typeAt = (editor: Editor, pos: number, text: string) => editor.view.dispatch(editor.state.tr.insertText(text, pos))
const setAttrs = (editor: Editor, id: string, attrs: Record<string, unknown>) => {
  const pos = posOf(editor, id)
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...nodeOf(editor, id).attrs, ...attrs }))
}

const twoUsers = async () => {
  const pa = relay.client("1")
  const pb = relay.client("2")
  await Promise.all([pa.whenSynced(), pb.whenSynced()])
  const a = makeEditor(pa.doc)
  const b = makeEditor(pb.doc)
  await waitFor(() => b.state.doc.child(0).type.name === "cover" && same(a, b), { what: "b to load" })
  return { pa, pb, a, b }
}

describe("Cover and media & text with two users on the relay (#427)", () => {
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    resetMediaLookups()
    api.getMediaById.mockImplementation(async (id: number) => ({ media: { id: Number(id), alt: "", media_path: `/uploads/${id}.jpg`, mime_type: "image/jpeg" } as Media }))
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

  it("seeds the blocks and the settings for both, with their ids", async () => {
    const { a, b } = await twoUsers()
    expect(same(a, b)).toBe(true)
    expect(nodeOf(b, C).attrs).toMatchObject({ mediaId: 1, decorative: true, overlay: 55 })
    expect(nodeOf(b, H).textContent).toBe("Notes")
    expect(nodeOf(b, M).attrs).toMatchObject({ mediaId: 2, position: "left" })
  })

  it("nested blocks edited by two users: one types in the heading, the other in the paragraph, both land", async () => {
    const { a, b } = await twoUsers()
    typeAt(a, posOf(a, H) + 1, "Latest ")
    typeAt(b, posOf(b, P) + 1, "New ")
    await waitFor(() => same(a, b) && nodeOf(a, H).textContent === "Latest Notes" && nodeOf(a, P).textContent === "New Updates", { what: "convergence" })
    await waitFor(() => (stored().blocks[H].attrs as { text?: string }).text === "Latest Notes", { what: "the store" })
    expect((stored().blocks[P].attrs as { text?: string }).text).toBe("New Updates")
    expect(stored().blocks[C].children).toEqual([H, P])
    expect(() => validateBlockDoc(stored())).not.toThrow()
  })

  it("one user changes the overlay and the focal point while the other types inside the cover", async () => {
    const { a, b } = await twoUsers()
    setAttrs(a, C, { overlay: 30, focalX: 10, focalY: 90 })
    typeAt(b, posOf(b, P) + 1, "x")
    await waitFor(() => same(a, b) && nodeOf(b, C).attrs.overlay === 30 && nodeOf(a, P).textContent === "xUpdates", { what: "convergence" })
    expect(nodeOf(b, C).attrs).toMatchObject({ focalX: 10, focalY: 90 })
    await waitFor(() => (stored().blocks[C].attrs as { overlay?: number }).overlay === 30, { what: "the store" })
    expect((stored().blocks[C].attrs as { focal?: unknown }).focal).toEqual({ x: 10, y: 90 })
  })

  it("two users change different settings of the same block: both land, an attribute at a time", async () => {
    const { a, b } = await twoUsers()
    setAttrs(a, M, { position: "right" })
    setAttrs(b, M, { alt: "Dunes", decorative: false })
    await waitFor(() => same(a, b) && nodeOf(a, M).attrs.position === "right" && nodeOf(a, M).attrs.alt === "Dunes", { what: "convergence" })
  })

  it("two users picking a focal point at once end on one of the two, on both peers", async () => {
    const { a, b } = await twoUsers()
    setAttrs(a, C, { focalX: 10, focalY: 10 })
    setAttrs(b, C, { focalX: 90, focalY: 90 })
    await waitFor(() => same(a, b), { what: "convergence" })
    const { focalX, focalY } = nodeOf(a, C).attrs
    expect([[10, 10], [90, 90]]).toContainEqual([focalX, focalY])
  })

  it("both users delete the cover's last two blocks at once: the cover and its image survive, and the store repairs it", async () => {
    const { a, b } = await twoUsers()
    // At the same moment: A deletes the heading, B the paragraph. Neither sees the other's yet,
    // so the merge leaves the cover with no blocks at all.
    a.view.dispatch(deleteBlockTr(a.state, editorBlockById(a.state.doc, H)!)!)
    b.view.dispatch(deleteBlockTr(b.state, editorBlockById(b.state.doc, P)!)!)
    // y-tiptap deletes an element whose children fail the content check: without
    // `emptyNotInSchema`, an empty cover would be deleted here, for every peer.
    await waitFor(() => same(a, b) && a.state.doc.child(0).type.name === "cover", { what: "convergence" })
    expect(a.state.doc.child(0).attrs.mediaId).toBe(1)
    await waitFor(() => stored().blocks[C]?.children?.length === 1, { what: "the store's repair" })
    expect(() => validateBlockDoc(stored())).not.toThrow()
    expect((stored().blocks[C].attrs as { mediaId?: number }).mediaId).toBe(1)
  })

  it("a third user and a restart see the same doc", async () => {
    const { a } = await twoUsers()
    a.view.dispatch(a.state.tr.setSelection(NodeSelection.create(a.state.doc, posOf(a, M))))
    setAttrs(a, C, { overlay: 70, align: "wide" })
    setAttrs(a, M, { position: "right" })
    await waitFor(() => (stored().blocks[M].attrs as { position?: string }).position === "right", { what: "the store" })
    const expected = stored()
    await relay.restart()
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.state.doc.childCount >= 2 && c.state.doc.child(0).type.name === "cover", { what: "c to load" })
    expect(nodeOf(c, C).attrs).toMatchObject({ overlay: 70, align: "wide", mediaId: 1 })
    expect(nodeOf(c, M).attrs).toMatchObject({ position: "right" })
    expect(stored()).toEqual(expected)
    expect(pc.doc.getXmlFragment(EDITOR_FRAGMENT).length).toBe(3)
  })
})
