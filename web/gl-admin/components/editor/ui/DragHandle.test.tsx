import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { BlockActions, refOf, topLevelBlockAt } from "../utils/blockActions"
import { BlockGutterKeys } from "../utils/blockGutter"
import { BlockNodeViews } from "../extensions/BlockNodeViews"
import { BlockNavigationKeys, BlockSelectionKeys } from "../extensions/BlockNavigation"
import { editorBlockById, refOfBlock } from "../utils/blockTree"
import DragHandle from "./DragHandle"

// The handle → block menu wiring (#356), on the gutter plugin (#417). jsdom has no layout,
// so instead of a pointer, `hover` shows the gutter at a block the way the plugin does when
// the pointer reaches it (the same path Tab uses).

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Inserting from + focuses the editor, which scrolls the selection into view.
stubJsdomRangeLayout()

let editor: Editor
let element: HTMLDivElement
let container: HTMLDivElement
let root: Root

type GutterStorage = { blockGutter: { focusAddButton: ((ref: { id: string | null; pos: number }) => boolean) | null } }

/** Shows the gutter at the top-level block `index` (or a block by id). */
function hover(at: number | string) {
  const ref =
    typeof at === "string"
      ? refOfBlock(editorBlockById(editor.state.doc, at)!)
      : (() => {
          let pos = 0
          editor.state.doc.forEach((_node, offset, i) => {
            if (i === at) pos = offset
          })
          return refOf(topLevelBlockAt(editor.state.doc, pos)!)
        })()
  act(() => {
    ;(editor.storage as unknown as GutterStorage).blockGutter.focusAddButton!(ref)
  })
}

function mount(content: string, hovered: number | null = 1) {
  element = document.createElement("div")
  document.body.appendChild(element)
  editor = new Editor({
    element,
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: false })),
      BlockNodeViews,
      BlockActions,
      BlockGutterKeys,
      BlockSelectionKeys,
      BlockNavigationKeys,
    ],
    content,
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<DragHandle editor={editor} postUrl="http://site.test/post/7" />))
  if (hovered !== null) hover(hovered)
}

function unmount() {
  act(() => root.unmount())
  container.remove()
  editor.destroy()
  element.remove()
}

beforeEach(() => {
  mount("<h2>Intro</h2><p>alpha</p><h2>Usage</h2><p>end</p>")
})
afterEach(() => unmount())

const handle = () => document.querySelector<HTMLButtonElement>('button[aria-label="Block menu"]')!
const addButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Add block"]')!
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
    unmount()
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
    ;(document.activeElement as HTMLElement | null)?.blur()
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
    unmount()
    mount("<pre><code>x</code></pre>", null)
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

// #417: the gutter at any depth.
const GROUP = "blk-0417-group-0000001"
const A = "blk-0417-para-a000001"
const B = "blk-0417-para-b000001"
const C = "blk-0417-para-c000001"
const NESTED = `<div data-type="group" data-block-id="${GROUP}"><p data-block-id="${A}">alpha</p><p data-block-id="${B}">beta</p></div><p data-block-id="${C}">gamma</p>`

const groupTexts = () => {
  const group = editor.state.doc.firstChild!
  const out: string[] = []
  group.forEach((child) => out.push(`${child.attrs["data-block-id"]}:${child.textContent}`))
  return out
}

/** Gives each block's DOM a box, so the plugin's pointer maths has a layout to read. */
function layout(boxes: Record<string, { top: number; bottom: number; left: number; right: number }>) {
  for (const [id, box] of Object.entries(boxes)) {
    const dom = editor.view.dom.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!
    dom.getBoundingClientRect = () => ({ ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box }) as DOMRect
  }
}

function dragEvent(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const data = new Map<string, string>()
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    dataTransfer: {
      value: { effectAllowed: "", dropEffect: "", setData: (k: string, v: string) => data.set(k, v), setDragImage: () => {}, getData: (k: string) => data.get(k) ?? "" },
    },
  })
  return event
}

describe("the gutter at any depth (#417)", () => {
  beforeEach(() => {
    unmount()
    mount(NESTED, null)
  })

  it("acts on a block inside a group: its menu duplicates it inside the group", () => {
    hover(A)
    expect(handle().className).not.toContain("is-hidden")
    act(() => handle().click())
    const duplicate = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent?.startsWith("Duplicate"))!
    act(() => duplicate.click())
    const texts = groupTexts().map((t) => t.split(":")[1])
    expect(texts).toEqual(["alpha", "alpha", "beta"])
    // The copy got a fresh id; the original kept its own.
    expect(groupTexts()[0]).toBe(`${A}:alpha`)
    expect(new Set(groupTexts().map((t) => t.split(":")[0])).size).toBe(3)
  })

  it("+ beside a block in a group offers no group (the nesting table); beside the group it does", async () => {
    hover(A)
    act(() => addButton().click())
    await placed()
    typeInto(search(), "group")
    expect(addMenu()!.querySelector('[role="status"]')!.textContent).toContain("No blocks match")
    key(search(), "Escape")
    hover(GROUP)
    act(() => addButton().click())
    await placed()
    typeInto(search(), "group")
    expect(Array.from(addMenu()!.querySelectorAll('[role="option"] .editor-insert__name')).map((n) => n.textContent)).toEqual(["Group"])
  })

  it("Tab on the drag handle goes on to the block's toolbar: a group's Width and Background", () => {
    hover(GROUP)
    handle().focus()
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    act(() => {
      handle().dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    const toolbar = editor.view.dom.querySelector('[role="toolbar"][aria-label="Group"]')!
    expect(toolbar.contains(document.activeElement)).toBe(true)
    // The group is selected, so its toolbar shows.
    expect(editor.state.selection.from).toBe(0)
    expect((editor.state.selection as any).node?.type.name).toBe("group")
    // → moves between its buttons; Esc goes back to the group in the text.
    const first = document.activeElement
    act(() => {
      ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).not.toBe(first)
    expect(toolbar.contains(document.activeElement)).toBe(true)
  })

  it("Tab on the handle of a block without a toolbar goes on and leaves the caret alone", () => {
    editor.commands.setTextSelection(4) // inside "alpha"
    hover(A)
    handle().focus()
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    act(() => {
      handle().dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(false)
    expect(editor.state.selection.from).toBe(4)
    expect(editor.state.selection.empty).toBe(true)
  })

  it("drags a block into a group, between two of its blocks: one transaction, the block keeps its id", () => {
    layout({
      [GROUP]: { top: 0, bottom: 100, left: 0, right: 500 },
      [A]: { top: 10, bottom: 40, left: 20, right: 480 },
      [B]: { top: 50, bottom: 80, left: 20, right: 480 },
      [C]: { top: 110, bottom: 140, left: 0, right: 500 },
    })
    hover(C)
    const changes: number[] = []
    editor.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) changes.push(1)
    })
    act(() => {
      handle().dispatchEvent(dragEvent("dragstart", 0, 120))
    })
    // Over the lower half of "alpha", inside the group: after it.
    const over = dragEvent("dragover", 100, 30)
    act(() => {
      editor.view.dom.dispatchEvent(over)
    })
    expect(over.defaultPrevented).toBe(true)
    const line = editor.view.dom.parentElement!.querySelector<HTMLElement>(".editor-drop-line")!
    expect(line.hidden).toBe(false)
    act(() => {
      editor.view.dom.dispatchEvent(dragEvent("drop", 100, 30))
    })
    expect(groupTexts()).toEqual([`${A}:alpha`, `${C}:gamma`, `${B}:beta`])
    // Only the group is left at the top (and the empty line TipTap keeps after a last group).
    expect(editor.state.doc.firstChild!.type.name).toBe("group")
    expect(editor.state.doc.lastChild!.textContent).toBe("")
    expect(changes).toEqual([1])
    expect(line.hidden).toBe(true)
  })

  it("a group dragged onto a block inside another group lands beside that group, never inside it", () => {
    unmount()
    const G2 = "blk-0417-group-0000002"
    const D = "blk-0417-para-d000001"
    mount(`${NESTED.replace(`<p data-block-id="${C}">gamma</p>`, "")}<div data-type="group" data-block-id="${G2}"><p data-block-id="${D}">delta</p></div>`, null)
    layout({
      [GROUP]: { top: 0, bottom: 100, left: 0, right: 500 },
      [A]: { top: 10, bottom: 40, left: 20, right: 480 },
      [B]: { top: 50, bottom: 80, left: 20, right: 480 },
      [G2]: { top: 110, bottom: 160, left: 0, right: 500 },
      [D]: { top: 120, bottom: 150, left: 20, right: 480 },
    })
    hover(G2)
    act(() => {
      handle().dispatchEvent(dragEvent("dragstart", 0, 115))
    })
    // Over the top half of "alpha": not inside the first group (no group in a group), so
    // before that group.
    act(() => {
      editor.view.dom.dispatchEvent(dragEvent("dragover", 100, 15))
    })
    act(() => {
      editor.view.dom.dispatchEvent(dragEvent("drop", 100, 15))
    })
    const top: string[] = []
    editor.state.doc.forEach((node) => node.textContent && top.push(node.attrs["data-block-id"]))
    expect(top).toEqual([G2, GROUP])
    expect(groupTexts()).toEqual([`${D}:delta`])
  })
})