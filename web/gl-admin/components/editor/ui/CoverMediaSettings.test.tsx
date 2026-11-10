import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { resetMediaLookups } from "@gl-admin/lib/mediaLookup"
import type { Media } from "@gl-admin/lib/api/types"
import BlockSettingsPanel from "./BlockSettingsPanel"
import { COVER_ALT_HELP, MEDIA_POSITION_HELP, NO_ALT_HELP, OVERLAY_HELP } from "./CoverMediaSettings"
import { requestGalleryAltFocus } from "../utils/galleryActions"

// The settings panel's Block tab for cover and media & text (#427, the canvas's "Editor ·
// cover, media & text" and "Keyboard" › Focal point): the fields, each one transaction, the
// focal point's keys (1%, 10% with Shift) and "No alt text".

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
stubJsdomRangeLayout()

const api = vi.hoisted(() => ({ getMediaById: vi.fn() }))
vi.mock("@gl-admin/lib/api/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gl-admin/lib/api/media")>()),
  getMediaById: api.getMediaById,
}))

const COVER = "cover-aaaa-0000000000"
const MEDIA = "media-aaaa-0000000000"

const media = (id: number, extra: Partial<Media> = {}) =>
  ({ id, name: `photo-${id}`, alt: "", media_path: `/uploads/media/photo-${id}.jpg`, mime_type: "image/jpeg", original_filename: `photo-${id}.jpg`, width: 1500, height: 1000, ...extra }) as Media

let editor: Editor
let container: HTMLDivElement
let root: Root
let mounted = false

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))))

function mount(content: object) {
  mounted = true
  editor = new Editor({
    element: document.createElement("div"),
    extensions: Object.values(schemaExtensions({ collaborating: false })),
    content: { type: "doc", content: [content] },
  })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)))
    root.render(<BlockSettingsPanel editor={editor} />)
  })
}

const cover = (attrs: Record<string, unknown> = {}) => ({ type: "cover", attrs: { "data-block-id": COVER, mediaId: 1, ...attrs }, content: [{ type: "paragraph" }] })
const mediaText = (attrs: Record<string, unknown> = {}) => ({ type: "mediaText", attrs: { "data-block-id": MEDIA, mediaId: 1, ...attrs }, content: [{ type: "paragraph" }] })

const attrs = () => editor.state.doc.child(0).attrs
const dot = () => container.querySelector(".block-settings__focal-dot") as HTMLButtonElement
const axis = (label: string) => {
  const target = Array.from(container.querySelectorAll(".block-settings__unit label")).find((l) => l.textContent === label) as HTMLLabelElement
  return document.getElementById(target.htmlFor) as HTMLInputElement
}
const check = () => container.querySelector('.block-settings__check input') as HTMLInputElement
const altField = () => {
  const target = Array.from(container.querySelectorAll("label")).find((l) => l.textContent === "Alt text") as HTMLLabelElement
  return document.getElementById(target.htmlFor) as HTMLTextAreaElement
}
const radio = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((b) => b.textContent === label)!
const press = (name: string, init: KeyboardEventInit = {}) => act(() => void dot().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init })))
const typeAxis = (input: HTMLInputElement, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
const typeAlt = (value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    setter.call(altField(), value)
    altField().dispatchEvent(new Event("input", { bubbles: true }))
  })
const setRange = (value: string) =>
  act(() => {
    const input = container.querySelector('input[type="range"]') as HTMLInputElement
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
  if (mounted) {
    act(() => root.unmount())
    container.remove()
    editor.destroy()
    mounted = false
  }
})

describe("the focal point's keyboard (\"Keyboard\" › Focal point)", () => {
  it("arrow keys move it 1%", async () => {
    mount(cover({ focalX: 50, focalY: 40 }))
    await flush()
    press("ArrowRight")
    expect([attrs().focalX, attrs().focalY]).toEqual([51, 40])
    press("ArrowLeft")
    press("ArrowLeft")
    expect(attrs().focalX).toBe(49)
    press("ArrowDown")
    expect(attrs().focalY).toBe(41)
    press("ArrowUp")
    press("ArrowUp")
    expect(attrs().focalY).toBe(39)
  })

  it("Shift moves it 10%, and it stops at the edges", async () => {
    mount(cover({ focalX: 95, focalY: 3 }))
    await flush()
    press("ArrowRight", { shiftKey: true })
    expect(attrs().focalX).toBe(100)
    press("ArrowLeft", { shiftKey: true })
    expect(attrs().focalX).toBe(90)
    press("ArrowUp", { shiftKey: true })
    expect(attrs().focalY).toBe(0)
    press("ArrowDown", { shiftKey: true })
    expect(attrs().focalY).toBe(10)
  })

  it("starts from the media's own focal point until someone moves it, then stores both axes", async () => {
    api.getMediaById.mockImplementation(async (id: number) => ({ media: media(Number(id), { focal_point: { x: 0.25, y: 0.75 } }) }))
    mount(mediaText())
    await flush()
    expect(attrs().focalX).toBeNull()
    expect(axis("X").value).toBe("25")
    expect(axis("Y").value).toBe("75")
    press("ArrowUp")
    expect([attrs().focalX, attrs().focalY]).toEqual([25, 74])
  })

  it("any other key does nothing, and each press is one change of the node", async () => {
    mount(cover({ focalX: 50, focalY: 40 }))
    await flush()
    const before = attrs()
    press("Enter")
    expect(attrs()).toBe(before)
  })

  it("the X and Y fields take exact values, clamped; junk is ignored", async () => {
    mount(cover({ focalX: 50, focalY: 40 }))
    await flush()
    typeAxis(axis("X"), "12")
    expect(attrs().focalX).toBe(12)
    typeAxis(axis("Y"), "400")
    expect(attrs().focalY).toBe(100)
    typeAxis(axis("X"), "abc")
    expect(attrs().focalX).toBe(12)
  })

  it("a cover with no image yet has no focal point control", async () => {
    mount(cover({ mediaId: null }))
    await flush()
    expect(dot()).toBeNull()
  })
})

describe("the Cover panel", () => {
  it("shows its fields as drawn: decorative first, on by default, with the alt text field disabled", async () => {
    mount(cover())
    await flush()
    expect(container.querySelector(".block-settings__sub")?.textContent).toBe("An image with blocks on top.")
    expect(container.textContent).toContain("photo-1.jpg")
    expect(check().checked).toBe(true)
    expect(altField().disabled).toBe(true)
    expect(container.textContent).toContain(COVER_ALT_HELP)
    expect(container.textContent).toContain(OVERLAY_HELP)
    expect(container.textContent).toContain("55%")
    expect(container.textContent).not.toContain(NO_ALT_HELP)
  })

  it("Overlay is a range in steps of 5 up to 80", async () => {
    mount(cover())
    await flush()
    const range = container.querySelector('input[type="range"]') as HTMLInputElement
    expect([range.min, range.max, range.step]).toEqual(["0", "80", "5"])
    setRange("30")
    expect(attrs().overlay).toBe(30)
    expect(container.textContent).toContain("30%")
  })

  it("Width sets the align, and unticking Decorative opens the alt text", async () => {
    mount(cover())
    await flush()
    act(() => radio("Full").click())
    expect(attrs().align).toBe("full")
    act(() => check().click())
    expect(attrs().decorative).toBe(false)
    expect(altField().disabled).toBe(false)
    typeAlt("Towers at noon")
    expect(attrs().alt).toBe("Towers at noon")
    typeAlt("")
    expect(attrs().alt).toBeNull()
  })
})

describe("the Media & text panel", () => {
  it("shows Media position, the alt text and Decorative after it, not ticked", async () => {
    mount(mediaText())
    await flush()
    expect(container.querySelector(".block-settings__sub")?.textContent).toBe("An image beside other blocks.")
    expect(container.textContent).toContain(MEDIA_POSITION_HELP)
    expect(check().checked).toBe(false)
    expect(altField().disabled).toBe(false)
    act(() => radio("Right").click())
    expect(attrs().position).toBe("right")
  })

  it("warns while the image has no alt text and isn't decorative, and the flag's focus lands in the field", async () => {
    mount(mediaText())
    await flush()
    expect(container.textContent).toContain(NO_ALT_HELP)
    expect(altField().getAttribute("aria-invalid")).toBe("true")
    act(() => requestGalleryAltFocus(editor, MEDIA))
    expect(document.activeElement).toBe(altField())
    act(() => check().click())
    expect(attrs().decorative).toBe(true)
    expect(container.textContent).not.toContain(NO_ALT_HELP)
  })

  it("a read-only panel changes nothing", async () => {
    mount(mediaText())
    await flush()
    act(() => {
      editor.setEditable(false)
      root.render(<BlockSettingsPanel editor={editor} />)
    })
    expect(container.querySelector("fieldset")?.disabled).toBe(true)
    const position = attrs().position
    act(() => radio("Right").click())
    expect(attrs().position).toBe(position)
  })
})
