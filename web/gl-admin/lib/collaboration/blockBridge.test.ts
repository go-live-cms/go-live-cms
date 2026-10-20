import { describe, it, expect } from "vitest"
import { getSchema, Node } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import TextAlign from "@tiptap/extension-text-align"
import { Schema } from "prosemirror-model"
import { ImageWithMediaId } from "@gl-admin/components/editor/extensions/ImageWithMediaId"
import { BlockIdExtension } from "@gl-admin/components/editor/extensions/BlockIdExtension"
import {
  pmToBlockDoc,
  blockDocToPM,
  blockDocToPMWithReport,
  restoreDroppedBlocks,
  synthesizedItemId,
} from "./blockBridge"
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

  it("drops a schema-invalid top-level block but keeps the rest of the doc", () => {
    const bad = id()
    const good = id()
    // A blockquote whose pm blob has no content violates `block+`; nodeFromJSON
    // builds it anyway, so blockDocToPM must catch it with check().
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [bad, good],
      blocks: {
        [bad]: { id: bad, type: "blockquote", version: 1, attrs: { pm: { type: "blockquote", content: [] } } },
        [good]: { id: good, type: "paragraph", version: 1, attrs: { text: "kept" } },
      },
    }
    const { node: pm, dropped } = blockDocToPMWithReport(doc, schema)
    expect(() => pm.check()).not.toThrow()
    expect(pm.childCount).toBe(1)
    expect(pm.child(0).attrs["data-block-id"]).toBe(good)
    expect(pm.textContent).toBe("kept")
    expect(dropped).toEqual([{ id: bad, parentId: null, afterId: null }])
  })

  it("an empty code_block is dropped on its own instead of failing the whole doc", () => {
    // ProseMirror disallows empty text nodes, so nodeFromJSON throws for a code_block
    // with empty code. That throw is now per block: the rest of the doc still loads.
    const a = id()
    const b = id()
    const doc: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [b, a],
      blocks: {
        [b]: { id: b, type: "paragraph", version: 1, attrs: { text: "before" } },
        [a]: { id: a, type: "code_block", version: 1, attrs: { code: "" } },
      },
    }
    const { node, dropped } = blockDocToPMWithReport(doc, schema)
    expect(node.childCount).toBe(1)
    expect(node.textContent).toBe("before")
    expect(dropped).toEqual([{ id: a, parentId: null, afterId: b }])
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
    // Type-specific attrs the summary above doesn't cover.
    expect((out.blocks[h].attrs as any).level).toBe(2)
    expect((out.blocks[cb].attrs as any).code).toBe("go()")
    expect((out.blocks[cb].attrs as any).language).toBe("go")
    expect((out.blocks[img].attrs as any).src).toBe("/m/c.png")
    expect((out.blocks[img].attrs as any).alt).toBe("c")
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
      expect((out.blocks[a].attrs as any).level).toBe(level)
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
    const backList = back.blocks[back.blocks_order[0]]
    expect(backList.type).toBe("bullet_list")
    expect(backList.children).toHaveLength(1)
    const backItemPm = (back.blocks[backList.children![0]].attrs as any).pm
    const backNested = backItemPm.content.find((n: any) => n.type === "bulletList")
    expect(backNested).toBeTruthy()
    expect(back.blocks[backList.children![0]].attrs.text).toBe("parentchild")
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

  // #213: the schema requires `listItem+`, but schema.nodeFromJSON doesn't validate
  // content expressions, so an empty list used to build a schema-invalid node silently.
  // node.check() enforces the content rule, so it's the proof of validity here.
  describe("empty lists (#213)", () => {
    const cases = [
      ["bullet_list", "bulletList", { children: [] }],
      ["bullet_list", "bulletList", {}], // children absent
      ["ordered_list", "orderedList", { children: [] }],
      ["ordered_list", "orderedList", {}],
    ] as const

    for (const [blockType, pmType, extra] of cases) {
      it(`${blockType} with ${"children" in extra ? "children: []" : "no children"} gets one empty listItem`, () => {
        const a = id()
        const doc: BlockDocV1 = {
          doc_version: 1,
          blocks_order: [a],
          blocks: { [a]: { id: a, type: blockType, version: 1, attrs: {}, ...extra } as any },
        }
        const pm = blockDocToPM(doc, schema)
        expect(() => pm.check()).not.toThrow()
        const list = pm.child(0)
        expect(list.type.name).toBe(pmType)
        expect(list.attrs["data-block-id"]).toBe(a)
        expect(list.childCount).toBe(1)
        const item = list.child(0)
        expect(item.type.name).toBe("listItem")
        expect(item.attrs["data-block-id"]).toBe(synthesizedItemId(a))
        expect(item.childCount).toBe(1)
        expect(item.child(0).type.name).toBe("paragraph")
        expect(item.textContent).toBe("")
      })
    }

    it("a list whose children are all dangling ids also gets one empty listItem", () => {
      const a = id()
      const doc: BlockDocV1 = {
        doc_version: 1,
        blocks_order: [a],
        blocks: { [a]: { id: a, type: "bullet_list", version: 1, attrs: {}, children: ["missing-0000000000"] } },
      }
      const pm = blockDocToPM(doc, schema)
      expect(() => pm.check()).not.toThrow()
      expect(pm.child(0).childCount).toBe(1)
    })

    it("the healed list round-trips as a list with one empty list_item child", () => {
      const a = id()
      const out = roundTrip({
        doc_version: 1,
        blocks_order: [a],
        blocks: { [a]: { id: a, type: "bullet_list", version: 1, attrs: {}, children: [] } },
      })
      expect(out.blocks_order).toEqual([a])
      const list = out.blocks[a]
      expect(list.type).toBe("bullet_list")
      expect(list.children).toHaveLength(1)
      const item = out.blocks[list.children![0]]
      expect(item.type).toBe("list_item")
      expect(item.id).toBe(synthesizedItemId(a))
      expect(item.attrs.text).toBeUndefined()
    })

    it("the synthesized item's id is stable across loads and saves (no Yjs churn, rule 2)", () => {
      const a = id()
      const doc: BlockDocV1 = {
        doc_version: 1,
        blocks_order: [a],
        blocks: { [a]: { id: a, type: "ordered_list", version: 1, attrs: {}, children: [] } },
      }
      const pm = blockDocToPM(doc, schema)
      // Two saves of the same editor doc, and a fresh load, must agree on the item id.
      const save1 = pmToBlockDoc(pm)
      const save2 = pmToBlockDoc(pm)
      const reload = pmToBlockDoc(blockDocToPM(doc, schema))
      expect(save2.blocks[a].children).toEqual(save1.blocks[a].children)
      expect(reload.blocks[a].children).toEqual(save1.blocks[a].children)
      expect(save2).toEqual(save1)
    })

    it("the synthesized item id passes pmToBlockDoc's length check even for a short list id", () => {
      const a = "L1" // shorter than pmToBlockDoc's 10-char minimum
      expect(synthesizedItemId(a).length).toBeGreaterThanOrEqual(10)
      const doc: BlockDocV1 = {
        doc_version: 1,
        blocks_order: [a],
        blocks: { [a]: { id: a, type: "bullet_list", version: 1, attrs: {}, children: [] } },
      }
      const pm = blockDocToPM(doc, schema)
      const save1 = pmToBlockDoc(pm)
      const save2 = pmToBlockDoc(pm)
      const itemId = save1.blocks[save1.blocks_order[0]].children![0]
      expect(itemId).toBe(synthesizedItemId(a))
      expect(save2.blocks[save2.blocks_order[0]].children).toEqual([itemId])
    })

    it("wraps a paragraph child in a listItem, keeping its text and id", () => {
      const list = id()
      const para = id()
      const item = id()
      const { node, dropped } = blockDocToPMWithReport(
        {
          doc_version: 1,
          blocks_order: [list],
          blocks: {
            [para]: { id: para, type: "paragraph", version: 1, attrs: { text: "Buy milk" } },
            [item]: { id: item, type: "list_item", version: 1, attrs: { text: "real" } },
            [list]: { id: list, type: "bullet_list", version: 1, attrs: {}, children: [para, item] },
          },
        },
        schema,
      )
      expect(() => node.check()).not.toThrow()
      expect(dropped).toEqual([])
      const pmList = node.child(0)
      expect(pmList.childCount).toBe(2)
      expect(pmList.child(0).type.name).toBe("listItem")
      expect(pmList.child(0).attrs["data-block-id"]).toBe(para)
      expect(pmList.child(0).textContent).toBe("Buy milk")
      expect(pmList.child(1).attrs["data-block-id"]).toBe(item)
    })

    it("drops and reports a child that can't be a list item; a list left empty gets the synthesized item", () => {
      const list = id()
      const heading = id()
      const { node, dropped } = blockDocToPMWithReport(
        {
          doc_version: 1,
          blocks_order: [list],
          blocks: {
            [heading]: { id: heading, type: "heading", version: 1, attrs: { level: 2, text: "H" } },
            [list]: { id: list, type: "bullet_list", version: 1, attrs: {}, children: [heading] },
          },
        },
        schema,
      )
      expect(() => node.check()).not.toThrow()
      expect(dropped).toEqual([{ id: heading, parentId: list, afterId: null }])
      expect(node.child(0).child(0).attrs["data-block-id"]).toBe(synthesizedItemId(list))
    })

    it("one invalid list item is dropped on its own; its valid siblings stay", () => {
      const list = id()
      const [i1, bad, i2] = [id(), id(), id()]
      const { node, dropped } = blockDocToPMWithReport(
        {
          doc_version: 1,
          blocks_order: [list],
          blocks: {
            [i1]: { id: i1, type: "list_item", version: 1, attrs: { text: "one" } },
            // listItem requires `paragraph block*`; an empty pm blob violates it.
            [bad]: { id: bad, type: "list_item", version: 1, attrs: { pm: { type: "listItem", content: [] } } },
            [i2]: { id: i2, type: "list_item", version: 1, attrs: { text: "two" } },
            [list]: { id: list, type: "ordered_list", version: 1, attrs: {}, children: [i1, bad, i2] },
          },
        },
        schema,
      )
      expect(() => node.check()).not.toThrow()
      const pmList = node.child(0)
      expect(pmList.childCount).toBe(2)
      expect(pmList.textContent).toBe("onetwo")
      expect(dropped).toEqual([{ id: bad, parentId: list, afterId: i1 }])
    })

    it("pmToBlockDoc never emits a childless list block (skips an invalid empty list node)", () => {
      const list = id()
      const para = id()
      // nodeFromJSON builds the invalid empty list without complaint — exactly the
      // input pmToBlockDoc must not persist.
      const pmIn = schema.nodeFromJSON({
        type: "doc",
        content: [
          { type: "orderedList", attrs: { "data-block-id": list }, content: [] },
          { type: "paragraph", attrs: { "data-block-id": para }, content: [{ type: "text", text: "kept" }] },
        ],
      })
      expect(() => pmIn.check()).toThrow()
      const out = pmToBlockDoc(pmIn)
      expect(out.blocks_order).toEqual([para])
      expect(out.blocks[list]).toBeUndefined()
      expect(out.blocks[para].attrs.text).toBe("kept")
    })
  })

  describe("restoreDroppedBlocks — dropped blocks survive a save", () => {
    const badQuote = (bid: string) =>
      ({ id: bid, type: "blockquote", version: 1, attrs: { pm: { type: "blockquote", content: [] } } }) as const
    const para = (bid: string, text: string) => ({ id: bid, type: "paragraph", version: 1, attrs: { text } }) as const

    /** Load → editor → save, then merge the dropped blocks back (what performSave does). */
    function saveAfterLoad(source: BlockDocV1, edit?: (saved: BlockDocV1) => BlockDocV1) {
      const { node, dropped } = blockDocToPMWithReport(source, schema)
      let saved = pmToBlockDoc(node)
      if (edit) saved = edit(saved)
      return restoreDroppedBlocks(saved, source, dropped)
    }

    it("puts dropped top-level blocks back in their original positions, in order", () => {
      const [p1, bad1, bad2, p2] = [id(), id(), id(), id()]
      const source: BlockDocV1 = {
        doc_version: 1,
        blocks_order: [bad1, p1, bad2, p2],
        blocks: { [p1]: para(p1, "a"), [bad1]: badQuote(bad1), [bad2]: badQuote(bad2), [p2]: para(p2, "b") },
      }
      const out = saveAfterLoad(source)
      expect(out.blocks_order).toEqual([bad1, p1, bad2, p2])
      expect(out.blocks[bad1]).toEqual(source.blocks[bad1])
      expect(out.blocks[bad2]).toEqual(source.blocks[bad2])
    })

    it("appends a dropped block at the end when its preceding block was deleted", () => {
      const [p1, bad, p2] = [id(), id(), id()]
      const source: BlockDocV1 = {
        doc_version: 1,
        blocks_order: [p1, bad, p2],
        blocks: { [p1]: para(p1, "a"), [bad]: badQuote(bad), [p2]: para(p2, "b") },
      }
      const out = saveAfterLoad(source, (saved) => {
        const { [p1]: _gone, ...blocks } = saved.blocks
        return { ...saved, blocks_order: [p2], blocks }
      })
      expect(out.blocks_order).toEqual([p2, bad])
    })

    it("puts a dropped list item back into its list", () => {
      const list = id()
      const [i1, bad, i2] = [id(), id(), id()]
      const source: BlockDocV1 = {
        doc_version: 1,
        blocks_order: [list],
        blocks: {
          [i1]: { id: i1, type: "list_item", version: 1, attrs: { text: "one" } },
          [bad]: { id: bad, type: "list_item", version: 1, attrs: { pm: { type: "listItem", content: [] } } },
          [i2]: { id: i2, type: "list_item", version: 1, attrs: { text: "two" } },
          [list]: { id: list, type: "ordered_list", version: 1, attrs: {}, children: [i1, bad, i2] },
        },
      }
      const out = saveAfterLoad(source)
      expect(out.blocks[list].children).toEqual([i1, bad, i2])
      expect(out.blocks[bad]).toEqual(source.blocks[bad])
    })

    it("a list whose only item is dropped keeps that item on save, next to the synthesized one", () => {
      const list = id()
      const item = id()
      const source: BlockDocV1 = {
        doc_version: 1,
        blocks_order: [list],
        blocks: {
          // An unknown mark makes nodeFromJSON throw for this item.
          [item]: {
            id: item,
            type: "list_item",
            version: 1,
            attrs: { pm: { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "nope" }] }] }] } },
          },
          [list]: { id: list, type: "bullet_list", version: 1, attrs: {}, children: [item] },
        },
      }
      const { dropped } = blockDocToPMWithReport(source, schema)
      expect(dropped).toEqual([{ id: item, parentId: list, afterId: null }])
      const out = saveAfterLoad(source)
      expect(out.blocks_order).toEqual([list])
      expect(out.blocks[list].children).toEqual([item, synthesizedItemId(list)])
      expect(out.blocks[item]).toEqual(source.blocks[item])
    })

    it("is a no-op when nothing was dropped", () => {
      const p = id()
      const doc: BlockDocV1 = { doc_version: 1, blocks_order: [p], blocks: { [p]: para(p, "x") } }
      expect(restoreDroppedBlocks(doc, doc, [])).toBe(doc)
    })
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
