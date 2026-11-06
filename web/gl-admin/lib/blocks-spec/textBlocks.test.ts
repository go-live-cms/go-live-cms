import { describe, expect, it } from "vitest"
import {
  acceptsChild,
  CALLOUT_TONES,
  isBlockNode,
  isFlowType,
  listItemNodeOf,
  listItemOf,
  normalizeCalloutTone,
  validateBlockDoc,
  type BlockDocV1,
} from "./index"

// The callout, pull quote and to-do list in Block Spec v1 (#419): what the validator the
// collab store runs accepts and refuses, and the nesting rules they follow (the shared
// vectors in nestingVectors.json pin the same docs against the API).

const one = (block: Record<string, unknown>, extra: Record<string, unknown> = {}): BlockDocV1 =>
  ({
    doc_version: 1,
    blocks_order: [block.id as string],
    blocks: { [block.id as string]: block, ...extra },
  }) as unknown as BlockDocV1

const CALLOUT = "blk-callout-00001"
const PULL = "blk-pullquote-001"
const TODO = "blk-todo-list-001"
const TASK = "blk-todo-item-001"

describe("callout", () => {
  it("takes each tone, and no tone (read as info)", () => {
    for (const tone of [...CALLOUT_TONES, undefined]) {
      expect(() => validateBlockDoc(one({ id: CALLOUT, type: "callout", version: 1, attrs: { tone, text: "x" } }))).not.toThrow()
    }
  })

  it("refuses a tone outside the enum", () => {
    for (const tone of ["error", "INFO", "", 1, null]) {
      expect(() => validateBlockDoc(one({ id: CALLOUT, type: "callout", version: 1, attrs: { tone } })), String(tone)).toThrow()
    }
  })

  it("normalizeCalloutTone keeps a tone and makes anything else info", () => {
    expect(normalizeCalloutTone("danger")).toBe("danger")
    for (const value of ["Danger", "", null, undefined, 3, {}]) expect(normalizeCalloutTone(value)).toBe("info")
  })

  it("is a version 1 block with no children", () => {
    expect(() => validateBlockDoc(one({ id: CALLOUT, type: "callout", version: 2, attrs: {} }))).toThrow()
  })
})

describe("pull quote", () => {
  it("takes a citation up to the quote's cap, counted in code points", () => {
    const ok = "é".repeat(300)
    expect(() => validateBlockDoc(one({ id: PULL, type: "pull_quote", version: 1, attrs: { text: "x", cite: ok } }))).not.toThrow()
    expect(() => validateBlockDoc(one({ id: PULL, type: "pull_quote", version: 1, attrs: { cite: ok + "é" } }))).toThrow()
    expect(() => validateBlockDoc(one({ id: PULL, type: "pull_quote", version: 1, attrs: { cite: 7 } }))).toThrow()
  })
})

describe("to-do list", () => {
  const list = (item: Record<string, unknown>) =>
    one({ id: TODO, type: "todo_list", version: 1, attrs: {}, children: [TASK] }, { [TASK]: { id: TASK, type: "todo_item", version: 1, ...item } })

  it("holds its items by id, each with a boolean checked", () => {
    for (const checked of [true, false, undefined]) {
      expect(() => validateBlockDoc(list({ attrs: { text: "Ship it", checked } }))).not.toThrow()
    }
  })

  it("refuses a checked that isn't a boolean", () => {
    for (const checked of ["true", 1, null]) expect(() => validateBlockDoc(list({ attrs: { checked } })), String(checked)).toThrow()
  })

  it("refuses children on an item", () => {
    expect(() => validateBlockDoc(list({ attrs: {}, children: [] }))).toThrow(/has no children/)
  })

  it("is a list: its item type, node and the block predicate", () => {
    expect(listItemOf("todo_list")).toEqual({ type: "todo_item", node: "taskItem" })
    expect(listItemOf("bullet_list")).toEqual({ type: "list_item", node: "listItem" })
    expect(listItemOf("callout")).toBeUndefined()
    expect(listItemNodeOf("taskList")).toBe("taskItem")
    // A task item is a block in its list only; a list item never is in a to-do list.
    expect(isBlockNode("taskItem", "taskList")).toBe(true)
    expect(isBlockNode("taskItem", "bulletList")).toBe(false)
    expect(isBlockNode("listItem", "taskList")).toBe(false)
    expect(isBlockNode("listItem", "bulletList")).toBe(true)
    // The paragraphs inside a callout, pull quote or task item are their pm, not blocks.
    expect(isBlockNode("paragraph", "callout")).toBe(false)
    expect(isBlockNode("paragraph", "taskItem")).toBe(false)
  })
})

describe("nesting", () => {
  it("all three are flow, so a group may hold them; a to-do item isn't", () => {
    for (const type of ["callout", "pull_quote", "todo_list"]) {
      expect(isFlowType(type), type).toBe(true)
      expect(acceptsChild("group", type), type).toBe(true)
    }
    expect(isFlowType("todo_item")).toBe(false)
    expect(acceptsChild("group", "todo_item")).toBe(false)
  })
})
