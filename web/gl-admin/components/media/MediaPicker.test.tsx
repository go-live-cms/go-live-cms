import React, { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Media } from "@gl-admin/lib/api/types"
import MediaPicker from "./MediaPicker"

// The shared media picker (#423, design 3.4): one dialog for the featured and social
// images and every media block. A kind limits it (the API's `type`); without one the
// library's kind filter shows. One or several files, Upload in place, "No alt text" on
// images without it (#325), Remove for the file in use, and the keyboard.

const api = vi.hoisted(() => ({ getMedia: vi.fn(), createMedia: vi.fn() }))
vi.mock("@gl-admin/lib/api/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gl-admin/lib/api/media")>()),
  getMedia: api.getMedia,
  createMedia: api.createMedia,
}))

function media(id: number, extra: Partial<Media> = {}): Media {
  return {
    id,
    name: `photo-${id}.jpg`,
    description: "",
    alt: "A photo",
    media_path: `/uploads/media/photo-${id}.jpg`,
    user_id: 1,
    created_at: "2026-11-01T00:00:00Z",
    changed_at: "2026-11-01T00:00:00Z",
    file_size: 1024,
    mime_type: "image/jpeg",
    original_filename: `photo-${id}.jpg`,
    ...extra,
  }
}

const videos = [
  media(1, { name: "launch.mp4", mime_type: "video/mp4", media_path: "/uploads/media/launch.mp4", alt: "" }),
  media(2, { name: "demo.webm", mime_type: "video/webm", media_path: "/uploads/media/demo.webm", alt: "" }),
]

beforeEach(() => {
  api.getMedia.mockReset()
  api.createMedia.mockReset()
  api.getMedia.mockImplementation(async (params: { type?: string }) => ({
    data: params.type === "video" ? videos : [media(10), media(11, { alt: "" }), media(12, { alt: "", decorative: true })],
    meta: { count: 3, limit: 20, offset: 0, total: 3 },
  }))
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  vi.restoreAllMocks()
})

let root: Root | null = null
let container: HTMLElement | null = null

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
function button(name: string | RegExp, scope: ParentNode = document): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    typeof name === "string" ? nameOf(b) === name : name.test(nameOf(b))
  )
  if (!found) throw new Error(`no button named ${name}: ${Array.from(scope.querySelectorAll("button")).map(nameOf).join(" | ")}`)
  return found
}
const queryButton = (name: string) => Array.from(document.querySelectorAll("button")).find((b) => nameOf(b) === name) ?? null
const dialogTitle = () => document.querySelector('[role="dialog"] .gl-modal__title, [role="dialog"] h2')?.textContent
const click = async (el: Element) => {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}
const key = async (el: Element, k: string) => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }))
  })
}
async function chooseFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", { value: files, configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await flush()
  await flush()
}
const uploadInput = () => document.querySelector('[data-testid="media-picker-upload"]') as HTMLInputElement
const tile = (name: string) => button(name, document.querySelector(".gl-media-picker__grid") ?? document)
describe("MediaPicker", () => {
  it("lists only its kind: the API's type filter, no kind filter shown", async () => {
    await render(<MediaPicker isOpen onClose={() => {}} onSelect={() => {}} kind="video" />)
    expect(tile("launch.mp4")).toBeTruthy()
    expect(api.getMedia).toHaveBeenCalledWith(expect.objectContaining({ type: "video", offset: 0 }))
    expect(dialogTitle()).toBe("Choose a video")
    expect(document.querySelector('[role="radiogroup"]')).toBeNull()
    // A video tile shows its format, not a picture.
    expect(tile("launch.mp4").textContent).toContain("MP4")
    expect(tile("launch.mp4").querySelector("img")).toBeNull()
  })

  it("without a kind, offers the library's kind filter and lists by it", async () => {
    await render(<MediaPicker isOpen onClose={() => {}} onSelect={() => {}} />)
    const filter = document.querySelector('[role="radiogroup"][aria-label="Kind of file"]')!
    const radios = Array.from(filter.querySelectorAll('[role="radio"]'))
    expect(radios.map((r) => r.textContent)).toEqual(["All", "Images", "Video", "Audio", "Files"])
    await click(button("Video", filter))
    expect(api.getMedia).toHaveBeenLastCalledWith(expect.objectContaining({ type: "video" }))
    expect(tile("demo.webm")).toBeTruthy()
    expect(button("Video", filter).getAttribute("aria-checked")).toBe("true")
  })

  it("picks one file and closes", async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    await render(<MediaPicker isOpen onClose={onClose} onSelect={onSelect} kind="image" />)
    await click(tile("photo-10.jpg"))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 10 }))
    expect(onClose).toHaveBeenCalled()
  })

  it("flags images without alt text, not decorative ones (#325)", async () => {
    await render(<MediaPicker isOpen onClose={() => {}} onSelect={() => {}} kind="image" />)
    expect(tile("photo-11.jpg, no alt text").textContent).toContain("No alt text")
    expect(tile("photo-12.jpg").textContent).not.toContain("No alt text")
    expect(tile("photo-10.jpg").textContent).not.toContain("No alt text")
  })

  it("marks the file in use and offers Remove (the featured image's, as before)", async () => {
    const onSelect = vi.fn()
    await render(
      <MediaPicker isOpen onClose={() => {}} onSelect={onSelect} kind="image" current={media(10)} title="Select Featured Image" removeLabel="Remove Featured Image" />,
    )
    expect(dialogTitle()).toBe("Select Featured Image")
    expect(tile("photo-10.jpg").getAttribute("aria-current")).toBe("true")
    expect(tile("photo-12.jpg").getAttribute("aria-current")).toBeNull()
    await click(button("Remove Featured Image"))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it("has no Remove without a file in use", async () => {
    await render(<MediaPicker isOpen onClose={() => {}} onSelect={() => {}} kind="image" removeLabel="Remove Featured Image" />)
    expect(queryButton("Remove Featured Image")).toBeNull()
  })

  it("chooses several files, in the order picked, confirmed with the dialog's button", async () => {
    const onSelectMany = vi.fn()
    const onClose = vi.fn()
    await render(<MediaPicker isOpen multiple onClose={onClose} onSelect={() => {}} onSelectMany={onSelectMany} kind="image" />)
    expect(button(/^Add/).disabled).toBe(true)
    await click(tile("photo-12.jpg"))
    await click(tile("photo-10.jpg"))
    expect(tile("photo-12.jpg").getAttribute("aria-pressed")).toBe("true")
    await click(tile("photo-11.jpg, no alt text"))
    await click(tile("photo-11.jpg, no alt text")) // and out again
    expect(tile("photo-11.jpg, no alt text").getAttribute("aria-pressed")).toBe("false")
    expect(document.body.textContent).toContain("2 chosen")
    expect(onClose).not.toHaveBeenCalled()
    await click(button("Add 2 images"))
    expect(onSelectMany.mock.calls[0][0].map((m: Media) => m.id)).toEqual([12, 10])
    expect(onClose).toHaveBeenCalled()
  })

  it("uploads in place, and picks what was uploaded", async () => {
    const uploaded = media(50, { name: "new.mp4", mime_type: "video/mp4", media_path: "/uploads/media/new.mp4", alt: "" })
    api.createMedia.mockResolvedValue({ media: uploaded })
    const onSelect = vi.fn()
    await render(<MediaPicker isOpen onClose={() => {}} onSelect={onSelect} kind="video" />)
    expect(uploadInput().accept).toContain("video/mp4")
    const file = new File(["x"], "new.mp4", { type: "video/mp4" })
    await chooseFiles(uploadInput(), [file])
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 50 }))
    const form = api.createMedia.mock.calls[0][0] as FormData
    expect(form.get("file")).toBe(file)
    expect(form.get("name")).toBe("new.mp4")
    expect(form.get("description")).toBe("Uploaded file: new.mp4")
  })

  it("refuses to upload a file of another kind", async () => {
    await render(<MediaPicker isOpen onClose={() => {}} onSelect={() => {}} kind="audio" />)
    await chooseFiles(uploadInput(), [new File(["x"], "photo.png", { type: "image/png" })])
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("photo.png isn't an audio file")
    expect(api.createMedia).not.toHaveBeenCalled()
  })

  it("adds uploads to a multiple choice instead of closing", async () => {
    api.createMedia.mockResolvedValueOnce({ media: media(60) }).mockResolvedValueOnce({ media: media(61) })
    const onSelectMany = vi.fn()
    await render(<MediaPicker isOpen multiple onClose={() => {}} onSelect={() => {}} onSelectMany={onSelectMany} kind="image" />)
    await chooseFiles(uploadInput(), [new File(["a"], "a.jpg", { type: "image/jpeg" }), new File(["b"], "b.jpg", { type: "image/jpeg" })])
    expect(document.body.textContent).toContain("2 chosen")
    expect(tile("photo-60.jpg").getAttribute("aria-pressed")).toBe("true")
    await click(button("Add 2 images"))
    expect(onSelectMany.mock.calls[0][0].map((m: Media) => m.id)).toEqual([60, 61])
  })

  it("moves between tiles with the arrow keys, Home and End; each tile is a button", async () => {
    const onSelect = vi.fn()
    await render(<MediaPicker isOpen onClose={() => {}} onSelect={onSelect} kind="image" />)
    const first = tile("photo-10.jpg")
    first.focus()
    const grid = first.closest("ul")!
    await key(grid, "ArrowRight")
    expect(document.activeElement).toBe(tile("photo-11.jpg, no alt text"))
    await key(grid, "End")
    expect(document.activeElement).toBe(tile("photo-12.jpg"))
    await key(grid, "Home")
    expect(document.activeElement).toBe(first)
    await key(grid, "ArrowLeft")
    expect(document.activeElement).toBe(first)
    expect(first.tagName).toBe("BUTTON")
    expect(first.type).toBe("button")
  })

  it("searches by the typed words, and says when nothing matches", async () => {
    await render(<MediaPicker isOpen onClose={() => {}} onSelect={() => {}} kind="audio" />)
    api.getMedia.mockResolvedValue({ data: [], meta: { count: 0, limit: 20, offset: 0, total: 0 } })
    const search = document.querySelector('input[type="search"]') as HTMLInputElement
    expect(document.querySelector(`label[for="${search.id}"]`)!.textContent).toBe("Search audio files")
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
      setValue.call(search, "episode")
      search.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    await flush()
    expect(api.getMedia).toHaveBeenLastCalledWith(expect.objectContaining({ type: "audio", search: "episode" }))
    expect(document.body.textContent).toContain('No audio files found for "episode"')
  })
})