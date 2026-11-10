import { describe, it, expect } from "vitest"
import {
  acceptsChild,
  blocksInReadingOrder,
  CONTAINER_PART_NODE_NAMES,
  CONTAINERS,
  containerContent,
  type ContainerRule,
  dedupeBlockRefs,
  isBlockNode,
  isFlowType,
  nestingIssues,
  synthesizedChildId,
  TEXT_PART_NODE_NAMES,
  topLevelContent,
  validateBlockDoc,
} from "."
import { themeBlockContentProblem } from "../theme-blocks/installed"
import nestingVectors from "./nestingVectors.json"

// How blocks nest (#414, design 2.2–2.3). The vectors are shared with the API
// (api/post_blocks_nesting_test.go), so the collab store and the API never disagree on
// which docs are valid.

interface Vector {
  name: string
  valid: boolean
  doc: any
  deduped?: { blocks_order: string[]; children: Record<string, string[]> }
}

const vectors = nestingVectors.vectors as Vector[]

describe("nestingVectors.json (shared with the API)", () => {
  it("has valid and invalid cases", () => {
    expect(vectors.filter((v) => v.valid).length).toBeGreaterThan(3)
    expect(vectors.filter((v) => !v.valid).length).toBeGreaterThan(10)
  })

  for (const vector of vectors) {
    it(`${vector.valid ? "accepts" : "refuses"}: ${vector.name}`, () => {
      const input = structuredClone(vector.doc)
      const doc = dedupeBlockRefs(vector.doc)
      // The input is never mutated.
      expect(vector.doc).toEqual(input)
      if (vector.valid) {
        expect(nestingIssues(doc)).toEqual([])
        expect(() => validateBlockDoc(doc)).not.toThrow()
      } else {
        expect(() => validateBlockDoc(doc)).toThrow()
      }
      if (vector.deduped) {
        expect(doc.blocks_order).toEqual(vector.deduped.blocks_order)
        for (const [id, children] of Object.entries(vector.deduped.children)) expect(doc.blocks[id].children).toEqual(children)
      }
    })
  }

  it("a structural problem is refused without dedupe too (and a repeat is only fine after it)", () => {
    const repeat = vectors.find((v) => v.name.startsWith("a repeat within one group"))!
    expect(nestingIssues(repeat.doc).length).toBeGreaterThan(0)
    expect(nestingIssues(dedupeBlockRefs(repeat.doc))).toEqual([])
  })
})

describe("dedupeBlockRefs", () => {
  it("returns the doc itself when nothing repeats", () => {
    const doc = vectors[0].doc
    expect(dedupeBlockRefs(doc)).toBe(doc)
  })

  it("leaves a block under two parents alone (that is an error, not a repeat)", () => {
    const doc = vectors.find((v) => v.name === "a block under two groups")!.doc
    expect(dedupeBlockRefs(doc)).toBe(doc)
  })

  it("ignores shapes that aren't a block doc", () => {
    expect(dedupeBlockRefs(null)).toBe(null)
    expect(dedupeBlockRefs({})).toEqual({})
  })
})

describe("the nesting table", () => {
  it("is acyclic: no container can hold itself, directly or through another", () => {
    // Containers only: a row may name a flow type too (a gallery's images, #424).
    const holds = (type: string): string[] => (CONTAINERS as any)[type].accepts.filter((t: string) => t in CONTAINERS)
    const visit = (type: string, path: string[]) => {
      expect(path).not.toContain(type)
      for (const child of holds(type)) visit(child, [...path, type])
    }
    for (const type of Object.keys(CONTAINERS)) visit(type, [])
  })

  it("no container is flow (so `block` in a content expression never admits one)", () => {
    for (const type of Object.keys(CONTAINERS)) expect(isFlowType(type)).toBe(false)
  })

  it("synthesized ids are deterministic and at least 10 characters past the container id", () => {
    for (const [type, row] of Object.entries(CONTAINERS)) {
      const rule: ContainerRule = row
      // A container that may be empty (a gallery, #424) has nothing to synthesize.
      if (!rule.synthesize) {
        expect(rule.min, type).toBe(0)
        continue
      }
      expect(rule.synthesize.role.length, type).toBeGreaterThanOrEqual(9)
      expect(synthesizedChildId("g", rule.synthesize.role).length).toBeGreaterThanOrEqual(11)
      expect(synthesizedChildId("blk-0001-x", rule.synthesize.role)).toBe(synthesizedChildId("blk-0001-x", rule.synthesize.role))
    }
  })

  it("derives the content expressions", () => {
    expect(containerContent("group")).toBe("(block | tableBlock | video | audio | file | embed | html | buttons | spacer | details | columns)+")
    // #421: its part first, then flow.
    expect(containerContent("details")).toBe("detailsSummary (block | tableBlock | video | audio | file | embed | html | buttons | spacer)+")
    // #424: image blocks, none is fine, then its caption.
    expect(containerContent("gallery")).toBe("image* galleryCaption")
    // #426: the 2–4 limit is the table's, not the schema's (`countNotInSchema`), each column holding flow and details.
    expect(containerContent("columns")).toBe("column+")
    expect(containerContent("column")).toBe("(block | tableBlock | video | audio | file | embed | html | buttons | spacer | details)+")
    expect(topLevelContent()).toBe("(block | tableBlock | video | audio | file | embed | html | buttons | spacer | group | details | gallery | columns)+")
  })

  it("details (#421): holds flow, sits at the top or in a group, its summary a part (never a block)", () => {
    expect(acceptsChild("details", "paragraph")).toBe(true)
    expect(acceptsChild("details", "table")).toBe(true)
    expect(acceptsChild("details", "video")).toBe(true)
    expect(acceptsChild("details", "file")).toBe(true)
    expect(acceptsChild("details", "theme:example/alert")).toBe(true)
    expect(acceptsChild("details", "details")).toBe(false)
    expect(acceptsChild("details", "group")).toBe(false)
    expect(acceptsChild("details", "list_item")).toBe(false)
    expect(acceptsChild("group", "details")).toBe(true)
    expect(isBlockNode("paragraph", "details")).toBe(true)
    expect(isBlockNode("detailsSummary", "details")).toBe(false)
    expect(CONTAINER_PART_NODE_NAMES.has("detailsSummary")).toBe(true)
    expect(TEXT_PART_NODE_NAMES).toEqual(new Set(["imageCaption", "tableCaption", "button", "detailsSummary", "galleryCaption"]))
  })

  it("a group holds flow: core flow types, theme blocks and unknown types, never a container or a list item", () => {
    for (const type of ["paragraph", "heading", "blockquote", "code_block", "divider", "image", "bullet_list", "ordered_list"]) {
      expect(acceptsChild("group", type), type).toBe(true)
    }
    expect(acceptsChild("group", "theme:example/alert")).toBe(true)
    expect(acceptsChild("group", "alert")).toBe(true)
    expect(acceptsChild("group", "group")).toBe(false)
    expect(acceptsChild("group", "list_item")).toBe(false)
    expect(acceptsChild("paragraph", "paragraph")).toBe(false)
    expect(acceptsChild("group", "")).toBe(false)
    expect(acceptsChild("group", undefined)).toBe(false)
  })
})

describe("isBlockNode (the shared block predicate, design 2.6)", () => {
  it("top-level nodes, list items of a list, and a container's children are blocks", () => {
    expect(isBlockNode("paragraph", null)).toBe(true)
    expect(isBlockNode("group", "doc")).toBe(true)
    expect(isBlockNode("listItem", "bulletList")).toBe(true)
    expect(isBlockNode("listItem", "orderedList")).toBe(true)
    expect(isBlockNode("paragraph", "group")).toBe(true)
    expect(isBlockNode("bulletList", "group")).toBe(true)
    expect(isBlockNode("theme:example/alert", "group")).toBe(true)
  })

  it("nodes inside a block's own content are not", () => {
    expect(isBlockNode("paragraph", "listItem")).toBe(false)
    expect(isBlockNode("paragraph", "blockquote")).toBe(false)
    expect(isBlockNode("imageCaption", "image")).toBe(false)
    expect(isBlockNode("bulletList", "listItem")).toBe(false)
    expect(isBlockNode("listItem", "group")).toBe(false)
  })
})

describe("blocksInReadingOrder", () => {
  it("visits blocks_order and each container's children depth first, each once, not list items", () => {
    const doc = vectors.find((v) => v.name === "a group holding flow blocks")!.doc
    expect(blocksInReadingOrder(doc)).toEqual(["group-0001", "head-00001", "para-00001", "image-0001", "list-00001"])
    expect(blocksInReadingOrder({ blocks_order: ["a", "a", "missing"], blocks: { a: { type: "paragraph" } } })).toEqual(["a"])
    expect(blocksInReadingOrder(null)).toEqual([])
  })
})

describe("theme block content (design 2.11)", () => {
  it("allows text and text blocks only", () => {
    for (const content of ["", "inline*", "text*", "paragraph+", "(paragraph | heading)+", "codeBlock"]) {
      expect(themeBlockContentProblem(content), content).toBeNull()
    }
    for (const content of ["block+", "image", "group+", "(paragraph | bulletList)+", "blockquote", "listItem+"]) {
      expect(themeBlockContentProblem(content), content).toMatch(/may only hold/)
    }
    expect(themeBlockContentProblem(undefined)).toMatch(/content expression/)
  })
})
