import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { resetMediaLookups } from "@gl-admin/lib/mediaLookup"
import { ApiError } from "@gl-admin/lib/api/errors"
import type { Media } from "@gl-admin/lib/api/types"
import BlockSettingsPanel from "./BlockSettingsPanel"
import { galleryImageMissingAlt } from "./GallerySettings"
import { requestGalleryAltFocus } from "../utils/galleryActions"

// The settings panel's Block tab for a gallery (#424, the canvas's Gallery settings and
// "Errors & empty states"): Columns, the images one by one, "No alt text" per image, and
// the selected image's alt text and caption fields.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
stubJsdomRangeLayout()

const api = vi.hoisted(() => ({ getMediaById: vi.fn() }))
vi.mock("@gl-admin/lib/api/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gl-admin/lib/api/media")>()),
  getMediaById: api.getMediaById,
}))

const G = "gallery-aaaa-00000000"
const A = "image-aaaa-0000000000"
const B = "image-bbbb-0000000000"
const C = "image-cccc-0000000000"

const image = (id: string, mediaId: number, alt: string, caption?: string) => ({
  type: "image",
  attrs: { "data-block-id": id, mediaId, src: `/uploads/${mediaId}.jpg`, alt },
  ...(caption ? { content: [{ type: "imageCaption", content: [{ type: "text", text: caption }] }] } : {}),
})

const media = (id: number, extra: Partial<Media> = {}) =>
  ({ id, name: `photo-${id}`, alt: "", media_path: `/uploads/media/photo-${id}.jpg`, mime_type: "image/jpeg", original_filename: `photo-${id}.jpg`, ...extra }) as Media

let editor: Editor
let container: HTMLDivElement
let root: Root
let mounted = false

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))

function mount(images: object[], columns = 3) {
  mounted = true
  editor = new Editor({
    element: document.createElement("div"),
    extensions: Object.values(schemaExtensions({ collaborating: false })),
    content: { type: "doc", content: [{ type: "gallery", attrs: { "data-block-id": G, columns }, content: [...images, { type: "galleryCaption" }] }] },
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<BlockSettingsPanel editor={editor} />))
}

const select = (id: string) =>
  act(() => {
    let at = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.attrs["data-block-id"] === id) at = pos
    })
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)))
  })

const rows = () => Array.from(container.querySelectorAll(".block-settings__gallery-row"))
const radio = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((b) => b.textContent === label)!
const field = (label: string) => {
  const target = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.startsWith(label))!
  return document.getElementById(target.htmlFor) as HTMLInputElement
}
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })

beforeEach(() => {
  resetMediaLookups()
  api.getMediaById.mockReset()
  api.getMediaById.mockImplementation(async (id: number) => ({ media: media(Number(id)) }))
})
afterEach(() => {
  if (!mounted) return
  mounted = false
  act(() => root.unmount())
  container.remove()
  editor.destroy()
})

describe("galleryImageMissingAlt (#424, per image)", () => {
  it("flags a blank alt unless the media is decorative or gone", () => {
    expect(galleryImageMissingAlt("", null)).toBe(true)
    expect(galleryImageMissingAlt("   ", { status: "loading" })).toBe(true)
    expect(galleryImageMissingAlt(null, { status: "unknown" })).toBe(true)
    expect(galleryImageMissingAlt("A roof", { status: "found", media: media(1) })).toBe(false)
    expect(galleryImageMissingAlt("", { status: "found", media: media(1, { decorative: true }) })).toBe(false)
    expect(galleryImageMissingAlt("", { status: "missing" })).toBe(false)
  })
})

describe("the gallery's settings (#424)", () => {
  it("shows the image count and Columns; picking one sets the gallery's columns", () => {
    mount([image(A, 1, "A"), image(B, 2, "B")])
    select(G)
    expect(container.querySelector(".block-settings__name")?.textContent).toBe("Gallery")
    expect(container.textContent).toContain("2 images")
    expect(radio("3").getAttribute("aria-checked")).toBe("true")
    expect(container.textContent).toContain("On phones the gallery drops to 2 columns.")
    act(() => radio("4").click())
    expect(editor.state.doc.child(0).attrs.columns).toBe(4)
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
  })

  it("an empty gallery says so", () => {
    mount([])
    select(G)
    expect(container.textContent).toContain("No images")
    expect(container.textContent).toContain("None yet. Images you add get their alt text from Media.")
  })

  it("flags each image without alt text on its own row, and only those", async () => {
    api.getMediaById.mockImplementation(async (id: number) => ({ media: media(Number(id), Number(id) === 3 ? { decorative: true } : {}) }))
    mount([image(A, 1, "Roof"), image(B, 2, ""), image(C, 3, "")])
    select(G)
    await flush()
    const flagged = rows().map((row) => row.textContent?.includes("No alt text"))
    expect(flagged).toEqual([false, true, false])
  })

  it("a row whose media was deleted says it's missing and isn't flagged for alt text", async () => {
    api.getMediaById.mockImplementation(async (id: number) => {
      if (Number(id) === 2) throw new ApiError("not found", 404)
      return { media: media(Number(id)) }
    })
    mount([image(A, 1, "Roof"), image(B, 2, "")])
    select(G)
    await flush()
    expect(rows()[1].textContent).toContain("The image file is missing")
    expect(rows()[1].textContent).not.toContain("No alt text")
  })

  it("a selected image shows the gallery's panel with its row open; clicking a row selects it", () => {
    mount([image(A, 1, "Roof", "October"), image(B, 2, "")])
    select(A)
    expect(container.querySelector(".block-settings__name")?.textContent).toBe("Gallery")
    expect(rows()[0].classList.contains("is-selected")).toBe(true)
    expect(field("Alt text").value).toBe("Roof")
    expect(field("Caption").value).toBe("October")
    act(() => (rows()[1].querySelector("button") as HTMLButtonElement).click())
    expect((editor.state.selection as NodeSelection).node.attrs["data-block-id"]).toBe(B)
    expect(rows()[1].classList.contains("is-selected")).toBe(true)
    expect(field("Alt text").value).toBe("")
  })

  it("typing sets that image's alt and caption and keeps it selected", () => {
    mount([image(A, 1, ""), image(B, 2, "")])
    select(B)
    type(field("Alt text"), "A tower")
    const second = editor.state.doc.child(0).child(1)
    expect(second.attrs.alt).toBe("A tower")
    expect(editor.state.selection).toBeInstanceOf(NodeSelection)
    type(field("Caption"), "Downtown")
    expect(editor.state.doc.child(0).child(1).textContent).toBe("Downtown")
    expect((editor.state.selection as NodeSelection).node.attrs["data-block-id"]).toBe(B)
    // The other image is untouched.
    expect(editor.state.doc.child(0).child(0).attrs.alt).toBe("")
  })

  it("a collaborator's change reaches the field while it isn't this user's own", () => {
    mount([image(A, 1, "Roof", "October")])
    select(A)
    act(() => editor.view.dispatch(editor.state.tr.insert(3, editor.schema.text("Early "))))
    expect(field("Caption").value).toBe("Early October")
  })

  it("focus lands in the alt text when ↵ asked for it", () => {
    mount([image(A, 1, "Roof"), image(B, 2, "")])
    select(B)
    act(() => requestGalleryAltFocus(editor, B))
    expect(document.activeElement).toBe(field("Alt text"))
    expect(field("Alt text").id).toContain(B)
  })
})
