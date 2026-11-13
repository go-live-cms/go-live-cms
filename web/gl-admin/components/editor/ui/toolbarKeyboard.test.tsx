import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import BubbleMenu from "./BubbleMenu"
import CommandSelect from "./CommandSelect"
import { FloatingToolbarKeys } from "../utils/floatingToolbar"

// Keyboard access to the editor's floating toolbars (#144): ⌥F10 from the text to the
// toolbar that is showing, ← → Home End inside it, Esc back to the text with the
// selection kept; and the toolbars' pickers (CommandSelect) as listboxes. TipTap's
// floating menu is replaced by its children (what it shows, not where), inside the
// editor's wrapper as in the app.

vi.mock("@tiptap/react/menus", () => ({
  BubbleMenu: ({ children }: { children: ReactNode }) => <div data-testid="bubble">{children}</div>,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let editor: Editor
let wrapper: HTMLDivElement
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // jsdom lays nothing out: every element has no boxes, so "showing" is stubbed.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList)
  wrapper = document.createElement("div")
  wrapper.className = "editor-wrapper"
  document.body.appendChild(wrapper)
  const mount = document.createElement("div")
  wrapper.appendChild(mount)
  editor = new Editor({
    element: mount,
    extensions: [...Object.values(schemaExtensions({ collaborating: false })), FloatingToolbarKeys],
    content: {
      type: "doc",
      content: [{ type: "paragraph", attrs: { "data-block-id": "blk-0144-toolbar-0001" }, content: [{ type: "text", text: "alpha beta" }] }],
    },
  })
  container = document.createElement("div")
  wrapper.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  editor.destroy()
  wrapper.remove()
  vi.restoreAllMocks()
})

function press(key: string, init: KeyboardEventInit = {}, target: Element | null = document.activeElement) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    ;(target ?? document.body).dispatchEvent(event)
  })
  return event
}

const focused = () => document.activeElement as HTMLElement

function selectAlpha() {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 6)))
  editor.view.focus()
  act(() => root.render(<BubbleMenu editor={editor} openLinkModal={() => {}} />))
}

describe("floating toolbars from the keyboard (#144)", () => {
  it("⌥F10 in the text moves focus to the selection toolbar's first control", () => {
    selectAlpha()
    const event = press("F10", { altKey: true }, editor.view.dom)
    expect(event.defaultPrevented).toBe(true)
    expect(focused().closest("[role=toolbar]")?.getAttribute("aria-label")).toBe("Format text")
    expect(focused().getAttribute("aria-label")).toMatch(/^Turn into/)
  })

  it("← → Home End move between the controls, wrapping", () => {
    selectAlpha()
    const controls = [...container.querySelectorAll<HTMLElement>("[role=toolbar] button")]
    const first = controls[0]
    const last = controls[controls.length - 1]
    press("F10", { altKey: true }, editor.view.dom)
    expect(focused()).toBe(first)
    press("ArrowRight")
    expect(focused().getAttribute("aria-label")).toBe("Bold")
    press("ArrowLeft")
    expect(focused()).toBe(first)
    press("ArrowLeft")
    expect(focused()).toBe(last)
    press("Home")
    expect(focused()).toBe(first)
    press("End")
    expect(focused()).toBe(last)
  })

  it("Esc goes back to the text with the selection as it was, and a control still works", () => {
    selectAlpha()
    press("F10", { altKey: true }, editor.view.dom)
    press("ArrowRight") // Bold
    act(() => focused().click())
    expect(editor.isActive("bold")).toBe(true)
    focused().focus()
    press("Escape")
    expect(editor.view.hasFocus()).toBe(true)
    expect([editor.state.selection.from, editor.state.selection.to]).toEqual([1, 6])
  })

  it("does nothing when no toolbar is showing", () => {
    editor.view.focus()
    const event = press("F10", { altKey: true }, editor.view.dom)
    expect(event.defaultPrevented).toBe(false)
    expect(editor.view.hasFocus()).toBe(true)
  })
})

describe("CommandSelect from the keyboard (#144)", () => {
  const options = [
    { value: "paragraph", label: "Paragraph" },
    { value: "heading-1", label: "Heading 1" },
    { value: "quote", label: "Quote" },
  ]

  function renderSelect(onChange = vi.fn()) {
    act(() => root.render(<CommandSelect options={options} value="heading-1" onChange={onChange} label="Turn into" />))
    return { onChange, trigger: container.querySelector<HTMLButtonElement>(".editor-select__trigger")! }
  }

  it("↓ on the trigger opens the list on the current option; ↑↓ and typeahead move; ↵ picks", () => {
    const { onChange, trigger } = renderSelect()
    trigger.focus()
    press("ArrowDown")
    const list = container.querySelector("[role=listbox]")!
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(trigger.getAttribute("aria-controls")).toBe(list.id)
    expect(focused().textContent).toBe("Heading 1")
    expect(focused().getAttribute("aria-selected")).toBe("true")
    press("ArrowDown")
    expect(focused().textContent).toBe("Quote")
    press("ArrowDown") // wraps
    expect(focused().textContent).toBe("Paragraph")
    press("q")
    expect(focused().textContent).toBe("Quote")
    press("Enter")
    expect(onChange).toHaveBeenCalledWith(options[2])
    expect(container.querySelector("[role=listbox]")).toBeNull()
  })

  it("Esc closes the list and gives focus back to the trigger, without reaching a toolbar or dialog", () => {
    const outer = vi.fn()
    const { onChange, trigger } = renderSelect()
    trigger.focus()
    press("ArrowDown")
    document.addEventListener("keydown", outer)
    press("Escape")
    document.removeEventListener("keydown", outer)
    expect(container.querySelector("[role=listbox]")).toBeNull()
    expect(focused()).toBe(trigger)
    expect(onChange).not.toHaveBeenCalled()
    expect(outer).not.toHaveBeenCalled()
  })

  it("only the active option is a Tab stop", () => {
    const { trigger } = renderSelect()
    trigger.focus()
    press("ArrowDown")
    const stops = [...container.querySelectorAll<HTMLElement>("[role=option]")].map((o) => o.tabIndex)
    expect(stops).toEqual([-1, 0, -1])
  })
})
