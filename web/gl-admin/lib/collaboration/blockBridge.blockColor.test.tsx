import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { BLOCK_COLORS, normalizeBlockColor, validateBlockDoc, type BlockDocV1 } from "../blocks-spec"
import { blockDocToPM, pmToBlockDoc } from "./blockBridge"
import { getCoreSchema, schemaExtensions, schemaWithStandIns } from "./schema"
import { sanitizePastedHTML, PasteSanitizer } from "../../components/editor/extensions/PasteSanitizer"
import BlockRenderer from "../../../src/components/BlockRenderer"

// Block colour (#356): a palette token, from the editor through block_doc to the public
// page, and nothing else on the way: an unknown value is dropped by the paste sanitizer,
// the bridge, the validator and the renderer. The Go sanitizer has the same rule
// (TestSanitize_BlockColor).

const schema = getCoreSchema()
const ID = (n: number) => `blk-${String(n).padStart(4, "0")}-000000000`
const text = (t: string) => [{ type: "text", text: t }]

const TINTED = schema.nodeFromJSON({
  type: "doc",
  content: [
    { type: "paragraph", attrs: { "data-block-id": ID(1), blockColor: "red" }, content: text("red text") },
    { type: "heading", attrs: { "data-block-id": ID(2), level: 2, blockColor: "blue-background" }, content: text("Tinted") },
    {
      type: "blockquote",
      attrs: { "data-block-id": ID(3), blockColor: "gray" },
      content: [{ type: "paragraph", content: text("quoted") }],
    },
    {
      type: "bulletList",
      attrs: { "data-block-id": ID(4), blockColor: "green" },
      content: [
        {
          type: "listItem",
          attrs: { "data-block-id": ID(5) },
          content: [{ type: "paragraph", attrs: { blockColor: "purple" }, content: text("nested tint") }],
        },
      ],
    },
    { type: "paragraph", attrs: { "data-block-id": ID(6) }, content: text("plain") },
  ],
})

describe("block colour in Block Spec (#356)", () => {
  it("is the block's attrs.blockColor, never in its pm, and absent when untinted", () => {
    const doc = pmToBlockDoc(TINTED)
    const attrs = (n: number) => doc.blocks[ID(n)].attrs as any
    expect(attrs(1).blockColor).toBe("red")
    expect(attrs(2).blockColor).toBe("blue-background")
    expect(attrs(3).blockColor).toBe("gray")
    expect(attrs(4).blockColor).toBe("green")
    for (const n of [1, 2, 3]) expect(attrs(n).pm.attrs).not.toHaveProperty("blockColor")
    expect(attrs(6)).not.toHaveProperty("blockColor")
    // A nested paragraph's own colour stays in its list item's pm.
    expect(attrs(5).pm.content[0].attrs.blockColor).toBe("purple")
    // No "blockColor": null anywhere: untinted blocks store what they stored before.
    expect(JSON.stringify(doc)).not.toContain('"blockColor":null')
    expect(() => validateBlockDoc(doc)).not.toThrow()
  })

  it("round-trips through the editor's schema unchanged", () => {
    const doc = pmToBlockDoc(TINTED)
    const pm = blockDocToPM(doc, schema)
    pm.check()
    expect(pm.child(0).attrs.blockColor).toBe("red")
    expect(pm.child(1).attrs.blockColor).toBe("blue-background")
    expect(pm.child(3).attrs.blockColor).toBe("green")
    expect(pm.child(3).child(0).child(0).attrs.blockColor).toBe("purple")
    expect(pmToBlockDoc(pm)).toEqual(doc)
  })

  it("leaves a stored doc from before #356 exactly as it was (no store churn)", () => {
    const old: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [ID(1), ID(2), ID(3)],
      blocks: {
        [ID(1)]: { id: ID(1), type: "paragraph", version: 1, attrs: { pm: { type: "paragraph", attrs: { textAlign: null, "data-block-id": ID(1) }, content: text("a") }, text: "a" } },
        [ID(2)]: {
          id: ID(2),
          type: "blockquote",
          version: 2,
          attrs: {
            pm: { type: "blockquote", attrs: { "data-block-id": ID(2) }, content: [{ type: "paragraph", attrs: { textAlign: null, "data-block-id": null }, content: text("q") }] },
            text: "q",
          },
        },
        [ID(3)]: { id: ID(3), type: "bullet_list", version: 1, attrs: {}, children: [ID(4)] },
        [ID(4)]: {
          id: ID(4),
          type: "list_item",
          version: 1,
          attrs: {
            pm: { type: "listItem", attrs: { "data-block-id": ID(4) }, content: [{ type: "paragraph", attrs: { textAlign: null, "data-block-id": null }, content: text("i") }] },
            text: "i",
          },
        },
      },
    }
    expect(pmToBlockDoc(blockDocToPM(old, schema))).toEqual(old)
  })

  it("drops a colour outside the palette, from a node or from a stored doc", () => {
    // A peer's bad update in the live doc: the store leaves it out.
    const bad = schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { "data-block-id": ID(1), blockColor: "#ff0000" }, content: text("x") },
        {
          type: "bulletList",
          attrs: { "data-block-id": ID(2) },
          content: [{ type: "listItem", attrs: { "data-block-id": ID(3) }, content: [{ type: "paragraph", attrs: { blockColor: "evil" }, content: text("y") }] }],
        },
      ],
    })
    const doc = pmToBlockDoc(bad)
    expect(doc.blocks[ID(1)].attrs).not.toHaveProperty("blockColor")
    expect(JSON.stringify(doc)).not.toContain("evil")
    expect(() => validateBlockDoc(doc)).not.toThrow()

    // A stored doc written around the bridge: the editor never gets it.
    const stored = pmToBlockDoc(TINTED)
    ;(stored.blocks[ID(1)].attrs as any).blockColor = "url(javascript:alert(1))"
    expect(blockDocToPM(stored, schema).child(0).attrs.blockColor).toBeNull()
  })

  it("leaves an attr of that name on other node types alone (a custom node's own value)", () => {
    const custom: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [ID(9)],
      blocks: {
        [ID(9)]: {
          id: ID(9),
          type: "sidenote",
          version: 1,
          attrs: { pm: { type: "sidenote", attrs: { blockColor: "#ff0000", "data-block-id": ID(9) }, content: text("c") }, text: "c" },
        } as any,
      },
    }
    const withStandIn = schemaWithStandIns(schema, [(custom.blocks[ID(9)].attrs as any).pm])
    const out = pmToBlockDoc(blockDocToPM(custom, withStandIn))
    expect((out.blocks[ID(9)].attrs as any).pm.attrs.blockColor).toBe("#ff0000")
  })

  it("the validator refuses a colour outside the palette (the store never writes one)", () => {
    const doc = pmToBlockDoc(TINTED)
    for (const value of ["#ff0000", "Red", "red; color: blue", "background", 1]) {
      const copy = structuredClone(doc)
      ;(copy.blocks[ID(1)].attrs as any).blockColor = value
      expect(() => validateBlockDoc(copy), String(value)).toThrow()
    }
    for (const value of BLOCK_COLORS) {
      const copy = structuredClone(doc)
      ;(copy.blocks[ID(1)].attrs as any).blockColor = value
      expect(() => validateBlockDoc(copy), value).not.toThrow()
    }
  })

  it("renders on the public page as the palette class, and an unknown value as nothing", () => {
    const doc = pmToBlockDoc(TINTED)
    const html = renderToStaticMarkup(<BlockRenderer doc={doc} />)
    expect(html).toContain(`<p id="b-${ID(1)}" class="gl-color-red">red text</p>`)
    expect(html).toMatch(/<h2 id="tinted" class="gl-color-blue-background">/)
    expect(html).toContain(`<blockquote id="b-${ID(3)}" class="gl-color-gray">`)
    expect(html).toContain(`<ul id="b-${ID(4)}" class="gl-color-green">`)
    expect(html).toContain('<span class="gl-color-purple">nested tint</span>')
    expect(html).toContain(`<p id="b-${ID(6)}">plain</p>`)

    ;(doc.blocks[ID(1)].attrs as any).blockColor = 'red" onmouseover="alert(1)'
    ;(doc.blocks[ID(6)].attrs as any).blockColor = "#ff0000"
    const unsafe = renderToStaticMarkup(<BlockRenderer doc={doc} />)
    expect(unsafe).toContain(`<p id="b-${ID(1)}">red text</p>`)
    expect(unsafe).toContain(`<p id="b-${ID(6)}">plain</p>`)
    expect(unsafe).not.toContain("onmouseover")
  })
})

describe("block colour in pasted HTML (#128 allowlist)", () => {
  const editors: Editor[] = []
  afterEach(() => {
    while (editors.length) editors.pop()!.destroy()
  })

  it("keeps a palette data-block-color on a block, drops every other colour", () => {
    const html = sanitizePastedHTML(
      [
        '<p data-block-color="red">a</p>',
        '<h2 data-block-color="blue-background">b</h2>',
        '<p data-block-color="evil">c</p>',
        '<p data-block-color="#ff0000">d</p>',
        '<p style="color:#f00;background:yellow">e</p>',
        '<p><span data-block-color="red">f</span></p>',
        '<p data-block-color="RED">g</p>',
      ].join(""),
    )
    expect(html).toContain('<p data-block-color="red">a</p>')
    expect(html).toContain('<h2 data-block-color="blue-background">b</h2>')
    expect(html).toContain("<p>c</p>")
    expect(html).toContain("<p>d</p>")
    expect(html).toContain("<p>e</p>")
    expect(html).not.toContain("style")
    expect(html).not.toContain("<span")
    expect(html).toContain("<p>g</p>")
  })

  it("a paste gives the block the colour, or none", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [...Object.values(schemaExtensions({ collaborating: false })), PasteSanitizer],
    })
    editors.push(editor)
    // The first and last pasted paragraphs join the ones around the cursor; the middle
    // ones are whole blocks.
    editor.view.pasteHTML(
      '<p>start</p><p data-block-color="pink">tinted</p><p data-block-color="neon">unknown</p><p style="color:red">styled</p><p>end</p>',
      new Event("paste") as ClipboardEvent,
    )
    const colors: unknown[] = []
    editor.state.doc.forEach((node) => colors.push([node.textContent, node.attrs.blockColor]))
    expect(colors.slice(1, 4)).toEqual([
      ["tinted", "pink"],
      ["unknown", null],
      ["styled", null],
    ])
    expect(normalizeBlockColor("neon")).toBeNull()
  })
})
