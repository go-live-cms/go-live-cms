// Guards for #305: a remote caret must never change line height. jsdom has no layout,
// so these pin the structure that caused it instead of measuring.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import {
  createCaretElement,
  CursorAwareness,
  labelFlips,
  placeCaretLabels,
  safeCaretColor,
  scrollToCollaborator,
  stackLevel,
} from "./cursorAwareness"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")

describe("createCaretElement (#305)", () => {
  const caret = createCaretElement("Ada", "#5ad1a3", 2)
  const label = caret.querySelector<HTMLElement>(".collab-caret-label")

  it("is a zero-width bordered inline span, not a sized inline-block", () => {
    expect(caret.className).toBe("collab-caret")
    expect(caret.style.display).toBe("")
    expect(caret.style.height).toBe("")
    expect(caret.style.width).toBe("")
    expect(caret.style.borderLeft).toMatch(/2px solid/)
    expect(caret.style.marginLeft).toBe("-1px")
    expect(caret.style.marginRight).toBe("-1px")
  })

  it("holds a word joiner (no width, but the line's height) before the label", () => {
    expect(caret.firstChild?.nodeType).toBe(Node.TEXT_NODE)
    expect(caret.firstChild?.textContent).toBe(String.fromCharCode(0x2060))
  })

  it("keeps the label out of the flow, anchored above the caret, with its own typography", () => {
    expect(label?.textContent).toBe("Ada")
    expect(label?.parentElement).toBe(caret)
    expect(label?.style.position).toBe("absolute")
    expect(label?.style.top).toBe("0px")
    expect(label?.style.transform).toBe("translateY(-100%)")
    expect(label?.style.fontStyle).toBe("normal")
    expect(label?.style.textTransform).toBe("none")
  })
})

describe("TipTap base CSS ships with the editor styles (#305)", () => {
  it("_tiptap-base.scss neutralizes ProseMirror's separator image and editor.scss uses it", () => {
    const base = read("../../../assets/styles/components/editor/_tiptap-base.scss")
    expect(base).toMatch(/img\.ProseMirror-separator\s*\{[^}]*display:\s*inline !important[^}]*margin:\s*0 !important/)
    expect(read("../../../assets/styles/components/editor/editor.scss")).toMatch(/@use "\.\/tiptap-base"/)
  })

  it("the editor turns off TipTap's injection (a destroyed editor removes the shared tag)", () => {
    expect(read("../Editor.tsx")).toMatch(/injectCSS:\s*false/)
  })
})

// Presence "jump to cursor" (#356): the caret carries its awareness client id, and
// scrollToCollaborator scrolls to it.
describe("jump to a collaborator's caret (#356)", () => {
  const editors: Editor[] = []
  afterEach(() => {
    while (editors.length) {
      const editor = editors.pop()!
      const element = editor.options.element as HTMLElement | undefined
      editor.destroy()
      element?.remove()
    }
    vi.restoreAllMocks()
  })

  it("tags each caret with its awareness client id", () => {
    expect(createCaretElement("Ana", "#2a7e3b", 2, 42).dataset.clientId).toBe("42")
    expect(createCaretElement("Ana", "#2a7e3b").dataset.clientId).toBeUndefined()
  })

  function setup() {
    const awareness = new Awareness(new Y.Doc())
    const element = document.createElement("div")
    document.body.appendChild(element)
    const editor = new Editor({
      element,
      extensions: [StarterKit, CursorAwareness.configure({ awareness })],
      content: "<p>first line</p><p>second line</p>",
    })
    editors.push(editor)
    const remote = (clientId: number, selection: { anchor: number; head: number } | null) => {
      awareness.states.set(clientId, { user: { name: `User ${clientId}`, color: "#2a7e3b" }, selection })
      awareness.emit("change", [{ added: [clientId], updated: [], removed: [] }, "remote"])
    }
    const scrolled: Element[] = []
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this)
    })
    return { awareness, editor, remote, scrolled, element }
  }

  it("scrolls to the first of the person's tabs that has a caret", () => {
    // jsdom has no scrollIntoView; give it one to watch.
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
    const { awareness, editor, remote, scrolled } = setup()
    remote(7, null) // a tab whose window lost focus: no caret
    remote(8, { anchor: 15, head: 15 })
    expect(scrollToCollaborator(editor.view, awareness, [7, 8])).toBe(true)
    expect(scrolled).toHaveLength(1)
    expect((scrolled[0] as HTMLElement).dataset.clientId).toBe("8")
    // In the second paragraph (the caret's label is inline in its text).
    expect(scrolled[0].closest("p")?.textContent).toContain("cond line")
  })

  it("is false while the editor is hidden (History shows a version over it)", () => {
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
    const { awareness, editor, remote, scrolled, element } = setup()
    const host = document.createElement("div")
    host.hidden = true
    document.body.appendChild(host)
    host.appendChild(element)
    remote(8, { anchor: 3, head: 3 })
    expect(scrollToCollaborator(editor.view, awareness, [8])).toBe(false)
    expect(scrolled).toHaveLength(0)
    host.remove()
  })

  it("is false when none of them has a caret, and leaves this user's selection alone", () => {
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
    const { awareness, editor, remote, scrolled } = setup()
    remote(7, null)
    editor.commands.setTextSelection(3)
    expect(scrollToCollaborator(editor.view, awareness, [7, 99])).toBe(false)
    expect(scrolled).toHaveLength(0)
    expect(editor.state.selection.from).toBe(3)
  })
})

// Presence inside nested blocks (#417, "Others in nested layouts"): labels flip at a right
// edge and stack on the same spot, a block someone selected gets their outline and name,
// and only hex colours reach a style.
describe("caret labels in nested blocks (#417)", () => {
  it("a label flips to the caret's left when it would overflow the right edge", () => {
    expect(labelFlips(100, 60, 400)).toBe(false)
    expect(labelFlips(350, 60, 400)).toBe(true)
    expect(labelFlips(340, 60, 400)).toBe(false)
  })

  it("two labels on one spot stack; apart, or on other lines, they don't", () => {
    const placed = [{ left: 100, right: 160, top: 20, level: 0 }]
    expect(stackLevel({ left: 120, right: 180, top: 20 }, placed)).toBe(1)
    expect(stackLevel({ left: 170, right: 230, top: 20 }, placed)).toBe(0)
    expect(stackLevel({ left: 100, right: 160, top: 60 }, placed)).toBe(0)
    expect(stackLevel({ left: 100, right: 160, top: 20 }, [...placed, { left: 100, right: 160, top: 20, level: 1 }])).toBe(2)
  })

  function box(el: Element, left: number, top: number, width: number) {
    el.getBoundingClientRect = () => ({ left, top, right: left + width, bottom: top + 16, width, height: 16, x: left, y: top, toJSON: () => ({}) }) as DOMRect
  }

  it("placeCaretLabels flips at the edge of the caret's container, not the editor's", () => {
    const root = document.createElement("div")
    const column = document.createElement("div")
    column.setAttribute("data-collab-bounds", "")
    root.append(column)
    const near = createCaretElement("Priya Nair", "#7a3cc2", 2, 1)
    const far = createCaretElement("Sofia", "#2a7e3b", 2, 2)
    column.append(near, far)
    box(root, 0, 0, 1000)
    box(column, 0, 0, 300)
    box(near, 280, 40, 0)
    box(far, 40, 80, 0)
    for (const caret of [near, far]) Object.defineProperty(caret.querySelector(".collab-caret-label")!, "offsetWidth", { value: 70 })
    placeCaretLabels(root)
    const nearLabel = near.querySelector<HTMLElement>(".collab-caret-label")!
    const farLabel = far.querySelector<HTMLElement>(".collab-caret-label")!
    expect(nearLabel.classList.contains("is-flipped")).toBe(true)
    expect(nearLabel.style.right).toBe("-1px")
    expect(nearLabel.style.left).toBe("auto")
    expect(nearLabel.style.borderRadius).toBe("4px 4px 0 4px")
    expect(farLabel.classList.contains("is-flipped")).toBe(false)
    expect(farLabel.style.left).toBe("-1px")
  })

  it("placeCaretLabels stacks two labels at one caret position", () => {
    const root = document.createElement("div")
    const one = createCaretElement("Sofia Lima", "#2a7e3b", 2, 1)
    const two = createCaretElement("Ana Costa", "#b4261a", 2, 2)
    root.append(one, two)
    box(root, 0, 0, 1000)
    box(one, 100, 40, 0)
    box(two, 103, 40, 0)
    for (const caret of [one, two]) Object.defineProperty(caret.querySelector(".collab-caret-label")!, "offsetWidth", { value: 70 })
    placeCaretLabels(root)
    expect(one.querySelector<HTMLElement>(".collab-caret-label")!.style.transform).toBe("translateY(-100%)")
    expect(two.querySelector<HTMLElement>(".collab-caret-label")!.style.transform).toBe("translateY(calc(-100% * 2 - 2px))")
  })

  it("only a hex colour reaches a style", () => {
    expect(safeCaretColor("#2a7e3b")).toBe("#2a7e3b")
    expect(safeCaretColor("red; background: url(https://x.test/)")).toBe("#3b82f6")
    expect(safeCaretColor(undefined)).toBe("#3b82f6")
  })
})

describe("a block someone else selected (#417)", () => {
  const editors: Editor[] = []
  afterEach(() => {
    while (editors.length) editors.pop()!.destroy()
  })

  it("gets their outline and name on its top edge (in a group too), and no caret", () => {
    const awareness = new Awareness(new Y.Doc())
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [...Object.values(schemaExtensions({ collaborating: false })), CursorAwareness.configure({ awareness })],
      content: '<div data-type="group"><p>one</p><p>two</p></div><p>after</p>',
    })
    editors.push(editor)
    // The second paragraph in the group: positions 6..11.
    const group = editor.state.doc.firstChild!
    const from = 1 + group.firstChild!.nodeSize
    const to = from + group.child(1).nodeSize
    awareness.states.set(9, { user: { name: "Marco Ruiz", color: "#a3460a" }, selection: { anchor: from, head: to } })
    awareness.emit("change", [{ added: [9], updated: [], removed: [] }, "remote"])
    const outlined = editor.view.dom.querySelector<HTMLElement>(".collab-block-selection")!
    expect(outlined.tagName).toBe("P")
    expect(outlined.textContent).toBe("two")
    expect(outlined.getAttribute("data-collab-name")).toBe("Marco Ruiz")
    expect(outlined.style.getPropertyValue("--collab-color")).toBe("#a3460a")
    expect(editor.view.dom.querySelector(".collab-caret")).toBeNull()

    // A text selection inside it is a tint and a caret, as before.
    awareness.states.set(9, { user: { name: "Marco Ruiz", color: "#a3460a" }, selection: { anchor: from + 1, head: from + 3 } })
    awareness.emit("change", [{ added: [], updated: [9], removed: [] }, "remote"])
    expect(editor.view.dom.querySelector(".collab-block-selection")).toBeNull()
    expect(editor.view.dom.querySelector('.collab-caret[data-client-id="9"]')).not.toBeNull()
  })
})