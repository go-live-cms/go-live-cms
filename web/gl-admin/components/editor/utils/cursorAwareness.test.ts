// Guards for #305: a remote caret must never change line height. jsdom has no layout,
// so these pin the structure that caused it instead of measuring.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { createCaretElement, CursorAwareness, scrollToCollaborator } from "./cursorAwareness"

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
