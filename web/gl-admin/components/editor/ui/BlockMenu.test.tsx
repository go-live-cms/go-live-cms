import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import BlockMenu from "./BlockMenu"
import MoveToDialog, { filterHeadings } from "./MoveToDialog"
import { BlockActions, listHeadings, refOf, topLevelBlockAt, type BlockRef } from "../utils/blockActions"
import { PostBlockEditsStore } from "@gl-admin/lib/blockEditsStore"
import { BlockEditsContext } from "../blockEditsContext"

// The block menu (#356): what it offers, its keyboard, and that each item runs its
// action on the block it opened for. The actions themselves: blockActions*.test.ts.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ID = (n: number) => `blk-${String(n).padStart(4, "0")}-000000000`
const content = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2, "data-block-id": ID(1) }, content: [{ type: "text", text: "Intro" }] },
    { type: "paragraph", attrs: { "data-block-id": ID(2) }, content: [{ type: "text", text: "alpha" }] },
    { type: "heading", attrs: { level: 2, "data-block-id": ID(3) }, content: [{ type: "text", text: "Usage" }] },
    { type: "horizontalRule", attrs: { "data-block-id": ID(4) } },
    { type: "paragraph", attrs: { "data-block-id": ID(5) }, content: [{ type: "text", text: "end" }] },
  ],
}

let editor: Editor
let container: HTMLDivElement
let root: Root
let anchor: HTMLButtonElement

// Relative times ("2 hours ago") read the local calendar: a real clock just after
// midnight makes them "yesterday" (CI ran into it at 00:09 UTC). Only Date is faked, at
// 14:00 local time; timers and promises stay real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(2026, 9, 27, 14, 0, 0))
})
afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  editor = new Editor({
    element: document.createElement("div"),
    extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockActions],
    content,
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  anchor = document.createElement("button")
  document.body.appendChild(anchor)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  anchor.remove()
  editor.destroy()
  vi.restoreAllMocks()
})

const at = (index: number): BlockRef => {
  let pos = 0
  editor.state.doc.forEach((_n, offset, i) => {
    if (i === index) pos = offset
  })
  return refOf(topLevelBlockAt(editor.state.doc, pos)!)
}

function open(target: BlockRef, props: { postUrl?: string | null; onComment?: (ref: BlockRef) => void } = {}) {
  const onClose = vi.fn()
  const onMoveTo = vi.fn()
  const ref = createRef<HTMLElement>() as { current: HTMLElement | null }
  ref.current = anchor
  act(() => root.render(<BlockMenu editor={editor} target={target} anchor={ref} onClose={onClose} onMoveTo={onMoveTo} {...props} />))
  return { onClose, onMoveTo }
}

const menu = () => document.querySelector<HTMLElement>('[role="menu"][aria-label="Block actions"]')!
const item = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]')).find((b) =>
    b.querySelector(".gl-menu__label")?.textContent === label
  )!
const labels = () => Array.from(menu().querySelectorAll(".gl-menu__label")).map((l) => l.textContent)

describe("BlockMenu: Last edited by (#328)", () => {
  function openWithEdits(target: BlockRef, store: PostBlockEditsStore) {
    const ref = createRef<HTMLElement>() as { current: HTMLElement | null }
    ref.current = anchor
    act(() =>
      root.render(
        <BlockEditsContext.Provider value={store}>
          <BlockMenu editor={editor} target={target} anchor={ref} onClose={vi.fn()} onMoveTo={vi.fn()} />
        </BlockEditsContext.Provider>
      )
    )
  }
  const footer = () => menu().querySelector(".editor-block-menu__meta")

  it("shows the block's last editor under the items, describes the menu with it, and follows the server's stored messages", async () => {
    const edited = new Date(Date.now() - 2 * 60 * 60 * 1000 - 1000).toISOString()
    const store = new PostBlockEditsStore(1, {
      getPostBlockEdits: async () => ({
        [ID(2)]: { user: { id: 8, username: "ana", full_name: "Ana Costa", avatar: null }, edited_at: edited },
      }),
    })
    await store.refresh()
    openWithEdits(at(1), store)
    expect(footer()?.textContent).toBe("Last edited by Ana Costa · 2 hours ago")
    expect(menu().getAttribute("aria-describedby")).toBe(footer()!.id)
    // After the items: the footer isn't one of them.
    expect(menu().lastElementChild).toBe(footer())

    // Someone already known edits it again: the `stored` message's row replaces it.
    act(() => store.applyStored([{ block_id: ID(2), user_id: 8, edited_at: new Date().toISOString() }]))
    expect(footer()?.textContent).toBe("Last edited by Ana Costa · just now")
  })

  it("shows no line for a block without attribution, nor without the store", async () => {
    const store = new PostBlockEditsStore(1, { getPostBlockEdits: async () => ({}) })
    await store.refresh()
    openWithEdits(at(1), store)
    expect(footer()).toBeNull()
    expect(menu().hasAttribute("aria-describedby")).toBe(false)
    open(at(1))
    expect(footer()).toBeNull()
  })
})

describe("BlockMenu: Comment (#192)", () => {
  it("offers Comment (Ctrl M) after Colour when the post has comments, and opens it for that block", () => {
    const onComment = vi.fn()
    const { onClose } = open(at(1), { onComment })
    expect(labels()).toEqual(["Colour", "Comment", "Duplicate", "Copy link to block", "Move to", "Delete"])
    expect(item("Comment").textContent).toContain("Ctrl M")
    act(() => item("Comment").click())
    expect(onClose).toHaveBeenCalledWith(false)
    expect(onComment).toHaveBeenCalledWith(at(1))
  })

  it("leaves Comment out without comments", () => {
    open(at(1))
    expect(labels()).not.toContain("Comment")
  })

  it("Ctrl M in the editor comments on the block holding the cursor", () => {
    const openComment = vi.fn()
    ;(editor.storage as any).blockActions.openComment = openComment
    editor.commands.setTextSelection(at(1).pos + 2)
    const event = new KeyboardEvent("keydown", { key: "m", ctrlKey: true, bubbles: true, cancelable: true })
    editor.view.someProp("handleKeyDown", (f) => f(editor.view, event))
    expect(openComment).toHaveBeenCalledWith(at(1))
  })
})

describe("BlockMenu (#356)", () => {
  it("offers Colour, Duplicate, Copy link to block, Move to and Delete, with shortcuts", () => {
    open(at(1), { postUrl: "http://site.test/post/7" })
    expect(labels()).toEqual(["Colour", "Duplicate", "Copy link to block", "Move to", "Delete"])
    expect(item("Duplicate").textContent).toContain("Ctrl D")
    expect(item("Move to").textContent).toContain("Ctrl Shift P")
    expect(item("Colour").getAttribute("aria-haspopup")).toBe("menu")
  })

  it("has no Colour for a block that takes none (a divider)", () => {
    open(at(3))
    expect(labels()).not.toContain("Colour")
  })

  it("Duplicate copies the block it opened for and closes", () => {
    const { onClose } = open(at(1))
    act(() => item("Duplicate").click())
    expect(onClose).toHaveBeenCalled()
    const texts: string[] = []
    editor.state.doc.forEach((n) => texts.push(n.textContent))
    expect(texts).toEqual(["Intro", "alpha", "alpha", "Usage", "", "end"])
  })

  it("Colour › opens the palette (ArrowRight too) and sets the colour", () => {
    open(at(1))
    act(() => item("Colour").focus())
    act(() => {
      item("Colour").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    })
    const palette = document.querySelector('[role="menu"][aria-label="Colour"]')!
    expect(palette).not.toBeNull()
    const radios = Array.from(palette.querySelectorAll('[role="menuitemradio"]')).map((b) => b.textContent)
    expect(radios).toHaveLength(19) // Default + 9 text + 9 background
    expect(item("Default").getAttribute("aria-checked")).toBe("true")
    act(() => item("Blue background").click())
    expect(editor.state.doc.child(1).attrs.blockColor).toBe("blue-background")
  })

  it("Copy link to block copies the public URL with #b-<id>; without a post URL it's off", async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    open(at(1))
    expect(item("Copy link to block").getAttribute("aria-disabled")).toBe("true")
    open(at(1), { postUrl: "http://site.test/post/7" })
    await act(async () => item("Copy link to block").click())
    expect(writeText).toHaveBeenCalledWith(`http://site.test/post/7#b-${ID(2)}`)
  })

  it("Move to hands the block to the picker", () => {
    const { onMoveTo } = open(at(1))
    act(() => item("Move to").click())
    expect(onMoveTo).toHaveBeenCalledWith(at(1))
  })

  it("Del (the hint next to Delete) deletes the block from the menu", () => {
    open(at(1))
    act(() => {
      menu().dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }))
    })
    const texts: string[] = []
    editor.state.doc.forEach((n) => texts.push(n.textContent))
    expect(texts).toEqual(["Intro", "Usage", "", "end"])
  })

  it("Escape closes and returns focus to the handle", () => {
    const { onClose } = open(at(1))
    act(() => {
      menu().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledWith(true)
  })
})

describe("MoveToDialog (#356)", () => {
  it("lists the other headings, filters them, and moves the block under the one picked", () => {
    const onClose = vi.fn()
    act(() => root.render(<MoveToDialog editor={editor} target={at(1)} onClose={onClose} />))
    const options = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".editor-move-to__option"))
    expect(options().map((o) => o.querySelector(".editor-move-to__text")?.textContent)).toEqual(["Intro", "Usage"])
    act(() => options()[1].click())
    expect(onClose).toHaveBeenCalled()
    const texts: string[] = []
    editor.state.doc.forEach((n) => texts.push(n.textContent))
    expect(texts).toEqual(["Intro", "Usage", "alpha", "", "end"])
  })

  it("leaves the heading itself out, and filters by text", () => {
    const headings = listHeadings(editor.state.doc)
    expect(filterHeadings(headings, "  usa ").map((h) => h.text)).toEqual(["Usage"])
    act(() => root.render(<MoveToDialog editor={editor} target={at(0)} onClose={() => {}} />))
    expect(Array.from(document.querySelectorAll(".editor-move-to__text")).map((t) => t.textContent)).toEqual(["Usage"])
  })
})
