import { describe, it, expect, afterEach } from "vitest"
import { Editor } from "@tiptap/core"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import {
  BlockActions,
  blockLink,
  canColor,
  deleteBlock,
  duplicateBlock,
  listHeadings,
  moveBlockUnder,
  refOf,
  setBlockColor,
  topLevelBlockAt,
  topLevelBlockAtSelection,
  withoutBlockIds,
  type BlockRef,
} from "./blockActions"

// The block menu's actions (#356) on one headless editor with the real schema and
// BlockIdExtension. Two editors on the collab server: blockActions.collab.test.ts.

const editors: Editor[] = []
afterEach(() => {
  while (editors.length) editors.pop()!.destroy()
})

const ID = (n: number) => `blk-${String(n).padStart(4, "0")}-000000000`

function makeEditor(content: object): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockActions],
    content,
  })
  editors.push(editor)
  return editor
}

const p = (id: number, text: string, attrs: object = {}) => ({
  type: "paragraph",
  attrs: { "data-block-id": ID(id), ...attrs },
  content: [{ type: "text", text }],
})
const h = (id: number, text: string, level = 2) => ({
  type: "heading",
  attrs: { "data-block-id": ID(id), level },
  content: [{ type: "text", text }],
})
const li = (id: number, text: string, nested?: object) => ({
  type: "listItem",
  attrs: { "data-block-id": ID(id) },
  content: [{ type: "paragraph", content: [{ type: "text", text }] }, ...(nested ? [nested] : [])],
})

const DOC = {
  type: "doc",
  content: [
    h(1, "First"),
    p(2, "alpha"),
    h(3, "Second", 3),
    p(4, "beta"),
    { type: "bulletList", attrs: { "data-block-id": ID(5) }, content: [li(6, "one"), li(7, "two", { type: "bulletList", content: [li(8, "deep")] })] },
    // Ends in a paragraph: after a final list TipTap's TrailingNode would append one.
    p(9, "end"),
  ],
}

const texts = (editor: Editor) => {
  const out: string[] = []
  editor.state.doc.forEach((node) => out.push(node.textContent))
  return out
}
const ref = (editor: Editor, index: number): BlockRef => {
  let at = 0
  editor.state.doc.forEach((_node, offset, i) => {
    if (i === index) at = offset
  })
  return refOf(topLevelBlockAt(editor.state.doc, at)!)
}
const allIds = (editor: Editor) => {
  const ids: string[] = []
  editor.state.doc.descendants((node, _pos, parent) => {
    if (parent === editor.state.doc || node.type.name === "listItem") ids.push(node.attrs["data-block-id"])
    return !node.isTextblock
  })
  return ids
}

describe("withoutBlockIds", () => {
  it("removes every block id, at any depth, and nothing else", () => {
    const list = DOC.content[4]
    const out = withoutBlockIds(list)
    expect(JSON.stringify(out)).not.toContain("data-block-id")
    expect(JSON.stringify(out)).toContain('"text":"deep"')
    expect(JSON.stringify(list)).toContain(ID(8)) // the input is untouched
  })
})

describe("finding blocks", () => {
  it("topLevelBlockAt and topLevelBlockAtSelection find the top-level block", () => {
    const editor = makeEditor(DOC)
    const second = topLevelBlockAt(editor.state.doc, 0)!
    expect(second.node.attrs["data-block-id"]).toBe(ID(1))
    // A cursor deep in the nested list item belongs to the list.
    let deepPos = 0
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "deep") deepPos = pos + 1
    })
    editor.commands.setTextSelection(deepPos)
    expect(topLevelBlockAtSelection(editor.state)?.node.attrs["data-block-id"]).toBe(ID(5))
    expect(topLevelBlockAt(editor.state.doc, editor.state.doc.content.size)).toBeNull()
  })

  it("listHeadings lists the top-level headings with their levels and text", () => {
    const editor = makeEditor(DOC)
    expect(listHeadings(editor.state.doc).map(({ id, level, text }) => ({ id, level, text }))).toEqual([
      { id: ID(1), level: 2, text: "First" },
      { id: ID(3), level: 3, text: "Second" },
    ])
  })
})

describe("duplicateBlock", () => {
  it("puts a copy right below with new ids for the block and every list item", () => {
    const editor = makeEditor(DOC)
    const before = allIds(editor)
    expect(duplicateBlock(editor, ref(editor, 4))).not.toBeNull()
    expect(texts(editor)).toEqual(["First", "alpha", "Second", "beta", "onetwodeep", "onetwodeep", "end"])
    const ids = allIds(editor)
    expect(new Set(ids).size).toBe(ids.length)
    // Every original id is still there, in order; the copy's 4 ids are all new.
    expect(ids.filter((id) => before.includes(id))).toEqual(before)
    expect(ids).toHaveLength(before.length + 4)
    const copy = editor.state.doc.child(5)
    expect(copy.attrs["data-block-id"]).not.toBe(ID(5))
    // The cursor goes into the copy.
    expect(topLevelBlockAtSelection(editor.state)?.node).toBe(copy)
  })

  it("keeps the block's attributes: level, alignment, colour", () => {
    const editor = makeEditor({ type: "doc", content: [p(1, "x", { textAlign: "center", blockColor: "red" })] })
    duplicateBlock(editor, ref(editor, 0))
    const copy = editor.state.doc.child(1)
    expect(copy.attrs).toMatchObject({ textAlign: "center", blockColor: "red" })
    expect(copy.attrs["data-block-id"]).not.toBe(ID(1))
  })

  it("Ctrl D duplicates the block holding the cursor", () => {
    const editor = makeEditor(DOC)
    editor.commands.setTextSelection(10) // inside "alpha"
    // jsdom isn't a Mac: Mod is Ctrl.
    const event = new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true })
    editor.view.someProp("handleKeyDown", (f) => f(editor.view, event))
    expect(texts(editor).filter((t) => t === "alpha")).toHaveLength(2)
  })

  it("does nothing for a block that isn't there any more", () => {
    const editor = makeEditor(DOC)
    expect(duplicateBlock(editor, { id: "blk-gone-000000000", pos: 0 })).toBeNull()
    expect(texts(editor)).toHaveLength(6)
  })
})

describe("moveBlockUnder", () => {
  it("moves a block from below up under a heading, keeping its id", () => {
    const editor = makeEditor(DOC)
    expect(moveBlockUnder(editor, ref(editor, 3), ref(editor, 0))).toBe(true)
    expect(texts(editor)).toEqual(["First", "beta", "alpha", "Second", "onetwodeep", "end"])
    expect(editor.state.doc.child(1).attrs["data-block-id"]).toBe(ID(4))
  })

  it("moves a block from above down under a heading, children and ids included", () => {
    const editor = makeEditor({ type: "doc", content: [DOC.content[4], ...DOC.content.slice(0, 4), DOC.content[5]] })
    const before = allIds(editor)
    expect(moveBlockUnder(editor, ref(editor, 0), ref(editor, 3))).toBe(true)
    expect(texts(editor)).toEqual(["First", "alpha", "Second", "onetwodeep", "beta", "end"])
    expect(allIds(editor).sort()).toEqual(before.sort())
  })

  it("moves a heading under another heading", () => {
    const editor = makeEditor(DOC)
    expect(moveBlockUnder(editor, ref(editor, 2), ref(editor, 0))).toBe(true)
    expect(texts(editor)).toEqual(["First", "Second", "alpha", "beta", "onetwodeep", "end"])
  })

  it("is a no-op when the block is already right under the heading", () => {
    const editor = makeEditor(DOC)
    const doc = editor.state.doc
    expect(moveBlockUnder(editor, ref(editor, 1), ref(editor, 0))).toBe(true)
    expect(editor.state.doc.eq(doc)).toBe(true)
  })

  it("refuses the heading itself, a target that isn't a heading, and missing blocks", () => {
    const editor = makeEditor(DOC)
    expect(moveBlockUnder(editor, ref(editor, 0), ref(editor, 0))).toBe(false)
    expect(moveBlockUnder(editor, ref(editor, 3), ref(editor, 1))).toBe(false)
    expect(moveBlockUnder(editor, { id: "blk-gone-000000000", pos: 0 }, ref(editor, 0))).toBe(false)
    expect(texts(editor)).toEqual(["First", "alpha", "Second", "beta", "onetwodeep", "end"])
  })
})

describe("setBlockColor", () => {
  it("sets and clears a palette colour on the blocks that take one", () => {
    const editor = makeEditor(DOC)
    expect(setBlockColor(editor, ref(editor, 1), "green")).toBe(true)
    expect(editor.state.doc.child(1).attrs.blockColor).toBe("green")
    expect(setBlockColor(editor, ref(editor, 4), "pink-background")).toBe(true)
    expect(editor.state.doc.child(4).attrs.blockColor).toBe("pink-background")
    expect(setBlockColor(editor, ref(editor, 1), null)).toBe(true)
    expect(editor.state.doc.child(1).attrs.blockColor).toBeNull()
  })

  it("refuses anything outside the palette, and blocks without a colour", () => {
    const editor = makeEditor({
      type: "doc",
      content: [p(1, "x"), { type: "horizontalRule", attrs: { "data-block-id": ID(2) } }, p(3, "y")],
    })
    expect(setBlockColor(editor, ref(editor, 0), "#ff0000" as never)).toBe(false)
    expect(setBlockColor(editor, ref(editor, 0), "url(x)" as never)).toBe(false)
    expect(editor.state.doc.child(0).attrs.blockColor).toBeNull()
    expect(canColor(editor.state.doc.child(1))).toBe(false)
    expect(setBlockColor(editor, ref(editor, 1), "red")).toBe(false)
  })
})

describe("deleteBlock", () => {
  it("removes the block and everything in it", () => {
    const editor = makeEditor(DOC)
    expect(deleteBlock(editor, ref(editor, 4))).toBe(true)
    expect(texts(editor)).toEqual(["First", "alpha", "Second", "beta", "end"])
  })
})

describe("blockLink", () => {
  it("is the post URL with #b-<block id>", () => {
    expect(blockLink("https://site.test/post/hello", ID(4))).toBe(`https://site.test/post/hello#b-${ID(4)}`)
    expect(blockLink("https://site.test/post/hello#old", ID(4))).toBe(`https://site.test/post/hello#b-${ID(4)}`)
  })

  it("is null without a post URL or a usable id", () => {
    expect(blockLink(null, ID(4))).toBeNull()
    expect(blockLink("https://site.test/post/1", null)).toBeNull()
    expect(blockLink("https://site.test/post/1", "short")).toBeNull()
    expect(blockLink("https://site.test/post/1", 'x"><script>')).toBeNull()
  })
})
