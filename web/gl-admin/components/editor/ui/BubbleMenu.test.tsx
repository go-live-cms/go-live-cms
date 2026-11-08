import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import BubbleMenu from "./BubbleMenu"

// The selection toolbar's marks (#418, "Editor · text blocks", Paragraph): Highlight,
// Superscript and Subscript after Link, pressed when active, and not offered in a caption,
// which keeps bold, italic and link. TipTap's floating menu itself is replaced by its
// children here: what it shows, not where.

vi.mock("@tiptap/react/menus", () => ({
  BubbleMenu: ({ children }: { children: ReactNode }) => <div data-testid="bubble">{children}</div>,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const P = "blk-0418-bubble-00001"
const IMG = "blk-0418-bubble-image1"

let editor: Editor
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: Object.values(schemaExtensions({ collaborating: false })),
    content: {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { "data-block-id": P }, content: [{ type: "text", text: "alpha beta" }] },
        {
          type: "image",
          attrs: { src: "/uploads/a.png", "data-block-id": IMG },
          content: [{ type: "imageCaption", content: [{ type: "text", text: "Caption" }] }],
        },
      ],
    },
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  editor.destroy()
})

const labels = () => [...container.querySelectorAll<HTMLButtonElement>("[role=toolbar] button[aria-label]")].map((b) => b.getAttribute("aria-label"))
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

function show(from: number, to: number) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
  act(() => root.render(<BubbleMenu editor={editor} openLinkModal={() => {}} />))
}

describe("BubbleMenu marks (#418)", () => {
  it("offers Highlight, Superscript and Subscript after Link, and runs them", () => {
    show(1, 6) // "alpha"
    const marks = labels().filter((label) => label !== "Turn into")
    expect(marks.slice(-4)).toEqual(["Link", "Highlight", "Superscript", "Subscript"])
    expect(button("Highlight")!.getAttribute("aria-pressed")).toBe("false")

    act(() => button("Highlight")!.click())
    expect(editor.isActive("highlight")).toBe(true)
    act(() => root.render(<BubbleMenu editor={editor} openLinkModal={() => {}} />))
    expect(button("Highlight")!.getAttribute("aria-pressed")).toBe("true")

    act(() => button("Superscript")!.click())
    act(() => button("Subscript")!.click())
    act(() => root.render(<BubbleMenu editor={editor} openLinkModal={() => {}} />))
    // Subscript replaced superscript; the highlight stays.
    expect(button("Superscript")!.getAttribute("aria-pressed")).toBe("false")
    expect(button("Subscript")!.getAttribute("aria-pressed")).toBe("true")
    expect(editor.state.doc.firstChild!.firstChild!.marks.map((mark) => mark.type.name)).toEqual(["highlight", "subscript"])
  })

  it("isn't offered in a caption, which keeps bold, italic and link", () => {
    let from = 0
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "imageCaption") from = pos + 1
    })
    show(from, from + 3)
    expect(labels()).toEqual(["Bold", "Italic", "Link"])
  })
})
