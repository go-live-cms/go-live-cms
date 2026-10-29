import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { NodeSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { canonical } from "@gl-admin/lib/collaboration/fragmentBridge.fixtures"
import { startRelay, waitFor, type Relay } from "@gl-admin/lib/collaboration/hocuspocusRelay.testkit"
import { CITE_MAX_LENGTH, validateBlockDoc, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import { BlockNodeViews } from "./BlockNodeViews"

// Image caption + width and quote citation (#346) in the editor: the commands, the
// caption's keys, the node views, and two collaborators on the real collab server.

const editors: Editor[] = []

function makeEditor(doc?: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: Boolean(doc) })),
      BlockNodeViews,
      ...(doc ? [Collaboration.configure({ document: doc })] : []),
    ],
  })
  editors.push(editor)
  return editor
}

afterEach(() => {
  while (editors.length) {
    const editor = editors.pop()!
    const element = editor.options.element as HTMLElement
    editor.destroy()
    element.remove()
  }
})

const IMG = "blk-0346-image-000001"
const QUOTE = "blk-0346-quote-000001"
const PARA = "blk-0346-para-0000001"

const seed: BlockDocV1 = {
  doc_version: 1,
  blocks_order: [PARA, IMG, QUOTE],
  blocks: {
    [PARA]: { id: PARA, type: "paragraph", version: 1, attrs: { text: "start" } },
    [IMG]: { id: IMG, type: "image", version: 1, attrs: { src: "/uploads/a.png", alt: "A", mediaId: 5 } },
    [QUOTE]: { id: QUOTE, type: "blockquote", version: 1, attrs: { text: "Quoted" } },
  },
}

function posOf(editor: Editor, type: string): number {
  let found = -1
  editor.state.doc.forEach((node, offset) => {
    if (found === -1 && node.type.name === type) found = offset
  })
  if (found === -1) throw new Error(`no ${type}`)
  return found
}

const key = (editor: Editor, name: string) =>
  editor.view.someProp("handleKeyDown", (handler) => handler(editor.view, new KeyboardEvent("keydown", { key: name })))

function editorWithSeed(): Editor {
  const editor = makeEditor()
  editor.commands.setContent({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "start" }] },
      { type: "image", attrs: { src: "/uploads/a.png" } },
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Quoted" }] }] },
    ],
  })
  return editor
}

describe("image commands and caption keys (#346)", () => {
  it("setImageAlign sets the width of the selected image and keeps it selected", () => {
    const editor = editorWithSeed()
    expect(editor.commands.setImageAlign("wide")).toBe(false) // nothing selected
    editor.commands.setNodeSelection(posOf(editor, "image"))
    expect(editor.commands.setImageAlign("full")).toBe(true)
    expect(editor.state.doc.nodeAt(posOf(editor, "image"))!.attrs.align).toBe("full")
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(editor.commands.setImageAlign("huge" as any)).toBe(false)
  })

  it("toggleImageCaption adds an empty caption with the cursor in it, and removes it again", () => {
    const editor = editorWithSeed()
    const pos = posOf(editor, "image")
    editor.commands.setNodeSelection(pos)
    editor.commands.toggleImageCaption()
    expect(editor.state.doc.nodeAt(pos)!.firstChild!.type.name).toBe("imageCaption")
    expect(editor.state.selection.$from.parent.type.name).toBe("imageCaption")
    editor.commands.insertContent("Hello")
    expect(editor.state.doc.nodeAt(pos)!.textContent).toBe("Hello")
    // From inside the caption too.
    editor.commands.toggleImageCaption()
    expect(editor.state.doc.nodeAt(pos)!.childCount).toBe(0)
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
  })

  it("caption marks: bold, italic and link apply, others don't", () => {
    const editor = editorWithSeed()
    editor.commands.setNodeSelection(posOf(editor, "image"))
    editor.commands.toggleImageCaption()
    editor.commands.insertContent("word")
    editor.commands.selectParentNode()
    editor.commands.setTextSelection({ from: posOf(editor, "image") + 2, to: posOf(editor, "image") + 6 })
    expect(editor.commands.toggleBold()).toBe(true)
    expect(editor.commands.toggleUnderline()).toBe(false)
    expect(editor.commands.toggleCode()).toBe(false)
    const marks = editor.state.doc.nodeAt(posOf(editor, "image"))!.firstChild!.firstChild!.marks.map((m) => m.type.name)
    expect(marks).toEqual(["bold"])
  })

  it("Enter in a caption opens a paragraph under the image instead of splitting it", () => {
    const editor = editorWithSeed()
    const pos = posOf(editor, "image")
    editor.commands.setNodeSelection(pos)
    editor.commands.toggleImageCaption()
    editor.commands.insertContent("Cap")
    expect(key(editor, "Enter")).toBe(true)
    const types: string[] = []
    editor.state.doc.forEach((node) => types.push(node.type.name))
    // (StarterKit's TrailingNode adds the last paragraph.)
    expect(types).toEqual(["paragraph", "image", "paragraph", "blockquote", "paragraph"])
    expect(editor.state.doc.nodeAt(pos)!.textContent).toBe("Cap")
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph")
  })

  it("Backspace in an empty caption removes it and selects the image", () => {
    const editor = editorWithSeed()
    const pos = posOf(editor, "image")
    editor.commands.setNodeSelection(pos)
    editor.commands.toggleImageCaption()
    expect(key(editor, "Backspace")).toBe(true)
    expect(editor.state.doc.nodeAt(pos)!.childCount).toBe(0)
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
  })
})

describe("node views (#346)", () => {
  it("the image view shows the width, selects on click, and offers Add caption", () => {
    const editor = editorWithSeed()
    const figure = editor.view.dom.querySelector("figure.editor-image__figure") as HTMLElement
    expect(figure.dataset.align).toBe("inline")
    const img = figure.querySelector("img")!
    expect(img.getAttribute("src")).toBe("/uploads/a.png")

    img.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect((editor.state.selection as NodeSelection).node.type.name).toBe("image")

    editor.commands.setImageAlign("wide")
    expect(figure.dataset.align).toBe("wide")

    const add = figure.querySelector(".editor-image__add-caption") as HTMLButtonElement
    expect(add.hidden).toBe(false)
    add.click()
    expect(editor.state.doc.nodeAt(posOf(editor, "image"))!.firstChild!.type.name).toBe("imageCaption")
    expect(add.hidden).toBe(true)
    expect(figure.querySelector("figcaption")).not.toBeNull()
  })

  it("the quote view edits cite through its field and follows the attribute", () => {
    const editor = editorWithSeed()
    const input = editor.view.dom.querySelector(".editor-quote__cite input") as HTMLInputElement
    expect(input.value).toBe("")
    input.value = "Ada Lovelace"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(editor.state.doc.nodeAt(posOf(editor, "blockquote"))!.attrs.cite).toBe("Ada Lovelace")

    // Spaces as typed: trimming happens when the doc is converted to Block Spec.
    input.value = "Ada "
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(editor.state.doc.nodeAt(posOf(editor, "blockquote"))!.attrs.cite).toBe("Ada ")

    const pos = posOf(editor, "blockquote")
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...editor.state.doc.nodeAt(pos)!.attrs, cite: "Remote" }))
    expect(input.value).toBe("Remote")
  })

  it("a read-only editor ignores input in the cite field and hides an empty one", () => {
    const editor = editorWithSeed()
    editor.setEditable(false)
    const input = editor.view.dom.querySelector(".editor-quote__cite input") as HTMLInputElement
    input.dispatchEvent(new Event("focus"))
    expect(input.readOnly).toBe(true)
    input.value = "nope"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(editor.state.doc.nodeAt(posOf(editor, "blockquote"))!.attrs.cite).toBeNull()
  })

  it("Add caption does nothing once the editor turned read-only (a demotion)", () => {
    const editor = editorWithSeed()
    const add = editor.view.dom.querySelector(".editor-image__add-caption") as HTMLButtonElement
    editor.setEditable(false)
    add.click()
    expect(editor.state.doc.nodeAt(posOf(editor, "image"))!.childCount).toBe(0)
  })

  it("the cite field caps at CITE_MAX_LENGTH code points, not UTF-16 units", () => {
    const editor = editorWithSeed()
    const input = editor.view.dom.querySelector(".editor-quote__cite input") as HTMLInputElement
    input.value = "😀".repeat(CITE_MAX_LENGTH + 3)
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect([...editor.state.doc.nodeAt(posOf(editor, "blockquote"))!.attrs.cite].length).toBe(CITE_MAX_LENGTH)
  })
})

describe("caption, width and cite with collaboration, on the Hocuspocus relay (#346)", () => {
  let relay: Relay
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    relay = await startRelay({ blockDoc: canonical(seed), revision: 2 })
  })
  afterEach(async () => {
    while (editors.length) editors.pop()!.destroy()
    await relay.destroy()
    vi.restoreAllMocks()
  })

  it("one user's caption, width and cite reach the other user and the stored block_doc", async () => {
    const pa = relay.client("1")
    const pb = relay.client("2")
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => b.getText().includes("Quoted"), { what: "b to load" })

    // Width: wide, then full.
    a.commands.setNodeSelection(posOf(a, "image"))
    a.commands.setImageAlign("wide")
    await waitFor(() => b.state.doc.nodeAt(posOf(b, "image"))?.attrs.align === "wide", { what: "wide on b" })
    a.commands.setNodeSelection(posOf(a, "image"))
    a.commands.setImageAlign("full")

    // Caption with a link.
    a.commands.setNodeSelection(posOf(a, "image"))
    a.commands.toggleImageCaption()
    a.commands.insertContent([
      { type: "text", text: "Photo by " },
      { type: "text", text: "Ada", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
    ])

    // Cite, through the quote's field.
    const input = a.view.dom.querySelector(".editor-quote__cite input") as HTMLInputElement
    input.value = "Ada Lovelace"
    input.dispatchEvent(new Event("input", { bubbles: true }))

    await waitFor(() => JSON.stringify(b.state.doc.toJSON()) === JSON.stringify(a.state.doc.toJSON()), { what: "convergence" })
    const image = b.state.doc.nodeAt(posOf(b, "image"))!
    expect(image.attrs.align).toBe("full")
    expect(image.textContent).toBe("Photo by Ada")
    expect(b.state.doc.nodeAt(posOf(b, "blockquote"))!.attrs.cite).toBe("Ada Lovelace")
    expect((b.view.dom.querySelector(".editor-quote__cite input") as HTMLInputElement).value).toBe("Ada Lovelace")
    expect((b.view.dom.querySelector("figure.editor-image__figure") as HTMLElement).dataset.align).toBe("full")

    // The stored block_doc has them, valid and sanitized-shape.
    const stored = () => relay.api.posts.get("12")!.block_doc!
    await waitFor(() => (stored().blocks[QUOTE]?.attrs as any)?.cite === "Ada Lovelace" && (stored().blocks[IMG]?.attrs as any)?.caption?.length === 2, {
      what: "the store",
    })
    const doc = stored()
    expect(() => validateBlockDoc(doc)).not.toThrow()
    expect(doc.blocks[IMG]).toMatchObject({ version: 2, attrs: { src: "/uploads/a.png", mediaId: 5, align: "full" } })
    expect((doc.blocks[IMG].attrs as any).caption).toEqual([
      { type: "text", text: "Photo by " },
      { type: "text", text: "Ada", marks: [{ type: "link", attrs: expect.objectContaining({ href: "https://example.com" }) }] },
    ])
    expect(doc.blocks[QUOTE]).toMatchObject({ version: 2, attrs: { cite: "Ada Lovelace" } })

    // A third user opening the post later gets them from the server (the Yjs round trip).
    const pc = relay.client("3")
    await pc.whenSynced()
    const c = makeEditor(pc.doc)
    await waitFor(() => c.getText().includes("Quoted"), { what: "c to load" })
    expect(c.state.doc.toJSON()).toEqual(a.state.doc.toJSON())
  })
})
