import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { isChangeOrigin } from "@tiptap/extension-collaboration"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { resetMediaLookups } from "@gl-admin/lib/mediaLookup"
import type { Media } from "@gl-admin/lib/api/types"
import { BlockNodeViews } from "./BlockNodeViews"
import { GalleryKeyboard } from "./GalleryKeyboard"
import { BlockSelectionKeys } from "./BlockNavigation"
import { addMediaToGallery } from "../blocks/mediaPicking"
import { applyBlockMove } from "../utils/blockMoveSync"
import { editorBlockById, planBlockMove, type DropTarget } from "../utils/blockTree"
import { moveGalleryImage, setGalleryImageAlt, setGalleryImageCaption } from "../utils/galleryActions"

// Two users in one gallery on the real collab server (#424, the issue's acceptance): adding
// several images, reordering and captioning at once. A reorder by keyboard and by drag is
// one Yjs transaction with every id kept; captions merge per character, an alt is one
// attribute, and the stored block_doc is valid, with a third user and a restart seeing the same.

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
    extensions: [...Object.values(schemaExtensions({ collaborating: true })), BlockNodeViews, GalleryKeyboard, BlockSelectionKeys, Collaboration.configure({ document: doc })],
  })
  editors.push(editor)
  return editor
}

const G = "blk-0424-gallery-00001"
const A = "blk-0424-image-a00001"
const B = "blk-0424-image-b00001"
const C = "blk-0424-image-c00001"
const AFTER = "blk-0424-after-000001"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [G, AFTER],
  blocks: {
    [G]: { id: G, type: "gallery", version: 1, attrs: { columns: 3, caption: [{ type: "text", text: "Six covers" }] }, children: [A, B, C] },
    [A]: { id: A, type: "image", version: 2, attrs: { src: "/uploads/a.jpg", alt: "A", mediaId: 1, caption: [{ type: "text", text: "October" }] } },
    [B]: { id: B, type: "image", version: 2, attrs: { src: "/uploads/b.jpg", mediaId: 2 } },
    [C]: { id: C, type: "image", version: 2, attrs: { src: "/uploads/c.jpg", alt: "C", mediaId: 3 } },
    [AFTER]: { id: AFTER, type: "paragraph", version: 1, attrs: { text: "after" } },
  },
}

const images = (editor: Editor) => {
  const out: string[] = []
  editor.state.doc.child(0).forEach((child) => {
    if (child.type.name === "image") out.push(child.attrs["data-block-id"])
  })
  return out
}
const child = (editor: Editor, id: string): PMNode => {
  let found: PMNode | null = null
  editor.state.doc.descendants((node) => {
    if (node.attrs["data-block-id"] === id) found = node
  })
  if (!found) throw new Error(`no ${id}`)
  return found
}
const same = (a: Editor, b: Editor) => JSON.stringify(a.state.doc.toJSON()) === JSON.stringify(b.state.doc.toJSON())
const stored = () => relay.api.posts.get("12")!.block_doc as BlockDocV1

function localTransactions(doc: Y.Doc, run: () => void): number {
  let count = 0
  const onTransaction = (tr: Y.Transaction) => {
    if (tr.local && tr.changed.size > 0) count++
  }
  doc.on("afterTransaction", onTransaction)
  run()
  doc.off("afterTransaction", onTransaction)
  return count
}

const twoUsers = async () => {
  const pa = relay.client("1")
  const pb = relay.client("2")
  await Promise.all([pa.whenSynced(), pb.whenSynced()])
  const a = makeEditor(pa.doc)
  const b = makeEditor(pb.doc)
  await waitFor(() => b.state.doc.child(0).type.name === "gallery" && images(b).length === 3, { what: "b to load" })
  return { pa, pb, a, b }
}

describe("Gallery with two users on the relay (#424)", () => {
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    resetMediaLookups()
    api.getMediaById.mockImplementation(async (id: number) => ({ media: { id: Number(id), alt: "", mime_type: "image/jpeg" } as Media }))
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

  it("a keyboard reorder is one Yjs transaction with every id kept, on both peers and in the stored doc", async () => {
    const { pa, a, b } = await twoUsers()
    a.view.dispatch(a.state.tr.setSelection(NodeSelection.create(a.state.doc, 1)))
    const transactions = localTransactions(pa.doc, () => moveGalleryImage(a, { id: A, pos: 0 }, 1))
    expect(transactions).toBe(1)
    expect(images(a)).toEqual([B, A, C])
    await waitFor(() => same(a, b), { what: "convergence" })
    expect(images(b)).toEqual([B, A, C])
    await waitFor(() => stored().blocks[G].children?.[0] === B, { what: "the store" })
    expect(stored().blocks[G].children).toEqual([B, A, C])
    expect(() => validateBlockDoc(stored())).not.toThrow()
    expect((stored().blocks[A].attrs as any).caption).toEqual([{ type: "text", text: "October" }])
  })

  it("a drag is one Yjs transaction too, and the image keeps its id and caption", async () => {
    const { pa, a, b } = await twoUsers()
    const dragged = editorBlockById(a.state.doc, A)!
    const over = editorBlockById(a.state.doc, C)!
    const target: DropTarget = { pos: over.pos + over.node.nodeSize, holderPos: over.holderPos, index: over.index + 1 }
    const move = planBlockMove(a.state, dragged, target)!
    const transactions = localTransactions(pa.doc, () => applyBlockMove(a.view, move))
    expect(transactions).toBe(1)
    expect(images(a)).toEqual([B, C, A])
    expect(child(a, A).firstChild?.textContent).toBe("October")
    await waitFor(() => same(a, b), { what: "convergence" })
    await waitFor(() => stored().blocks[G].children?.[2] === A, { what: "the store" })
  })

  it("one user reorders while the other captions an image: both land, captions merge per character", async () => {
    const { a, b } = await twoUsers()
    // At the same time, on the same caption: A at its start, B at its end, and A moves another image.
    setGalleryImageCaption(a, { id: A, pos: 0 }, "Early October")
    setGalleryImageCaption(b, { id: A, pos: 0 }, "October issue")
    moveGalleryImage(b, { id: C, pos: 0 }, -1)
    setGalleryImageAlt(b, { id: B, pos: 0 }, "A tower")

    await waitFor(() => same(a, b) && child(a, A).textContent === "Early October issue", { what: "convergence" })
    expect(images(a)).toEqual([A, C, B])
    expect(child(a, B).attrs.alt).toBe("A tower")

    await waitFor(() => (stored().blocks[A].attrs as any).caption?.[0]?.text === "Early October issue" && stored().blocks[G].children?.[1] === C, { what: "the store" })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(doc.blocks[G].children).toEqual([A, C, B])
    expect((doc.blocks[B].attrs as any).alt).toBe("A tower")
    expect(Object.values(doc.blocks).map((block) => block.type).sort()).toEqual(["gallery", "image", "image", "image", "paragraph"])

    // A third user opening the post later, and a restarted server, give the same doc.
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.state.doc.child(0).type.name === "gallery" && images(c).length === 3, { what: "c to load" })
    expect(c.state.doc.toJSON()).toEqual(a.state.doc.toJSON())
    const before = c.state.doc.toJSON()
    await relay.restart()
    const pd = relay.client("2")
    await pd.whenSynced()
    const d = makeEditor(pd.doc)
    await waitFor(() => d.state.doc.child(0).type.name === "gallery" && images(d).length === 3, { what: "d to load after the restart" })
    expect(d.state.doc.toJSON()).toEqual(before)
  })

  it("adding several images at once is one Yjs update, with unique ids on both peers, and in Used in order", async () => {
    const { pa, a, b } = await twoUsers()
    const picked = [4, 5].map((id) => ({ id, alt: `Alt ${id}`, name: `n${id}`, media_path: `/uploads/${id}.jpg`, mime_type: "image/jpeg" }) as Media)
    const transactions = localTransactions(pa.doc, () => addMediaToGallery(a, { id: G, pos: 0 }, picked))
    expect(transactions).toBe(1)
    await waitFor(() => same(a, b) && images(b).length === 5, { what: "convergence" })
    expect(new Set(images(b)).size).toBe(5)
    await waitFor(() => (stored().blocks[G].children?.length ?? 0) === 5, { what: "the store" })
    const added = stored().blocks[G].children!.slice(3).map((id) => (stored().blocks[id].attrs as any).mediaId)
    expect(added).toEqual([4, 5])
  })

  it("removing every image stores an empty gallery with its caption; a peer's view matches", async () => {
    const { a, b } = await twoUsers()
    const tr = a.state.tr
    tr.delete(1, 1 + a.state.doc.child(0).child(0).nodeSize + a.state.doc.child(0).child(1).nodeSize + a.state.doc.child(0).child(2).nodeSize)
    a.view.dispatch(tr)
    await waitFor(() => same(a, b) && images(b).length === 0, { what: "convergence" })
    expect(b.state.doc.child(0).lastChild?.textContent).toBe("Six covers")
    await waitFor(() => (stored().blocks[G].children?.length ?? 1) === 0, { what: "the store" })
    expect(() => validateBlockDoc(stored())).not.toThrow()
    expect((stored().blocks[G].attrs as any).caption).toEqual([{ type: "text", text: "Six covers" }])
  })

  it("is quiet after a reorder: nothing re-stamps or echoes (rule 7)", async () => {
    const { pa, pb, a, b } = await twoUsers()
    moveGalleryImage(a, { id: A, pos: 0 }, 1)
    await waitFor(() => same(a, b), { what: "convergence" })
    let updates = 0
    let localOnB = 0
    const count = () => updates++
    const onB = ({ transaction }: { transaction: any }) => {
      if (transaction.docChanged && !isChangeOrigin(transaction)) localOnB++
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    pa.doc.on("update", count)
    pb.doc.on("update", count)
    b.on("transaction", onB)
    await new Promise((resolve) => setTimeout(resolve, 300))
    pa.doc.off("update", count)
    pb.doc.off("update", count)
    b.off("transaction", onB)
    expect(updates).toBe(0)
    expect(localOnB).toBe(0)
  })
})
