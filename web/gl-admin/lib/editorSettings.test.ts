import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"

// Markdown shortcuts (#330): the workspace setting turns TipTap's input and paste rules
// off, and nothing else. A headless editor with the admin editor's real extensions
// (non-collab; the bound editor gets the same options from Editor.tsx).

const api = vi.hoisted(() => ({ getSettings: vi.fn() }))
vi.mock("@gl-admin/lib/api/settings", () => ({ getSettings: api.getSettings }))

import { getExtensions } from "@gl-admin/components/editor/utils/extensions"
import { loadEditorSettings, markdownRuleOptions, resetEditorSettings, setEditorSettings, toEditorSettings } from "./editorSettings"

let editor: Editor | null = null

afterEach(() => {
  editor?.destroy()
  editor = null
})

function makeEditor(markdownShortcuts: boolean): Editor {
  editor = new Editor({
    extensions: getExtensions({ collabProvider: null })(),
    content: "<p></p>",
    ...markdownRuleOptions(markdownShortcuts),
  })
  return editor
}

// Types `text` one character at a time the way the browser does: each goes through
// ProseMirror's handleTextInput (where TipTap's input rules run), then is inserted if
// nothing handled it.
function typeText(ed: Editor, text: string) {
  for (const ch of text) {
    const { view } = ed
    const { from, to } = view.state.selection
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)))
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to))
  }
}

const firstNode = (ed: Editor) => ed.state.doc.firstChild!

describe("markdownRuleOptions", () => {
  it("keeps every rule on, or only smart punctuation and pasted links", () => {
    expect(markdownRuleOptions(true)).toEqual({ enableInputRules: true, enablePasteRules: true })
    expect(markdownRuleOptions(false)).toEqual({ enableInputRules: ["typography"], enablePasteRules: ["link"] })
  })
})

describe("the editor with Markdown shortcuts", () => {
  it.each([
    ["# ", "heading"],
    ["- ", "bulletList"],
    ["1. ", "orderedList"],
    ["> ", "blockquote"],
    ["``` ", "codeBlock"],
  ])("on: %j turns the line into a %s", (typed, type) => {
    const ed = makeEditor(true)
    typeText(ed, typed)
    expect(firstNode(ed).type.name).toBe(type)
  })

  it.each(["# ", "- ", "1. ", "> ", "``` "])("off: %j stays text in a paragraph", (typed) => {
    const ed = makeEditor(false)
    typeText(ed, typed)
    expect(firstNode(ed).type.name).toBe("paragraph")
    expect(firstNode(ed).textContent).toBe(typed)
  })

  it("off: **bold** stays literal; on: it becomes bold", () => {
    const off = makeEditor(false)
    typeText(off, "**bold**")
    expect(off.getHTML()).not.toContain("<strong>")
    off.destroy()

    const on = makeEditor(true)
    typeText(on, "**bold**")
    expect(on.getHTML()).toContain("<strong>bold</strong>")
  })

  it("off keeps smart punctuation (not a Markdown shortcut)", () => {
    const ed = makeEditor(false)
    typeText(ed, "a -- b")
    expect(firstNode(ed).textContent).toBe("a — b")
  })

  it("off changes no schema: the same node and mark types either way", () => {
    const on = makeEditor(true)
    const types = (ed: Editor) => [Object.keys(ed.schema.nodes).sort(), Object.keys(ed.schema.marks).sort()]
    const onTypes = types(on)
    on.destroy()
    expect(types(makeEditor(false))).toEqual(onTypes)
  })
})

describe("loading the setting", () => {
  beforeEach(() => {
    resetEditorSettings()
    api.getSettings.mockReset()
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("reads editor_markdown_shortcuts from /settings once", async () => {
    api.getSettings.mockResolvedValue({ editor_markdown_shortcuts: false })
    expect(await loadEditorSettings()).toEqual({ markdownShortcuts: false })
    expect(await loadEditorSettings()).toEqual({ markdownShortcuts: false })
    expect(api.getSettings).toHaveBeenCalledTimes(1)
  })

  it("falls back to shortcuts on when the lookup fails, and retries next time", async () => {
    api.getSettings.mockRejectedValueOnce(new Error("down")).mockResolvedValue({ editor_markdown_shortcuts: false })
    expect(await loadEditorSettings()).toEqual({ markdownShortcuts: true })
    expect(await loadEditorSettings()).toEqual({ markdownShortcuts: false })
  })

  it("takes what the Settings page saved without another request", async () => {
    setEditorSettings({ editor_markdown_shortcuts: false })
    expect(await loadEditorSettings()).toEqual({ markdownShortcuts: false })
    expect(api.getSettings).not.toHaveBeenCalled()
  })

  it("treats a missing field (an older API) as on", () => {
    expect(toEditorSettings({} as never)).toEqual({ markdownShortcuts: true })
    expect(toEditorSettings(null)).toEqual({ markdownShortcuts: true })
  })
})
