import { act, useEffect, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { BlockActions } from "../utils/blockActions"

// The handle → block menu wiring (#356). jsdom has no layout, so TipTap's handle (which
// follows the pointer) is replaced by one that reports the second block as hovered, the
// way the real one calls onNodeChange.
const hover = { index: 1 }
vi.mock("@tiptap/extension-drag-handle-react", () => ({
  DragHandle: ({ editor, onNodeChange, children }: { editor: Editor; onNodeChange: (d: unknown) => void; children: ReactNode }) => {
    useEffect(() => {
      let pos = 0
      editor.state.doc.forEach((_node, offset, i) => {
        if (i === hover.index) pos = offset
      })
      onNodeChange({ editor, node: editor.state.doc.nodeAt(pos), pos })
    }, [editor, onNodeChange])
    return <div data-testid="tiptap-drag-handle">{children}</div>
  },
}))

const { default: DragHandle } = await import("./DragHandle")

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let editor: Editor
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockActions],
    content: "<h2>Intro</h2><p>alpha</p><h2>Usage</h2><p>end</p>",
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<DragHandle editor={editor} postUrl="http://site.test/post/7" />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  editor.destroy()
})

const handle = () => container.querySelector<HTMLButtonElement>('button[aria-label="Block menu"]')!
const blockMenu = () => document.querySelector('[role="menu"][aria-label="Block actions"]')

describe("DragHandle (#356)", () => {
  it("is a button that opens the block menu for the hovered block, and closes it again", () => {
    expect(handle().getAttribute("aria-haspopup")).toBe("menu")
    expect(handle().className).not.toContain("is-hidden")
    const transactions: boolean[] = []
    editor.on("transaction", ({ transaction }) => transactions.push(transaction.getMeta("lockDragHandle")))

    act(() => handle().click())
    expect(blockMenu()).not.toBeNull()
    expect(handle().getAttribute("aria-expanded")).toBe("true")
    // The handle is pinned while the menu is open (a meta-only transaction, no doc change).
    expect(transactions).toEqual([true])

    act(() => handle().click())
    expect(blockMenu()).toBeNull()
    expect(transactions).toEqual([true, false])
  })

  it("runs the menu's action on the hovered block", () => {
    act(() => handle().click())
    const duplicate = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) =>
      b.textContent?.startsWith("Duplicate")
    )!
    act(() => duplicate.click())
    const texts: string[] = []
    editor.state.doc.forEach((node) => texts.push(node.textContent))
    expect(texts).toEqual(["Intro", "alpha", "alpha", "Usage", "end"])
    expect(blockMenu()).toBeNull()
  })

  it("Ctrl Shift P opens Move to for the block holding the cursor", () => {
    editor.commands.setTextSelection(9) // inside "alpha"
    // jsdom gives no keyCode, which prosemirror-keymap maps "P" back to "p" with: send "p".
    const event = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
    act(() => {
      editor.view.someProp("handleKeyDown", (f) => f(editor.view, event))
    })
    const options = Array.from(document.querySelectorAll(".editor-move-to__text")).map((t) => t.textContent)
    expect(options).toEqual(["Intro", "Usage"])
  })
})
