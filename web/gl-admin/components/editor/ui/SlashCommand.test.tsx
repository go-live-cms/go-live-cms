import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { CORE_BLOCKS, flattenSections, menuEntries, searchCatalog, type CatalogEntry } from "../blocks/catalog"
import { SLASH_MENU_ID, SlashCommandExtension, SlashCommandList, type SlashCommandListRef } from "./SlashCommand"

// The slash menu (#415) through the real suggestion plugin and the real list: what opens
// it, search, the keys (across groups, ↵, Esc keeping the text), the no-match state, the
// listbox wiring and the role gate. slashCommandManager only positions the popup; its Esc
// (close, keep the text) is mirrored by `render` below.

stubJsdomRangeLayout()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let editor: Editor | null = null
let root: Root | null = null
let host: HTMLDivElement | null = null
const list = createRef<SlashCommandListRef>()
let opened = 0

function close() {
  root?.unmount()
  host?.remove()
  root = null
  host = null
}

afterEach(() => {
  act(() => close())
  editor?.destroy()
  editor = null
  opened = 0
})

function makeEditor(content = "<p>first</p><p></p>", entries: readonly CatalogEntry[] = CORE_BLOCKS) {
  act(() => {
    close()
    editor?.destroy()
  })
  const show = (props: any) => {
    if (!root) {
      opened++
      host = document.createElement("div")
      document.body.appendChild(host)
      root = createRoot(host)
    }
    root.render(<SlashCommandList ref={list} {...props} />)
  }
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: false })),
      SlashCommandExtension.configure({
        suggestion: {
          startOfLine: true,
          allow: ({ state, range }: any) => !state.doc.resolve(range.from).parent.type.spec.code,
          items: () => [...entries],
          render: () => ({
            onStart: show,
            onUpdate: (props: any) => root && show(props),
            onKeyDown: ({ event }: { event: KeyboardEvent }) => {
              if (!root) return false
              if (event.key === "Escape") {
                close()
                return true
              }
              return list.current?.onKeyDown({ event }) ?? false
            },
            onExit: close,
          }),
        },
      }),
    ],
    content,
  })
  // The caret at the end of the last block.
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  return editor
}

function type(text: string) {
  act(() => {
    for (const char of text) {
      const { from, to } = editor!.state.selection
      editor!.view.dispatch(editor!.state.tr.insertText(char, from, to))
    }
  })
}

/** Sends a key through the editor's keydown handlers (the suggestion plugin's first). True when one handled it. */
function press(key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  let handled = false
  act(() => {
    handled = !!editor!.view.someProp("handleKeyDown", (f) => f(editor!.view, event))
  })
  return handled
}

const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
const active = () => document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
const topTypes = () => {
  const types: string[] = []
  editor!.state.doc.forEach((node) => types.push(node.type.name))
  return types
}

describe("the slash menu", () => {
  it("opens on / at the start of a line, not after text or in code", () => {
    makeEditor()
    type("/")
    expect(opened).toBe(1)
    expect(options()).toHaveLength(CORE_BLOCKS.length)

    makeEditor("<p>a</p>")
    type(" /")
    expect(opened).toBe(1) // not again

    makeEditor("<pre><code>x</code></pre>")
    type("/")
    expect(opened).toBe(1)
  })

  it("lists every block in its group, with no cap, and filters by name and keyword with the match in bold", () => {
    makeEditor()
    type("/")
    const groups = Array.from(document.querySelectorAll('[role="listbox"] > [role="group"]')).map((g) => g.getAttribute("aria-label"))
    expect(groups).toEqual(["Text", "Media", "Layout", "Embeds", "Advanced"])
    expect(document.querySelector(".editor-insert__footer")!.textContent).toBe("↑↓ to move↵ to insertesc to close")

    type("he")
    expect(options().map((o) => o.querySelector(".editor-insert__name")!.textContent)).toEqual([
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Heading 4",
      "Heading 5",
      "Heading 6",
      // By its keyword "hero" (#427).
      "Cover",
    ])
    expect(options()[0].querySelector("b")!.textContent).toBe("He")
    expect(document.querySelector('[role="listbox"]')!.getAttribute("aria-label")).toBe("Blocks matching he")
    expect(document.querySelector(".editor-insert__footer")!.textContent).toBe("7 results↵ inserts Heading 1")

    // Something only keywords have: "/photo" (Image's and Gallery's, shown on the right).
    act(() => {
      const { from } = editor!.state.selection
      editor!.view.dispatch(editor!.state.tr.delete(from - 2, from))
    })
    type("photo")
    expect(options().map((o) => o.textContent)).toEqual(["Imagephoto", "Galleryphotos"])
  })

  it("moves across groups with ↑↓, wrapping, and ↵ inserts the highlighted block in place of /query", () => {
    makeEditor()
    type("/")
    expect(active()!.textContent).toBe("Paragraph")
    // From the last Text block down into Media.
    // Paragraph, six headings, three lists, quote, pull quote, callout (#419), then code.
    for (let i = 0; i < 13; i++) expect(press("ArrowDown")).toBe(true)
    expect(active()!.textContent).toBe("Code```")
    press("ArrowDown")
    expect(active()!.textContent).toBe("Table")
    press("ArrowDown")
    expect(active()!.textContent).toBe("Details")
    press("ArrowDown")
    expect(active()!.textContent).toBe("Footnote")
    press("ArrowDown")
    expect(active()!.textContent).toBe("Image")
    // Gallery (#424), video, audio and file (#423), cover and media & text (#427), then Layout.
    for (const name of ["Gallery", "Video", "Audio", "File", "Cover", "Media & text"]) {
      press("ArrowDown")
      expect(active()!.textContent).toBe(name)
    }
    press("ArrowDown")
    expect(active()!.textContent).toBe("Divider---")
    press("ArrowDown")
    expect(active()!.textContent).toBe("Group")
    // Columns, Buttons and Spacer (#426), the embeds (#425), then it wraps.
    for (const name of ["Columns", "Buttons", "Spacer", "YouTube", "Vimeo", "X", "Embed a link", "Custom HTMLAdmins"]) {
      press("ArrowDown")
      expect(active()!.textContent).toBe(name)
    }
    press("ArrowDown")
    expect(active()!.textContent).toBe("Paragraph")
    press("ArrowUp")
    expect(active()!.textContent).toBe("Custom HTMLAdmins")
    for (const name of ["Embed a link", "X", "Vimeo", "YouTube", "Spacer", "Buttons", "Columns", "Group", "Divider---"]) {
      press("ArrowUp")
      expect(active()!.textContent).toBe(name)
    }

    expect(press("Enter")).toBe(true)
    expect(topTypes()).toEqual(["paragraph", "horizontalRule", "paragraph"])
    expect(editor!.state.doc.textContent).toBe("first")
    expect(root).toBeNull() // closed
  })

  it("keeps the highlight when the doc changes elsewhere (a collaborator typing)", () => {
    makeEditor()
    type("/")
    press("ArrowDown")
    press("ArrowDown")
    expect(active()!.textContent).toBe("H2Heading 2##")
    // Text added to the first paragraph: the menu is updated with the same query.
    act(() => {
      editor!.view.dispatch(editor!.state.tr.insertText("!", 2))
    })
    expect(root).not.toBeNull()
    expect(active()!.textContent).toBe("H2Heading 2##")
    // A new query starts at its first result.
    type("h")
    expect(active()!.textContent).toBe("H1Heading 1#")
  })

  it.each(flattenSections(searchCatalog(CORE_BLOCKS, "")).map((m, i) => [m.entry.name, i] as const))(
    "inserts %s from the keyboard alone",
    (_name, index) => {
      makeEditor()
      type("/")
      for (let i = 0; i < index; i++) press("ArrowDown")
      press("Enter")
      expect(editor!.state.doc.textContent).toBe("first")
      expect(topTypes().length).toBeGreaterThanOrEqual(2)
    }
  )

  it("says nothing matches, lets ↵ and the arrows through, and Esc keeps what was typed", () => {
    makeEditor()
    type("/map")
    expect(options()).toHaveLength(0)
    const status = document.querySelector('[role="status"]')!
    expect(status.textContent).toContain("No blocks match “map”")
    expect(document.querySelector(".editor-insert__footer")!.textContent).toBe("esc closes the menu and keeps “/map” as text")
    // The menu doesn't take them (the editor's own keys do).
    const key = (k: string) => list.current!.onKeyDown({ event: new KeyboardEvent("keydown", { key: k }) })
    expect(key("ArrowDown")).toBe(false)
    expect(key("Enter")).toBe(false)

    expect(press("Escape")).toBe(true)
    expect(root).toBeNull()
    expect(editor!.state.doc.lastChild!.textContent).toBe("/map")
    // Typing on doesn't reopen it while the same "/" is matched.
    type("s")
    expect(opened).toBe(1)
    expect(editor!.state.doc.lastChild!.textContent).toBe("/maps")
  })

  it("Esc on an open menu closes it and keeps /he as text", () => {
    makeEditor()
    type("/he")
    expect(press("Escape")).toBe(true)
    expect(root).toBeNull()
    expect(editor!.state.doc.lastChild!.textContent).toBe("/he")
    expect(editor!.state.doc.lastChild!.type.name).toBe("paragraph")
  })

  it("points the text at the listbox and the active option while open", () => {
    makeEditor()
    type("/")
    const dom = editor!.view.dom
    expect(dom.getAttribute("aria-controls")).toBe(`${SLASH_MENU_ID}-list`)
    expect(document.getElementById(`${SLASH_MENU_ID}-list`)!.getAttribute("role")).toBe("listbox")
    expect(dom.getAttribute("aria-activedescendant")).toBe(active()!.id)
    press("ArrowDown")
    expect(dom.getAttribute("aria-activedescendant")).toBe(active()!.id)
    expect(active()!.textContent).toBe("H1Heading 1#") // the H1 tile, the name, the shortcut
    press("Escape")
    expect(dom.hasAttribute("aria-activedescendant")).toBe(false)
    expect(dom.hasAttribute("aria-controls")).toBe(false)
  })

  it("inserts the clicked option", () => {
    makeEditor()
    type("/")
    const quote = options().find((o) => o.textContent?.startsWith("Quote"))!
    act(() => quote.click())
    expect(topTypes()).toContain("blockquote")
    expect(editor!.state.doc.textContent).toBe("first")
  })
})

describe("the role gate in the menu", () => {
  it("shows Advanced with the Admins pill to admins only", () => {
    makeEditor("<p>first</p><p></p>", menuEntries({ role: "admin" }, CORE_BLOCKS))
    type("/")
    const html = options().find((o) => o.textContent?.startsWith("Custom HTML"))!
    expect(html.querySelector(".editor-insert__pill")!.textContent).toBe("Admins")
    expect(html.closest('[role="group"]')!.getAttribute("aria-label")).toBe("Advanced")

    // A contributor isn't offered the embeds (#425).
    const embeds = CORE_BLOCKS.filter((entry) => entry.group === "embeds").length
    for (const [role, count] of [["editor", CORE_BLOCKS.length - 1], ["contributor", CORE_BLOCKS.length - 1 - embeds]] as const) {
      makeEditor("<p>first</p><p></p>", menuEntries({ role }, CORE_BLOCKS))
      type("/")
      expect(options()).toHaveLength(count)
      expect(options().some((o) => o.textContent?.includes("Custom HTML"))).toBe(false)
      expect(document.querySelector('[role="group"][aria-label="Advanced"]')).toBeNull()
    }
  })
})
