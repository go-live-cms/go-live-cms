import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import { DOMParser as PMDOMParser, DOMSerializer } from "prosemirror-model"
import { validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { blockDocToPMWithReport, pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { fragmentToBlockDoc, seedFragment } from "@gl-admin/lib/collaboration/fragmentBridge"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { getInstalledCollabSchema } from "@gl-admin/lib/theme-blocks/collabSchema"
import { sanitizePastedHTML } from "./PasteSanitizer"

// #320's inline nodes through the editor's half of the chain: the commands, the plain
// text the block's `text` attr reads, Block Spec ⇄ ProseMirror ⇄ the Yjs fragment (the
// collab server's seed and store), the clipboard HTML and paste. The API's half is
// api/inline_nodes_test.go (the same vectors), the public render is contentRenderer's test.

const schema = getInstalledCollabSchema()

const P1 = "blk-inline-para01"
const QUOTE = "blk-inline-quote1"
const CELL_TABLE = "blk-inline-table1"

const text = (value: string) => ({ type: "text", text: value })
const mention = { type: "mention", attrs: { userId: 7, label: "Ana Costa" } }
const link = { type: "contentLink", attrs: { postId: 42, label: "The guide" } }
const date = { type: "dateChip", attrs: { date: "2026-11-12", time: null, reminder: false } }
const reminder = { type: "dateChip", attrs: { date: "2026-12-01", time: "10:30", reminder: true } }

function inlineDoc(): BlockDocV1 {
  return {
    doc_version: 1,
    blocks_order: [P1, QUOTE, CELL_TABLE],
    blocks: {
      [P1]: { id: P1, type: "paragraph", version: 1, attrs: { pm: { type: "paragraph", content: [text("Ask "), mention, text(" about "), link, text(" by "), date] } } },
      [QUOTE]: { id: QUOTE, type: "blockquote", version: 2, attrs: { pm: { type: "blockquote", content: [{ type: "paragraph", content: [reminder] }] } } },
      [CELL_TABLE]: {
        id: CELL_TABLE,
        type: "table",
        version: 1,
        attrs: {
          pm: { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [text("Owner "), mention] }] }] }] },
        },
      },
    },
  }
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe("the full chain (Block Spec → PM → Yjs → Block Spec)", () => {
  it("is unchanged and valid, in a paragraph, a quote and a table cell", () => {
    const doc = canonical(inlineDoc(), schema)
    expect(() => validateBlockDoc(doc)).not.toThrow()
    const nodes = JSON.stringify(doc)
    expect(nodes).toContain('"type":"mention"')
    expect(nodes).toContain('"userId":7')
    expect(nodes).toContain('"postId":42')
    expect(nodes).toContain('"reminder":true')

    const ydoc = new Y.Doc()
    const fragment = ydoc.getXmlFragment("default")
    expect(seedFragment(doc, fragment, schema).entries).toEqual([])
    const stored = fragmentToBlockDoc(fragment, schema)
    expect(stored).toEqual(doc)
  })

  it("keeps no mark on an inline node: y-tiptap stores marks on text only", () => {
    // A bold mention is bold only in the editor that made it; the shared doc (and so
    // every peer, the stored block_doc and the site) has the plain mention. Nothing else
    // is lost, and it never loops (CLAUDE.md, blockBridge notes).
    const doc = inlineDoc()
    ;(doc.blocks[P1].attrs as any).pm.content[1] = { ...mention, marks: [{ type: "bold" }] }
    const ydoc = new Y.Doc()
    const fragment = ydoc.getXmlFragment("default")
    seedFragment(canonical(doc, schema), fragment, schema)
    const stored = fragmentToBlockDoc(fragment, schema)
    expect((stored.blocks[P1].attrs as any).pm.content[1]).toEqual(mention)
  })

  it("builds inline atoms and reads them as text for the block's `text`", () => {
    const { node, dropped } = blockDocToPMWithReport(inlineDoc(), schema)
    expect(dropped).toEqual([])
    expect(() => node.check()).not.toThrow()
    const paragraph = node.child(0)
    expect(paragraph.child(1).type.name).toBe("mention")
    expect(paragraph.child(1).isAtom && paragraph.child(1).isInline).toBe(true)
    expect(paragraph.textContent).toBe("Ask @Ana Costa about The guide by Nov 12, 2026")
    const out = pmToBlockDoc(node)
    expect((out.blocks[P1].attrs as any).text).toBe("Ask @Ana Costa about The guide by Nov 12, 2026")
    expect((out.blocks[QUOTE].attrs as any).text).toBe("Dec 1, 2026, 10:30 AM")
  })

  it("a node the schema can't take is dropped with its block kept (#213), never thrown", () => {
    const doc = inlineDoc()
    // A mention inside an image caption (text only): the caption can't hold it.
    doc.blocks_order.push("blk-inline-image1")
    doc.blocks["blk-inline-image1"] = { id: "blk-inline-image1", type: "image", version: 2, attrs: { src: "/uploads/a.png", mediaId: 1, caption: [mention as any] } }
    const { dropped } = blockDocToPMWithReport(doc, schema)
    expect(dropped.map((d) => d.id)).not.toContain(P1)
  })
})

describe("the editor", () => {
  let editor: Editor
  beforeEach(() => {
    editor = new Editor({ extensions: Object.values(schemaExtensions({ collaborating: false })), content: "<p>Hi</p>" })
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  })
  afterEach(() => editor.destroy())

  it("inserts each node with a space after it, replacing the typed @query", () => {
    editor.commands.insertContent(" @an")
    const end = editor.state.selection.from
    expect(editor.commands.insertMention({ userId: 7, label: "  Ana\nCosta " }, { from: end - 3, to: end })).toBe(true)
    editor.commands.insertContentLink({ postId: 42, label: "The guide" })
    editor.commands.insertDateChip({ date: "2026-11-12", time: null, reminder: true })
    const json = editor.getJSON().content![0].content! as any[]
    expect(json.map((n: any) => n.type)).toEqual(["text", "mention", "text", "contentLink", "text", "dateChip", "text"])
    expect(json[1].attrs).toEqual({ userId: 7, label: "Ana Costa" })
    // A reminder always has a time: 09:00 when none was given.
    expect(json[5].attrs).toEqual({ date: "2026-11-12", time: "09:00", reminder: true })
    expect(editor.getText()).toBe("Hi @Ana Costa The guide Nov 12, 2026, 9:00 AM ")
  })

  it("refuses a date chip without a valid day", () => {
    expect(editor.commands.insertDateChip({ date: "2026-02-30", time: null, reminder: false })).toBe(false)
  })

  it("copies as HTML that parses back to the same nodes", () => {
    const { node } = blockDocToPMWithReport(inlineDoc(), schema)
    const fragment = DOMSerializer.fromSchema(schema).serializeFragment(node.child(0).content)
    const div = document.createElement("div")
    div.append(fragment)
    expect(div.innerHTML).toContain('data-type="mention"')
    expect(div.innerHTML).toContain('data-user-id="7"')
    expect(div.innerHTML).toContain('data-post-id="42"')
    expect(div.innerHTML).toContain('data-date="2026-11-12"')
    const wrapper = document.createElement("p")
    wrapper.innerHTML = div.innerHTML
    const holder = document.createElement("div")
    holder.append(wrapper)
    const parsed = PMDOMParser.fromSchema(schema).parse(holder)
    expect(parsed.child(0).content.toJSON()).toEqual(node.child(0).content.toJSON())
  })
})

describe("paste (#128)", () => {
  const parse = (html: string) => {
    const holder = document.createElement("div")
    holder.innerHTML = sanitizePastedHTML(html)
    return PMDOMParser.fromSchema(schema).parse(holder).toJSON()
  }

  it("keeps the editor's own inline nodes, with checked values", () => {
    const json = parse(
      '<p>Hi <span data-type="mention" data-user-id="7" data-label="Ana">@Ana</span> ' +
        '<span data-type="content-link" data-post-id="42" data-label="Guide">Guide</span> ' +
        '<span data-type="date" data-date="2026-11-12" data-time="10:00" data-reminder="true">Nov 12</span></p>',
    )
    const content = json.content[0].content
    expect(content.find((n: any) => n.type === "mention").attrs).toEqual({ userId: 7, label: "Ana" })
    expect(content.find((n: any) => n.type === "contentLink").attrs).toEqual({ postId: 42, label: "Guide" })
    expect(content.find((n: any) => n.type === "dateChip").attrs).toEqual({ date: "2026-11-12", time: "10:00", reminder: true })
  })

  it("turns a span without a valid id or date, or with the wrong attrs, into text", () => {
    const html = sanitizePastedHTML(
      '<p><span data-type="mention" data-user-id="x" onclick="alert(1)">@Ana</span> ' +
        '<span data-type="date" data-date="2026-13-01">soon</span> ' +
        '<span data-type="mention" data-user-id="7" data-post-id="9" data-date="2026-11-12" data-email="a@b.c">@Ana</span> ' +
        '<span style="color:red" data-user-id="7">plain</span></p>',
    )
    expect(html).not.toContain("onclick")
    expect(html).not.toContain('data-user-id="x"')
    expect(html).not.toContain("2026-13-01")
    expect(html).not.toContain("data-post-id")
    expect(html).not.toContain("data-email")
    // The forged mention keeps only its own valid id; the plain span is unwrapped.
    expect(html).toContain('<span data-type="mention" data-user-id="7">@Ana</span>')
    expect(html).not.toContain("<span>")
    expect(html).toContain("plain")
    const content = parse(html).content[0].content
    expect(content.filter((n: any) => n.type === "mention")).toHaveLength(1)
    expect(content.some((n: any) => n.type === "dateChip")).toBe(false)
  })
})
