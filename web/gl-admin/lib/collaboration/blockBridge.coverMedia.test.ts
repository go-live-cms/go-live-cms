import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as Y from "yjs"
import { validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { blockDocToPMWithReport, pmToBlockDoc } from "./blockBridge"
import { fragmentToBlockDoc, repairEmptyContainers, seedFragment, stampFragmentBlockIds } from "./fragmentBridge"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import { canonical } from "./fragmentBridge.fixtures"

// Cover and media & text through the bridge (#427, design 2.2): containers whose image is
// attrs, not a part. Round trips, normalized values, drops at their level, an empty one's
// synthesized line, the store's per-child fallback, and the repair of a merge that empties one.

const schema = getInstalledCollabSchema()

const C1 = "blk-cover-000001"
const M1 = "blk-media-000001"
const H1 = "blk-head-0000001"
const P1 = "blk-para-0000001"
const D1 = "blk-detail-00001"
const G1 = "blk-group-000001"

function coverDoc(attrs: Record<string, unknown> = { mediaId: 12, alt: "Towers", decorative: false, focal: { x: 50, y: 40 }, overlay: 60, align: "full" }): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [C1],
    blocks: {
      [C1]: { id: C1, type: "cover", version: 1, attrs, children: [H1, P1] },
      [H1]: { id: H1, type: "heading", version: 1, attrs: { level: 2, text: "Notes" } },
      [P1]: { id: P1, type: "paragraph", version: 1, attrs: { text: "Updates" } },
    },
  } as BlockDocV1
}

function mediaTextDoc(attrs: Record<string, unknown> = { mediaId: 7, alt: "Dunes", decorative: true, focal: { x: 5, y: 95 }, position: "right" }): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [G1],
    blocks: {
      [G1]: { id: G1, type: "group", version: 1, attrs: {}, children: [M1] },
      [M1]: { id: M1, type: "media_text", version: 1, attrs, children: [H1, D1] },
      [H1]: { id: H1, type: "heading", version: 1, attrs: { level: 3, text: "Faster" } },
      [D1]: { id: D1, type: "details", version: 1, attrs: {}, children: [P1] },
      [P1]: { id: P1, type: "paragraph", version: 1, attrs: { text: "More" } },
    },
  } as BlockDocV1
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("cover through the bridge (#427)", () => {
  it("round trips: the image as attrs, the focal point as two node attrs and one stored object", () => {
    const { node: doc, dropped } = blockDocToPMWithReport(coverDoc(), schema)
    expect(dropped).toEqual([])
    doc.check()
    const cover = doc.child(0)
    expect(cover.type.name).toBe("cover")
    expect(cover.attrs).toMatchObject({ "data-block-id": C1, mediaId: 12, alt: "Towers", decorative: false, focalX: 50, focalY: 40, overlay: 60, align: "full" })
    expect(cover.childCount).toBe(2)
    const out = pmToBlockDoc(doc)
    expect(out).toEqual(canonical(coverDoc(), schema))
    expect(out.blocks[C1].children).toEqual([H1, P1])
    expect(out.blocks[C1].attrs).toEqual({ mediaId: 12, alt: "Towers", decorative: false, focal: { x: 50, y: 40 }, overlay: 60, align: "full" })
    expect(() => validateBlockDoc(out)).not.toThrow()
  })

  it("a new cover's defaults: decorative and the overlay are written, everything else left out", () => {
    const out = pmToBlockDoc(blockDocToPMWithReport(coverDoc({}), schema).node)
    expect(out.blocks[C1].attrs).toEqual({ decorative: true, overlay: 55 })
  })

  it("a stored value out of range is normalized on the way in; a bad one costs the attr, never the block", () => {
    const { node, dropped } = blockDocToPMWithReport(coverDoc({ mediaId: 0, alt: 12, decorative: "yes", focal: { x: 300, y: "up" }, overlay: 95, align: "huge" }), schema)
    expect(dropped).toEqual([])
    expect(node.child(0).attrs).toMatchObject({ mediaId: null, alt: null, decorative: true, focalX: null, focalY: null, overlay: 80, align: "content" })
    expect(pmToBlockDoc(node).blocks[C1].attrs).toEqual({ decorative: true, overlay: 80 })
  })

  it("a child the table doesn't allow is dropped on its own and reported under the cover", () => {
    const source = coverDoc()
    source.blocks[C1].children = [H1, D1, P1]
    source.blocks[D1] = { id: D1, type: "details", version: 1, attrs: {}, children: [] } as any
    const { node, dropped } = blockDocToPMWithReport(source, schema)
    expect(dropped).toEqual([{ id: D1, parentId: C1, afterId: H1 }])
    expect(node.child(0).childCount).toBe(2)
  })

  it("left with no block, it gets an empty paragraph with a deterministic id", () => {
    const source = coverDoc()
    source.blocks[C1].children = []
    delete source.blocks[H1]
    delete source.blocks[P1]
    const first = blockDocToPMWithReport(source, schema).node.child(0)
    expect(first.childCount).toBe(1)
    expect(first.child(0).attrs["data-block-id"]).toBe(`${C1}-paragraph`)
    expect(blockDocToPMWithReport(source, schema).node.child(0).child(0).attrs["data-block-id"]).toBe(`${C1}-paragraph`)
  })

  it("a cover can't be seeded inside a group: it's dropped, not lost", () => {
    const source: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [G1],
      blocks: {
        [G1]: { id: G1, type: "group", version: 1, attrs: {}, children: [C1] },
        [C1]: { id: C1, type: "cover", version: 1, attrs: {}, children: [P1] },
        [P1]: { id: P1, type: "paragraph", version: 1, attrs: { text: "x" } },
      },
    } as BlockDocV1
    expect(blockDocToPMWithReport(source, schema).dropped).toEqual([{ id: C1, parentId: G1, afterId: null }])
  })
})

describe("media & text through the bridge (#427)", () => {
  it("round trips inside a group, details included", () => {
    const { node: doc, dropped } = blockDocToPMWithReport(mediaTextDoc(), schema)
    expect(dropped).toEqual([])
    doc.check()
    const media = doc.child(0).child(0)
    expect(media.type.name).toBe("mediaText")
    expect(media.attrs).toMatchObject({ mediaId: 7, alt: "Dunes", decorative: true, focalX: 5, focalY: 95, position: "right" })
    expect(media.child(1).type.name).toBe("details")
    const out = pmToBlockDoc(doc)
    expect(out).toEqual(canonical(mediaTextDoc(), schema))
    expect(() => validateBlockDoc(out)).not.toThrow()
  })

  it("defaults are left out; decorative is written", () => {
    const out = pmToBlockDoc(blockDocToPMWithReport(mediaTextDoc({}), schema).node)
    expect(out.blocks[M1].attrs).toEqual({ decorative: false })
  })
})

describe("through the Yjs fragment (the collab server's path)", () => {
  const seededDoc = (source: BlockDocV1) => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment("default")
    seedFragment(source, fragment, schema)
    return { doc, fragment }
  }

  it("a seed and a store give the same doc", () => {
    for (const source of [coverDoc(), mediaTextDoc()]) {
      const { fragment } = seededDoc(source)
      stampFragmentBlockIds(fragment)
      expect(fragmentToBlockDoc(fragment, schema)).toEqual(canonical(source, schema))
    }
  })

  it("keeps a broken child's previous version under the cover, not the whole cover's", () => {
    const { doc, fragment } = seededDoc(coverDoc())
    doc.transact(() => {
      const cover = fragment.get(0) as Y.XmlElement
      // A node the schema can't build as a block.
      const broken = new Y.XmlElement("text")
      cover.delete(1, 1)
      cover.insert(1, [broken])
      broken.setAttribute("data-block-id", P1)
    })
    const issues: { id: string | null; parentId?: string | null }[] = []
    const out = fragmentToBlockDoc(fragment, schema, { previous: coverDoc(), onUnconvertible: (block) => issues.push(block) })
    expect(issues.map((issue) => [issue.id, issue.parentId])).toEqual([[P1, C1]])
    expect(out.blocks[C1].children).toEqual([H1, P1])
    expect((out.blocks[P1].attrs as { text: string }).text).toBe("Updates")
  })

  describe("repairEmptyContainers", () => {
    it("puts an empty paragraph into a cover or media & text a merge emptied, in one transaction", () => {
      for (const source of [coverDoc(), mediaTextDoc()]) {
        const { doc, fragment } = seededDoc(source)
        const target = (source.blocks_order[0] === C1 ? fragment.get(0) : (fragment.get(0) as Y.XmlElement).get(0)) as Y.XmlElement
        doc.transact(() => target.delete(0, target.length))
        let transactions = 0
        doc.on("afterTransaction", (tr: Y.Transaction) => {
          if (tr.changed.size > 0) transactions++
        })
        expect(repairEmptyContainers(fragment)).toBe(1)
        expect(transactions).toBe(1)
        expect(target.length).toBe(1)
        expect((target.get(0) as Y.XmlElement).nodeName).toBe("paragraph")
        stampFragmentBlockIds(fragment)
        expect(() => validateBlockDoc(fragmentToBlockDoc(fragment, schema))).not.toThrow()
      }
    })

    it("leaves everything else alone: no update when nothing is empty", () => {
      const { doc, fragment } = seededDoc(coverDoc())
      let updates = 0
      doc.on("update", () => updates++)
      expect(repairEmptyContainers(fragment)).toBe(0)
      expect(updates).toBe(0)
    })

    it("an emptied cover keeps its image and settings through the repair", () => {
      const { doc, fragment } = seededDoc(coverDoc())
      const cover = fragment.get(0) as Y.XmlElement
      doc.transact(() => cover.delete(0, cover.length))
      repairEmptyContainers(fragment)
      stampFragmentBlockIds(fragment)
      const stored = fragmentToBlockDoc(fragment, schema)
      expect(stored.blocks[C1].attrs).toEqual(canonical(coverDoc(), schema).blocks[C1].attrs)
    })
  })
})
