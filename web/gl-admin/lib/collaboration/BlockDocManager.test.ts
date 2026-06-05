import { describe, it, expect, beforeEach } from "vitest"
import * as Y from "yjs"
import { BlockDocManager } from "./BlockDocManager"
import type { Block, BlockDocV1 } from "../blocks-spec"

let counter = 0
const id = () => `blk-${(counter++).toString().padStart(4, "0")}-0000000000`

const para = (text = ""): Block => ({ id: id(), type: "paragraph", version: 1, attrs: { text } })

function freshManager(): BlockDocManager {
  return new BlockDocManager(new Y.Doc())
}

describe("BlockDocManager — empty state", () => {
  it("reports an empty doc on a fresh Y.Doc", () => {
    const m = freshManager()
    expect(m.getBlockDocV1()).toEqual({ doc_version: 1, blocks_order: [], blocks: {} })
  })
})

describe("BlockDocManager — CRUD", () => {
  it("setBlock + getBlock round-trips a block", () => {
    const m = freshManager()
    const b = para("hi")
    m.setBlock(b)
    expect(m.getBlock(b.id)).toMatchObject({ id: b.id, type: "paragraph", attrs: { text: "hi" } })
  })

  it("getBlock returns null for a missing id", () => {
    expect(freshManager().getBlock("nope-nope-nope")).toBeNull()
  })

  it("insertBlockAtPosition inserts at the right index", () => {
    const m = freshManager()
    const a = para("a")
    const b = para("b")
    const c = para("c")
    m.insertBlockAtPosition(a, 0)
    m.insertBlockAtPosition(c, 1)
    m.insertBlockAtPosition(b, 1) // between a and c
    expect(m.getBlockDocV1().blocks_order).toEqual([a.id, b.id, c.id])
  })

  it("deleteBlock removes the block and its order entry", () => {
    const m = freshManager()
    const a = para("a")
    const b = para("b")
    m.insertBlockAtPosition(a, 0)
    m.insertBlockAtPosition(b, 1)
    m.deleteBlock(a.id)
    const doc = m.getBlockDocV1()
    expect(doc.blocks_order).toEqual([b.id])
    expect(doc.blocks[a.id]).toBeUndefined()
  })

  it("deleteBlock cleans up child references in parent lists", () => {
    const m = freshManager()
    const li1 = para("one")
    const li2 = para("two")
    const list: Block = { id: id(), type: "bullet_list", version: 1, attrs: {}, children: [li1.id, li2.id] }
    m.setBlock(li1)
    m.setBlock(li2)
    m.insertBlockAtPosition(list, 0)

    m.deleteBlock(li1.id)
    expect(m.getBlock(list.id)?.children).toEqual([li2.id])
  })
})

describe("BlockDocManager — ordering", () => {
  it("moveBlock forward adjusts the index correctly", () => {
    const m = freshManager()
    const blocks = [para("a"), para("b"), para("c"), para("d")]
    blocks.forEach((b, i) => m.insertBlockAtPosition(b, i))
    m.moveBlock(blocks[0].id, 2) // move 'a' forward
    expect(m.getBlockDocV1().blocks_order).toEqual([blocks[1].id, blocks[0].id, blocks[2].id, blocks[3].id])
  })

  it("moveBlock backward inserts at the target index", () => {
    const m = freshManager()
    const blocks = [para("a"), para("b"), para("c"), para("d")]
    blocks.forEach((b, i) => m.insertBlockAtPosition(b, i))
    m.moveBlock(blocks[3].id, 1) // move 'd' backward
    expect(m.getBlockDocV1().blocks_order).toEqual([blocks[0].id, blocks[3].id, blocks[1].id, blocks[2].id])
  })

  it("moveBlock is a no-op for an unknown id", () => {
    const m = freshManager()
    const a = para("a")
    m.insertBlockAtPosition(a, 0)
    m.moveBlock("missing-missing", 0)
    expect(m.getBlockDocV1().blocks_order).toEqual([a.id])
  })

  it("setBlocksOrder replaces the order array", () => {
    const m = freshManager()
    const a = para("a")
    const b = para("b")
    m.setBlock(a)
    m.setBlock(b)
    m.setBlocksOrder([b.id, a.id])
    expect(m.getBlockDocV1().blocks_order).toEqual([b.id, a.id])
  })
})

describe("BlockDocManager — initializeDoc", () => {
  it("seeds a single empty paragraph when the doc is empty", () => {
    const m = freshManager()
    m.initializeDoc()
    const doc = m.getBlockDocV1()
    expect(doc.blocks_order).toHaveLength(1)
    expect(doc.blocks[doc.blocks_order[0]].type).toBe("paragraph")
  })

  it("is a no-op when the doc already has content", () => {
    const m = freshManager()
    const a = para("existing")
    m.insertBlockAtPosition(a, 0)
    m.initializeDoc()
    expect(m.getBlockDocV1().blocks_order).toEqual([a.id])
  })
})

describe("BlockDocManager — setBlockDocV1 (destructive replace)", () => {
  it("clears existing content and repopulates from the new doc", () => {
    const m = freshManager()
    // seed some initial content
    const old1 = para("old1")
    const old2 = para("old2")
    m.insertBlockAtPosition(old1, 0)
    m.insertBlockAtPosition(old2, 1)

    const n1 = para("new1")
    const next: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [n1.id],
      blocks: { [n1.id]: n1 },
    }
    m.setBlockDocV1(next)

    const result = m.getBlockDocV1()
    expect(result.blocks_order).toEqual([n1.id])
    expect(result.blocks[old1.id]).toBeUndefined()
    expect(result.blocks[old2.id]).toBeUndefined()
    expect(result.blocks[n1.id].attrs.text).toBe("new1")
  })

  it("setting an empty doc wipes everything (documents the destructive behavior)", () => {
    const m = freshManager()
    m.insertBlockAtPosition(para("content"), 0)
    m.setBlockDocV1({ doc_version: 1, blocks_order: [], blocks: {} })
    expect(m.getBlockDocV1()).toEqual({ doc_version: 1, blocks_order: [], blocks: {} })
  })
})

describe("BlockDocManager — setBlockDocV1 is incremental (no churn)", () => {
  it("re-applying identical content emits NO change (no Yjs update / observer fire)", () => {
    const m = freshManager()
    const a = para("same")
    const b = para("also")
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [a.id, b.id],
      blocks: { [a.id]: a, [b.id]: b },
    }
    m.setBlockDocV1(doc)

    let calls = 0
    const stop = m.onDocumentChange(() => {
      calls++
    })
    // Re-apply a structurally-identical doc (fresh objects, same content).
    m.setBlockDocV1({
      doc_version: 1,
      blocks_order: [a.id, b.id],
      blocks: { [a.id]: { ...a, attrs: { ...a.attrs } }, [b.id]: { ...b, attrs: { ...b.attrs } } },
    })
    expect(calls).toBe(0) // no observer → no Yjs update → no WS broadcast / LevelDB write
    stop()
  })

  it("updates only the changed block in place, leaving others untouched", () => {
    const m = freshManager()
    const a = para("one")
    const b = para("two")
    m.setBlockDocV1({ doc_version: 1, blocks_order: [a.id, b.id], blocks: { [a.id]: a, [b.id]: b } })

    m.setBlockDocV1({
      doc_version: 1,
      blocks_order: [a.id, b.id],
      blocks: { [a.id]: { ...a, attrs: { text: "ONE" } }, [b.id]: b },
    })
    expect(m.getBlock(a.id)?.attrs.text).toBe("ONE")
    expect(m.getBlock(b.id)?.attrs.text).toBe("two")
  })

  it("a pure reorder keeps the same block contents", () => {
    const m = freshManager()
    const a = para("a")
    const b = para("b")
    m.setBlockDocV1({ doc_version: 1, blocks_order: [a.id, b.id], blocks: { [a.id]: a, [b.id]: b } })
    m.setBlockDocV1({ doc_version: 1, blocks_order: [b.id, a.id], blocks: { [a.id]: a, [b.id]: b } })
    expect(m.getBlockDocV1().blocks_order).toEqual([b.id, a.id])
    expect(m.getBlock(a.id)?.attrs.text).toBe("a")
  })
})

describe("BlockDocManager — onDocumentChange", () => {
  it("fires the callback with the latest doc on a change", () => {
    const m = freshManager()
    let lastDoc: BlockDocV1 | null = null
    const stop = m.onDocumentChange((doc) => {
      lastDoc = doc
    })

    const a = para("watched")
    m.insertBlockAtPosition(a, 0)

    expect(lastDoc).not.toBeNull()
    expect(lastDoc!.blocks_order).toEqual([a.id])
    stop()
  })

  it("stops firing after the cleanup function is called", () => {
    const m = freshManager()
    let calls = 0
    const stop = m.onDocumentChange(() => {
      calls++
    })

    m.insertBlockAtPosition(para("one"), 0)
    const afterFirst = calls
    expect(afterFirst).toBeGreaterThan(0)

    stop()
    m.insertBlockAtPosition(para("two"), 1)
    expect(calls).toBe(afterFirst) // no further calls after cleanup
  })

  it("a single setBlockDocV1 transaction reflects the final state to observers", () => {
    const m = freshManager()
    const seen: number[] = []
    const stop = m.onDocumentChange((doc) => {
      seen.push(doc.blocks_order.length)
    })

    const a = para("a")
    const b = para("b")
    m.setBlockDocV1({ doc_version: 1, blocks_order: [a.id, b.id], blocks: { [a.id]: a, [b.id]: b } })

    // The handler is registered on both the blocks map and the order array, so a
    // transaction touching both fires it more than once — but every callback sees
    // the committed final state (2 blocks), never a half-applied one.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((n) => n === 2)).toBe(true)
    stop()
  })
})
