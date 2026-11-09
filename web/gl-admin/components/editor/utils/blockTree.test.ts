import { describe, expect, it } from "vitest"
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state"
import type { Node as PMNode } from "prosemirror-model"
import { getCoreSchema } from "@gl-admin/lib/collaboration/schema"
import {
  containerBlockOf,
  deleteBlockTr,
  dropTargetFor,
  editorBlockAtSelection,
  editorBlockById,
  holderAccepts,
  moveBlockTr,
  removalRange,
  siblingTarget,
} from "./blockTree"
import { dropLine, dropTargetAt, pickBlock, type Rect } from "./gutterPlugin"

// The block tree at any depth (#417): which blocks a move may go to (the nesting table,
// blocks-spec/nesting.ts: no group in a group, nothing inside itself), what a move or a
// delete removes (a container left empty goes too), and which block the pointer is on.

const schema = getCoreSchema()

const p = (id: string, text: string) => ({ type: "paragraph", attrs: { "data-block-id": id }, content: [{ type: "text", text }] })
const group = (id: string, ...content: unknown[]) => ({ type: "group", attrs: { "data-block-id": id }, content })

function doc(...content: unknown[]): PMNode {
  const node = schema.nodeFromJSON({ type: "doc", content })
  node.check()
  return node
}

const block = (d: PMNode, id: string) => {
  const found = editorBlockById(d, id)
  if (!found) throw new Error(`no ${id}`)
  return found
}

/** The ids of the doc's blocks as a nested list: "g1[a,b]". */
function shape(d: PMNode): string {
  const walk = (node: PMNode): string => {
    const items: string[] = []
    node.forEach((child) => {
      const id = String(child.attrs["data-block-id"] ?? child.type.name)
      items.push(child.type.name === "group" ? `${id}[${walk(child)}]` : id)
    })
    return items.join(",")
  }
  return walk(d)
}

const G1 = "g1-0000000001"
const G2 = "g2-0000000002"
const A = "a-00000000001"
const B = "b-00000000002"
const C = "c-00000000003"
const D = "d-00000000004"

const base = () => doc(group(G1, p(A, "alpha"), p(B, "beta")), p(C, "gamma"), group(G2, p(D, "delta")))

/** A gallery of three images and its caption (#424). */
const galleryLayoutDoc = () =>
  doc({
    type: "gallery",
    attrs: { "data-block-id": "gallery-aaaa-00000000" },
    content: [
      { type: "image", attrs: { "data-block-id": "image-aaaa-0000000000", src: "/a.jpg" } },
      { type: "image", attrs: { "data-block-id": "image-bbbb-0000000000", src: "/b.jpg" } },
      { type: "image", attrs: { "data-block-id": "image-cccc-0000000000", src: "/c.jpg" } },
      { type: "galleryCaption" },
    ],
  })

describe("the nesting table at a drop (#417)", () => {
  it("a paragraph goes into a group; a group never into a group", () => {
    const d = base()
    expect(holderAccepts(block(d, G1).node, block(d, C).node)).toBe(true)
    expect(holderAccepts(block(d, G1).node, block(d, G2).node)).toBe(false)
    expect(holderAccepts(d, block(d, G2).node)).toBe(true)
  })

  it("a paragraph dropped beside a block in a group lands in the group", () => {
    const d = base()
    const target = dropTargetFor(d, block(d, C), block(d, A), "after")!
    expect(target).toMatchObject({ holderPos: block(d, G1).pos, index: 1 })
  })

  it("a group dropped beside a block in another group lands beside that group instead", () => {
    const d = base()
    const target = dropTargetFor(d, block(d, G2), block(d, A), "before")!
    expect(target).toEqual({ pos: 0, holderPos: -1, index: 0 })
    const after = dropTargetFor(d, block(d, G2), block(d, B), "after")!
    expect(after).toEqual({ pos: block(d, G1).node.nodeSize, holderPos: -1, index: 1 })
  })

  it("a group is never dropped inside itself", () => {
    const d = base()
    // Over its own child: the place beside the group, which is where it already is.
    const target = dropTargetFor(d, block(d, G1), block(d, A), "after")!
    expect(target.holderPos).toBe(-1)
    expect(moveBlockTr(EditorState.create({ doc: d }), block(d, G1), target)).toBeNull()
  })
})

describe("moves and deletes (#417)", () => {
  it("moves a block into a group in one transaction, the same node with its id", () => {
    const d = base()
    const state = EditorState.create({ doc: d })
    const tr = moveBlockTr(state, block(d, C), dropTargetFor(d, block(d, C), block(d, A), "after")!)!
    expect(shape(tr.doc)).toBe(`${G1}[${A},${C},${B}],${G2}[${D}]`)
    expect((tr.selection as NodeSelection).node.attrs["data-block-id"]).toBe(C)
    expect(tr.doc.textContent).toBe(d.textContent.replace("gamma", "").replace("alphabeta", "alphagammabeta"))
  })

  it("moving a group's only block out takes the empty group with it", () => {
    const d = base()
    expect(removalRange(d, block(d, D))).toEqual({ from: block(d, G2).pos, to: block(d, G2).pos + block(d, G2).node.nodeSize })
    const state = EditorState.create({ doc: d })
    const tr = moveBlockTr(state, block(d, D), dropTargetFor(d, block(d, D), block(d, C), "before")!)!
    expect(shape(tr.doc)).toBe(`${G1}[${A},${B}],${D},${C}`)
    tr.doc.check()
  })

  it("moving the only block of the post's only group out of it leaves the block", () => {
    const d = doc(group(G1, p(A, "alpha")))
    const state = EditorState.create({ doc: d })
    const target = dropTargetFor(d, block(d, A), block(d, G1), "after")!
    const tr = moveBlockTr(state, block(d, A), target)!
    expect(shape(tr.doc)).toBe(A)
    tr.doc.check()
  })

  it("keeps a caret that was in the moved block where it was in it", () => {
    const d = base()
    const caret = block(d, A).pos + 3
    const state = EditorState.create({ doc: d, selection: TextSelection.create(d, caret) })
    const tr = moveBlockTr(state, block(d, A), siblingTarget(d, block(d, A), 1)!)!
    expect(shape(tr.doc)).toBe(`${G1}[${B},${A}],${C},${G2}[${D}]`)
    expect(tr.selection.from).toBe(block(tr.doc, A).pos + 3)
  })

  it("siblingTarget stays inside the container: nothing below a group's last block", () => {
    const d = base()
    expect(siblingTarget(d, block(d, B), 1)).toBeNull()
    expect(siblingTarget(d, block(d, A), -1)).toBeNull()
    expect(siblingTarget(d, block(d, C), -1)).toEqual({ pos: 0, holderPos: -1, index: 0 })
  })

  it("deletes a block, a group with its only block, and leaves an empty line for the last one", () => {
    const d = base()
    const state = EditorState.create({ doc: d })
    expect(shape(deleteBlockTr(state, block(d, A))!.doc)).toBe(`${G1}[${B}],${C},${G2}[${D}]`)
    expect(shape(deleteBlockTr(state, block(d, D))!.doc)).toBe(`${G1}[${A},${B}],${C}`)
    const only = doc(group(G1, p(A, "alpha")))
    const last = deleteBlockTr(EditorState.create({ doc: only }), block(only, A))!.doc
    expect(last.childCount).toBe(1)
    expect(last.firstChild!.type.name).toBe("paragraph")
    expect(last.textContent).toBe("")
  })

  it("finds the block the selection is in, and its container", () => {
    const d = base()
    const state = EditorState.create({ doc: d, selection: TextSelection.create(d, block(d, B).pos + 2) })
    const at = editorBlockAtSelection(state)!
    expect(at.node.attrs["data-block-id"]).toBe(B)
    expect(containerBlockOf(d, at)!.node.attrs["data-block-id"]).toBe(G1)
    expect(containerBlockOf(d, containerBlockOf(d, at)!)).toBeNull()
  })
})

describe("the pointer (#417, gutterPlugin.ts)", () => {
  // g1 holds a and b, indented 20px; c below it; g2 holds d.
  const d = base()
  const boxes: Record<string, Rect> = {
    [G1]: { top: 0, bottom: 100, left: 0, right: 500 },
    [A]: { top: 10, bottom: 40, left: 20, right: 480 },
    [B]: { top: 50, bottom: 90, left: 20, right: 480 },
    [C]: { top: 110, bottom: 140, left: 0, right: 500 },
    [G2]: { top: 150, bottom: 200, left: 0, right: 500 },
    [D]: { top: 160, bottom: 190, left: 20, right: 480 },
  }
  const rectOf = (pos: number) => boxes[String(d.nodeAt(pos)?.attrs["data-block-id"])] ?? null
  const picked = (x: number, y: number) => pickBlock(d, rectOf, x, y)?.block.node.attrs["data-block-id"]

  it("inside a group picks the block there; in the group's own left margin, the group", () => {
    expect(picked(100, 20)).toBe(A)
    expect(picked(100, 70)).toBe(B)
    // Between a and b (the group's padding): the nearest of its blocks.
    expect(picked(100, 45)).toBe(A)
    // Left of the group's edge (where its gutter is): the group itself.
    expect(picked(-10, 20)).toBe(G1)
    expect(picked(100, 120)).toBe(C)
    expect(picked(100, 175)).toBe(D)
  })

  it("a drop over a block lands above or below it by the half the pointer is in", () => {
    const below = dropTargetAt(d, block(d, C), rectOf, 100, 35)!
    expect(below).toMatchObject({ holderPos: block(d, G1).pos, index: 1 })
    const above = dropTargetAt(d, block(d, C), rectOf, 100, 15)!
    expect(above).toMatchObject({ holderPos: block(d, G1).pos, index: 0 })
    // The line is drawn at the top of the block after it, as wide as that block.
    expect(dropLine(d, below, rectOf)).toEqual({ y: 50, left: 20, right: 480 })
    // At the end of a group: the bottom of its last block.
    const end = dropTargetAt(d, block(d, C), rectOf, 100, 80)!
    expect(dropLine(d, end, rectOf)).toEqual({ y: 90, left: 20, right: 480 })
  })

  it("among a gallery's images a drop lands left or right of the image, and the line stands upright (#424)", () => {
    const doc2 = galleryLayoutDoc()
    const G = "gallery-aaaa-00000000"
    const [I1, I2, I3] = ["image-aaaa-0000000000", "image-bbbb-0000000000", "image-cccc-0000000000"]
    const tiles: Record<string, Rect> = {
      [G]: { top: 0, bottom: 150, left: 0, right: 330 },
      [I1]: { top: 0, bottom: 100, left: 0, right: 100 },
      [I2]: { top: 0, bottom: 100, left: 110, right: 210 },
      [I3]: { top: 0, bottom: 100, left: 220, right: 320 },
    }
    const rect = (pos: number) => tiles[String(doc2.nodeAt(pos)?.attrs["data-block-id"])] ?? null
    const at = (id: string) => block(doc2, id)

    const leftOfSecond = dropTargetAt(doc2, at(I3), rect, 120, 50)!
    expect(leftOfSecond).toMatchObject({ holderPos: at(G).pos, index: 1 })
    expect(dropLine(doc2, leftOfSecond, rect)).toEqual({ y: 0, left: 110, right: 110, height: 100 })
    const rightOfSecond = dropTargetAt(doc2, at(I1), rect, 200, 50)!
    expect(rightOfSecond).toMatchObject({ holderPos: at(G).pos, index: 2 })
    // After the last image, in front of the caption: the right edge of that image.
    const afterLast = dropTargetAt(doc2, at(I1), rect, 310, 50)!
    expect(afterLast).toMatchObject({ holderPos: at(G).pos, index: 3 })
    expect(dropLine(doc2, afterLast, rect)).toEqual({ y: 0, left: 320, right: 320, height: 100 })
    // A block that can't go among the tiles lands above or below the gallery, by height.
    const para = doc(
      p(A, "alpha"),
      { type: "gallery", attrs: { "data-block-id": G }, content: [{ type: "image", attrs: { "data-block-id": I1, src: "/a.jpg" } }, { type: "galleryCaption" }] },
    )
    const paraRect = (pos: number) =>
      ({ [A]: { top: 200, bottom: 230, left: 0, right: 330 }, [G]: tiles[G], [I1]: tiles[I1] } as Record<string, Rect>)[String(para.nodeAt(pos)?.attrs["data-block-id"])] ?? null
    // Right half of the tile, top half: before the gallery (by x it would have been after it).
    expect(dropTargetAt(para, block(para, A), paraRect, 90, 10)).toMatchObject({ holderPos: -1, index: 1 })
    // Under the images (its caption) the gallery is what the pointer is on.
    expect(pickBlock(doc2, rect, 100, 130)?.block.node.attrs["data-block-id"]).toBe(G)
    expect(pickBlock(doc2, rect, 150, 50)?.block.node.attrs["data-block-id"]).toBe(I2)
  })

  it("a group dragged over another group's block gets the place beside that group", () => {
    const target = dropTargetAt(d, block(d, G2), rectOf, 100, 75)!
    expect(target).toMatchObject({ holderPos: -1, index: 1 })
  })
})
