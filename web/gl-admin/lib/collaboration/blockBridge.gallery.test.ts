import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as Y from "yjs"
import { normalizeGalleryColumns, validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { blockDocToPMWithReport, pmToBlockDoc } from "./blockBridge"
import { fragmentToBlockDoc, seedFragment, stampFragmentBlockIds, type UnconvertibleBlock } from "./fragmentBridge"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import { canonical } from "./fragmentBridge.fixtures"

// Gallery (#424, design 2.2, 2.4, 2.5): a container of image blocks whose caption is a part
// (`galleryCaption`, last child) stored as `attrs.caption` runs. It may be empty, and then
// nothing is synthesized or dropped. Round trips through the bridge and the Yjs fragment; a
// child that isn't an image is dropped on its own and put back; the store's fallback per child.

const schema = getInstalledCollabSchema()

const G1 = "blk-gallery-0001"
const I1 = "blk-image-000001"
const I2 = "blk-image-000002"
const P1 = "blk-para-0000001"

const CAPTION = [
  { type: "text", text: "Six " },
  { type: "text", text: "covers", marks: [{ type: "italic" }] },
] as const

function galleryDoc(): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [G1, P1],
    blocks: {
      [G1]: { id: G1, type: "gallery", version: 1, attrs: { columns: 4, caption: [...CAPTION] }, children: [I1, I2] },
      [I1]: { id: I1, type: "image", version: 2, attrs: { src: "/uploads/a.png", alt: "A roof", mediaId: 7, caption: [{ type: "text", text: "October" }] } },
      [I2]: { id: I2, type: "image", version: 2, attrs: { src: "/uploads/b.png", mediaId: 8 } },
      [P1]: { id: P1, type: "paragraph", version: 1, attrs: { text: "after" } },
    },
  }
}

const emptyGallery = (attrs: Record<string, unknown> = { columns: 2 }): BlockDocV1 => ({
  doc_version: 1,
  blocks_order: [G1],
  blocks: { [G1]: { id: G1, type: "gallery", version: 1, attrs, children: [] } },
})

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("gallery through the bridge (#424)", () => {
  it("round trips: images as child blocks with their own attrs, the caption as runs, columns", () => {
    const { node: doc, dropped } = blockDocToPMWithReport(galleryDoc(), schema)
    expect(dropped).toEqual([])
    doc.check()
    const gallery = doc.child(0)
    expect(gallery.type.name).toBe("gallery")
    expect(gallery.attrs).toMatchObject({ columns: 4, "data-block-id": G1 })
    expect(gallery.child(0).attrs).toMatchObject({ mediaId: 7, alt: "A roof", "data-block-id": I1 })
    expect(gallery.child(0).firstChild?.textContent).toBe("October")
    expect(gallery.lastChild?.type.name).toBe("galleryCaption")
    expect(gallery.lastChild?.textContent).toBe("Six covers")
    expect(pmToBlockDoc(doc)).toEqual(canonical(galleryDoc(), schema))
  })

  it("the caption is never a block and has no id; each image is a block", () => {
    const out = pmToBlockDoc(blockDocToPMWithReport(galleryDoc(), schema).node)
    expect(out.blocks[G1].children).toEqual([I1, I2])
    expect(Object.values(out.blocks).map((b) => b.type).sort()).toEqual(["gallery", "image", "image", "paragraph"])
    expect(() => validateBlockDoc(out)).not.toThrow()
  })

  it("two captions from a race on a captionless image are both stored, in order", () => {
    const { node } = blockDocToPMWithReport(galleryDoc(), schema)
    const json = node.toJSON()
    json.content[0].content[1].content = [
      { type: "imageCaption", content: [{ type: "text", text: "From Ana" }] },
      { type: "imageCaption", content: [{ type: "text", text: "From Kenji" }] },
    ]
    const out = pmToBlockDoc(schema.nodeFromJSON(json))
    expect((out.blocks[I2].attrs as any).caption).toEqual([
      { type: "text", text: "From Ana" },
      { type: "text", text: " " },
      { type: "text", text: "From Kenji" },
    ])
  })

  it("an empty gallery is kept, with nothing synthesized or dropped, its caption included", () => {
    const withCaption = emptyGallery({ columns: 3, caption: [{ type: "text", text: "Nothing yet" }] })
    const { node: doc, dropped } = blockDocToPMWithReport(withCaption, schema)
    expect(dropped).toEqual([])
    doc.check()
    expect(doc.child(0).childCount).toBe(1)
    expect(doc.child(0).child(0).type.name).toBe("galleryCaption")
    const out = pmToBlockDoc(doc)
    expect(out).toEqual(withCaption)
    expect(() => validateBlockDoc(out)).not.toThrow()
  })

  it("columns are normalized: clamped to 2–4, anything else is the default", () => {
    for (const [value, want] of [[1, 2], [2, 2], [3, 3], [4, 4], [9, 4], [2.9, 2], ["4", 3], [undefined, 3], [null, 3], [Number.NaN, 3]] as const) {
      expect(normalizeGalleryColumns(value as unknown), String(value)).toBe(want)
      const { node: doc } = blockDocToPMWithReport(emptyGallery({ columns: value as unknown as number }), schema)
      expect(doc.child(0).attrs.columns, String(value)).toBe(want)
    }
  })

  it("a child that isn't an image is dropped and reported on its own; the gallery keeps the others", () => {
    const bad = galleryDoc()
    bad.blocks[G1].children = [I1, P1, I2]
    bad.blocks_order = [G1]
    const { node: doc, dropped } = blockDocToPMWithReport(bad, schema)
    expect(dropped).toEqual([{ id: P1, parentId: G1, afterId: I1 }])
    expect(doc.child(0).childCount).toBe(3)
    doc.check()
  })

  it("every image dropped leaves an empty gallery, not a missing one", () => {
    const bad = galleryDoc()
    bad.blocks[G1].children = [P1]
    bad.blocks_order = [G1]
    const { node: doc, dropped } = blockDocToPMWithReport(bad, schema)
    expect(dropped).toHaveLength(1)
    doc.check()
    expect(doc.child(0).childCount).toBe(1)
  })
})

describe("gallery through the Yjs fragment (#424)", () => {
  const roundTrip = (blockDoc: BlockDocV1) => {
    const ydoc = new Y.Doc()
    const fragment = ydoc.getXmlFragment("default")
    seedFragment(blockDoc, fragment, schema)
    stampFragmentBlockIds(fragment)
    return { fragment, out: fragmentToBlockDoc(fragment, schema) }
  }

  it("seeds and stores with the same ids, children and caption", () => {
    expect(roundTrip(galleryDoc()).out).toEqual(canonical(galleryDoc(), schema))
  })

  it("an empty gallery is stored as one, not skipped", () => {
    const { out } = roundTrip(emptyGallery())
    expect(out.blocks_order).toEqual([G1])
    expect(out.blocks[G1].children).toEqual([])
  })

  function breakChild(fragment: Y.XmlFragment, index: number) {
    const gallery = fragment.get(0) as Y.XmlElement
    const id = (gallery.get(index) as Y.XmlElement).getAttribute("data-block-id")
    gallery.doc!.transact(() => {
      gallery.delete(index, 1)
      const malformed = new Y.XmlElement("text")
      gallery.insert(index, [malformed])
      if (id) malformed.setAttribute("data-block-id", id)
    })
  }

  it("an unbuildable image keeps its previous version under the gallery; the live caption stays", () => {
    const previous = canonical(galleryDoc(), schema)
    const { fragment } = roundTrip(previous)
    breakChild(fragment, 1)
    const unconvertible: UnconvertibleBlock[] = []
    const out = fragmentToBlockDoc(fragment, schema, { previous, onUnconvertible: (block) => unconvertible.push(block) })
    expect(unconvertible).toEqual([expect.objectContaining({ id: I2, parentId: G1 })])
    expect(out).toEqual(previous)
  })

  it("a gallery whose images all fail to build falls back as a whole: it isn't an empty one", () => {
    const previous = canonical(galleryDoc(), schema)
    const { fragment } = roundTrip(previous)
    breakChild(fragment, 0)
    breakChild(fragment, 1)
    const unconvertible: UnconvertibleBlock[] = []
    const out = fragmentToBlockDoc(fragment, schema, { previous, onUnconvertible: (block) => unconvertible.push(block) })
    expect(unconvertible.map((block) => block.id)).toEqual([I1, I2, G1])
    expect(out).toEqual(previous)
  })
})
