import { describe, it, expect } from "vitest"
import { generateJSON, getSchema } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import TextAlign from "@tiptap/extension-text-align"
import Link from "@tiptap/extension-link"
import { Schema } from "prosemirror-model"
import { ImageWithMediaId } from "@gl-admin/components/editor/extensions/ImageWithMediaId"
import { BlockIdExtension } from "@gl-admin/components/editor/extensions/BlockIdExtension"
import { QuoteCitation } from "@gl-admin/components/editor/extensions/QuoteCitation"
import { pmToBlockDoc, blockDocToPM, blockDocToPMWithReport } from "./blockBridge"
import { CITE_MAX_LENGTH, validateBlockDoc, type Block, type BlockDocV1, type CaptionText } from "../blocks-spec"

// Image caption + width and quote citation (#346), headlessly: the editor's node set
// (ImageWithMediaId brings its imageCaption child), the block-id global attribute, and
// the quote's cite global attribute.
const schema: Schema = getSchema([
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, link: false }),
  Link,
  TextAlign.configure({ types: ["heading", "paragraph"] }),
  ImageWithMediaId,
  BlockIdExtension,
  QuoteCitation,
])

const A = "blk-0346-image-000001"
const Q = "blk-0346-quote-000001"
const docOf = (...blocks: Block[]): BlockDocV1 => ({
  doc_version: 1,
  blocks_order: blocks.map((block) => block.id),
  blocks: Object.fromEntries(blocks.map((block) => [block.id, block])),
})
const roundTrip = (doc: BlockDocV1) => pmToBlockDoc(blockDocToPM(doc, schema))
const pmDocOf = (...content: unknown[]) => schema.nodeFromJSON({ type: "doc", content })

const caption: CaptionText[] = [
  { type: "text", text: "Photo by " },
  { type: "text", text: "Ada", marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://example.com" } }] },
  { type: "text", text: " in 2026", marks: [{ type: "italic" }] },
]

describe("image caption and width (#346)", () => {
  it("round-trips a rich caption and each width, as image v2", () => {
    for (const align of ["wide", "full"] as const) {
      const out = roundTrip(docOf({ id: A, type: "image", version: 2, attrs: { src: "/m/a.png", mediaId: 3, caption, align } }))
      const block = out.blocks[A]
      expect(block.version).toBe(2)
      expect(block.attrs).toMatchObject({ src: "/m/a.png", mediaId: 3, align })
      // Marks keep their attrs (link target/rel defaults included) and come in the
      // schema's order; compare text + mark types.
      const runs = (block.attrs as any).caption.map((run: any) => [run.text, (run.marks ?? []).map((m: any) => m.type).sort()])
      expect(runs).toEqual([
        ["Photo by ", []],
        ["Ada", ["bold", "link"]],
        [" in 2026", ["italic"]],
      ])
      expect((block.attrs as any).caption[1].marks.find((m: any) => m.type === "link").attrs.href).toBe("https://example.com")
      expect(() => validateBlockDoc(out)).not.toThrow()
    }
  })

  it("builds the caption as the image's imageCaption child, and checks", () => {
    const node = blockDocToPM(docOf({ id: A, type: "image", version: 2, attrs: { src: "/m/a.png", caption, align: "wide" } }), schema)
    const image = node.firstChild!
    expect(image.attrs.align).toBe("wide")
    expect(image.childCount).toBe(1)
    expect(image.firstChild!.type.name).toBe("imageCaption")
    expect(image.firstChild!.textContent).toBe("Photo by Ada in 2026")
    expect(() => node.check()).not.toThrow()
  })

  it("an old v1 image (no caption, no align) loads as before and stores no new keys", () => {
    const node = blockDocToPM(docOf({ id: A, type: "image", version: 1, attrs: { src: "/m/a.png", alt: "a" } }), schema)
    expect(node.firstChild!.childCount).toBe(0)
    expect(node.firstChild!.attrs.align).toBe("inline")
    const attrs = JSON.parse(JSON.stringify(pmToBlockDoc(node).blocks[A].attrs))
    expect(attrs).toEqual({ src: "/m/a.png", alt: "a" })
  })

  it("leaves out an empty caption and the default width", () => {
    const out = pmToBlockDoc(
      pmDocOf({ type: "image", attrs: { src: "/m/a.png", align: "inline", "data-block-id": A }, content: [{ type: "imageCaption" }] }),
    )
    expect(JSON.parse(JSON.stringify(out.blocks[A].attrs))).toEqual({ src: "/m/a.png" })
  })

  it("an unknown width loads as inline instead of dropping the image", () => {
    const { node, dropped } = blockDocToPMWithReport(
      docOf({ id: A, type: "image", version: 2, attrs: { src: "/m/a.png", align: "huge" as any } }),
      schema,
    )
    expect(dropped).toEqual([])
    expect(node.firstChild!.attrs.align).toBe("inline")
    expect((pmToBlockDoc(node).blocks[A].attrs as any).align).toBeUndefined()
  })

  it("a caption with marks a caption can't hold keeps its text and the image", () => {
    const bad = [
      { type: "text", text: "under", marks: [{ type: "underline" }, { type: "italic" }] },
      { type: "hardBreak" },
      { type: "text", text: "" },
      { type: "text", text: " code", marks: [{ type: "code" }] },
    ]
    const { node, dropped } = blockDocToPMWithReport(
      docOf({ id: A, type: "image", version: 2, attrs: { src: "/m/a.png", caption: bad as any } }),
      schema,
    )
    expect(dropped).toEqual([])
    const out = (pmToBlockDoc(node).blocks[A].attrs as any).caption
    expect(out).toEqual([
      { type: "text", text: "under", marks: [{ type: "italic" }] },
      { type: "text", text: " code" },
    ])
  })

  it("a link attr the schema doesn't declare costs that attr, not the image", () => {
    const { node, dropped } = blockDocToPMWithReport(
      docOf({
        id: A,
        type: "image",
        version: 2,
        attrs: { src: "/m/a.png", caption: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "https://e.com", foo: 1 } }] }] },
      }),
      schema,
    )
    expect(dropped).toEqual([])
    const mark = (pmToBlockDoc(node).blocks[A].attrs as any).caption[0].marks[0]
    expect(mark.attrs.href).toBe("https://e.com")
    expect(mark.attrs).not.toHaveProperty("foo")
  })

  it("parses a <figure> with a <figcaption> into an image with its caption", () => {
    const json = generateJSON(
      '<figure data-align="full"><img src="/m/a.png" alt="a" data-media-id="7"><figcaption>By <strong>Ada</strong></figcaption></figure>',
      [StarterKit, ImageWithMediaId],
    )
    expect(json.content[0]).toMatchObject({
      type: "image",
      attrs: { src: "/m/a.png", alt: "a", mediaId: 7, align: "full" },
      content: [{ type: "imageCaption", content: [{ text: "By " }, { text: "Ada", marks: [{ type: "bold" }] }] }],
    })
  })

  it("a <figcaption> on its own stays text: it never becomes an empty image", () => {
    const json = generateJSON("<figure><figcaption>Just a caption</figcaption></figure>", [StarterKit, ImageWithMediaId])
    expect(json.content.map((node: any) => node.type)).not.toContain("image")
    expect(JSON.stringify(json)).toContain("Just a caption")
  })
})

describe("quote citation (#346)", () => {
  it("round-trips cite as blockquote v2, outside the stored pm", () => {
    const out = roundTrip(docOf({ id: Q, type: "blockquote", version: 1, attrs: { text: "Quoted", cite: "Ada Lovelace" } }))
    const block = out.blocks[Q]
    expect(block.version).toBe(2)
    expect((block.attrs as any).cite).toBe("Ada Lovelace")
    expect((block.attrs as any).pm.attrs).not.toHaveProperty("cite")
    expect(() => validateBlockDoc(out)).not.toThrow()
  })

  it("the block's cite wins over a cite inside its pm, and no cite means none", () => {
    const pm = { type: "blockquote", attrs: { cite: "stale" }, content: [{ type: "paragraph", content: [{ type: "text", text: "q" }] }] }
    const withCite = blockDocToPM(docOf({ id: Q, type: "blockquote", version: 2, attrs: { pm, cite: "Fresh" } }), schema)
    expect(withCite.firstChild!.attrs.cite).toBe("Fresh")
    const without = blockDocToPM(docOf({ id: Q, type: "blockquote", version: 2, attrs: { pm } }), schema)
    expect(without.firstChild!.attrs.cite).toBeNull()
  })

  it("stores a trimmed cite capped at CITE_MAX_LENGTH, and none for a blank one", () => {
    const quote = (cite: string) =>
      pmDocOf({ type: "blockquote", attrs: { cite, "data-block-id": Q }, content: [{ type: "paragraph", content: [{ type: "text", text: "q" }] }] })
    expect((pmToBlockDoc(quote("  Ada  ")).blocks[Q].attrs as any).cite).toBe("Ada")
    expect((pmToBlockDoc(quote("   ")).blocks[Q].attrs as any).cite).toBeUndefined()
    expect((pmToBlockDoc(quote("x".repeat(CITE_MAX_LENGTH + 50))).blocks[Q].attrs as any).cite).toHaveLength(CITE_MAX_LENGTH)
  })

  it("an old quote gains no cite key, in its attrs or its pm", () => {
    const out = roundTrip(docOf({ id: Q, type: "blockquote", version: 1, attrs: { text: "q" } }))
    const attrs = JSON.parse(JSON.stringify(out.blocks[Q].attrs))
    expect(Object.keys(attrs).sort()).toEqual(["pm", "text"])
    expect(attrs.pm.attrs).toEqual({ "data-block-id": Q })
    // And it's stable: a second pass changes nothing.
    expect(roundTrip(out)).toEqual(out)
  })

  it("a schema without QuoteCitation still builds a quote that has no cite", () => {
    const plain = getSchema([StarterKit, BlockIdExtension])
    const { dropped } = blockDocToPMWithReport(docOf({ id: Q, type: "blockquote", version: 1, attrs: { text: "q" } }), plain)
    expect(dropped).toEqual([])
  })
})
