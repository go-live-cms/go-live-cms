import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useLocation } from "react-router-dom"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { COMMAND_PALETTE_DEBOUNCE_MS, openCommandPalette } from "@gl-admin/lib/commandPalette"
import type { CommandPaletteResults } from "@gl-admin/lib/api/commandPalette"
import { OpenLinkModal } from "../editor/extensions/OpenLinkModal"

// The command palette (#41): where Ctrl K opens it and where it stays the editor's, what
// each role is offered, the debounce and stale answers, the keys, and where a pick goes.

const api = vi.hoisted(() => ({ role: "admin" as string | undefined, search: vi.fn() }))

vi.mock("@gl-admin/lib/hooks/useCurrentRole", () => ({ useCurrentRole: () => api.role }))
vi.mock("@gl-admin/lib/api/commandPalette", () => ({ searchCommandPalette: api.search }))

import CommandPalette from "./CommandPalette"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const empty = (over: Partial<CommandPaletteResults> = {}): CommandPaletteResults => ({ posts: [], pages: [], media: [], terms: [], ...over })
const post = (id: number, title: string, post_status = "published") => ({ id, title, post_type: "post", post_status })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let container: HTMLDivElement
let outside: HTMLButtonElement
let root: Root
let path = "/"

function Probe() {
  const location = useLocation()
  path = location.pathname + location.search
  return null
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!
const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
const optionLabels = () => options().map((o) => o.getAttribute("aria-label"))
const groups = () => Array.from(document.querySelectorAll('[role="group"]')).map((g) => g.getAttribute("aria-label"))

function pressCtrlK(target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function press(key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  act(() => {
    input().dispatchEvent(event)
  })
  return event
}

function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text)
    input().dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function afterDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(COMMAND_PALETTE_DEBOUNCE_MS)
    await Promise.resolve()
  })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  api.role = "admin"
  api.search.mockReset()
  api.search.mockResolvedValue(empty())
  path = "/"
  outside = document.createElement("button")
  document.body.appendChild(outside)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <CommandPalette />
        <Probe />
      </MemoryRouter>
    )
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  outside.remove()
  vi.useRealTimers()
})

describe("opening", () => {
  it("Ctrl K opens it from anywhere outside the editor and takes the focus", () => {
    outside.focus()
    const event = pressCtrlK()
    expect(dialog()?.getAttribute("aria-modal")).toBe("true")
    expect(document.activeElement).toBe(input())
    expect(event.defaultPrevented).toBe(true)
  })

  it("Ctrl K closes it again", () => {
    pressCtrlK()
    pressCtrlK()
    expect(dialog()).toBeNull()
  })

  it("Cmd K does the same", () => {
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }))
    })
    expect(dialog()).not.toBeNull()
  })

  it("leaves Ctrl K to the browser and the editor while the editor has focus", () => {
    const editor = document.createElement("div")
    editor.className = "ProseMirror"
    editor.tabIndex = 0
    document.body.appendChild(editor)
    editor.focus()
    const event = pressCtrlK(editor)
    expect(dialog()).toBeNull()
    expect(event.defaultPrevented).toBe(false)
    editor.remove()
  })

  it("keeps Ctrl K as the link dialog in a real editor, and opens from outside it", () => {
    const onOpen = vi.fn()
    const element = document.createElement("div")
    document.body.appendChild(element)
    const editor = new Editor({
      element,
      extensions: [StarterKit, OpenLinkModal.configure({ onOpen })],
      content: "<p>Some text</p>",
    })
    editor.view.dom.focus()
    expect(document.activeElement).toBe(editor.view.dom)

    pressCtrlK(editor.view.dom)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()

    outside.focus()
    pressCtrlK(outside)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(dialog()).not.toBeNull()

    editor.destroy()
    element.remove()
  })

  it("the Search button opens it even while the editor has focus", () => {
    const editor = document.createElement("div")
    editor.className = "ProseMirror"
    editor.tabIndex = 0
    document.body.appendChild(editor)
    editor.focus()
    act(() => openCommandPalette())
    expect(dialog()).not.toBeNull()
    editor.remove()
  })

  it("doesn't open over another dialog", () => {
    const other = document.createElement("div")
    other.setAttribute("aria-modal", "true")
    document.body.appendChild(other)
    outside.focus()
    pressCtrlK()
    expect(dialog()).toBeNull()
    other.remove()
  })

  it("Esc closes it and returns focus to where it was", () => {
    outside.focus()
    pressCtrlK()
    expect(document.activeElement).toBe(input())
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    })
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(outside)
  })

  it("the scrim closes it", () => {
    pressCtrlK()
    act(() => {
      dialog()!.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    })
    expect(dialog()).toBeNull()
  })
})

describe("permissions", () => {
  it("offers an admin every action", () => {
    pressCtrlK()
    expect(optionLabels()).toEqual(["New post", "New page", "Settings", "Media", "Users"])
  })

  it.each(["editor", "contributor"])("hides Settings and Users from an %s", (role) => {
    api.role = role
    pressCtrlK()
    expect(optionLabels()).toEqual(["New post", "New page", "Media"])
  })

  it("doesn't search for a role without content access", async () => {
    api.role = "subscriber"
    pressCtrlK()
    expect(options()).toHaveLength(0)
    type("draft")
    await afterDebounce()
    expect(api.search).not.toHaveBeenCalled()
    expect(dialog()!.textContent).not.toContain("No results")
  })

  it("shows a Users group only when the API sent one", async () => {
    api.role = "editor"
    api.search.mockResolvedValue(empty({ posts: [post(1, "Draft notes")] }))
    pressCtrlK()
    type("draft")
    await afterDebounce()
    await flush()
    expect(groups()).toEqual(["Posts"])

    api.search.mockResolvedValue(empty({ users: [{ id: 5, username: "ana", full_name: "Ana", avatar: null, role: "editor" }] }))
    type("drafty")
    await afterDebounce()
    await flush()
    expect(groups()).toEqual(["Users"])
    expect(optionLabels()).toEqual(["Ana, Editor"])
  })
})

describe("searching", () => {
  it("waits for a pause and asks once", async () => {
    pressCtrlK()
    type("d")
    await act(async () => vi.advanceTimersByTime(COMMAND_PALETTE_DEBOUNCE_MS - 1))
    type("dr")
    await act(async () => vi.advanceTimersByTime(COMMAND_PALETTE_DEBOUNCE_MS - 1))
    expect(api.search).not.toHaveBeenCalled()
    await afterDebounce()
    expect(api.search).toHaveBeenCalledTimes(1)
    expect(api.search.mock.calls[0][0]).toBe("dr")
  })

  it("doesn't search with nothing typed", async () => {
    pressCtrlK()
    type("   ")
    await afterDebounce()
    expect(api.search).not.toHaveBeenCalled()
  })

  it("cancels the request a newer query replaces and ignores its answer", async () => {
    const first = deferred<CommandPaletteResults>()
    const second = deferred<CommandPaletteResults>()
    api.search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    pressCtrlK()

    type("old")
    await afterDebounce()
    const firstSignal = api.search.mock.calls[0][1] as AbortSignal
    expect(firstSignal.aborted).toBe(false)

    type("new text")
    expect(firstSignal.aborted).toBe(true)
    await afterDebounce()

    // The newer answer lands first, the stale one after it.
    second.resolve(empty({ posts: [post(2, "New text results")] }))
    await flush()
    first.resolve(empty({ posts: [post(1, "Old stale result")] }))
    await flush()

    expect(optionLabels()).toEqual(["New text results, Published"])
  })

  it("never shows an answer for other text, even when the request can't be cancelled in time", async () => {
    const first = deferred<CommandPaletteResults>()
    api.search.mockReturnValueOnce(first.promise)
    pressCtrlK()
    type("old")
    await afterDebounce()
    type("new text")
    first.resolve(empty({ posts: [post(1, "Old stale result")] }))
    await flush()
    expect(optionLabels()).toEqual([])
  })

  it("ignores a late failure of a replaced request", async () => {
    const first = deferred<CommandPaletteResults>()
    api.search.mockReturnValueOnce(first.promise).mockResolvedValueOnce(empty({ posts: [post(2, "Fresh")] }))
    pressCtrlK()
    type("old")
    await afterDebounce()
    type("fresh")
    await afterDebounce()
    await flush()
    first.reject(new DOMException("Aborted", "AbortError"))
    await flush()
    expect(optionLabels()).toEqual(["Fresh, Published"])
    expect(dialog()!.textContent).not.toContain("Search isn't available")
  })

  it("shows the matching actions and skeletons while it waits, then the results", async () => {
    const answer = deferred<CommandPaletteResults>()
    api.search.mockReturnValueOnce(answer.promise)
    pressCtrlK()
    type("new")
    expect(groups()).toEqual(["Jump to"])
    expect(document.querySelector(".gl-skeleton")).not.toBeNull()
    expect(document.querySelector('[role="status"]')!.textContent).toBe("Searching…")

    await afterDebounce()
    answer.resolve(empty({ posts: [post(1, "News")] }))
    await flush()
    expect(groups()).toEqual(["Jump to", "Posts"])
    expect(document.querySelector(".gl-skeleton")).toBeNull()
    expect(options()[0].getAttribute("aria-selected")).toBe("true")
  })

  it("says so when nothing matches", async () => {
    pressCtrlK()
    type("quarterly roadmap")
    await afterDebounce()
    await flush()
    expect(dialog()!.textContent).toContain("No results for “quarterly roadmap”")
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(input().getAttribute("aria-expanded")).toBe("false")
  })

  it("says so when the search fails, and keeps the actions that match", async () => {
    api.search.mockRejectedValue(new Error("offline"))
    pressCtrlK()
    type("new")
    await afterDebounce()
    await flush()
    expect(dialog()!.textContent).toContain("Search isn't available")
    expect(groups()).toEqual(["Jump to"])
  })

  it("forgets the text when it's closed and reopened", () => {
    pressCtrlK()
    type("draft")
    pressCtrlK()
    pressCtrlK()
    expect(input().value).toBe("")
  })
})

describe("keyboard", () => {
  async function withResults() {
    api.search.mockResolvedValue(
      empty({
        posts: [post(1, "One"), post(2, "Two")],
        media: [{ id: 3, name: "Three", media_path: "/uploads/media/three.pdf", mime_type: "application/pdf" } as CommandPaletteResults["media"][number]],
      })
    )
    pressCtrlK()
    type("t")
    await afterDebounce()
    await flush()
  }

  const activeId = () => input().getAttribute("aria-activedescendant")
  const selectedLabel = () => options().find((o) => o.getAttribute("aria-selected") === "true")?.getAttribute("aria-label")

  it("uses listbox and option semantics", async () => {
    await withResults()
    const list = document.querySelector('[role="listbox"]')!
    expect(input().getAttribute("aria-controls")).toBe(list.id)
    expect(input().getAttribute("aria-expanded")).toBe("true")
    expect(activeId()).toBe(options()[0].id)
    expect(list.querySelectorAll('[role="group"]').length).toBe(2)
  })

  it("walks the options across groups and wraps", async () => {
    await withResults()
    expect(selectedLabel()).toBe("One, Published")
    expect(press("ArrowDown").defaultPrevented).toBe(true)
    expect(selectedLabel()).toBe("Two, Published")
    press("ArrowDown")
    expect(selectedLabel()).toBe("Three, File")
    expect(activeId()).toBe(options()[2].id)
    press("ArrowDown")
    expect(selectedLabel()).toBe("One, Published")
    press("ArrowUp")
    expect(selectedLabel()).toBe("Three, File")
  })

  it("Enter opens the active result", async () => {
    await withResults()
    press("ArrowDown")
    press("Enter")
    expect(path).toBe("/content/edit/2")
    expect(dialog()).toBeNull()
  })

  it("a new query starts at its first result", async () => {
    await withResults()
    press("ArrowDown")
    api.search.mockResolvedValue(empty({ posts: [post(9, "Tree")] }))
    type("tr")
    await afterDebounce()
    await flush()
    expect(selectedLabel()).toBe("Tree, Published")
  })

  it("Enter with nothing to open does nothing", async () => {
    pressCtrlK()
    type("quarterly roadmap")
    await afterDebounce()
    await flush()
    press("Enter")
    expect(path).toBe("/")
    expect(dialog()).not.toBeNull()
  })

  it("the pointer moves the highlight and a click opens it", async () => {
    await withResults()
    act(() => {
      options()[1].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }))
    })
    expect(selectedLabel()).toBe("Two, Published")
    act(() => {
      options()[2].click()
    })
    expect(path).toBe("/media/3")
  })
})

describe("actions", () => {
  it.each([
    ["New post", "/content/post/new"],
    ["New page", "/content/page/new"],
    ["Settings", "/settings"],
    ["Media", "/media"],
    ["Users", "/users"],
  ])("%s goes to %s", (label, target) => {
    pressCtrlK()
    act(() => {
      options().find((o) => o.getAttribute("aria-label") === label)!.click()
    })
    expect(path).toBe(target)
    expect(dialog()).toBeNull()
  })

  it("finds an action by typing it", () => {
    pressCtrlK()
    type("sett")
    expect(optionLabels()).toEqual(["Settings"])
    press("Enter")
    expect(path).toBe("/settings")
  })
})
