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
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
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

// Build a single-node PM doc headlessly for the PM→Block direction.
function pmDocOf(node: any) {
  return schema.nodeFromJSON({ type: "doc", content: [node] })
}

describe("pmToBlockDoc — per type (PM → Block)", () => {
  it("paragraph: captures text and the pm blob", () => {
    const a = id()
    const out = pmToBlockDoc(
      pmDocOf({ type: "paragraph", attrs: { "data-block-id": a }, content: [{ type: "text", text: "hello" }] })
    )
    const block = out.blocks[out.blocks_order[0]]
    expect(block.type).toBe("paragraph")
    expect(block.attrs.text).toBe("hello")
    expect((block.attrs as any).pm.type).toBe("paragraph")
  })

  it("heading: preserves level (incl. level 5) and text", () => {
    const a = id()
    const out = pmToBlockDoc(
      pmDocOf({ type: "heading", attrs: { level: 5, "data-block-id": a }, content: [{ type: "text", text: "Deep" }] })
    )
    const block = out.blocks[out.blocks_order[0]]
    expect(block.type).toBe("heading")
    expect((block.attrs as any).level).toBe(5)
    expect((block.attrs as any).pm.attrs.level).toBe(5)
    expect(block.attrs.text).toBe("Deep")
  })

  it("blockquote: flattens nested text into attrs.text", () => {
    const a = id()
    const out = pmToBlockDoc(
      pmDocOf({
        type: "blockquote",
        attrs: { "data-block-id": a },
        content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }],
      })
    )
    const block = out.blocks[out.blocks_order[0]]
    expect(block.type).toBe("blockquote")
    expect(block.attrs.text).toBe("quoted")
  })

  it("code_block: maps language and textContent to code", () => {
    const a = id()
    const out = pmToBlockDoc(
      pmDocOf({
        type: "codeBlock",
        attrs: { language: "go", "data-block-id": a },
        content: [{ type: "text", text: "x := 1" }],
      })
    )
    const block = out.blocks[out.blocks_order[0]]
    expect(block.type).toBe("code_block")
    expect((block.attrs as any).code).toBe("x := 1")
    expect((block.attrs as any).language).toBe("go")
  })

  it("horizontalRule: becomes a divider block", () => {
    const a = id()
    const out = pmToBlockDoc(pmDocOf({ type: "horizontalRule", attrs: { "data-block-id": a } }))
    expect(out.blocks[out.blocks_order[0]].type).toBe("divider")
  })

  it("image: lifts src/alt/title/mediaId into attrs", () => {
    const a = id()
    const out = pmToBlockDoc(
      pmDocOf({
        type: "image",
        attrs: { src: "/m/a.png", alt: "a", title: "t", mediaId: 7, "data-block-id": a },
      })
    )
    const attrs = out.blocks[out.blocks_order[0]].attrs as any
    expect(attrs.src).toBe("/m/a.png")
    expect(attrs.alt).toBe("a")
    expect(attrs.title).toBe("t")
    expect(attrs.mediaId).toBe(7)
  })

  it("bullet_list: emits a list block plus list_item children entries", () => {
    const list = id()
    const out = pmToBlockDoc(
      pmDocOf({
        type: "bulletList",
        attrs: { "data-block-id": list },
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
        ],
      })
    )
    const listBlock = out.blocks[out.blocks_order[0]]
    expect(listBlock.type).toBe("bullet_list")
    expect(listBlock.children).toHaveLength(2)
    const childTexts = listBlock.children!.map((cid) => out.blocks[cid].attrs.text)
    expect(childTexts).toEqual(["one", "two"])
    expect(out.blocks[listBlock.children![0]].type).toBe("list_item")
  })

  it("custom node: preserves the pm blob and custom attrs (drops data-block-id from attrs)", () => {
    const a = id()
    const out = pmToBlockDoc(
      pmDocOf({
        type: "callout",
        attrs: { variant: "warn", "data-block-id": a },
        content: [{ type: "text", text: "heads up" }],
      })
    )
    const block = out.blocks[out.blocks_order[0]]
    expect(block.type).toBe("callout")
    expect((block.attrs as any).variant).toBe("warn")
    expect((block.attrs as any).pm.type).toBe("callout")
    // data-block-id is tracked on the block, not duplicated into attrs
    expect((block.attrs as any)["data-block-id"]).toBeUndefined()
  })
})

describe("blockDocToPM — per type (Block → PM)", () => {
  const docOf = (block: any) => ({ doc_version: 1 as const, blocks_order: [block.id], blocks: { [block.id]: block } })

  it("paragraph (no pm): rebuilds from text and injects data-block-id", () => {
    const a = id()
    const node = blockDocToPM(docOf({ id: a, type: "paragraph", version: 1, attrs: { text: "hi" } }), schema).child(0)
    expect(node.type.name).toBe("paragraph")
    expect(node.textContent).toBe("hi")
    expect(node.attrs["data-block-id"]).toBe(a)
  })

  it("heading (no pm): rebuilds at level 4 and injects data-block-id", () => {
    const a = id()
    const node = blockDocToPM(docOf({ id: a, type: "heading", version: 1, attrs: { level: 4, text: "H4" } }), schema).child(0)
    expect(node.type.name).toBe("heading")
    expect(node.attrs.level).toBe(4)
    expect(node.textContent).toBe("H4")
    expect(node.attrs["data-block-id"]).toBe(a)
  })

  it("code_block: rebuilds codeBlock with language and code text", () => {
    const a = id()
    const node = blockDocToPM(docOf({ id: a, type: "code_block", version: 1, attrs: { code: "let x", language: "rust" } }), schema).child(0)
    expect(node.type.name).toBe("codeBlock")
    expect(node.attrs.language).toBe("rust")
    expect(node.textContent).toBe("let x")
  })

  it("divider: rebuilds a horizontalRule", () => {
    const a = id()
    const node = blockDocToPM(docOf({ id: a, type: "divider", version: 1, attrs: {} }), schema).child(0)
    expect(node.type.name).toBe("horizontalRule")
  })

  it("image: rebuilds with src/alt/title/mediaId", () => {
    const a = id()
    const node = blockDocToPM(
      docOf({ id: a, type: "image", version: 1, attrs: { src: "/m/b.png", alt: "b", title: "tt", mediaId: 9 } }),
      schema
    ).child(0)
    expect(node.type.name).toBe("image")
    expect(node.attrs.src).toBe("/m/b.png")
    expect(node.attrs.mediaId).toBe(9)
  })

  it("bullet_list: rebuilds a bulletList with one listItem per child", () => {
    const list = id()
    const li1 = id()
    const li2 = id()
    const node = blockDocToPM(
      {
        doc_version: 1,
        blocks_order: [list],
        blocks: {
          [list]: { id: list, type: "bullet_list", version: 1, attrs: {}, children: [li1, li2] },
          [li1]: { id: li1, type: "list_item", version: 1, attrs: { text: "a" } },
          [li2]: { id: li2, type: "list_item", version: 1, attrs: { text: "b" } },
        },
      },
      schema
    ).child(0)
    expect(node.type.name).toBe("bulletList")
    expect(node.childCount).toBe(2)
    expect(node.child(0).type.name).toBe("listItem")
  })
})

describe("blockBridge — full round-trip (one of each type)", () => {
  // NOTE: a value-level toEqual() is wrong here — the bridge adds attrs.pm on the
  // way out, injects data-block-id, and reconstructs attrs.text — so the output is
  // never byte-equal to a hand-written input. We compare STRUCTURE instead:
  // order, type, text, and children links.
  const summarize = (d: BlockDocV1) =>
    d.blocks_order.map((bid) => ({
      type: d.blocks[bid].type,
      text: d.blocks[bid].attrs.text ?? undefined,
      children: d.blocks[bid].children,
    }))

  it("preserves order, types, text, and list children across every known type", () => {
    const h = id(), p = id(), q = id(), cb = id(), dv = id(), img = id(), list = id(), li = id()
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [h, p, q, cb, dv, img, list],
      blocks: {
        [h]: { id: h, type: "heading", version: 1, attrs: { level: 2, text: "Title" } },
        [p]: { id: p, type: "paragraph", version: 1, attrs: { text: "body" } },
        [q]: { id: q, type: "blockquote", version: 1, attrs: { text: "quote" } },
        [cb]: { id: cb, type: "code_block", version: 1, attrs: { code: "go()", language: "go" } },
        [dv]: { id: dv, type: "divider", version: 1, attrs: {} },
        [img]: { id: img, type: "image", version: 1, attrs: { src: "/m/c.png", alt: "c" } },
        [list]: { id: list, type: "bullet_list", version: 1, attrs: {}, children: [li] },
        [li]: { id: li, type: "list_item", version: 1, attrs: { text: "item" } },
      },
    }
    const out = roundTrip(doc)

    // Top-level order and ids are preserved (valid ids are kept, not regenerated).
    expect(out.blocks_order).toEqual([h, p, q, cb, dv, img, list])
    expect(summarize(out)).toEqual([
      { type: "heading", text: "Title", children: undefined },
      { type: "paragraph", text: "body", children: undefined },
      { type: "blockquote", text: "quote", children: undefined },
      { type: "code_block", text: undefined, children: undefined }, // code lives in attrs.code, not text
      { type: "divider", text: undefined, children: undefined },
      { type: "image", text: undefined, children: undefined },
      { type: "bullet_list", text: undefined, children: [li] },
    ])
    expect(out.blocks[li].attrs.text).toBe("item")
    expect((out.blocks[cb].attrs as any).code).toBe("go()")
  })
})

describe("blockBridge — marks survive round-trip", () => {
  it("keeps bold/italic marks in the paragraph pm blob", () => {
    const a = id()
    const pmIn = pmDocOf({
      type: "paragraph",
      attrs: { "data-block-id": a },
      content: [
        { type: "text", marks: [{ type: "bold" }], text: "bold" },
        { type: "text", text: " and " },
        { type: "text", marks: [{ type: "italic" }], text: "italic" },
      ],
    })
    // PM → Block → PM → Block; the marks ride along inside attrs.pm.
    const once = pmToBlockDoc(pmIn)
    const twice = roundTrip(once)
    const pm = (twice.blocks[twice.blocks_order[0]].attrs as any).pm
    const marks = pm.content.flatMap((n: any) => (n.marks || []).map((m: any) => m.type))
    expect(marks).toContain("bold")
    expect(marks).toContain("italic")
  })
})

describe("blockBridge — additional edge cases", () => {
  it("heading levels 4-6 round-trip (regression guard for the widened heading range)", () => {
    for (const level of [4, 5, 6] as const) {
      const a = id()
      const out = roundTrip({
        doc_version: 1,
        blocks_order: [a],
        blocks: { [a]: { id: a, type: "heading", version: 1, attrs: { level, text: `H${level}` } } },
      })
      expect((out.blocks[a].attrs as any).pm.attrs.level).toBe(level)
    }
  })

  it("nested list round-trips via the parent list_item pm blob (children are NOT flattened)", () => {
    const list = id()
    const pmIn = pmDocOf({
      type: "bulletList",
      attrs: { "data-block-id": list },
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "parent" }] },
            {
              type: "bulletList",
              content: [
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "child" }] }] },
              ],
            },
          ],
        },
      ],
    })
    const out = pmToBlockDoc(pmIn)
    const listBlock = out.blocks[out.blocks_order[0]]
    expect(listBlock.type).toBe("bullet_list")
    expect(listBlock.children).toHaveLength(1)
    // The nested list lives inside the list_item's pm blob, not as its own block entry.
    const itemPm = (out.blocks[listBlock.children![0]].attrs as any).pm
    const nested = itemPm.content.find((n: any) => n.type === "bulletList")
    expect(nested).toBeTruthy()
    // Round-trips back to the same structure.
    const back = roundTrip(out)
    expect(back.blocks[back.blocks_order[0]].type).toBe("bullet_list")
  })

  it("image without src round-trips (characterizes the nullish src)", () => {
    const a = id()
    const out = roundTrip({
      doc_version: 1,
      blocks_order: [a],
      blocks: { [a]: { id: a, type: "image", version: 1, attrs: { alt: "no-src" } } },
    })
    expect(out.blocks[a].type).toBe("image")
    // src absent on input stays absent (undefined) on output — no fabricated value.
    expect((out.blocks[a].attrs as any).src).toBeUndefined()
    expect((out.blocks[a].attrs as any).alt).toBe("no-src")
  })

  it("characterizes an empty bullet_list (no children) on the way to PM", () => {
    const a = id()
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [a],
      blocks: { [a]: { id: a, type: "bullet_list", version: 1, attrs: {}, children: [] } },
    }
    // blockToPMNode emits a bulletList with content: [], which violates the
    // schema's `listItem+` content rule. prosemirror's nodeFromJSON constructs
    // it without validating content, so this does NOT throw here — but the
    // resulting node is schema-invalid and would be rejected by editor checks.
    // Tracked as a follow-up (graceful empty-list handling). Pinning current behavior:
    const pm = blockDocToPM(doc, schema)
    const node = pm.child(0)
    expect(node.type.name).toBe("bulletList")
    expect(node.childCount).toBe(0)
    // And it round-trips back to an empty bullet_list with no children set.
    const back = pmToBlockDoc(pm)
    expect(back.blocks[back.blocks_order[0]].type).toBe("bullet_list")
    expect(back.blocks[back.blocks_order[0]].children).toBeUndefined()
  })

  it("forward-compat: an unknown attr on a known node survives via the pm blob", () => {
    const a = id()
    // textAlign is a real attr (TextAlign extension) standing in for any attr the
    // bridge doesn't special-case — it must survive purely through attrs.pm.
    const pmIn = pmDocOf({
      type: "paragraph",
      attrs: { "data-block-id": a, textAlign: "center" },
      content: [{ type: "text", text: "centered" }],
    })
    const out = roundTrip(pmToBlockDoc(pmIn))
    const pm = (out.blocks[out.blocks_order[0]].attrs as any).pm
    expect(pm.attrs.textAlign).toBe("center")
  })
})
