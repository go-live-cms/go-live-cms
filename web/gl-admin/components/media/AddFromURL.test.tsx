import React, { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Media } from "@gl-admin/lib/api/types"
import { ApiError } from "@gl-admin/lib/api/errors"
import { AddFromURLDialog } from "./AddFromURL"
import MediaPicker from "./MediaPicker"

// "Add from URL" (#29; the canvas's "Media · Add from URL" board): the library's dialog
// and the picker's form. The API downloads; these only send the links and show results.

const api = vi.hoisted(() => ({ importMediaFromURLs: vi.fn(), getMedia: vi.fn() }))
vi.mock("@gl-admin/lib/api/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gl-admin/lib/api/media")>()),
  importMediaFromURLs: api.importMediaFromURLs,
  getMedia: api.getMedia,
}))

function media(id: number, extra: Partial<Media> = {}): Media {
  return {
    id,
    name: `photo-${id}`,
    description: "Imported from images.example.com",
    alt: "",
    media_path: `/uploads/media/photo-${id}.jpg`,
    user_id: 1,
    created_at: "2026-11-19T00:00:00Z",
    changed_at: "2026-11-19T00:00:00Z",
    file_size: 1024,
    mime_type: "image/jpeg",
    original_filename: `photo-${id}.jpg`,
    ...extra,
  }
}

let root: Root | null = null
let container: HTMLElement | null = null

beforeEach(() => {
  api.importMediaFromURLs.mockReset()
  api.getMedia.mockReset()
  api.getMedia.mockResolvedValue({ data: [], meta: { count: 0, limit: 20, offset: 0, total: 0 } })
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
})

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function render(element: ReactElement) {
  container = document.createElement("div")
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root.render(element)
  })
  await flush()
}

const nameOf = (el: Element) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim()
function button(name: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => nameOf(b) === name)
  if (!found) throw new Error(`no button named ${name}: ${Array.from(document.querySelectorAll("button")).map(nameOf).join(" | ")}`)
  return found
}
async function click(el: HTMLElement) {
  await act(async () => el.click())
  await flush()
}
function textarea(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>("textarea")!
}
async function type(text: string) {
  const el = textarea()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
  await act(async () => {
    setter.call(el, text)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("AddFromURLDialog", () => {
  it("starts empty with the button off, and refuses a line that isn't a link", async () => {
    await render(<AddFromURLDialog isOpen onClose={() => {}} onAdded={() => {}} />)
    expect(document.body.textContent).toContain("Add from URL")
    expect(textarea().value).toBe("")
    expect(button("Add files").disabled).toBe(true)

    await type("https://images.example.com/photo.jpg\nexample.com/clip.mp4\nhttps://cdn.example.com/report.pdf")
    expect(document.body.textContent).toContain("Line 2 isn't a link starting with http:// or https://.")
    expect(button("Add 2 files").disabled).toBe(true)

    await type("https://images.example.com/photo.jpg\nhttps://cdn.example.com/report.pdf")
    expect(button("Add 2 files").disabled).toBe(false)
  })

  it("sends the links, shows a row per link while adding, then the results", async () => {
    let finish: (value: unknown) => void = () => {}
    api.importMediaFromURLs.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const onAdded = vi.fn()
    await render(<AddFromURLDialog isOpen onClose={() => {}} onAdded={onAdded} />)
    await type("https://images.example.com/photo.jpg?token=s3cret\nhttps://cdn.example.com/big.mp4")
    await click(button("Add 2 files"))

    expect(api.importMediaFromURLs).toHaveBeenCalledWith(["https://images.example.com/photo.jpg?token=s3cret", "https://cdn.example.com/big.mp4"])
    expect(textarea().readOnly).toBe(true)
    expect(document.querySelectorAll(".gl-add-from-url__row.is-pending")).toHaveLength(2)
    // Each row shows the host and path, never the query.
    const rows = document.querySelector('[aria-label="Downloading"]')!.textContent
    expect(rows).toContain("images.example.com/photo.jpg")
    expect(rows).not.toContain("s3cret")
    expect(button("Cancel").disabled).toBe(true)

    await act(async () =>
      finish({
        results: [
          { url: "https://images.example.com/photo.jpg?token=s3cret", status: "added", media: media(7) },
          { url: "https://cdn.example.com/big.mp4", status: "failed", code: "too_large", error: "The file is larger than 50MB" },
        ],
        meta: { total: 2, successful: 1, failed: 1 },
      })
    )
    await flush()
    expect(onAdded).toHaveBeenCalledWith([expect.objectContaining({ id: 7 })])
    expect(document.body.textContent).toContain("1 added, 1 failed")
    expect(document.body.textContent).toContain("Added as photo-7.jpg")
    expect(document.body.textContent).toContain("The file is larger than 50MB")

    // The failed link goes back in the box.
    await click(button("Try failed again"))
    expect(textarea().value).toBe("https://cdn.example.com/big.mp4")
    expect(button("Add 1 file").disabled).toBe(false)
  })

  it("keeps the links when the whole request is refused", async () => {
    api.importMediaFromURLs.mockRejectedValue(new ApiError("too many requests, try again later", 429))
    const onAdded = vi.fn()
    await render(<AddFromURLDialog isOpen onClose={() => {}} onAdded={onAdded} />)
    await type("https://images.example.com/photo.jpg")
    await click(button("Add 1 file"))
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("Too many imports. Try again in a minute.")
    expect(textarea().value).toBe("https://images.example.com/photo.jpg")
    expect(button("Add 1 file").disabled).toBe(false)
    expect(onAdded).not.toHaveBeenCalled()
  })
})

describe("the media picker's Add from URL", () => {
  it("picks the added file of the picker's kind", async () => {
    api.importMediaFromURLs.mockResolvedValue({
      results: [{ url: "https://images.example.com/photo.jpg", status: "added", media: media(9) }],
      meta: { total: 1, successful: 1, failed: 0 },
    })
    const onSelect = vi.fn()
    await render(<MediaPicker isOpen onClose={() => {}} onSelect={onSelect} kind="image" />)
    await click(button("Add from URL"))
    await type("https://images.example.com/photo.jpg")
    await click(button("Add 1 file"))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }))
  })

  it("says so when nothing added is of the picker's kind", async () => {
    api.importMediaFromURLs.mockResolvedValue({
      results: [{ url: "https://cdn.example.com/report.pdf", status: "added", media: media(10, { mime_type: "application/pdf" }) }],
      meta: { total: 1, successful: 1, failed: 0 },
    })
    const onSelect = vi.fn()
    await render(<MediaPicker isOpen onClose={() => {}} onSelect={onSelect} kind="video" />)
    await click(button("Add from URL"))
    await type("https://cdn.example.com/report.pdf")
    await click(button("Add 1 file"))
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("None of the added files is a video. They're in the library.")
  })
})
