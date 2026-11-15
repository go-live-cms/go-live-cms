import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Media } from "@gl-admin/lib/types"

// A video's "Captions (VTT)" (#507): choose through the media picker (WebVTT only), Remove,
// the language, each saved at once with PUT /media/:id; read-only without write access.

const api = vi.hoisted(() => ({
  getMediaById: vi.fn(),
  getMedia: vi.fn(),
  updateMedia: vi.fn(),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock("@gl-admin/lib/api/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gl-admin/lib/api/media")>()),
  getMediaById: api.getMediaById,
  getMedia: api.getMedia,
  updateMedia: api.updateMedia,
}))
vi.mock("@gl-admin/components/ui/Toast", () => ({ toast }))

import CaptionsField from "./CaptionsField"
import { deleteDescription } from "./mediaActions"
import { ApiError } from "@gl-admin/lib/api/errors"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VIDEO: Media = {
  id: 12,
  name: "Studio tour",
  description: "",
  alt: "",
  media_path: "/uploads/media/tour.mp4",
  user_id: 1,
  created_at: "2026-11-01T00:00:00Z",
  changed_at: "2026-11-01T00:00:00Z",
  file_size: 1024,
  mime_type: "video/mp4",
  original_filename: "tour.mp4",
  captions_media_id: null,
  captions_lang: "",
}
const VTT: Media = { ...VIDEO, id: 30, name: "English", media_path: "/uploads/media/tour-en.vtt", mime_type: "text/vtt", original_filename: "tour-en.vtt" }

let container: HTMLDivElement
let root: Root
let onUpdated: ReturnType<typeof vi.fn<(media: Media) => void>>

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))

async function render(media: Media, canWrite = true) {
  await act(async () => root.render(<CaptionsField media={media} canWrite={canWrite} onUpdated={onUpdated} />))
  await flush()
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)

async function click(label: string) {
  const target = button(label)
  expect(target, label).toBeTruthy()
  await act(async () => target!.click())
  await flush()
}

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  onUpdated = vi.fn()
  api.getMediaById.mockReset().mockImplementation(() => Promise.resolve({ media: VTT }))
  api.getMedia.mockReset().mockImplementation(() => Promise.resolve({ data: [VTT], meta: { total: 1 } }))
  api.updateMedia.mockReset()
  toast.success.mockReset()
  toast.error.mockReset()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("CaptionsField", () => {
  it("adds captions from the picker, which lists WebVTT files only", async () => {
    api.updateMedia.mockResolvedValue({ media: { ...VIDEO, captions_media_id: 30, captions_lang: "en-US" } })
    await render(VIDEO)
    expect(container.textContent).toContain("Captions (VTT)")
    expect(container.textContent).toContain("No captions")

    await click("Add captions")
    expect(api.getMedia).toHaveBeenCalledWith(expect.objectContaining({ type: "captions" }))
    const tile = document.querySelector<HTMLButtonElement>("button[data-media-tile]")
    expect(tile?.getAttribute("aria-label")).toBe("English")
    await act(async () => tile!.click())
    await flush()

    expect(api.updateMedia).toHaveBeenCalledWith(12, { captions_media_id: 30 })
    // The file picked is shown as is: no lookup for it.
    expect(api.getMediaById).not.toHaveBeenCalled()
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: 12, captions_media_id: 30, captions_lang: "en-US" }))
    expect(toast.success).toHaveBeenCalledWith("Captions added")
  })

  it("shows the file and its language, and removes them", async () => {
    api.updateMedia.mockResolvedValue({ media: { ...VIDEO, captions_media_id: null, captions_lang: "" } })
    await render({ ...VIDEO, captions_media_id: 30, captions_lang: "en-US" })
    expect(api.getMediaById).toHaveBeenCalledWith(30)
    expect(container.textContent).toContain("English")
    expect(container.textContent).toContain("VTT · en-US")

    await click("Remove")
    expect(api.updateMedia).toHaveBeenCalledWith(12, { captions_media_id: null })
    expect(toast.success).toHaveBeenCalledWith("Captions removed")
  })

  it("saves a new language, and holds an invalid one", async () => {
    api.updateMedia.mockResolvedValue({ media: { ...VIDEO, captions_media_id: 30, captions_lang: "pt-BR" } })
    await render({ ...VIDEO, captions_media_id: 30, captions_lang: "en-US" })
    const input = container.querySelector<HTMLInputElement>("input")!
    const setValue = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
        input.dispatchEvent(new Event("input", { bubbles: true }))
      })
    }

    await setValue("Portuguese")
    expect(container.textContent).toContain("Use a language tag such as en or pt-BR.")
    expect(button("Save")?.disabled).toBe(true)

    await setValue("pt-BR")
    await click("Save")
    expect(api.updateMedia).toHaveBeenCalledWith(12, { captions_lang: "pt-BR" })
    expect(toast.success).toHaveBeenCalledWith("Captions language saved")
  })

  it("says why the API refused", async () => {
    api.updateMedia.mockRejectedValue(new ApiError("Bad request.", 400, null, "invalid_captions"))
    await render({ ...VIDEO, captions_media_id: 30, captions_lang: "en-US" })
    await click("Remove")
    expect(toast.error).toHaveBeenCalledWith("Captions must be a WebVTT (.vtt) file in the media library.")
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it("warns that deleting a captions file takes the captions off its videos", () => {
    expect(deleteDescription([VTT])).toBe("Videos it captions lose their captions. This can't be undone.")
    expect(deleteDescription([VIDEO])).toBe("Posts that use it lose the image. This can't be undone.")
    expect(deleteDescription([VTT, VIDEO])).toBe("Posts that use it lose the image. This can't be undone.")
  })

  it("is read-only without write access", async () => {
    await render({ ...VIDEO, captions_media_id: 30, captions_lang: "en-US" }, false)
    expect(container.textContent).toContain("English")
    expect(button("Replace")).toBeUndefined()
    expect(button("Remove")).toBeUndefined()
    expect(container.querySelector("input")).toBeNull()
  })
})
