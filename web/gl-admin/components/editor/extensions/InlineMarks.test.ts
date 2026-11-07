import { describe, it, expect, afterEach } from "vitest"
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { schemaExtensions, getCoreSchema } from "@gl-admin/lib/collaboration/schema"
import { blockDocToPMWithReport, pmToBlockDoc, withoutExcludedMarks } from "@gl-admin/lib/collaboration/blockBridge"
import { validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { PasteSanitizer, sanitizePastedHTML } from "./PasteSanitizer"
import { INLINE_MARK_NAMES } from "./InlineMarks"

// Highlight, superscript and subscript (#418): the schema, commands and the canvas's
// shortcuts (⌘⇧H, ⌘., ⌘,), superscript and subscript excluding each other, captions
// keeping bold/italic/link only, the Block Spec round trip and paste.

const editors: Editor[] = []
afterEach(() => {
  while (editors.length) editors.pop()!.destroy()
})

const P = "blk-0418-para-000001"
const IMG = "blk-0418-image-00001"

function makeEditor(content: object): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...Object.values(schemaExtensions({ collaborating: false })), PasteSanitizer],
    content,
  })
  editors.push(editor)
  return editor
}

const doc = (...content: object[]) => ({ type: "doc", content })
const para = (text: string, id = P) => ({ type: "paragraph", attrs: { "data-block-id": id }, content: [{ type: "text", text }] })

/** Selects `text` in the first paragraph. */
function select(editor: Editor, text: string) {
  let range: { from: number; to: number } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (range || !node.isTextblock) return
    const at = node.textContent.indexOf(text)
    if (at >= 0) range = { from: pos + 1 + at, to: pos + 1 + at + text.length }
  })
  if (!range) throw new Error(`no "${text}"`)
  editor.commands.setTextSelection(range)
}

/** Presses a key the way ProseMirror's keymap reads it ("Mod" is Ctrl off a Mac). */
function press(editor: Editor, key: string, mods: { shift?: boolean; keyCode?: number } = {}): boolean {
  const event = new KeyboardEvent("keydown", { key, keyCode: mods.keyCode, ctrlKey: true, shiftKey: !!mods.shift, bubbles: true, cancelable: true })
  return !!editor.view.someProp("handleKeyDown", (f) => f(editor.view, event))
}

/** `[text, mark names]` for each text run of the first textblock. */
function runs(editor: Editor): [string, string[]][] {
  const out: [string, string[]][] = []
  let done = false
  editor.state.doc.descendants((node) => {
    if (done || !node.isTextblock) return
    node.forEach((child) => out.push([child.text ?? "", child.marks.map((mark) => mark.type.name)]))
    done = true
    return false
  })
  return out
}

describe("schema (#418)", () => {
  const schema = getCoreSchema()

  it("has the three marks, the highlight with no colour attr", () => {
    expect(INLINE_MARK_NAMES.every((name) => schema.marks[name])).toBe(true)
    expect(schema.marks.highlight.spec.attrs ?? {}).toEqual({})
    expect(schema.marks.superscript.spec.attrs ?? {}).toEqual({})
    expect(schema.marks.subscript.spec.attrs ?? {}).toEqual({})
  })

  it("superscript and subscript exclude each other (and themselves); highlight combines with both", () => {
    const { superscript, subscript, highlight, bold } = schema.marks
    expect(superscript.excludes(subscript)).toBe(true)
    expect(subscript.excludes(superscript)).toBe(true)
    expect(superscript.excludes(superscript)).toBe(true)
    expect(subscript.excludes(subscript)).toBe(true)
    for (const other of [highlight, bold]) {
      expect(superscript.excludes(other)).toBe(false)
      expect(other.excludes(subscript)).toBe(false)
    }
  })

  it("captions don't allow them (bold, italic, link only)", () => {
    for (const caption of ["imageCaption", "tableCaption"]) {
      for (const name of INLINE_MARK_NAMES) expect(schema.nodes[caption].allowsMarkType(schema.marks[name]), `${caption} ${name}`).toBe(false)
    }
    expect(schema.nodes.paragraph.allowsMarkType(schema.marks.highlight)).toBe(true)
    expect(schema.nodes.heading.allowsMarkType(schema.marks.superscript)).toBe(true)
  })
})

describe("commands and shortcuts (#418)", () => {
  it("⌘⇧H highlights, ⌘. superscripts, ⌘, subscripts, and each toggles off again", () => {
    const editor = makeEditor(doc(para("alpha beta gamma")))
    select(editor, "alpha")
    expect(press(editor, "h", { shift: true })).toBe(true)
    select(editor, "beta")
    expect(press(editor, ".")).toBe(true)
    select(editor, "gamma")
    expect(press(editor, ",")).toBe(true)
    expect(runs(editor)).toEqual([
      ["alpha", ["highlight"]],
      [" ", []],
      ["beta", ["superscript"]],
      [" ", []],
      ["gamma", ["subscript"]],
    ])
    select(editor, "alpha")
    press(editor, "h", { shift: true })
    select(editor, "beta")
    press(editor, ".")
    select(editor, "gamma")
    press(editor, ",")
    expect(runs(editor)).toEqual([["alpha beta gamma", []]])
  })

  it("⌘⇧, (the settings panel, #417) and ⌘⇧. are never subscript or superscript, on any layout", () => {
    const editor = makeEditor(doc(para("alpha")))
    select(editor, "alpha")
    // US layout: Shift turns the key into < and >; elsewhere it may still read , and .
    // (ProseMirror's keymap would retry those without Shift: not these shortcuts).
    expect(press(editor, "<", { shift: true, keyCode: 188 })).toBe(false)
    expect(press(editor, ">", { shift: true, keyCode: 190 })).toBe(false)
    expect(press(editor, ",", { shift: true, keyCode: 188 })).toBe(false)
    expect(press(editor, ".", { shift: true, keyCode: 190 })).toBe(false)
    expect(runs(editor)).toEqual([["alpha", []]])
  })

  it("turning subscript on replaces superscript, and back; highlight stays", () => {
    const editor = makeEditor(doc(para("x2")))
    select(editor, "2")
    editor.chain().toggleHighlight().toggleSuperscript().run()
    expect(runs(editor)[1]).toEqual(["2", ["highlight", "superscript"]])
    editor.commands.toggleSubscript()
    expect(runs(editor)[1]).toEqual(["2", ["highlight", "subscript"]])
    expect(editor.isActive("superscript")).toBe(false)
    editor.commands.toggleSuperscript()
    expect(runs(editor)[1]).toEqual(["2", ["highlight", "superscript"]])
  })

  it("at a caret: the next typed text gets one of the two, not both", () => {
    const editor = makeEditor(doc(para("x")))
    editor.commands.setTextSelection(2)
    editor.chain().toggleSuperscript().toggleSubscript().insertContent("2").run()
    expect(runs(editor)).toEqual([
      ["x", []],
      ["2", ["subscript"]],
    ])
  })

  it("does nothing in an image caption: the caption keeps bold, italic and link", () => {
    const editor = makeEditor(
      doc({
        type: "image",
        attrs: { src: "/uploads/a.png", "data-block-id": IMG },
        content: [{ type: "imageCaption", content: [{ type: "text", text: "A caption" }] }],
      }),
    )
    let from = 0
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "imageCaption") from = pos + 1
    })
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, from + 1)))
    expect(editor.commands.toggleHighlight()).toBe(false)
    expect(editor.commands.toggleSuperscript()).toBe(false)
    press(editor, ",")
    expect(editor.commands.toggleBold()).toBe(true)
    let marks: string[] = []
    editor.state.doc.descendants((node) => {
      if (node.isText) marks = marks.concat(node.marks.map((mark) => mark.type.name))
    })
    expect(marks).toEqual(["bold"])
  })
})

describe("HTML (#418)", () => {
  it("parses <mark>, <sup> and <sub>, a <mark>'s colour ignored, and renders them back", () => {
    const editor = makeEditor(doc(para("x")))
    editor.commands.setContent('<p><mark data-color="#ff0000" style="background-color:#ff0000">hot</mark> x<sup>2</sup> H<sub>2</sub>O</p>')
    expect(runs(editor)).toEqual([
      ["hot", ["highlight"]],
      [" x", []],
      ["2", ["superscript"]],
      [" H", []],
      ["2", ["subscript"]],
      ["O", []],
    ])
    expect(editor.state.doc.firstChild!.firstChild!.marks[0].attrs).toEqual({})
    expect(editor.getHTML()).toContain("<mark>hot</mark> x<sup>2</sup> H<sub>2</sub>O")
  })

  it("nested <sup><sub> gives one of the two", () => {
    const editor = makeEditor(doc(para("x")))
    editor.commands.setContent("<p><sup><sub>2</sub></sup></p>")
    expect(runs(editor)).toEqual([["2", ["subscript"]]])
  })
})

describe("Block Spec round trip (#418)", () => {
  it("keeps the marks as runs with no attrs, and loads them back", () => {
    const editor = makeEditor(doc(para("H2O x2 key")))
    select(editor, "2")
    editor.commands.toggleSubscript()
    select(editor, "x2")
    editor.commands.setTextSelection({ from: editor.state.selection.to - 1, to: editor.state.selection.to })
    editor.commands.toggleSuperscript()
    select(editor, "key")
    editor.commands.toggleHighlight()

    const blockDoc = pmToBlockDoc(editor.state.doc)
    expect(() => validateBlockDoc(blockDoc)).not.toThrow()
    const content = (blockDoc.blocks[P].attrs as any).pm.content
    expect(content).toEqual([
      { type: "text", text: "H" },
      { type: "text", text: "2", marks: [{ type: "subscript" }] },
      { type: "text", text: "O x" },
      { type: "text", text: "2", marks: [{ type: "superscript" }] },
      { type: "text", text: " " },
      { type: "text", text: "key", marks: [{ type: "highlight" }] },
    ])

    const { node, dropped } = blockDocToPMWithReport(blockDoc, editor.schema)
    expect(dropped).toEqual([])
    expect(node.eq(editor.state.doc)).toBe(true)
    expect(pmToBlockDoc(node)).toEqual(blockDoc)
  })

  it("a stored run with both superscript and subscript loses one, not its block (#213)", () => {
    const schema = getCoreSchema()
    const stored: BlockDocV1 = {
      doc_version: 1,
      blocks_order: [P],
      blocks: {
        [P]: {
          id: P,
          type: "paragraph",
          version: 1,
          attrs: {
            text: "x2",
            pm: {
              type: "paragraph",
              content: [
                { type: "text", text: "x" },
                { type: "text", text: "2", marks: [{ type: "subscript" }, { type: "bold" }, { type: "superscript" }] },
              ],
            },
          },
        },
      },
    }
    const { node, dropped } = blockDocToPMWithReport(stored, schema)
    expect(dropped).toEqual([])
    expect(node.firstChild!.lastChild!.marks.map((mark) => mark.type.name)).toEqual(["bold", "subscript"])
  })

  it("the store writes a valid mark set for a run Yjs built with both (two users at once)", () => {
    const schema = getCoreSchema()
    // What y-tiptap builds from such a run: schema.text() takes the marks unchecked.
    const run = schema.text("2", [schema.marks.superscript.create(), schema.marks.subscript.create()])
    const paragraph = schema.nodes.paragraph.create({ "data-block-id": P }, [schema.text("x"), run])
    expect(() => paragraph.check()).toThrow(/Invalid collection of marks/)
    const blockDoc = pmToBlockDoc(schema.topNodeType.create(null, [paragraph]))
    expect((blockDoc.blocks[P].attrs as any).pm.content[1]).toEqual({ type: "text", text: "2", marks: [{ type: "subscript" }] })
    expect(blockDocToPMWithReport(blockDoc, schema).dropped).toEqual([])
  })
})

describe("withoutExcludedMarks (#418)", () => {
  const schema = getCoreSchema()
  const types = (marks: unknown) => (marks as { type: string }[]).map((mark) => mark.type)

  it("keeps what ProseMirror would keep, whatever the order", () => {
    expect(types(withoutExcludedMarks([{ type: "superscript" }, { type: "subscript" }], schema))).toEqual(["subscript"])
    expect(types(withoutExcludedMarks([{ type: "subscript" }, { type: "superscript" }], schema))).toEqual(["subscript"])
    // Inline code excludes every mark: two users' bold and code at once.
    expect(types(withoutExcludedMarks([{ type: "bold" }, { type: "code" }, { type: "italic" }], schema))).toEqual(["code"])
    // A repeated mark: the later one stays.
    expect(withoutExcludedMarks([{ type: "link", attrs: { href: "https://a.example" } }, { type: "link", attrs: { href: "https://b.example" } }], schema)).toEqual([
      { type: "link", attrs: { href: "https://b.example" } },
    ])
  })

  it("leaves a valid set (the same array) and unknown types alone", () => {
    const marks = [{ type: "bold" }, { type: "highlight" }, { type: "superscript" }]
    expect(withoutExcludedMarks(marks, schema)).toBe(marks)
    expect(types(withoutExcludedMarks([{ type: "spoiler" }, { type: "superscript" }, { type: "subscript" }], schema))).toEqual(["spoiler", "subscript"])
    expect(withoutExcludedMarks(undefined, schema)).toBeUndefined()
  })
})

describe("paste (#418)", () => {
  const pasteEvent = () => new Event("paste") as ClipboardEvent

  it("keeps <mark>, <sup> and <sub>, without their attributes", () => {
    const html = sanitizePastedHTML(
      '<p><mark class="x" style="background:red" data-color="red" onclick="alert(1)">hot</mark> x<sup style="color:red">2</sup> H<sub id="s">2</sub>O</p>',
    )
    expect(html).toBe("<p><mark>hot</mark> x<sup>2</sup> H<sub>2</sub>O</p>")
  })

  it("turns Docs' and Word's vertical-align spans into <sup> and <sub>", () => {
    const html = sanitizePastedHTML(
      '<p>x<span style="vertical-align:super">2</span> H<span style="vertical-align: sub; font-size: 0.6em">2</span>O <span style="vertical-align:baseline">n</span></p>',
    )
    expect(html).toBe("<p>x<sup>2</sup> H<sub>2</sub>O n</p>")
  })

  it("pasted into a paragraph they become the marks; into a caption only the caption's marks stay", () => {
    const editor = makeEditor(doc(para("start")))
    editor.commands.setTextSelection(6)
    editor.view.pasteHTML("<p><mark>hot</mark> x<sup>2</sup> H<sub>2</sub>O</p>", pasteEvent())
    expect(runs(editor)).toEqual([
      ["start", []],
      ["hot", ["highlight"]],
      [" x", []],
      ["2", ["superscript"]],
      [" H", []],
      ["2", ["subscript"]],
      ["O", []],
    ])

    const captioned = makeEditor(
      doc({
        type: "image",
        attrs: { src: "/uploads/a.png", "data-block-id": IMG },
        content: [{ type: "imageCaption", content: [{ type: "text", text: "Cap" }] }],
      }),
    )
    let end = 0
    captioned.state.doc.descendants((node, pos) => {
      if (node.type.name === "imageCaption") end = pos + 1 + node.content.size
    })
    captioned.view.dispatch(captioned.state.tr.setSelection(TextSelection.create(captioned.state.doc, end)))
    captioned.view.pasteHTML("<b>bold</b> <mark>hot</mark> x<sup>2</sup>", pasteEvent())
    const marks = new Set<string>()
    captioned.state.doc.descendants((node) => {
      if (node.isText) node.marks.forEach((mark) => marks.add(mark.type.name))
    })
    expect([...marks]).toEqual(["bold"])
  })
})
