import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { mentionName, resetMentionNames } from "@gl-admin/lib/mentionNames"
import { MENTION_MENU_ID, MentionMenuExtension, MentionMenuList, mentionMenuAllowed, resetMentionMenuCache, type MentionMenuListRef } from "./MentionMenu"
import { currentDateChipDialog } from "./DateChipDialog"

// The @ menu (#320) through the real suggestion plugin and the real list, with the API
// faked: what opens it, the groups in the design's order, search, the keys (↑↓ across
// groups and wrapping, ↵, Esc keeping the text), the listbox wiring, what each row
// inserts, and "Date or reminder" opening the date dialog.

const people = [
  { id: 7, username: "ana", full_name: "Ana Costa", avatar: null, role: "editor" },
  { id: 8, username: "anais", full_name: "Anaïs Dubois", avatar: null, role: "contributor" },
]
const posts = [
  { id: 3, title: "Analytics for every post", post_type: "post", post_type_label: "Post", post_status: "published" },
  { id: 4, title: "About", post_type: "page", post_type_label: "Page", post_status: "published" },
]

vi.mock("@gl-admin/lib/api/mentions", () => ({
  searchMentionPeople: vi.fn(async (q: string) => people.filter((p) => !q || p.full_name.toLowerCase().includes(q) || p.username.includes(q))),
  searchMentionContent: vi.fn(async (q: string) => posts.filter((p) => !q || p.title.toLowerCase().includes(q))),
  getMentionPeople: vi.fn(async (ids: number[]) => people.filter((p) => ids.includes(p.id))),
}))

// The site's date settings, as loaded (UTC): no request to the settings API.
vi.mock("@gl-admin/lib/hooks/useSiteSettings", () => {
  const settings = { language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" }
  return { loadedSiteDateSettings: () => settings, loadSiteDateSettings: async () => settings }
})

stubJsdomRangeLayout()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let editor: Editor | null = null
let root: Root | null = null
let host: HTMLDivElement | null = null
const list = createRef<MentionMenuListRef>()
let opened = 0

function close() {
  root?.unmount()
  host?.remove()
  root = null
  host = null
}

beforeEach(() => {
  resetMentionMenuCache()
  resetMentionNames()
})

afterEach(() => {
  act(() => close())
  currentDateChipDialog()?.close({ refocus: false })
  editor?.destroy()
  editor = null
  opened = 0
})

function makeEditor(content = "<p>Ask</p>") {
  act(() => {
    close()
    editor?.destroy()
  })
  opened = 0
  const show = (props: any) => {
    if (!root) {
      opened++
      host = document.createElement("div")
      document.body.appendChild(host)
      root = createRoot(host)
    }
    root.render(<MentionMenuList ref={list} {...props} />)
  }
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: false })),
      MentionMenuExtension.configure({
        suggestion: {
          allow: mentionMenuAllowed,
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

/** Lets the menu's debounced search answer. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200))
  })
}

function press(key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  let handled = false
  act(() => {
    handled = !!editor!.view.someProp("handleKeyDown", (f) => f(editor!.view, event))
  })
  return handled
}

const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
const labels = () => options().map((o) => o.getAttribute("aria-label"))
const active = () => document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
const inline = () => (editor!.getJSON().content![0].content ?? []).filter((n: any) => n.type !== "text")

describe("the @ menu", () => {
  it("opens on @ after a space, not inside a word or in code", async () => {
    makeEditor()
    type(" @")
    expect(opened).toBe(1)
    await settle()
    expect(labels()).toEqual([
      "Ana Costa, Editor",
      "Anaïs Dubois, Contributor",
      "Analytics for every post, Post",
      "About, Page",
      "Today",
      "Tomorrow",
      "Date or reminder…",
    ])
    // The groups the canvas shows: People, Link to post or page, then a divider and the dates.
    const groups = Array.from(document.querySelectorAll('[role="group"]')).map((g) => g.getAttribute("aria-label"))
    expect(groups).toEqual(["People", "Link to post or page", "Dates"])

    makeEditor("<p>mail</p>")
    type("@")
    expect(opened).toBe(0) // "mail@" is an address, not a mention

    makeEditor("<pre><code>x</code></pre>")
    type(" @")
    expect(opened).toBe(0)
  })

  it("searches as you type and inserts the member, then remembers their name", async () => {
    makeEditor()
    type(" @ana")
    await settle()
    expect(labels().slice(0, 3)).toEqual(["Ana Costa, Editor", "Anaïs Dubois, Contributor", "Analytics for every post, Post"])
    expect(press("Enter")).toBe(true)
    expect(inline()).toEqual([{ type: "mention", attrs: { userId: 7, label: "Ana Costa" } }])
    expect(editor!.getText()).toBe("Ask @Ana Costa ")
    expect(mentionName(7)).toBe("Ana Costa")
  })

  it("walks every group with the arrows, wrapping, and points the text at the option", async () => {
    makeEditor()
    type(" @")
    await settle()
    expect(active()?.getAttribute("aria-label")).toBe("Ana Costa, Editor")
    const dom = editor!.view.dom
    expect(dom.getAttribute("aria-controls")).toBe(`${MENTION_MENU_ID}-list`)
    expect(dom.getAttribute("aria-activedescendant")).toBe(active()!.id)
    press("ArrowDown")
    press("ArrowDown")
    expect(active()?.getAttribute("aria-label")).toBe("Analytics for every post, Post")
    press("ArrowUp")
    press("ArrowUp")
    press("ArrowUp")
    expect(active()?.getAttribute("aria-label")).toBe("Date or reminder…")
    press("ArrowDown")
    expect(active()?.getAttribute("aria-label")).toBe("Ana Costa, Editor")
    // A content link: the post's id and its title as the text.
    press("ArrowDown")
    press("ArrowDown")
    press("ArrowDown")
    press("Enter")
    expect(inline()).toEqual([{ type: "contentLink", attrs: { postId: 4, label: "About" } }])
  })

  it("inserts today's date, and opens the date dialog for a reminder", async () => {
    makeEditor()
    type(" @tod")
    await settle()
    expect(labels()).toEqual(["Today", "Date or reminder…"])
    press("Enter")
    const [chip] = inline() as any[]
    expect(chip.type).toBe("dateChip")
    expect(chip.attrs.reminder).toBe(false)
    expect(chip.attrs.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    makeEditor()
    type(" @remind")
    await settle()
    // Nothing matched: ↵ stays the editor's until an arrow picks the row.
    expect(document.querySelector('[role="status"]')?.textContent).toBe("No people or posts match “remind”")
    expect(active()).toBeNull()
    // No row is active, so ↵ is the editor's (a new line), not the menu's.
    expect(list.current!.onKeyDown({ event: new KeyboardEvent("keydown", { key: "Enter" }) })).toBe(false)
    // An arrow picks the row; ↵ then opens the dialog.
    press("ArrowDown")
    expect(active()?.getAttribute("aria-label")).toBe("Date or reminder…")
    press("Enter")
    const dialog = currentDateChipDialog()!
    expect(dialog).not.toBeNull()
    // The typed "@remind" is gone; the dialog inserts at the caret.
    expect(editor!.getText()).toBe("Ask ")
    const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)
    dialog.fields.date.value = day
    dialog.fields.remind.checked = true
    dialog.fields.remind.dispatchEvent(new Event("change"))
    expect(dialog.fields.time.value).toBe("09:00")
    expect(dialog.submit()).toBe(true)
    expect(inline()).toEqual([{ type: "dateChip", attrs: { date: day, time: "09:00", reminder: true } }])
  })

  it("doesn't keep a failed answer: the same query asks again", async () => {
    const api = await import("@gl-admin/lib/api/mentions")
    const search = vi.mocked(api.searchMentionPeople)
    search.mockRejectedValueOnce(new Error("429"))
    makeEditor()
    type(" @ana")
    await settle()
    expect(labels()).not.toContain("Ana Costa, Editor")
    const calls = search.mock.calls.length
    makeEditor()
    type(" @ana")
    await settle()
    expect(search.mock.calls.length).toBe(calls + 1)
    expect(labels()).toContain("Ana Costa, Editor")
  })

  it("Esc closes the menu and keeps what was typed", async () => {
    makeEditor()
    type(" @ana")
    await settle()
    expect(press("Escape")).toBe(true)
    expect(options()).toHaveLength(0)
    expect(editor!.getText()).toBe("Ask @ana")
  })

  it("doesn't open in a caption (text only)", () => {
    makeEditor('<figure><img src="/uploads/a.png" data-media-id="1"><figcaption>Cap</figcaption></figure>')
    const state = editor!.state
    let at = -1
    state.doc.descendants((node, pos) => {
      if (node.type.name === "imageCaption") at = pos + 1
    })
    if (at > 0) expect(mentionMenuAllowed({ state, range: { from: at } })).toBe(false)
    expect(mentionMenuAllowed({ state: makeEditor().state, range: { from: 1 } })).toBe(true)
  })
})
