import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PostAuthor } from "@gl-admin/lib/api/types"

// The Authors field (#319): chips in byline order, add / move / remove through
// PUT /posts/:id/authors, the last author kept, a failed save rolled back, and the
// read-only view.

const api = vi.hoisted(() => ({
  getPostAuthors: vi.fn(),
  setPostAuthors: vi.fn(),
  searchAuthorCandidates: vi.fn(),
}))
vi.mock("@gl-admin/lib/api/posts", () => api)
const PostAuthors = (await import("./PostAuthors")).default

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ana: PostAuthor = { id: 1, username: "ana", full_name: "Ana Costa" }
const luan: PostAuthor = { id: 2, username: "luan", full_name: "" }
const priya: PostAuthor = { id: 3, username: "priya", full_name: "Priya Nair" }

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  api.getPostAuthors.mockReset().mockResolvedValue([ana, luan])
  api.setPostAuthors.mockReset().mockImplementation(async (_id: number, ids: number[]) =>
    ids.map((id) => [ana, luan, priya].find((a) => a.id === id)!),
  )
  api.searchAuthorCandidates.mockReset().mockResolvedValue([ana, luan, priya])
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
}

async function mount(props: { readOnly?: boolean; onChange?: () => void } = {}) {
  await act(async () => {
    root.render(<PostAuthors postId={7} readOnly={props.readOnly ?? false} onChange={props.onChange} />)
  })
  await flush()
}

const chips = () => [...container.querySelectorAll(".post-authors__chip .post-authors__name")].map((c) => c.textContent)
const chip = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button.post-authors__chip")].find((b) => b.querySelector(".post-authors__name")?.textContent === name)!
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.includes(label))!

async function choose(name: string, item: string) {
  await act(async () => chip(name).click())
  await act(async () => menuItem(item).click())
  await flush()
}

describe("PostAuthors", () => {
  it("shows the byline in order with the design's hint", async () => {
    await mount()
    expect(api.getPostAuthors).toHaveBeenCalledWith(7)
    expect(chips()).toEqual(["Ana Costa", "luan"])
    expect(chip("Ana Costa").getAttribute("aria-label")).toBe("Ana Costa, author 1 of 2")
    expect(container.textContent).toContain("Adding an author doesn’t give them access.")
  })

  it("adds someone from the search, at the end", async () => {
    const onChange = vi.fn()
    await mount({ onChange })
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add author"]')!.click())
    await flush()
    expect(api.searchAuthorCandidates).toHaveBeenCalledWith("")
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!
    await act(async () => {
      input.focus()
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    })
    // Already-credited people aren't offered.
    const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)
    expect(options).toHaveLength(1)
    expect(options[0]).toContain("Priya Nair")
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    })
    await flush()
    expect(api.setPostAuthors).toHaveBeenCalledWith(7, [1, 2, 3])
    expect(chips()).toEqual(["Ana Costa", "luan", "Priya Nair"])
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it("reorders and removes", async () => {
    await mount()
    await choose("luan", "Move earlier")
    expect(api.setPostAuthors).toHaveBeenLastCalledWith(7, [2, 1])
    expect(chips()).toEqual(["luan", "Ana Costa"])
    await choose("luan", "Remove")
    expect(api.setPostAuthors).toHaveBeenLastCalledWith(7, [1])
    expect(chips()).toEqual(["Ana Costa"])
  })

  it("keeps the last author", async () => {
    api.getPostAuthors.mockResolvedValue([ana])
    await mount()
    await act(async () => chip("Ana Costa").click())
    expect(menuItem("Remove").getAttribute("aria-disabled") === "true" || menuItem("Remove").disabled).toBe(true)
    expect(menuItem("Remove").textContent).toContain("A post credits at least one author.")
  })

  it("puts the byline back when saving fails", async () => {
    api.setPostAuthors.mockRejectedValue(new Error("every author must be an existing user"))
    const onChange = vi.fn()
    await mount({ onChange })
    await choose("Ana Costa", "Move later")
    expect(chips()).toEqual(["Ana Costa", "luan"])
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("every author must be an existing user")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("is view-only for users who can't change the post's details", async () => {
    await mount({ readOnly: true })
    expect(chips()).toEqual(["Ana Costa", "luan"])
    expect(container.querySelector("button.post-authors__chip")).toBeNull()
    expect(container.querySelector('[aria-label="Add author"]')).toBeNull()
  })
})
