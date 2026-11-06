import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import BlockSettingsPanel from "./BlockSettingsPanel"

// The settings panel's Block tab (#417): the selected block, nested or not, its place in
// its containers, and a group's settings.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
stubJsdomRangeLayout()

const GROUP = "blk-0417-group-0000001"
const A = "blk-0417-para-a000001"

let editor: Editor
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: Object.values(schemaExtensions({ collaborating: false })),
    content: `<div data-type="group" data-block-id="${GROUP}"><p data-block-id="${A}">alpha</p></div><h3>Title</h3>`,
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<BlockSettingsPanel editor={editor} />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  editor.destroy()
})

const name = () => container.querySelector(".block-settings__name")?.textContent
const crumbs = () => Array.from(container.querySelectorAll(".block-settings__crumb-button")).map((b) => b.textContent)
const radio = (label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((b) => b.textContent === label)!

describe("the Block tab (#417)", () => {
  it("shows the block the caret is in, inside its group, and selects the group from the path", () => {
    act(() => {
      editor.commands.setTextSelection(3)
    })
    expect(name()).toBe("Paragraph")
    expect(crumbs()).toEqual(["Group"])
    expect(container.textContent).toContain("no settings here")
    act(() => (container.querySelector(".block-settings__crumb-button") as HTMLButtonElement).click())
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    expect((editor.state.selection as NodeSelection).node.attrs["data-block-id"]).toBe(GROUP)
    expect(name()).toBe("Group")
    expect(crumbs()).toEqual([])
  })

  it("changes a selected group's width and background, one change each", () => {
    act(() => {
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)))
    })
    expect(radio("Content").getAttribute("aria-checked")).toBe("true")
    const changes: number[] = []
    editor.on("transaction", ({ transaction }) => transaction.docChanged && changes.push(1))
    act(() => radio("Wide").click())
    act(() => radio("Tinted").click())
    expect(editor.state.doc.firstChild!.attrs).toMatchObject({ align: "wide", style: "tinted", "data-block-id": GROUP })
    expect(changes).toEqual([1, 1])
    expect(radio("Wide").getAttribute("aria-checked")).toBe("true")
    // Pressing the current value again changes nothing.
    act(() => radio("Wide").click())
    expect(changes).toEqual([1, 1])
  })

  it("names a heading by its level", () => {
    act(() => {
      editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize + 2)
    })
    expect(name()).toBe("Heading 3")
  })
})
