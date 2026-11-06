import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { DOMSerializer, type Node as PMNode } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { isBlockNode, validateBlockDoc } from "@gl-admin/lib/blocks-spec"
import { BlockNodeViews } from "./BlockNodeViews"
import { PasteSanitizer, sanitizePastedHTML } from "./PasteSanitizer"
import { duplicateBlock } from "../utils/blockActions"

// The Group block in the editor (#414): its commands and view, where the schema lets it
// go, and fresh, unique ids for every nested block after a split, a duplicate and a paste
// (#238, #356, #128).

let editor: Editor | null = null

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  editor?.destroy()
  editor = null
  vi.restoreAllMocks()
})

const GROUP = "group-aaaa-0000000000"
const INNER = "inner-aaaa-0000000000"
const SECOND = "secnd-aaaa-0000000000"
const AFTER = "after-aaaa-0000000000"

function makeEditor(content: object): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  editor = new Editor({
    element,
    extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockNodeViews, PasteSanitizer],
    content,
  })
  return editor
}

function groupDoc() {
  return {
    type: "doc",
    content: [
      {
        type: "group",
        attrs: { "data-block-id": GROUP, style: "tinted" },
        content: [
          { type: "paragraph", attrs: { "data-block-id": INNER }, content: [{ type: "text", text: "inside" }] },
          {
            type: "bulletList",
            attrs: { "data-block-id": SECOND },
            content: [{ type: "listItem", attrs: { "data-block-id": "item-aaaa-0000000000" }, content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }],
          },
        ],
      },
      { type: "paragraph", attrs: { "data-block-id": AFTER }, content: [{ type: "text", text: "after" }] },
    ],
  }
}

/** Every block id in the doc (by the shared predicate), in document order. */
function blockIds(doc: PMNode): unknown[] {
  const ids: unknown[] = []
  const walk = (node: PMNode, parentName: string | null) =>
    node.forEach((child) => {
      if (isBlockNode(child.type.name, parentName)) ids.push(child.attrs["data-block-id"])
      if (!child.isTextblock) walk(child, child.type.name)
    })
  walk(doc, null)
  return ids
}

function expectUniqueValidIds(doc: PMNode) {
  const ids = blockIds(doc)
  for (const id of ids) expect(typeof id === "string" && id.length >= 10, String(id)).toBe(true)
  expect(new Set(ids).size).toBe(ids.length)
  expect(() => validateBlockDoc(pmToBlockDoc(doc))).not.toThrow()
}

const pasteEvent = () => new Event("paste") as ClipboardEvent

describe("Group in the schema (#414)", () => {
  it("is a container the doc holds, not a `block` a quote, list item or theme block could hold", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "paragraph" }] })
    const { nodes } = ed.schema
    expect(nodes.doc.contentMatch.matchType(nodes.group)).toBeTruthy()
    expect(nodes.group.spec.group).toBeUndefined()
    expect(nodes.blockquote.contentMatch.matchType(nodes.group)).toBeNull()
    expect(nodes.listItem.contentMatch.matchType(nodes.paragraph)!.matchType(nodes.group)).toBeNull()
    expect(nodes.group.contentMatch.matchType(nodes.group)).toBeNull()
    expect(nodes.group.contentMatch.matchType(nodes.image)).toBeTruthy()
    expect(nodes.group.spec.isolating).toBe(true)
  })
})

describe("Group commands", () => {
  it("setGroup wraps the current block, and BlockIdExtension stamps the group and its child", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] })
    ed.commands.setTextSelection(3)
    expect(ed.commands.setGroup()).toBe(true)
    const group = ed.state.doc.child(0)
    expect(group.type.name).toBe("group")
    expect(group.attrs).toMatchObject({ style: "none", align: "content" })
    expect(group.child(0).textContent).toBe("hello")
    // The cursor stays in the paragraph, now inside the group.
    expect(ed.state.selection.$from.node(1).type.name).toBe("group")
    expectUniqueValidIds(ed.state.doc)
  })

  it("setGroup refuses where a group can't go: inside a group, a quote or a list item", () => {
    const ed = makeEditor(groupDoc())
    ed.commands.setTextSelection(3)
    expect(ed.commands.setGroup()).toBe(false)
    const quote = makeEditor({ type: "doc", content: [{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "q" }] }] }] })
    quote.commands.setTextSelection(2)
    expect(quote.can().setGroup()).toBe(false)
  })

  it("setGroupAttrs sets the style and width of the group the cursor is in", () => {
    const ed = makeEditor(groupDoc())
    ed.commands.setTextSelection(3)
    expect(ed.commands.setGroupAttrs({ align: "full", style: "none" })).toBe(true)
    expect(ed.state.doc.child(0).attrs).toMatchObject({ align: "full", style: "none", "data-block-id": GROUP })
    expect(ed.commands.setGroupAttrs({ style: "loud" as any })).toBe(false)
    // Outside any group.
    ed.commands.setTextSelection(ed.state.doc.content.size - 2)
    expect(ed.commands.setGroupAttrs({ style: "tinted" })).toBe(false)
  })
})

describe("ids inside a group (#238 at depth)", () => {
  it("a split inside a group gives the new block a fresh id; the original and the group keep theirs", () => {
    const ed = makeEditor(groupDoc())
    // doc > group(0) > paragraph(1) > "inside" at 2..8: split in the middle.
    ed.commands.setTextSelection(5)
    expect(ed.commands.splitBlock()).toBe(true)
    const group = ed.state.doc.child(0)
    expect(group.childCount).toBe(3)
    expect(group.attrs["data-block-id"]).toBe(GROUP)
    expect(group.child(0).attrs["data-block-id"]).toBe(INNER)
    expect(group.child(1).attrs["data-block-id"]).not.toBe(INNER)
    expectUniqueValidIds(ed.state.doc)
  })

  it("Duplicate (#356) copies the group with fresh ids for it and every block in it", () => {
    const ed = makeEditor(groupDoc())
    const before = new Set(blockIds(ed.state.doc))
    const at = duplicateBlock(ed, { id: GROUP, pos: 0 })
    expect(at).not.toBeNull()
    const copy = ed.state.doc.nodeAt(at!)!
    expect(copy.type.name).toBe("group")
    expect(copy.attrs.style).toBe("tinted")
    expect(copy.textContent).toBe("insideitem")
    const copyIds: unknown[] = [copy.attrs["data-block-id"], ...blockIds(ed.state.doc.type.create(null, copy.content))]
    for (const id of copyIds) expect(before.has(id)).toBe(false)
    expectUniqueValidIds(ed.state.doc)
  })

  it("pasting a whole group (the editor's own clipboard) gives a group with its attrs and fresh ids", () => {
    const ed = makeEditor(groupDoc())
    const groupEnd = ed.state.doc.child(0).nodeSize
    const wrap = document.createElement("div")
    wrap.append(DOMSerializer.fromSchema(ed.schema).serializeFragment(ed.state.doc.slice(0, groupEnd).content))
    ;(wrap.firstElementChild as HTMLElement).setAttribute("data-pm-slice", "0 0 []")
    expect(wrap.innerHTML).toContain(GROUP)
    // Paste at the end of the last paragraph.
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, ed.state.doc.content.size - 1)))
    ed.view.pasteHTML(wrap.innerHTML, pasteEvent())
    const groups: PMNode[] = []
    ed.state.doc.forEach((node) => node.type.name === "group" && groups.push(node))
    expect(groups).toHaveLength(2)
    expect(groups[1].attrs.style).toBe("tinted")
    expect(groups[1].attrs["data-block-id"]).not.toBe(GROUP)
    expect(groups[1].textContent).toBe("insideitem")
    expectUniqueValidIds(ed.state.doc)
  })

  it("pasting a slice copied from inside a group recreates a default group with no copied ids", () => {
    const ed = makeEditor(groupDoc())
    // The inner paragraph, as ProseMirror copies it: the group is its slice context.
    const context = JSON.stringify(["group", { style: "tinted", align: "wide", "data-block-id": GROUP }])
    const html = `<p data-pm-slice='1 1 ${context}' data-block-id="${INNER}">inside</p>`
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, ed.state.doc.content.size - 1)))
    ed.view.pasteHTML(html, pasteEvent())
    expectUniqueValidIds(ed.state.doc)
    expect(blockIds(ed.state.doc).filter((id) => id === INNER || id === GROUP)).toHaveLength(2)
  })
})

describe("paste sanitizer and containers (#128)", () => {
  const sliceOf = (html: string) =>
    new DOMParser().parseFromString(sanitizePastedHTML(html), "text/html").body.firstElementChild!.getAttribute("data-pm-slice")

  it("keeps a group as a slice context, with its attrs (and copied id) reset", () => {
    const ctx = JSON.stringify(["group", { style: "tinted", "data-block-id": GROUP }, "bulletList", {}])
    expect(sliceOf(`<p data-pm-slice='1 1 ${ctx}'>a</p>`)).toBe('1 1 ["group",null,"bulletList",null]')
  })

  it("keeps data-type, data-style and data-align only on a group's div, with valid values", () => {
    const out = (html: string) => sanitizePastedHTML(html)
    expect(out('<div data-type="group" data-style="tinted" data-align="wide"><p>a</p></div>')).toBe(
      '<div data-type="group" data-style="tinted" data-align="wide"><p>a</p></div>',
    )
    expect(out('<div data-type="group" data-style="loud" data-align="huge"><p>a</p></div>')).toBe('<div data-type="group"><p>a</p></div>')
    expect(out('<p data-type="group" data-style="tinted">a</p>')).toBe("<p>a</p>")
    expect(out('<div data-type="columns"><p>a</p></div>')).toBe("<div><p>a</p></div>")
    expect(out('<div data-style="tinted" data-align="wide"><p>a</p></div>')).toBe("<div><p>a</p></div>")
    expect(out('<div data-type="group" data-block-id="x-0000000000"><p>a</p></div>')).toBe('<div data-type="group"><p>a</p></div>')
  })
})

describe("the group's view (#414)", () => {
  it("its Width and Background buttons set the attrs, and show what is set", () => {
    const ed = makeEditor(groupDoc())
    const dom = ed.view.dom.querySelector(".editor-group") as HTMLElement
    expect(dom.dataset.style).toBe("tinted")
    expect(dom.dataset.blockId).toBe(GROUP)
    const button = (attr: string, value: string) => dom.querySelector(`button[data-attr="${attr}"][data-value="${value}"]`) as HTMLButtonElement
    expect(button("style", "tinted").getAttribute("aria-pressed")).toBe("true")
    button("align", "wide").click()
    expect(ed.state.doc.child(0).attrs.align).toBe("wide")
    button("style", "none").click()
    expect(ed.state.doc.child(0).attrs.style).toBe("none")
    const after = ed.view.dom.querySelector(".editor-group") as HTMLElement
    expect(after.dataset.align).toBe("wide")
    expect((after.querySelector('button[data-attr="align"][data-value="wide"]') as HTMLElement).getAttribute("aria-pressed")).toBe("true")
  })

  it("shows its settings while the cursor is in it, and not to a read-only editor", () => {
    const ed = makeEditor(groupDoc())
    ed.commands.setTextSelection(3)
    expect((ed.view.dom.querySelector(".editor-group") as HTMLElement).classList.contains("has-selection")).toBe(true)
    ed.commands.setTextSelection(ed.state.doc.content.size - 2)
    expect((ed.view.dom.querySelector(".editor-group") as HTMLElement).classList.contains("has-selection")).toBe(false)
    ed.setEditable(false)
    const dom = ed.view.dom.querySelector(".editor-group") as HTMLElement
    ;(dom.querySelector('button[data-attr="align"][data-value="full"]') as HTMLButtonElement).click()
    expect(ed.state.doc.child(0).attrs.align).toBe("content")
    // Promoted back (no node update in between): the same buttons work again.
    ed.setEditable(true)
    ;(dom.querySelector('button[data-attr="align"][data-value="full"]') as HTMLButtonElement).click()
    expect(ed.state.doc.child(0).attrs.align).toBe("full")
  })
})
