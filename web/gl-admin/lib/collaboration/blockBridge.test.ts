import { describe, it, expect } from "vitest"
import { getSchema, Node } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import TextAlign from "@tiptap/extension-text-align"
import { Schema } from "prosemirror-model"
import { ImageWithMediaId } from "@gl-admin/components/editor/extensions/ImageWithMediaId"
import { BlockIdExtension } from "@gl-admin/components/editor/extensions/BlockIdExtension"
import { pmToBlockDoc, blockDocToPM } from "./blockBridge"
import type { BlockDocV1 } from "../blocks-spec"

// A minimal test-only custom node, standing in for a theme block (e.g. "alert").
// It defines `data-block-id` because the bridge injects that attr into every
// node it reconstructs — a node type that doesn't declare it would throw in
// schema.nodeFromJSON. This mirrors what a well-behaved theme extension must do.
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "inline*",
  addAttributes() {
    return { "data-block-id": { default: null }, variant: { default: "info" } }
  },
  parseHTML() {
    return [{ tag: "div[data-type=callout]" }]
  },
  renderHTML() {
    return ["div", { "data-type": "callout" }, 0]
  },
})

// Build a real ProseMirror schema headlessly — same node set + global attrs the
// editor uses (StarterKit nodes, text-align, image-with-mediaId, the block-id
// global attribute), plus our test custom node.
const schema: Schema = getSchema([
  StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
  TextAlign.configure({ types: ["heading", "paragraph"] }),
  ImageWithMediaId,
  BlockIdExtension,
  Callout,
])

let counter = 0
const id = () => `blk-${(counter++).toString().padStart(4, "0")}-0000000000`

/** Block → PM → Block, returning the round-tripped doc for assertions. */
function roundTrip(doc: BlockDocV1): BlockDocV1 {
  const pm = blockDocToPM(doc, schema)
  return pmToBlockDoc(pm)
}

describe("blockBridge round-trip — known block types", () => {
  it("paragraph preserves id, type, and text", () => {
    const a = id()
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [a],
      blocks: { [a]: { id: a, type: "paragraph", version: 1, attrs: { text: "hello world" } } },
    }
    const out = roundTrip(doc)
    expect(out.blocks_order).toEqual([a])
    expect(out.blocks[a].type).toBe("paragraph")
    expect(out.blocks[a].attrs.text).toBe("hello world")
  })

  it("heading preserves level and text", () => {
    const a = id()
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [a],
      blocks: { [a]: { id: a, type: "heading", version: 1, attrs: { level: 2, text: "Title" } } },
    }
    const out = roundTrip(doc)
    expect(out.blocks[a].type).toBe("heading")
    expect((out.blocks[a].attrs as any).pm.attrs.level).toBe(2)
    expect(out.blocks[a].attrs.text).toBe("Title")
  })

  it("blockquote preserves text", () => {
    const a = id()
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [a],
      blocks: { [a]: { id: a, type: "blockquote", version: 1, attrs: { text: "quoted" } } },
    }
    const out = roundTrip(doc)
    expect(out.blocks[a].type).toBe("blockquote")
    expect(out.blocks[a].attrs.text).toBe("quoted")
  })

  it("code_block preserves code and language", () => {
    const a = id()
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [a],
      blocks: { [a]: { id: a, type: "code_block", version: 1, attrs: { code: "const x = 1", language: "javascript" } } },
    }
    const out = roundTrip(doc)
    expect(out.blocks[a].type).toBe("code_block")
    expect((out.blocks[a].attrs as any).code).toBe("const x = 1")
    expect((out.blocks[a].attrs as any).language).toBe("javascript")
  })

  it("divider round-trips as type divider", () => {
    const a = id()
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [a],
      blocks: { [a]: { id: a, type: "divider", version: 1, attrs: {} } },
    }
    const out = roundTrip(doc)
    expect(out.blocks[a].type).toBe("divider")
  })

  it("image preserves src, alt, title, mediaId", () => {
    const a = id()
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [a],
      blocks: {
        [a]: { id: a, type: "image", version: 1, attrs: { src: "/m/x.png", alt: "x", title: "t", mediaId: 42 } },
      },
    }
    const out = roundTrip(doc)
    const attrs = out.blocks[a].attrs as any
    expect(out.blocks[a].type).toBe("image")
    expect(attrs.src).toBe("/m/x.png")
    expect(attrs.alt).toBe("x")
    expect(attrs.title).toBe("t")
    expect(attrs.mediaId).toBe(42)
  })
})

describe("blockBridge round-trip — lists with children", () => {
  it("bullet_list preserves its list_item children ids and text", () => {
    const list = id()
    const li1 = id()
    const li2 = id()
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [list],
      blocks: {
        [list]: { id: list, type: "bullet_list", version: 1, attrs: {}, children: [li1, li2] },
        [li1]: { id: li1, type: "list_item", version: 1, attrs: { text: "one" } },
        [li2]: { id: li2, type: "list_item", version: 1, attrs: { text: "two" } },
      },
    }
    const out = roundTrip(doc)
    expect(out.blocks_order).toEqual([list])
    expect(out.blocks[list].type).toBe("bullet_list")
    expect(out.blocks[list].children).toEqual([li1, li2])
    expect(out.blocks[li1].attrs.text).toBe("one")
    expect(out.blocks[li2].attrs.text).toBe("two")
  })
})

describe("blockBridge round-trip — order and multiple blocks", () => {
  it("preserves block order across mixed types", () => {
    const a = id()
    const b = id()
    const c = id()
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [a, b, c],
      blocks: {
        [a]: { id: a, type: "heading", version: 1, attrs: { level: 1, text: "H" } },
        [b]: { id: b, type: "paragraph", version: 1, attrs: { text: "P" } },
        [c]: { id: c, type: "divider", version: 1, attrs: {} },
      },
    }
    const out = roundTrip(doc)
    expect(out.blocks_order).toEqual([a, b, c])
  })
})

describe("blockBridge — custom/theme node", () => {
  it("preserves an unknown node type via its stored pm blob", () => {
    const a = id()
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [a],
      blocks: {
        [a]: {
          id: a,
          type: "callout",
          version: 1,
          attrs: {
            variant: "warn",
            pm: {
              type: "callout",
              attrs: { variant: "warn", "data-block-id": a },
              content: [{ type: "text", text: "heads up" }],
            },
          },
        },
      },
    }
    const out = roundTrip(doc)
    expect(out.blocks[a].type).toBe("callout")
    expect(out.blocks[a].attrs.text).toBe("heads up")
  })
})

describe("blockBridge — edge cases", () => {
  it("round-trips an empty document", () => {
    const out = roundTrip({ doc_version: 1, blocks_order: [], blocks: {} })
    expect(out.blocks_order).toEqual([])
    expect(out.blocks).toEqual({})
  })

  it("regenerates duplicate block ids so each block is unique", () => {
    const dup = id()
    // Hand-build a PM doc with two paragraphs sharing the same data-block-id.
    const pm = schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { "data-block-id": dup }, content: [{ type: "text", text: "first" }] },
        { type: "paragraph", attrs: { "data-block-id": dup }, content: [{ type: "text", text: "second" }] },
      ],
    })
    const out = pmToBlockDoc(pm)
    expect(out.blocks_order).toHaveLength(2)
    // Both blocks present under distinct ids (the duplicate was regenerated).
    expect(new Set(out.blocks_order).size).toBe(2)
    const texts = out.blocks_order.map((bid) => out.blocks[bid].attrs.text)
    expect(texts).toEqual(["first", "second"])
  })

  it("documents the empty-code-block limitation (cannot build an empty text node)", () => {
    // ProseMirror disallows empty text nodes, so a code_block with empty code
    // cannot be reconstructed by blockDocToPM. Pinning this so it's a conscious
    // constraint rather than a surprise crash in production.
    const a = id()
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [a],
      blocks: { [a]: { id: a, type: "code_block", version: 1, attrs: { code: "" } } },
    }
    expect(() => blockDocToPM(doc, schema)).toThrow()
  })
})
