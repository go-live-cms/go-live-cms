// leveldbDiff.ts: the P4 dry-run comparison of a y-websocket LevelDB doc with block_doc.
import { describe, it, expect } from "vitest"
import * as Y from "yjs"
import type { BlockDocV1 } from "../gl-admin/lib/blocks-spec"
import { getCoreSchema } from "../gl-admin/lib/collaboration/schema"
import { EDITOR_FRAGMENT, seedFragment } from "../gl-admin/lib/collaboration/fragmentBridge"
import { canonical, ids, richDoc } from "../gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { compareDoc } from "./leveldbDiff"
import { appendParagraph, paragraphDoc } from "./testkit"

const schema = getCoreSchema()

/** What the old server's LevelDB would hold for `doc`, after `edit`. */
function leveldbOf(doc: BlockDocV1, edit: (ydoc: Y.Doc) => void = () => {}): Uint8Array {
  const ydoc = new Y.Doc()
  seedFragment(doc, ydoc.getXmlFragment(EDITOR_FRAGMENT), schema)
  // The old client's Block Spec mirror lives in the same doc; it must not matter.
  ydoc.getMap("blocks").set("stale", "x")
  edit(ydoc)
  return Y.encodeStateAsUpdate(ydoc)
}

const renameIds = (doc: BlockDocV1, suffix: string): BlockDocV1 =>
  JSON.parse(JSON.stringify(doc).replace(/blk-para-(\d+)/g, `blk-para-$1${suffix}`))

describe("compareDoc", () => {
  it("matches a doc whose fragment holds exactly block_doc", () => {
    const doc = canonical(paragraphDoc("one", "two"))
    expect(compareDoc({ doc: "post-7", update: leveldbOf(doc) }, doc, schema)).toEqual({
      doc: "post-7",
      postId: 7,
      status: "match",
      leveldbBlocks: 2,
      postgresBlocks: 2,
    })
  })

  it("matches the rich fixture (lists, headings, images)", () => {
    const doc = canonical(richDoc())
    expect(compareDoc({ doc: "post-1", update: leveldbOf(doc) }, doc, schema).status).toBe("match")
  })

  it("reports content only LevelDB has (an autosave that never caught up)", () => {
    const doc = canonical(paragraphDoc("one", "two"))
    const update = leveldbOf(doc, (ydoc) => appendParagraph(ydoc, "typed, never saved"))
    expect(compareDoc({ doc: "post-3", update }, doc, schema)).toMatchObject({
      status: "differs",
      leveldbBlocks: 3,
      postgresBlocks: 2,
      firstDifference: "block 3: only in LevelDB (paragraph)",
    })
  })

  it("reports edited text inside a block", () => {
    const doc = canonical(paragraphDoc("one", "two"))
    const newer = canonical(paragraphDoc("one", "two, edited"))
    expect(compareDoc({ doc: "post-3", update: leveldbOf(doc) }, newer, schema)).toMatchObject({
      status: "differs",
      firstDifference: "block 2 (paragraph): content differs",
    })
  })

  it("compares content, not format: a seed-format block_doc (no attrs.pm) the editor opened but never saved", () => {
    const seedFormat: BlockDocV1 = {
      doc_version: 1,
      blocks_order: ["seed-block-heading-01", "seed-block-para-02"],
      blocks: {
        "seed-block-heading-01": { id: "seed-block-heading-01", type: "heading", version: 1, attrs: { text: "Hello", level: 1 } },
        "seed-block-para-02": { id: "seed-block-para-02", type: "paragraph", version: 1, attrs: { text: "World" } },
      } as BlockDocV1["blocks"],
    }
    expect(compareDoc({ doc: "post-1", update: leveldbOf(seedFormat) }, seedFormat, schema).status).toBe("match")
    const update = leveldbOf(seedFormat, (ydoc) => appendParagraph(ydoc, "typed, never saved"))
    expect(compareDoc({ doc: "post-1", update }, seedFormat, schema).status).toBe("differs")
  })

  it("tells id-only differences apart from content differences", () => {
    const doc = canonical(paragraphDoc("one", "two"))
    expect(compareDoc({ doc: "post-3", update: leveldbOf(doc) }, renameIds(doc, "x"), schema).status).toBe("ids-differ")
  })

  it("doesn't count blocks the editor couldn't show (#213) as a difference", () => {
    const base = canonical(richDoc())
    const badCode = "blk-badcode-001"
    const doc: BlockDocV1 = {
      ...base,
      blocks_order: [ids.intro, badCode, ...base.blocks_order.slice(1)],
      blocks: { ...base.blocks, [badCode]: { id: badCode, type: "code_block", version: 1, attrs: { code: "" } } as BlockDocV1["blocks"][string] },
    }
    expect(compareDoc({ doc: "post-2", update: leveldbOf(doc) }, doc, schema).status).toBe("match")
  })

  it("classifies the harmless cases", () => {
    const doc = canonical(paragraphDoc("one"))
    const empty = new Y.Doc()
    empty.getMap("blocks").set("only", "the old mirror")
    expect(compareDoc({ doc: "post-4", update: Y.encodeStateAsUpdate(empty) }, doc, schema).status).toBe("empty")
    expect(compareDoc({ doc: "post-4", update: leveldbOf(doc) }, undefined, schema).status).toBe("no-post")
    expect(compareDoc({ doc: "probe", update: leveldbOf(doc) }, doc, schema)).toEqual({ doc: "probe", postId: null, status: "not-a-post" })
    expect(compareDoc({ doc: "post-4", update: null }, doc, schema).status).toBe("corrupt")
  })
})
