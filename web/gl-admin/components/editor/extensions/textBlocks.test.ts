import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { DOMSerializer, type Node as PMNode } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { isBlockNode, validateBlockDoc } from "@gl-admin/lib/blocks-spec"
import { BlockNodeViews } from "./BlockNodeViews"
import { PasteSanitizer, sanitizePastedHTML } from "./PasteSanitizer"
import { CORE_BLOCKS } from "../blocks/catalog"

// The callout, pull quote and to-do list in the editor (#419): their commands, views and
// settings, read-only editors, block ids for to-do items (#238), and paste (#128).

let editor: Editor | null = null

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  const element = editor?.options.element as HTMLElement | undefined
  editor?.destroy()
  element?.remove()
  editor = null
  vi.restoreAllMocks()
})

const CALLOUT = "callout-aaaa-00000000"
const PULL = "pullqte-aaaa-00000000"
const TODO = "todolst-aaaa-00000000"
const T1 = "todoit1-aaaa-00000000"
const T2 = "todoit2-aaaa-00000000"
const AFTER = "after-aaaa-0000000000"

function makeEditor(content: object | string): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  editor = new Editor({
    element,
    extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockNodeViews, PasteSanitizer],
    content,
  })
  return editor
}

const para = (value: string, id?: string) => ({ type: "paragraph", ...(id ? { attrs: { "data-block-id": id } } : {}), content: [{ type: "text", text: value }] })

function doc() {
  return {
    type: "doc",
    content: [
      { type: "callout", attrs: { "data-block-id": CALLOUT, tone: "warning" }, content: [para("Mind the gap")] },
      { type: "pullQuote", attrs: { "data-block-id": PULL, cite: "Ana" }, content: [{ type: "text", text: "Set large" }] },
      {
        type: "taskList",
        attrs: { "data-block-id": TODO },
        content: [
          { type: "taskItem", attrs: { "data-block-id": T1, checked: true }, content: [para("done")] },
          { type: "taskItem", attrs: { "data-block-id": T2, checked: false }, content: [para("to do")] },
        ],
      },
      para("after", AFTER),
    ],
  }
}

function blockIds(node: PMNode): unknown[] {
  const ids: unknown[] = []
  const walk = (parent: PMNode, parentName: string | null) =>
    parent.forEach((child) => {
      if (isBlockNode(child.type.name, parentName)) ids.push(child.attrs["data-block-id"])
      if (!child.isTextblock) walk(child, child.type.name)
    })
  walk(node, null)
  return ids
}

function expectUniqueValidIds(node: PMNode) {
  const ids = blockIds(node)
  expect(ids.every((id) => typeof id === "string" && id.length >= 10)).toBe(true)
  expect(new Set(ids).size).toBe(ids.length)
}

/** The position inside the text of the first node with this id. */
function inside(ed: Editor, id: string): number {
  let at = -1
  ed.state.doc.descendants((node, pos) => {
    if (at === -1 && node.attrs["data-block-id"] === id) at = pos + 2
  })
  return at
}

const pasteEvent = () => new Event("paste") as ClipboardEvent
const entry = (id: string) => CORE_BLOCKS.find((e) => e.id === id)!

describe("inserting (#419)", () => {
  it("Callout wraps the line in an info callout; Pull quote turns it into one; To-do list makes an item", () => {
    for (const [id, check] of [
      ["callout", (n: PMNode) => n.type.name === "callout" && n.attrs.tone === "info" && n.firstChild!.type.name === "paragraph"],
      ["pull-quote", (n: PMNode) => n.type.name === "pullQuote" && n.attrs.cite === null],
      ["todo-list", (n: PMNode) => n.type.name === "taskList" && n.firstChild!.type.name === "taskItem" && n.firstChild!.attrs.checked === false],
    ] as const) {
      const ed = makeEditor("<p>first</p><p>/que</p>")
      const from = ed.state.doc.firstChild!.nodeSize + 1
      ed.commands.setTextSelection(from + 4)
      entry(id).insert(ed, { from, to: from + 4 })
      expect(check(ed.state.doc.child(1)), id).toBe(true)
      expectUniqueValidIds(ed.state.doc)
      expect(() => validateBlockDoc(pmToBlockDoc(ed.state.doc))).not.toThrow()
      editor!.destroy()
      editor = null
    }
  })

  it("Enter in a to-do item makes another, unchecked, with its own id", () => {
    const ed = makeEditor(doc())
    let end = 0
    ed.state.doc.descendants((node, pos) => {
      if (node.attrs["data-block-id"] === T1) end = pos + node.nodeSize - 2
    })
    ed.commands.setTextSelection(end)
    ed.commands.splitListItem("taskItem")
    ed.commands.insertContent("new")
    const list = ed.state.doc.child(2)
    expect(list.childCount).toBe(3)
    expect(list.child(1).attrs.checked).toBe(false)
    expect(list.child(1).textContent).toBe("new")
    expectUniqueValidIds(ed.state.doc)
    expect(list.child(0).attrs["data-block-id"]).toBe(T1)
  })
})

describe("the callout's tone (#419)", () => {
  it("the view shows the tone's icon and the Type buttons set it", () => {
    const ed = makeEditor(doc())
    const dom = ed.view.dom.querySelector(".editor-callout") as HTMLElement
    expect(dom.dataset.tone).toBe("warning")
    expect(dom.dataset.blockId).toBe(CALLOUT)
    expect(dom.querySelector(".editor-callout__icon svg")!.getAttribute("aria-hidden")).toBe("true")
    const button = (tone: string) => dom.querySelector(`button[data-tone="${tone}"]`) as HTMLButtonElement
    expect(button("warning").getAttribute("aria-pressed")).toBe("true")
    expect(button("info").textContent).toBe("Info")
    button("danger").click()
    expect(ed.state.doc.child(0).attrs.tone).toBe("danger")
    expect(dom.dataset.tone).toBe("danger")
    expect(button("danger").getAttribute("aria-pressed")).toBe("true")
    expect(button("warning").getAttribute("aria-pressed")).toBe("false")
  })

  it("setCalloutTone (the toolbar's picker) sets the callout the cursor is in, and nothing outside one", () => {
    const ed = makeEditor(doc())
    ed.commands.setTextSelection(inside(ed, CALLOUT))
    expect(ed.commands.setCalloutTone("success")).toBe(true)
    expect(ed.state.doc.child(0).attrs.tone).toBe("success")
    expect(ed.commands.setCalloutTone("loud" as never)).toBe(false)
    ed.commands.setTextSelection(ed.state.doc.content.size - 2)
    expect(ed.commands.setCalloutTone("danger")).toBe(false)
    expect(ed.state.doc.child(0).attrs.tone).toBe("success")
  })

  it("shows its settings while the cursor is in it; a read-only editor can't change it", () => {
    const ed = makeEditor(doc())
    ed.commands.setTextSelection(inside(ed, CALLOUT))
    expect((ed.view.dom.querySelector(".editor-callout") as HTMLElement).classList.contains("has-selection")).toBe(true)
    ed.setEditable(false)
    const dom = ed.view.dom.querySelector(".editor-callout") as HTMLElement
    ;(dom.querySelector('button[data-tone="info"]') as HTMLButtonElement).click()
    expect(ed.state.doc.child(0).attrs.tone).toBe("warning")
    ed.setEditable(true)
    ;(dom.querySelector('button[data-tone="info"]') as HTMLButtonElement).click()
    expect(ed.state.doc.child(0).attrs.tone).toBe("info")
  })
})

describe("the pull quote's citation (#419)", () => {
  it("its field sets cite as typed; empty is none", () => {
    const ed = makeEditor(doc())
    const input = ed.view.dom.querySelector(".editor-pullquote .editor-quote__cite input") as HTMLInputElement
    expect(input.value).toBe("Ana")
    expect(input.getAttribute("aria-label")).toBe("Pull quote citation")
    input.value = "Ana Costa, editor "
    input.dispatchEvent(new Event("input"))
    expect(ed.state.doc.child(1).attrs.cite).toBe("Ana Costa, editor ")
    // Stored trimmed (normalizeCite in the bridge).
    expect((pmToBlockDoc(ed.state.doc).blocks[PULL].attrs as any).cite).toBe("Ana Costa, editor")
    input.value = ""
    input.dispatchEvent(new Event("input"))
    expect(ed.state.doc.child(1).attrs.cite).toBeNull()
  })
})

describe("to-do checkboxes (#419)", () => {
  // TaskItem's own view: its <li> has no data-type (only its HTML for the clipboard does).
  const checkbox = (ed: Editor, index: number) => ed.view.dom.querySelectorAll<HTMLInputElement>('ul[data-type="taskList"] > li input[type="checkbox"]')[index]

  it("ticking one sets checked on that item; the label says what it is", () => {
    const ed = makeEditor(doc())
    const box = checkbox(ed, 1)
    expect(box.checked).toBe(false)
    expect(box.getAttribute("aria-label") ?? (box as any).ariaLabel).toBe("To do: to do")
    box.checked = true
    box.dispatchEvent(new Event("change"))
    expect(ed.state.doc.child(2).child(1).attrs.checked).toBe(true)
    expect((pmToBlockDoc(ed.state.doc).blocks[T2].attrs as any).checked).toBe(true)
  })

  it("a read-only editor (a view-only reader) can't tick anything", () => {
    const ed = makeEditor(doc())
    ed.setEditable(false)
    const box = checkbox(ed, 0)
    box.checked = false
    box.dispatchEvent(new Event("change"))
    expect(box.checked).toBe(true)
    expect(ed.state.doc.child(2).child(0).attrs.checked).toBe(true)
  })
})

describe("paste (#128)", () => {
  it("the editor's own clipboard brings each block back with its values and fresh ids", () => {
    const ed = makeEditor(doc())
    const end = ed.state.doc.child(0).nodeSize + ed.state.doc.child(1).nodeSize + ed.state.doc.child(2).nodeSize
    const wrap = document.createElement("div")
    wrap.append(DOMSerializer.fromSchema(ed.schema).serializeFragment(ed.state.doc.slice(0, end).content))
    ;(wrap.firstElementChild as HTMLElement).setAttribute("data-pm-slice", "0 0 []")
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, ed.state.doc.content.size - 1)))
    ed.view.pasteHTML(wrap.innerHTML, pasteEvent())

    const types: string[] = []
    ed.state.doc.forEach((node) => types.push(node.type.name))
    expect(types.filter((t) => t === "callout")).toHaveLength(2)
    const pasted = (name: string) => {
      const all: PMNode[] = []
      ed.state.doc.forEach((node) => node.type.name === name && all.push(node))
      return all[1]
    }
    expect(pasted("callout").attrs.tone).toBe("warning")
    expect(pasted("callout").attrs["data-block-id"]).not.toBe(CALLOUT)
    expect(pasted("pullQuote").attrs.cite).toBe("Ana")
    expect(pasted("pullQuote").textContent).toBe("Set large")
    expect(pasted("taskList").child(0).attrs.checked).toBe(true)
    expect(pasted("taskList").child(1).attrs.checked).toBe(false)
    expectUniqueValidIds(ed.state.doc)
    expect(() => validateBlockDoc(pmToBlockDoc(ed.state.doc))).not.toThrow()
  })

  it("keeps their attributes only on their own element, with valid values", () => {
    const out = (html: string) => sanitizePastedHTML(html)
    expect(out('<div data-type="callout" data-tone="danger"><p>a</p></div>')).toBe('<div data-type="callout" data-tone="danger"><p>a</p></div>')
    expect(out('<div data-type="callout" data-tone="loud"><p>a</p></div>')).toBe('<div data-type="callout"><p>a</p></div>')
    expect(out('<p data-type="callout" data-tone="info">a</p>')).toBe("<p>a</p>")
    expect(out('<div data-tone="info"><p>a</p></div>')).toBe("<div><p>a</p></div>")

    expect(out('<figure data-type="pull-quote" data-cite="  Ana \n"><blockquote>a</blockquote></figure>')).toBe(
      '<figure data-type="pull-quote" data-cite="Ana"><blockquote>a</blockquote></figure>',
    )
    expect(out('<figure data-type="pull-quote" data-cite="   "><blockquote>a</blockquote></figure>')).toBe(
      '<figure data-type="pull-quote"><blockquote>a</blockquote></figure>',
    )
    expect(out('<figure data-cite="Ana"><blockquote>a</blockquote></figure>')).toBe("<figure><blockquote>a</blockquote></figure>")

    expect(out('<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p>a</p></div></li></ul>')).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><div><p>a</p></div></li></ul>',
    )
    expect(out('<ul data-type="taskList"><li data-type="taskItem" data-checked="maybe"><p>a</p></li></ul>')).toBe(
      '<ul data-type="taskList"><li data-type="taskItem"><p>a</p></li></ul>',
    )
    expect(out('<ol data-type="taskList"><li data-checked="true"><p>a</p></li></ol>')).toBe("<ol><li><p>a</p></li></ol>")
  })

  it("a slice copied from inside a callout or a to-do item keeps its wrapper with attrs reset", () => {
    const sliceOf = (html: string) =>
      new DOMParser().parseFromString(sanitizePastedHTML(html), "text/html").body.firstElementChild!.getAttribute("data-pm-slice")
    const ctx = JSON.stringify(["callout", { tone: "danger", "data-block-id": CALLOUT }])
    expect(sliceOf(`<p data-pm-slice='1 1 ${ctx}'>a</p>`)).toBe('1 1 ["callout",null]')
    const todo = JSON.stringify(["taskList", {}, "taskItem", { checked: true }])
    expect(sliceOf(`<p data-pm-slice='2 2 ${todo}'>a</p>`)).toBe('2 2 ["taskList",null,"taskItem",null]')
  })
})
