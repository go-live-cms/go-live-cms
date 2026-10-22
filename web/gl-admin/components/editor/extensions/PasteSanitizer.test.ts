import { describe, it, expect, afterEach } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import Link from "@tiptap/extension-link"
import TextAlign from "@tiptap/extension-text-align"
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight"
import { createLowlight, common } from "lowlight"
import type { Node as PMNode, Schema } from "prosemirror-model"
import { DOMSerializer } from "prosemirror-model"
import { TextSelection } from "prosemirror-state"
import { ImageWithMediaId } from "./ImageWithMediaId"
import { BlockIdExtension } from "./BlockIdExtension"
import { PasteSanitizer, sanitizePastedHTML } from "./PasteSanitizer"
import { pmToBlockDoc, blockDocToPM } from "@gl-admin/lib/collaboration/blockBridge"
import googleDocsHTML from "./__fixtures__/paste/google-docs.html?raw"
import wordHTML from "./__fixtures__/paste/word.html?raw"
import webPageHTML from "./__fixtures__/paste/web-page.html?raw"
import maliciousHTML from "./__fixtures__/paste/malicious.html?raw"

// Pastes go through the real paste pipeline (view.pasteHTML → transformPastedHTML →
// clipboard parser → handlePaste → BlockIdExtension's appendTransaction), on an editor
// configured like the admin one (editor/utils/extensions.ts), minus UI-only extensions.

const EXISTING_ID = "existing-para-0000000000"

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function makeEditor(content: object = { type: "doc", content: [{ type: "paragraph", attrs: { "data-block-id": EXISTING_ID } }] }) {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, codeBlock: false, link: false }),
      CodeBlockLowlight.configure({ lowlight: createLowlight(common), defaultLanguage: "javascript" }),
      Link.configure({
        autolink: true,
        openOnClick: false,
        protocols: ["http", "https"],
        validate: (href) => /^https?:\/\//.test(href),
      }),
      ImageWithMediaId.configure({ allowBase64: false }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      BlockIdExtension,
      PasteSanitizer,
    ],
    content,
  })
  return editor
}

// jsdom has no ClipboardEvent; nothing on the paste path needs its clipboardData.
const pasteEvent = () => new Event("paste") as ClipboardEvent

function paste(ed: Editor, html: string): PMNode {
  ed.view.pasteHTML(html, pasteEvent())
  return ed.state.doc
}

/** Top-level node types, skipping empty paragraphs (stray <br>s, trailing node). */
function outline(doc: PMNode): string[] {
  const out: string[] = []
  doc.forEach((node) => {
    if (node.type.name === "paragraph" && node.content.size === 0) return
    out.push(node.type.name === "heading" ? `heading${node.attrs.level}` : node.type.name)
  })
  return out
}

/** Names of the marks on the text node containing `text`. */
function marksOn(doc: PMNode, text: string): string[] {
  let marks: string[] | null = null
  doc.descendants((node) => {
    if (marks === null && node.isText && node.text!.includes(text)) marks = node.marks.map((m) => m.type.name).sort()
  })
  if (marks === null) throw new Error(`text not found: ${text}`)
  return marks
}

function hrefs(doc: PMNode): string[] {
  const out: string[] = []
  doc.descendants((node) => {
    for (const mark of node.marks) if (mark.type.name === "link") out.push(mark.attrs.href)
  })
  return out
}

function count(doc: PMNode, typeName: string): number {
  let n = 0
  doc.descendants((node) => {
    if (node.type.name === typeName) n++
  })
  return n
}

const fullText = (doc: PMNode) => doc.textBetween(0, doc.content.size, "\n")

/** Ids BlockIdExtension owns: top-level nodes and list items (any depth). */
function blockIds(doc: PMNode): unknown[] {
  const ids: unknown[] = []
  doc.descendants((node, _pos, parent) => {
    const listItem = node.type.name === "listItem" && ["bulletList", "orderedList"].includes(parent!.type.name)
    if (parent === doc || listItem) ids.push(node.attrs["data-block-id"])
    return !node.isTextblock
  })
  return ids
}

/**
 * The pasted doc is schema-valid, every block has a unique valid id, and it survives
 * pmToBlockDoc → blockDocToPM unchanged using exactly those ids (no backfill).
 */
function expectValidBlocks(doc: PMNode, schema: Schema) {
  expect(() => doc.check()).not.toThrow()

  const ids = blockIds(doc)
  for (const id of ids) expect(typeof id === "string" && id.length >= 10).toBe(true)
  expect(new Set(ids).size).toBe(ids.length)

  const blockDoc = pmToBlockDoc(doc)
  const topLevel: unknown[] = []
  doc.forEach((node) => topLevel.push(node.attrs["data-block-id"]))
  expect(blockDoc.blocks_order).toEqual(topLevel)
  for (const id of Object.keys(blockDoc.blocks)) expect(ids).toContain(id)

  const back = blockDocToPM(blockDoc, schema)
  expect(() => back.check()).not.toThrow()
  expect(back.toJSON()).toEqual(doc.toJSON())
}

describe("sanitizePastedHTML (#128)", () => {
  it("strips scripts, embeds, event handlers, styles and dangerous URLs", () => {
    const out = sanitizePastedHTML(maliciousHTML)
    for (const bad of ["alert", "javascript", "vbscript", "data:", "<script", "<iframe", "<object", "<embed",
      "<svg", "<img", "<style", "<form", "<input", "<button", "onclick", "onerror", "onmouseover", "style=",
      "data-block-id"]) {
      expect(out.toLowerCase()).not.toContain(bad)
    }
    expect(out).toContain('href="https://ok.example.com/"')
    expect(out).toContain("<b>bold</b>")
  })

  it("strips Word/Docs junk: comments, mso styles, o:p, spans and classes", () => {
    const out = sanitizePastedHTML(wordHTML)
    for (const bad of ["<!--", "mso", "<o:p", "<span", "class=", "<meta", "Style Definitions", "·", "file:"]) {
      expect(out).not.toContain(bad)
    }
  })

  it("turns a <br> between blocks into an empty paragraph, but leaves line breaks in text", () => {
    expect(sanitizePastedHTML("<p>a</p><br><p>b</p>")).toBe("<p>a</p><p></p><p>b</p>")
    expect(sanitizePastedHTML("<div><br></div>")).toBe("<div><p></p></div>")
    expect(sanitizePastedHTML("<p>a<br>b</p><p><br></p>")).toBe("<p>a<br>b</p><p><br></p>")
    expect(sanitizePastedHTML('<p>a</p><br class="Apple-interchange-newline">')).toBe("<p>a</p>")
  })

  it("keeps only a language-* class, and only on <code>", () => {
    expect(sanitizePastedHTML('<pre class="x"><code class="hljs language-go big">x</code></pre>')).toBe(
      '<pre><code class="language-go">x</code></pre>'
    )
  })

  it("keeps only list/quote wrappers in the ProseMirror slice context, with attrs reset", () => {
    const sliceOf = (ctx: unknown[]) => {
      const out = sanitizePastedHTML(`<p data-pm-slice='1 1 ${JSON.stringify(ctx)}'>a</p>`)
      return new DOMParser().parseFromString(out, "text/html").body.firstElementChild!.getAttribute("data-pm-slice")
    }
    expect(sliceOf(["bulletList", { "data-block-id": "list-aaaa-0000000000" }, "listItem", { "data-block-id": "item-aaaa-0000000000" }]))
      .toBe('1 1 ["bulletList",null,"listItem",null]')
    // Any web page can set data-pm-slice; ProseMirror creates its context nodes unvalidated.
    expect(sliceOf(["heading", { level: 99 }])).toBeNull()
    expect(sliceOf(["blockquote", null, "paragraph", { textAlign: "left;background:url(https://evil.example/x)" }])).toBeNull()
    expect(sanitizePastedHTML(`<p data-pm-slice="garbage">a</p>`)).toBe("<p>a</p>")
  })

  it("lifts spans that switch bold/italic off out of their <b>/<i>", () => {
    expect(sanitizePastedHTML('<p><strong>Total: <span style="font-weight:normal">see note</span> end</strong></p>')).toBe(
      "<p><strong>Total: </strong>see note<strong> end</strong></p>"
    )
    expect(sanitizePastedHTML('<p><i><span style="font-style:normal">plain</span></i></p>')).toBe("<p>plain</p>")
  })

  it("doesn't bold heading text styled font-weight:700", () => {
    expect(sanitizePastedHTML('<h2><span style="font-weight:700">Title</span></h2>')).toBe("<h2>Title</h2>")
  })

  it("nests a list with no preceding item in a new <li>", () => {
    expect(sanitizePastedHTML("<ul><ul><li>a</li></ul><li>b</li></ul>")).toBe("<ul><li><ul><li>a</li></ul></li><li>b</li></ul>")
  })

  it("keeps nav/details and address boundaries so their text doesn't merge", () => {
    expect(sanitizePastedHTML('<div><nav><a href="/">Home</a></nav>Intro</div>')).toBe('<div><div><a href="/">Home</a></div>Intro</div>')
    expect(sanitizePastedHTML("<address>Main St</address>")).toBe("<address>Main St</address>")
  })
})

describe("PasteSanitizer: paste converts to blocks (#128)", () => {
  it("Google Docs: keeps structure and formatting, drops the bold wrapper and images", () => {
    const ed = makeEditor()
    const doc = paste(ed, googleDocsHTML)

    expect(outline(doc)).toEqual(["heading1", "paragraph", "bulletList", "paragraph"])
    // The docs-internal-guid <b style="font-weight:normal"> wrapper must not bold everything.
    expect(marksOn(doc, "Quarterly report")).toEqual([])
    expect(marksOn(doc, "Revenue grew")).toEqual([])
    expect(marksOn(doc, "twelve percent")).toEqual(["bold"])
    expect(marksOn(doc, "year over year")).toEqual(["italic"])
    expect(marksOn(doc, "the dashboard")).toEqual(["link"])
    expect(marksOn(doc, "old figure")).toEqual(["strike"])
    expect(hrefs(doc)).toEqual(["https://example.com/q3"])
    expect(count(doc, "image")).toBe(0)
    expectValidBlocks(doc, ed.schema)
  })

  it("Word: drops list glyphs, o:p, conditional comments and local images", () => {
    const ed = makeEditor()
    const doc = paste(ed, wordHTML)

    expect(outline(doc)).toEqual(["heading2", "paragraph", "paragraph", "paragraph", "paragraph"])
    expect(marksOn(doc, "Attendees:")).toEqual(["bold"])
    expect(marksOn(doc, "Signed")).toEqual(["italic"])
    expect(marksOn(doc, "the team")).toEqual(["bold"])
    expect(fullText(doc)).toContain("First action")
    expect(fullText(doc)).not.toMatch(/·|mso|StartFragment/)
    expect(count(doc, "image")).toBe(0)
    expectValidBlocks(doc, ed.schema)
  })

  it("generic web page: maps to supported nodes and unwraps the rest", () => {
    const ed = makeEditor()
    const doc = paste(ed, webPageHTML)

    expect(outline(doc)).toEqual([
      "paragraph", // nav "Home"
      "heading3",
      "paragraph",
      "codeBlock",
      "blockquote",
      "horizontalRule",
      "orderedList",
      "paragraph", // th "Plan"
      "paragraph", // td "Free"
      "paragraph", // figcaption
      "heading5",
      "paragraph", // bare <span> text
    ])
    expect(marksOn(doc, "npm i golive")).toEqual(["code"])
    expect(marksOn(doc, "docs")).toEqual(["link"])
    expect(hrefs(doc)).toContain("https://docs.example.com/start")

    let code: PMNode | null = null
    doc.forEach((node) => {
      if (node.type.name === "codeBlock") code = node
    })
    expect(code!.attrs.language).toBe("bash")
    expect(code!.textContent).toBe("npm install\nnpm run dev")

    let list: PMNode | null = null
    doc.forEach((node) => {
      if (node.type.name === "orderedList") list = node
    })
    expect(list!.attrs.start).toBe(1)
    expect(count(doc, "image")).toBe(0)
    expectValidBlocks(doc, ed.schema)
  })

  it("malicious HTML: no script, handler, embed, image or unsafe link survives", () => {
    const ed = makeEditor()
    const doc = paste(ed, maliciousHTML)
    const json = JSON.stringify(doc.toJSON())

    expect(json).not.toMatch(/alert|javascript|vbscript|data:|msgbox|evil/i)
    expect(hrefs(doc)).toEqual(["https://ok.example.com/", "https://ok.example.com/2"])
    // Unsafe links keep their text, without the link.
    expect(fullText(doc)).toContain("Click one, two, three, four, five, safe")
    expect(marksOn(doc, "one")).toEqual([])
    expect(marksOn(doc, "bold")).toEqual(["bold"])
    expect(count(doc, "image")).toBe(0)
    expectValidBlocks(doc, ed.schema)
  })

  it("nested lists become nested list nodes inside the parent item, each item with an id", () => {
    const ed = makeEditor()
    const doc = paste(
      ed,
      "<ul><li>a<ul><li>a.1<ol><li>a.1.i</li></ol></li></ul></li><li>b</li></ul>" +
        // Google Docs style: the sub-list is a sibling of the items, not inside one.
        "<ol><li><p>x</p></li><ol><li><p>x.1</p></li></ol><li><p>y</p></li></ol>"
    )

    const lists: PMNode[] = []
    doc.forEach((node) => {
      if (node.type.name === "bulletList" || node.type.name === "orderedList") lists.push(node)
    })
    expect(lists.map((l) => l.type.name)).toEqual(["bulletList", "orderedList"])

    const [bullets, ordered] = lists
    expect(bullets.childCount).toBe(2)
    const a = bullets.child(0)
    expect(a.child(0).textContent).toBe("a")
    expect(a.child(1).type.name).toBe("bulletList")
    expect(a.child(1).child(0).child(1).type.name).toBe("orderedList")
    expect(a.child(1).child(0).child(1).textContent).toBe("a.1.i")

    expect(ordered.childCount).toBe(2)
    expect(ordered.child(0).child(1).type.name).toBe("orderedList")
    expect(ordered.child(0).child(1).textContent).toBe("x.1")
    expect(ordered.child(1).textContent).toBe("y")

    // Every item, nested ones included, carries its own id (#238); expectValidBlocks
    // checks they're all valid and unique.
    expect(count(doc, "listItem")).toBe(7)
    expect(blockIds(doc).length).toBe(2 + 7 + 1) // lists + items + trailing paragraph
    expectValidBlocks(doc, ed.schema)
  })

  it("never adopts pasted block ids: the existing block keeps its id, pasted ones get fresh ids", () => {
    const ed = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { "data-block-id": "first-para-0000000000" } },
        { type: "paragraph", attrs: { "data-block-id": EXISTING_ID }, content: [{ type: "text", text: "original" }] },
      ],
    })
    // Paste BEFORE the original: BlockIdExtension dedupes in document order, so a copied
    // id that survived the paste would win and the original block would be re-keyed.
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 1)))
    const doc = paste(ed, `<p data-block-id="${EXISTING_ID}">copy</p><h2 data-block-id="${EXISTING_ID}">title</h2>`)

    expect(outline(doc)).toEqual(["paragraph", "heading2", "paragraph"])
    expect(doc.lastChild!.textContent).toBe("original")
    expect(doc.lastChild!.attrs["data-block-id"]).toBe(EXISTING_ID)
    expect(blockIds(doc).filter((id) => id === EXISTING_ID)).toHaveLength(1)
    expectValidBlocks(doc, ed.schema)
  })

  it("copying a list item within the editor pastes as a list with new ids", () => {
    const ed = makeEditor({
      type: "doc",
      content: [
        {
          type: "bulletList",
          attrs: { "data-block-id": "list-aaaa-0000000000" },
          content: [
            {
              type: "listItem",
              attrs: { "data-block-id": "item-aaaa-0000000000" },
              content: [{ type: "paragraph", content: [{ type: "text", text: "copied item" }] }],
            },
          ],
        },
        { type: "paragraph", attrs: { "data-block-id": "para-aaaa-0000000000" } },
      ],
    })
    // Copy the whole list the way ProseMirror puts it on the clipboard: the serialized
    // nodes (data-block-id included) with a data-pm-slice marker on the first element.
    const listEnd = ed.state.doc.child(0).nodeSize
    const wrap = document.createElement("div")
    wrap.append(DOMSerializer.fromSchema(ed.schema).serializeFragment(ed.state.doc.slice(0, listEnd).content))
    ;(wrap.firstElementChild as HTMLElement).setAttribute("data-pm-slice", "0 0 []")
    expect(wrap.innerHTML).toContain("item-aaaa-0000000000")
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, listEnd + 1)))
    const doc = paste(ed, wrap.innerHTML)

    expect(outline(doc)).toEqual(["bulletList", "bulletList"])
    expect(doc.child(1).textContent).toBe("copied item")
    expect(blockIds(doc).slice(0, 2)).toEqual(["list-aaaa-0000000000", "item-aaaa-0000000000"])
    expect(blockIds(doc).slice(2)).not.toContain("item-aaaa-0000000000")
    expectValidBlocks(doc, ed.schema)
  })

  it("plain-text paste still works and gets block ids", () => {
    const ed = makeEditor()
    ed.view.pasteText("line one\n\nline two <script>alert(1)</script>", pasteEvent())
    const doc = ed.state.doc

    expect(fullText(doc)).toContain("line one")
    // Plain text is text: the markup is inserted literally, never parsed.
    expect(fullText(doc)).toContain("line two <script>alert(1)</script>")
    expect(count(doc, "paragraph")).toBeGreaterThanOrEqual(2)
    expectValidBlocks(doc, ed.schema)
  })
})
