import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { EMPTY_LINE_HINT, EMPTY_POST_HINT, getExtensions } from "./extensions"

// "Empty insert states" (#415): "Type / for blocks, or start writing" in a new post,
// "Type / for blocks" on an empty line, and only on the focused line, so a post never
// fills up with placeholder text.

stubJsdomRangeLayout()

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function makeEditor(content: string) {
  const element = document.createElement("div")
  document.body.appendChild(element)
  editor = new Editor({ element, extensions: getExtensions({ collabProvider: null })(), content })
  return editor
}

// TipTap tracks focus from the DOM's focus/blur (and redraws its decorations then).
const focus = (ed: Editor) => ed.view.dom.dispatchEvent(new FocusEvent("focus"))
const blur = (ed: Editor) => ed.view.dom.dispatchEvent(new FocusEvent("blur"))

const hints = (ed: Editor) =>
  Array.from(ed.view.dom.querySelectorAll<HTMLElement>("[data-placeholder]"))
    .map((el) => el.getAttribute("data-placeholder"))
    .filter(Boolean)

describe("the empty line hint", () => {
  it("shows the new-post hint in an empty, focused post", () => {
    const ed = makeEditor("<p></p>")
    expect(hints(ed)).toEqual([])
    focus(ed)
    expect(hints(ed)).toEqual([EMPTY_POST_HINT])
    expect(EMPTY_POST_HINT).toBe("Type / for blocks, or start writing")
    blur(ed)
    expect(hints(ed)).toEqual([])
  })

  it("shows on the focused empty line only, never on the others", () => {
    const ed = makeEditor("<p>alpha</p><p></p><p>beta</p><p></p>")
    ed.commands.setTextSelection(ed.state.doc.firstChild!.nodeSize + 1) // the first empty line
    focus(ed)
    expect(hints(ed)).toEqual([EMPTY_LINE_HINT])
    const lines = ed.view.dom.querySelectorAll("p")
    expect(lines[1].getAttribute("data-placeholder")).toBe("Type / for blocks")
    expect(lines[3].getAttribute("data-placeholder")).toBeNull()

    blur(ed)
    expect(hints(ed)).toEqual([])
  })

  it("keeps a heading's own placeholder", () => {
    const ed = makeEditor("<p>alpha</p><h2></h2>")
    ed.commands.setTextSelection(ed.state.doc.firstChild!.nodeSize + 1)
    focus(ed)
    expect(hints(ed)).toEqual(["Heading 2…"])
  })
})
