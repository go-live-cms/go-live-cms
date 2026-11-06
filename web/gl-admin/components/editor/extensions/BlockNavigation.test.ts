import { afterEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { BlockNodeViews } from "./BlockNodeViews"
import { BlockNavigationKeys, BlockSelectionKeys } from "./BlockNavigation"
import { SlashCommandExtension } from "../ui/SlashCommand"
import { CORE_BLOCKS } from "../blocks/catalog"

// The keyboard model for blocks at any depth (#417, "Keyboard" › "Moving between blocks"
// and "Toolbar and settings"): Esc walks up from the caret through the containers, ↵ steps
// into a container (or edits a block), ↑↓ move between the blocks beside it, ⌘⇧↑↓ move a
// block inside its container, ⌫ deletes a selected block.

stubJsdomRangeLayout()

const GROUP = "blk-0417-group-0000001"
const A = "blk-0417-para-a000001"
const B = "blk-0417-para-b000001"
const C = "blk-0417-para-c000001"
const AFTER = "blk-0417-after-000001"
const LIST = "blk-0417-list-0000001"

const CONTENT = `<div data-type="group" data-block-id="${GROUP}"><p data-block-id="${A}">alpha</p><p data-block-id="${B}">beta</p><p data-block-id="${C}">gamma</p></div><p data-block-id="${AFTER}">after</p><ul data-block-id="${LIST}"><li><p>one</p></li><li><p>two</p></li></ul><p>end</p>`

let editor: Editor
afterEach(() => editor?.destroy())

function mount(content = CONTENT, extra: any[] = []) {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockNodeViews, BlockSelectionKeys, BlockNavigationKeys, ...extra],
    content,
  })
  return editor
}

function press(key: string, mods: { ctrl?: boolean; shift?: boolean } = {}): boolean {
  const event = new KeyboardEvent("keydown", { key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, bubbles: true, cancelable: true })
  return !!editor.view.someProp("handleKeyDown", (f) => f(editor.view, event))
}

function posOf(id: string): number {
  let at = -1
  editor.state.doc.descendants((node, pos) => {
    if (at === -1 && node.attrs["data-block-id"] === id) at = pos
  })
  if (at === -1) throw new Error(`no ${id}`)
  return at
}

/** The id of the selected block, or "text" for a caret. */
function selected(): string {
  const { selection } = editor.state
  if (selection instanceof NodeSelection) return selection.node.attrs["data-block-id"]
  return "text"
}

const caretIn = (id: string, offset = 1) => editor.commands.setTextSelection(posOf(id) + offset)
const groupOrder = () => {
  const out: string[] = []
  editor.state.doc.firstChild!.forEach((node) => out.push(node.attrs["data-block-id"]))
  return out
}

describe("Esc, ↵ and ↑↓ (#417)", () => {
  it("Esc selects the block around the caret, then its container, then stays at the top", () => {
    mount()
    caretIn(B, 2)
    expect(press("Escape")).toBe(true)
    expect(selected()).toBe(B)
    expect(press("Escape")).toBe(true)
    expect(selected()).toBe(GROUP)
    // The top: nothing above the group; the key is left alone.
    expect(press("Escape")).toBe(false)
    expect(selected()).toBe(GROUP)
  })

  it("Esc in a list item selects the whole list (its items are its own business)", () => {
    mount()
    let inTwo = -1
    editor.state.doc.descendants((node, pos) => {
      if (inTwo === -1 && node.isText && node.text === "two") inTwo = pos + 1
    })
    editor.commands.setTextSelection(inTwo)
    press("Escape")
    expect(selected()).toBe(LIST)
  })

  it("↵ on a selected container steps into its first block; ↵ again edits it (caret at its end)", () => {
    mount()
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, posOf(GROUP))))
    expect(press("Enter")).toBe(true)
    expect(selected()).toBe(A)
    expect(press("Enter")).toBe(true)
    const { selection } = editor.state
    expect(selection).toBeInstanceOf(TextSelection)
    expect(selection.empty).toBe(true)
    expect(selection.from).toBe(posOf(A) + 1 + "alpha".length)
    // The doc didn't change: no paragraph was added after the selected block.
    expect(groupOrder()).toEqual([A, B, C])
  })

  it("↑↓ select the block before or after, inside the same container, and stop at its ends", () => {
    mount()
    caretIn(A)
    press("Escape")
    expect(press("ArrowDown")).toBe(true)
    expect(selected()).toBe(B)
    press("ArrowDown")
    expect(selected()).toBe(C)
    // The last block of the group: the selection stays (never jumps out of the group).
    expect(press("ArrowDown")).toBe(true)
    expect(selected()).toBe(C)
    press("ArrowUp")
    press("ArrowUp")
    expect(selected()).toBe(A)
    // At the top level they walk the doc's blocks.
    press("Escape")
    press("ArrowDown")
    expect(selected()).toBe(AFTER)
    press("ArrowDown")
    expect(selected()).toBe(LIST)
  })

  it("leaves ↑↓ alone in the text", () => {
    mount()
    caretIn(B, 2)
    expect(press("ArrowDown")).toBe(false)
    expect(press("ArrowUp")).toBe(false)
    expect(selected()).toBe("text")
  })
})

describe("⌘⇧↑ / ⌘⇧↓ and ⌫ (#417)", () => {
  it("moves the block holding the caret inside its group, in one transaction, keeping its id and the caret", () => {
    mount()
    caretIn(A, 3)
    const changes: number[] = []
    editor.on("transaction", ({ transaction }) => transaction.docChanged && changes.push(1))
    expect(press("ArrowDown", { ctrl: true, shift: true })).toBe(true)
    expect(groupOrder()).toEqual([B, A, C])
    expect(changes).toEqual([1])
    // The caret is where it was in "alpha".
    expect(editor.state.selection.from).toBe(posOf(A) + 3)
    press("ArrowDown", { ctrl: true, shift: true })
    expect(groupOrder()).toEqual([B, C, A])
    // The last block of the group stays in it: no move out of the container.
    expect(press("ArrowDown", { ctrl: true, shift: true })).toBe(true)
    expect(groupOrder()).toEqual([B, C, A])
    expect(changes).toEqual([1, 1])
  })

  it("moves a selected block, which stays selected; a selected group moves as a whole", () => {
    mount()
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, posOf(GROUP))))
    press("ArrowDown", { ctrl: true, shift: true })
    const top: string[] = []
    editor.state.doc.forEach((node) => top.push(node.attrs["data-block-id"]))
    expect(top.slice(0, 2)).toEqual([AFTER, GROUP])
    expect(selected()).toBe(GROUP)
    expect(editor.state.doc.child(1).childCount).toBe(3)
  })

  it("⌫ deletes the selected block; the last block of a group takes the group with it", () => {
    mount(`<div data-type="group" data-block-id="${GROUP}"><p data-block-id="${A}">alpha</p></div><p data-block-id="${AFTER}">after</p>`)
    caretIn(A)
    press("Escape")
    expect(press("Backspace")).toBe(true)
    const top: string[] = []
    editor.state.doc.forEach((node) => top.push(`${node.type.name}:${node.textContent}`))
    expect(top).toEqual(["paragraph:after"])
  })

  it("⌫ on a group's first block leaves the caret on the next block, inside the group", () => {
    mount()
    caretIn(A)
    press("Escape")
    press("Backspace")
    expect(groupOrder()).toEqual([B, C])
    const { $from } = editor.state.selection
    expect($from.parent.attrs["data-block-id"]).toBe(B)
  })

  it("Delete on the post's only block leaves an empty line", () => {
    mount(`<p data-block-id="${A}">alpha</p>`)
    caretIn(A)
    press("Escape")
    expect(press("Delete")).toBe(true)
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.firstChild!.type.name).toBe("paragraph")
    expect(editor.state.doc.textContent).toBe("")
  })

  it("⌫ in the text still deletes text", () => {
    mount()
    caretIn(A, 3)
    expect(press("Backspace")).toBe(false)
  })

  it("⌘⇧, opens the settings on the Block tab, when the editor has a panel to open", () => {
    mount()
    caretIn(A)
    expect(press(",", { ctrl: true, shift: true })).toBe(false)
    const toggle = vi.fn()
    ;(editor.storage as any).blockNavigationKeys.toggleBlockSettings = toggle
    expect(press(",", { ctrl: true, shift: true })).toBe(true)
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it("Esc closes an open slash menu first and keeps the text (the menu's Esc runs before this one)", () => {
    mount(`<p data-block-id="${A}">alpha</p><p data-block-id="${B}"></p>`, [
      SlashCommandExtension.configure({
        suggestion: {
          startOfLine: true,
          items: () => CORE_BLOCKS,
          render: () => ({ onStart: () => {}, onUpdate: () => {}, onKeyDown: ({ event }: { event: KeyboardEvent }) => event.key === "Escape", onExit: () => {} }),
        },
      }),
    ])
    caretIn(B)
    editor.commands.insertContent("/")
    expect(press("Escape")).toBe(true)
    expect(selected()).toBe("text")
  })
})
