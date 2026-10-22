import type { BlockDocV1 } from "../blocks-spec"
import { blockDocToPM, pmToBlockDoc } from "./blockBridge"
import { getCoreSchema, schemaWithStandIns } from "./schema"
import { pmRoots } from "./fragmentBridge"

// Block docs shared by the fragmentBridge tests (#206). Ids are fixed (and >= 10
// characters, the bridge's minimum) so assertions can name them.

/** What the editor would save for `doc`: one load + save through the bridge, as the server converts it. */
export function canonical(doc: BlockDocV1, base = getCoreSchema()): BlockDocV1 {
  return pmToBlockDoc(blockDocToPM(doc, schemaWithStandIns(base, pmRoots(doc))))
}

export const ids = {
  intro: "blk-intro-000001",
  h1: "blk-heading-01",
  h4: "blk-heading-04",
  h6: "blk-heading-06",
  quote: "blk-quote-00001",
  code: "blk-code-000001",
  rule: "blk-divider-0001",
  image: "blk-image-00001",
  bullets: "blk-bullets-0001",
  item1: "blk-item-000001",
  item2: "blk-item-000002",
  nested: "blk-nested-0001",
  nestedItem: "blk-item-000003",
  numbers: "blk-numbers-0001",
  item4: "blk-item-000004",
  callout: "blk-callout-0001",
  outro: "blk-outro-000001",
} as const

const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) })
const para = (id: string | null, ...content: unknown[]) => ({
  type: "paragraph",
  attrs: { textAlign: null, "data-block-id": id },
  content,
})

/** One block of every kind the editor makes, plus a theme block and nested lists. */
export function richDoc(): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [
      ids.intro,
      ids.h1,
      ids.h4,
      ids.h6,
      ids.quote,
      ids.code,
      ids.rule,
      ids.image,
      ids.bullets,
      ids.numbers,
      ids.callout,
      ids.outro,
    ],
    blocks: {
      [ids.intro]: {
        id: ids.intro,
        type: "paragraph",
        version: 1,
        attrs: {
          pm: para(
            ids.intro,
            text("Plain, "),
            text("bold", [{ type: "bold" }]),
            text(" and "),
            text("a link", [{ type: "link", attrs: { href: "https://example.test", target: "_blank", rel: "noopener noreferrer nofollow", class: "editor-link" } }]),
          ),
          text: "Plain, bold and a link",
        },
      },
      [ids.h1]: { id: ids.h1, type: "heading", version: 1, attrs: { level: 1, text: "Title" } },
      [ids.h4]: { id: ids.h4, type: "heading", version: 1, attrs: { level: 4, text: "Fourth" } },
      [ids.h6]: { id: ids.h6, type: "heading", version: 1, attrs: { level: 6, text: "Sixth" } },
      [ids.quote]: { id: ids.quote, type: "blockquote", version: 1, attrs: { text: "Quoted" } },
      [ids.code]: { id: ids.code, type: "code_block", version: 1, attrs: { code: "const x = 1", language: "javascript" } },
      [ids.rule]: { id: ids.rule, type: "divider", version: 1, attrs: {} },
      [ids.image]: { id: ids.image, type: "image", version: 1, attrs: { src: "/uploads/x.png", alt: "x", title: "t", mediaId: 42 } },
      [ids.bullets]: { id: ids.bullets, type: "bullet_list", version: 1, attrs: {}, children: [ids.item1, ids.item2] },
      [ids.item1]: { id: ids.item1, type: "list_item", version: 1, attrs: { text: "First" } },
      [ids.item2]: {
        id: ids.item2,
        type: "list_item",
        version: 1,
        attrs: {
          pm: {
            type: "listItem",
            attrs: { "data-block-id": ids.item2 },
            content: [
              para(null, text("Second")),
              {
                type: "bulletList",
                attrs: { "data-block-id": ids.nested },
                content: [{ type: "listItem", attrs: { "data-block-id": ids.nestedItem }, content: [para(null, text("Nested"))] }],
              },
            ],
          },
          text: "SecondNested",
        },
      },
      [ids.numbers]: { id: ids.numbers, type: "ordered_list", version: 1, attrs: {}, children: [ids.item4] },
      [ids.item4]: { id: ids.item4, type: "list_item", version: 1, attrs: { text: "Numbered" } },
      [ids.callout]: {
        id: ids.callout,
        type: "callout",
        version: 1,
        attrs: {
          pm: { type: "callout", attrs: { "data-block-id": ids.callout, variant: "warn" }, content: [text("Theme block")] },
          text: "Theme block",
          variant: "warn",
        },
      },
      [ids.outro]: { id: ids.outro, type: "paragraph", version: 1, attrs: { text: "The end" } },
    },
  }
}
