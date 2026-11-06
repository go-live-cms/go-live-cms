import { act, useEffect, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { BlockActions } from "../utils/blockActions"
import { BlockGutterKeys } from "../utils/blockGutter"

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
// Inserting from + focuses the editor, which scrolls the selection into view.
stubJsdomRangeLayout()

let editor: Editor
let container: HTMLDivElement
let root: Root

function mount(content: string) {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockActions, BlockGutterKeys],
    content,
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<DragHandle editor={editor} postUrl="http://site.test/post/7" />))
}

beforeEach(() => {
  hover.index = 1
  mount("<h2>Intro</h2><p>alpha</p><h2>Usage</h2><p>end</p>")
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  editor.destroy()
})

const handle = () => container.querySelector<HTMLButtonElement>('button[aria-label="Block menu"]')!
const addButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Add block"]')!
const addMenu = () => document.querySelector<HTMLElement>(".editor-insert--add")
const search = () => addMenu()!.querySelector<HTMLInputElement>('input[role="combobox"]')!
const texts = () => {
  const out: string[] = []
  editor.state.doc.forEach((node) => out.push(`${node.type.name}:${node.textContent}`))
  return out
}
// useFloating places the menu asynchronously (floating-ui's computePosition); focus moves in after.
const placed = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
})
function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
function key(target: HTMLElement, name: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }))
  })
}
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

describe("+ in the margin (#415)", () => {
  it("is a button beside the handle that opens the block list with its own search field, focused", async () => {
    expect(addButton().nextElementSibling).toBe(handle())
    expect(addButton().getAttribute("aria-haspopup")).toBe("listbox")
    act(() => addButton().click())
    await placed()
    expect(addMenu()).not.toBeNull()
    expect(addButton().getAttribute("aria-expanded")).toBe("true")
    expect(document.activeElement).toBe(search())
    expect(search().getAttribute("aria-controls")).toBe(addMenu()!.querySelector('[role="listbox"]')!.id)
    expect(search().getAttribute("aria-activedescendant")).toBe(addMenu()!.querySelector('[aria-selected="true"]')!.id)
    expect(addMenu()!.querySelector(".editor-insert__footer")!.textContent).toBe("Type to search↑↓ ↵esc returns to +")
  })

  it("Esc closes it and returns focus to +, leaving the post as it was", async () => {
    const before = texts()
    act(() => addButton().click())
    await placed()
    typeInto(search(), "quo")
    key(search(), "Escape")
    expect(addMenu()).toBeNull()
    expect(document.activeElement).toBe(addButton())
    expect(addButton().getAttribute("aria-expanded")).toBe("false")
    expect(texts()).toEqual(before)
  })

  it("searches, moves with the arrows across groups, and ↵ inserts on a new line below the block", async () => {
    act(() => addButton().click())
    await placed()
    typeInto(search(), "i")
    const names = () => Array.from(addMenu()!.querySelectorAll('[role="option"] .editor-insert__name')).map((n) => n.textContent)
    // Callout by its keyword "info" (#419), Image by its name.
    expect(names()).toEqual(["Callout", "Image"])
    typeInto(search(), "l")
    // Three names ("list") in Text, one keyword ("line") in Layout.
    expect(names()).toEqual(["Bulleted list", "Numbered list", "To-do list", "Divider"])
    key(search(), "ArrowDown")
    key(search(), "ArrowDown")
    key(search(), "ArrowDown")
    expect(addMenu()!.querySelector('[aria-selected="true"] .editor-insert__name')!.textContent).toBe("Divider")
    key(search(), "ArrowDown") // wraps
    expect(addMenu()!.querySelector('[aria-selected="true"] .editor-insert__name')!.textContent).toBe("Bulleted list")
    key(search(), "ArrowUp")
    key(search(), "Enter")
    expect(addMenu()).toBeNull()
    expect(texts().slice(0, 3)).toEqual(["heading:Intro", "paragraph:alpha", "horizontalRule:"])
    expect(texts().slice(-2)).toEqual(["heading:Usage", "paragraph:end"])
  })

  it("on an empty line, makes that line the block", async () => {
    act(() => root.unmount())
    container.remove()
    editor.destroy()
    hover.index = 1
    mount("<p>alpha</p><p></p><p>end</p>")
    // An empty line has + but no drag handle.
    expect(handle().className).toContain("is-hidden")
    expect(handle().tabIndex).toBe(-1)
    act(() => addButton().click())
    await placed()
    typeInto(search(), "heading 2")
    key(search(), "Enter")
    expect(texts()).toEqual(["paragraph:alpha", "heading:", "paragraph:end"])
    expect(editor.state.doc.child(1).attrs.level).toBe(2)
  })

  it("says nothing matches, and ↵ then does nothing", async () => {
    const before = texts()
    act(() => addButton().click())
    await placed()
    typeInto(search(), "map")
    expect(addMenu()!.querySelector('[role="status"]')!.textContent).toContain("No blocks match “map”")
    expect(search().getAttribute("aria-expanded")).toBe("false")
    key(search(), "Enter")
    expect(addMenu()).not.toBeNull()
    expect(texts()).toEqual(before)
  })

  it("is reached from the text with Tab, at the caret's block", () => {
    editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize + 2) // inside "alpha"
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    let handled = false
    act(() => {
      handled = !!editor.view.someProp("handleKeyDown", (f) => f(editor.view, event))
    })
    expect(handled).toBe(true)
    expect(document.activeElement).toBe(addButton())
    // Space / Enter on a button is a click.
    act(() => addButton().click())
    expect(addMenu()).not.toBeNull()
  })

  it("leaves Tab to the browser in a code block", () => {
    act(() => root.unmount())
    container.remove()
    editor.destroy()
    mount("<pre><code>x</code></pre>")
    editor.commands.setTextSelection(2)
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    let handled = true
    act(() => {
      handled = !!editor.view.someProp("handleKeyDown", (f) => f(editor.view, event))
    })
    expect(handled).toBe(false)
    expect(document.activeElement).not.toBe(addButton())
  })
})
