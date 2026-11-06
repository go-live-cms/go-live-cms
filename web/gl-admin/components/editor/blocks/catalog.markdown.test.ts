import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { getExtensions } from "../utils/extensions"
import { markdownRuleOptions } from "@gl-admin/lib/editorSettings"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { CORE_BLOCKS } from "./catalog"

// The Markdown shortcuts the menus show (#415, design 3.2) are TipTap's own input rules
// (StarterKit and CodeBlockLowlight already have every one: nothing is added for them).
// Each hint the catalog shows must make its block when typed at the start of a line, and
// none may when the workspace's Markdown shortcuts setting is off (lib/editorSettings.ts).

stubJsdomRangeLayout()

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

// The editor as the admin builds it (no collab doc), with the setting on or off.
function makeEditor(markdownShortcuts: boolean) {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: getExtensions({ collabProvider: null })(),
    ...markdownRuleOptions(markdownShortcuts),
    content: "<p></p>",
  })
  editor.commands.setTextSelection(1)
  return editor
}

// Types `text` one character at a time, as the browser would: input rules first
// (ProseMirror's handleTextInput), else the character goes in.
function type(ed: Editor, text: string) {
  for (const char of text) {
    const { from, to } = ed.state.selection
    const view = ed.view
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, char, () => ed.state.tr.insertText(char, from, to)))
    if (!handled) view.dispatch(ed.state.tr.insertText(char, from, to))
  }
}

// What follows the hint to fire the rule: a space for most, nothing for "---".
const trigger = (markdown: string) => (markdown === "---" ? markdown : `${markdown} `)

// The block each entry's type is in the editor.
const PM_NODE: Record<string, string> = {
  heading: "heading",
  bullet_list: "bulletList",
  ordered_list: "orderedList",
  blockquote: "blockquote",
  code_block: "codeBlock",
  divider: "horizontalRule",
  // #419: TaskItem's own input rule wraps the line in a to-do list.
  todo_list: "taskList",
}

const shortcuts = CORE_BLOCKS.filter((entry) => entry.markdown)

describe("Markdown shortcuts shown in the menus", () => {
  it("are the design's list: # to ######, -, 1., [], >, ``` and ---", () => {
    expect(shortcuts.map((e) => e.markdown)).toEqual(["#", "##", "###", "####", "#####", "######", "-", "1.", "[]", ">", "```", "---"])
  })

  it("[x] makes a to-do that is already done (#419)", () => {
    const ed = makeEditor(true)
    type(ed, "[x] ")
    const item = ed.state.doc.firstChild!.firstChild!
    expect(item.type.name).toBe("taskItem")
    expect(item.attrs.checked).toBe(true)
  })

  it.each(shortcuts.map((e) => [e.markdown!, e] as const))("%s makes the block it's shown next to", (markdown, entry) => {
    const ed = makeEditor(true)
    type(ed, trigger(markdown))
    const first = ed.state.doc.firstChild!
    expect(first.type.name).toBe(PM_NODE[entry.type])
    if (entry.type === "heading") expect(first.attrs.level).toBe(markdown.length)
    // The shortcut's characters are gone.
    expect(ed.state.doc.textContent).toBe("")
  })

  it.each(shortcuts.map((e) => [e.markdown!] as const))("%s stays text when Markdown shortcuts are off", (markdown) => {
    const ed = makeEditor(false)
    type(ed, trigger(markdown))
    expect(ed.state.doc.childCount).toBe(1)
    expect(ed.state.doc.firstChild!.type.name).toBe("paragraph")
    expect(ed.state.doc.textContent.length).toBeGreaterThan(0)
  })
})
