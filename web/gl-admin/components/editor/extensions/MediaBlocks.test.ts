import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { validateBlockDoc } from "@gl-admin/lib/blocks-spec"
import { ApiError } from "@gl-admin/lib/api/errors"
import { resetMediaLookups } from "@gl-admin/lib/mediaLookup"
import type { Media } from "@gl-admin/lib/api/types"
import { BlockNodeViews } from "./BlockNodeViews"
import { MISSING_TITLES, UNKNOWN_TEXT } from "./MediaBlockViews"
import { applyMediaToBlock, registerMediaPickerHost, type MediaPickRequest } from "../blocks/mediaPicking"
import { CORE_BLOCKS } from "../blocks/catalog"
import { refOfBlock } from "../utils/blockTree"

// The video, audio and file blocks in the editor (#423; the canvas's "Editor · image,
// gallery, video, audio, file" and "Errors & empty states"): inserting one, its empty state
// (Upload, Choose from Media), the file from the shared picker or an upload, the player or
// the download row, the file's label, and the missing state ("The file is missing" with
// Replace), the image's too. A failed lookup is never shown as missing.

const api = vi.hoisted(() => ({ getMediaById: vi.fn(), createMedia: vi.fn() }))
vi.mock("@gl-admin/lib/api/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gl-admin/lib/api/media")>()),
  getMediaById: api.getMediaById,
  createMedia: api.createMedia,
}))

let editor: Editor | null = null
let requests: MediaPickRequest[] = []

const VIDEO = "video-aaaa-0000000000"
const FILE = "file-aaaa-00000000000"
const IMAGE = "image-aaaa-0000000000"

function media(id: number, extra: Partial<Media> = {}): Media {
  return {
    id,
    name: `file-${id}.mp4`,
    description: "",
    alt: "",
    media_path: `/uploads/media/file-${id}.mp4`,
    user_id: 1,
    created_at: "2026-11-01T00:00:00Z",
    changed_at: "2026-11-01T00:00:00Z",
    file_size: 18 * 1024 * 1024,
    mime_type: "video/mp4",
    original_filename: `file-${id}.mp4`,
    ...extra,
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
  resetMediaLookups()
  api.getMediaById.mockReset()
  api.createMedia.mockReset()
  api.getMediaById.mockImplementation(async (id: number) => ({ media: media(Number(id)) }))
  requests = []
})
afterEach(() => {
  const element = editor?.options.element as HTMLElement | undefined
  editor?.destroy()
  element?.remove()
  editor = null
  vi.restoreAllMocks()
})

function makeEditor(content: object, { editable = true } = {}): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  editor = new Editor({ element, editable, extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockNodeViews], content })
  registerMediaPickerHost(editor, { open: (request) => requests.push(request) })
  return editor
}

const para = (text?: string) => ({ type: "paragraph", ...(text ? { content: [{ type: "text", text }] } : {}) })
const dom = (ed: Editor, id: string) => ed.view.dom.querySelector(`[data-block-id="${id}"]`) as HTMLElement
const buttonNamed = (root: HTMLElement, name: string) =>
  Array.from(root.querySelectorAll("button")).find((b) => b.textContent === name && !b.hidden) as HTMLButtonElement | undefined
const posOf = (ed: Editor, id: string) => {
  let found = -1
  ed.state.doc.descendants((node, pos) => {
    if (node.attrs["data-block-id"] === id) found = pos
  })
  return found
}

describe("inserting a media block (#423)", () => {
  it.each(["video", "audio", "file"])("the menus' %s entry replaces the typed line with an empty block", (type) => {
    const ed = makeEditor({ type: "doc", content: [para("first"), para("/vid")] })
    const entry = CORE_BLOCKS.find((e) => e.id === type)!
    const end = ed.state.doc.content.size - 1
    ed.commands.setTextSelection(end)
    entry.insert(ed, { from: end - 4, to: end })
    const types: string[] = []
    ed.state.doc.forEach((node) => types.push(node.type.name))
    expect(types.slice(0, 2)).toEqual(["paragraph", type])
    expect(ed.state.doc.textContent).toBe("first")
    // The empty state: the block's name, its hint, Upload and Choose from Media.
    const view = ed.view.dom.querySelector(`[data-type="${type}"]`) as HTMLElement
    expect(view.dataset.state).toBe("empty")
    expect(buttonNamed(view, "Upload")).toBeDefined()
    expect(buttonNamed(view, "Choose from Media")).toBeDefined()
  })
})

describe("choosing the file (#423)", () => {
  it("Choose from Media asks for the picker with the block's kind, and the pick sets the media id", async () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "video", attrs: { "data-block-id": VIDEO } }, para()] })
    buttonNamed(dom(ed, VIDEO), "Choose from Media")!.click()
    expect(requests).toHaveLength(1)
    expect(requests[0].kind).toBe("video")
    requests[0].onPick(media(12))
    await flush()
    expect(ed.state.doc.firstChild!.attrs.mediaId).toBe(12)
    const video = dom(ed, VIDEO).querySelector("video")!
    expect(video.getAttribute("src")).toBe("/uploads/media/file-12.mp4")
    expect(video.controls).toBe(true)
    expect(video.autoplay).toBe(false)
    expect(video.hasAttribute("autoplay")).toBe(false)
    // The pick's own media answers the lookup: no request for it.
    expect(api.getMediaById).not.toHaveBeenCalled()
    expect(pmToBlockDoc(ed.state.doc).blocks[VIDEO]).toMatchObject({ type: "video", attrs: { mediaId: 12 } })
  })

  it("asks for documents for a file block, whose label stays empty (the file's name shows)", async () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "file", attrs: { "data-block-id": FILE } }, para()] })
    buttonNamed(dom(ed, FILE), "Choose from Media")!.click()
    expect(requests[0].kind).toBe("document")
    requests[0].onPick(media(14, { name: "import-checklist.pdf", mime_type: "application/pdf", file_size: 245_760, original_filename: "import-checklist.pdf", media_path: "/uploads/media/c.pdf" }))
    await flush()
    expect(ed.state.doc.firstChild!.attrs).toMatchObject({ mediaId: 14, label: null })
    expect((dom(ed, FILE).querySelector("input.editor-media__label") as HTMLInputElement).placeholder).toBe("import-checklist.pdf")
    expect(dom(ed, FILE).querySelector(".editor-media__meta")!.textContent).toBe("PDF · 240 KB")
    // A Replace shows the new file's name: nothing of the old one was stored.
    expect(pmToBlockDoc(ed.state.doc).blocks[FILE].attrs).toEqual({ mediaId: 14 })
  })

  it("finds the block again by its id when the file arrives, after a collaborator moved it", () => {
    const ed = makeEditor({ type: "doc", content: [para("a"), { type: "video", attrs: { "data-block-id": VIDEO } }] })
    buttonNamed(dom(ed, VIDEO), "Choose from Media")!.click()
    ed.commands.insertContentAt(0, [para("inserted"), para("above")])
    requests[0].onPick(media(30))
    expect(ed.state.doc.nodeAt(posOf(ed, VIDEO))!.attrs.mediaId).toBe(30)
  })

  it("Upload in the block uploads the file and points the block at it", async () => {
    api.createMedia.mockResolvedValue({ media: media(40, { name: "clip.mp4" }) })
    const ed = makeEditor({ type: "doc", content: [{ type: "video", attrs: { "data-block-id": VIDEO } }, para()] })
    const input = dom(ed, VIDEO).querySelector('input[type="file"]') as HTMLInputElement
    expect(input.accept).toContain("video/mp4")
    const file = new File(["x"], "clip.mp4", { type: "video/mp4" })
    Object.defineProperty(input, "files", { value: [file], configurable: true })
    input.dispatchEvent(new Event("change"))
    await flush()
    await flush()
    const form = api.createMedia.mock.calls[0][0] as FormData
    expect(form.get("file")).toBe(file)
    expect(form.get("name")).toBe("clip.mp4")
    expect(ed.state.doc.firstChild!.attrs.mediaId).toBe(40)
  })

  it("an image takes the media's URL, alt text and name; a decorative one an empty alt (#325)", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "image", attrs: { "data-block-id": IMAGE, src: "data:image/svg+xml,x" } }, para()] })
    const block = { node: ed.state.doc.firstChild!, pos: 0 }
    applyMediaToBlock(ed, refOfBlock(block), media(5, { media_path: "/uploads/media/a.jpg", mime_type: "image/jpeg", alt: " A cabin ", name: "cabin" }))
    expect(ed.state.doc.firstChild!.attrs).toMatchObject({ src: "/uploads/media/a.jpg", alt: "A cabin", title: "cabin", mediaId: 5 })
    applyMediaToBlock(ed, refOfBlock(block), media(6, { media_path: "/uploads/media/b.jpg", mime_type: "image/jpeg", alt: "x", decorative: true }))
    expect(ed.state.doc.firstChild!.attrs).toMatchObject({ alt: "", mediaId: 6 })
  })

  it("types the file's label in the block, stored trimmed", async () => {
    api.getMediaById.mockResolvedValue({ media: media(14, { name: "import-checklist.pdf", mime_type: "application/pdf" }) })
    const ed = makeEditor({ type: "doc", content: [{ type: "file", attrs: { "data-block-id": FILE, mediaId: 14 } }, para()] })
    await flush()
    const input = dom(ed, FILE).querySelector("input.editor-media__label") as HTMLInputElement
    expect(input.placeholder).toBe("import-checklist.pdf")
    input.value = " Checklist "
    input.dispatchEvent(new Event("input"))
    expect(ed.state.doc.firstChild!.attrs.label).toBe(" Checklist ")
    const doc = pmToBlockDoc(ed.state.doc)
    expect(doc.blocks[FILE].attrs).toEqual({ mediaId: 14, label: "Checklist" })
    expect(() => validateBlockDoc(doc)).not.toThrow()
  })

  it("adds a caption to a video or audio block, the image's caption node", () => {
    const ed = makeEditor({ type: "doc", content: [{ type: "audio", attrs: { "data-block-id": VIDEO, mediaId: 2 } }, para()] })
    ed.view.dispatch(ed.state.tr.setSelection(NodeSelection.create(ed.state.doc, 0)))
    expect(ed.commands.toggleMediaCaption()).toBe(true)
    expect(ed.state.doc.firstChild!.firstChild!.type.name).toBe("imageCaption")
    ed.commands.insertContent("Episode 12")
    expect(pmToBlockDoc(ed.state.doc).blocks[VIDEO].attrs).toEqual({ mediaId: 2, caption: [{ type: "text", text: "Episode 12" }] })
  })
})

describe("a media file that's missing (#423)", () => {
  it.each([
    ["video", MISSING_TITLES.video],
    ["audio", MISSING_TITLES.audio],
    ["file", MISSING_TITLES.file],
  ])("a %s whose media was deleted says so, with Replace", async (type, title) => {
    api.getMediaById.mockRejectedValue(new ApiError("Not found.", 404))
    const ed = makeEditor({ type: "doc", content: [{ type, attrs: { "data-block-id": VIDEO, mediaId: 99 } }, para()] })
    await flush()
    const view = dom(ed, VIDEO)
    expect(view.dataset.state).toBe("missing")
    const panel = view.querySelector('[role="group"]') as HTMLElement
    expect(document.getElementById(panel.getAttribute("aria-labelledby")!)!.textContent).toBe(title)
    expect(view.querySelector("video, audio")).toBeNull()
    buttonNamed(panel, "Replace")!.click()
    expect(requests[0].kind).toBe(type === "file" ? "document" : type)
    requests[0].onPick(media(100))
    await flush()
    expect(dom(ed, VIDEO).dataset.state).toBe("found")
  })

  it("an image whose media was deleted shows 'The image file is missing' in place of the picture", async () => {
    api.getMediaById.mockRejectedValue(new ApiError("Not found.", 404))
    const ed = makeEditor({
      type: "doc",
      content: [{ type: "image", attrs: { "data-block-id": IMAGE, mediaId: 7, src: "/uploads/media/gone.jpg", title: "cabin-hillside.jpg" } }, para()],
    })
    await flush()
    const figure = dom(ed, IMAGE)
    expect(figure.classList.contains("is-missing")).toBe(true)
    expect(figure.querySelector("img")!.hidden).toBe(true)
    expect(figure.textContent).toContain("The image file is missing")
    expect(figure.textContent).toContain("cabin-hillside.jpg is no longer in Media.")
    buttonNamed(figure, "Replace")!.click()
    expect(requests[0].kind).toBe("image")
  })

  it("a failed lookup isn't a missing file: the image shows, the video says its details are unavailable", async () => {
    api.getMediaById.mockRejectedValue(new ApiError("Server error.", 500))
    const ed = makeEditor({
      type: "doc",
      content: [
        { type: "image", attrs: { "data-block-id": IMAGE, mediaId: 7, src: "/uploads/media/x.jpg" } },
        { type: "video", attrs: { "data-block-id": VIDEO, mediaId: 8 } },
        para(),
      ],
    })
    await flush()
    expect(dom(ed, IMAGE).classList.contains("is-missing")).toBe(false)
    expect(dom(ed, IMAGE).querySelector("img")!.hidden).toBe(false)
    expect(dom(ed, VIDEO).dataset.state).toBe("unknown")
    expect(dom(ed, VIDEO).textContent).toContain(UNKNOWN_TEXT)
    expect(dom(ed, VIDEO).textContent).not.toContain("missing")
  })
})

describe("read-only (#423)", () => {
  it("shows no Upload, Choose or Replace, and the label can't be typed in", async () => {
    api.getMediaById.mockImplementation(async (id: number) => {
      if (Number(id) === 99) throw new ApiError("Not found.", 404)
      return { media: media(Number(id), { mime_type: "application/pdf" }) }
    })
    const ed = makeEditor(
      {
        type: "doc",
        content: [
          { type: "video", attrs: { "data-block-id": VIDEO } },
          { type: "file", attrs: { "data-block-id": FILE, mediaId: 14 } },
          { type: "audio", attrs: { "data-block-id": IMAGE, mediaId: 99 } },
        ],
      },
      { editable: false },
    )
    await flush()
    expect(buttonNamed(dom(ed, VIDEO), "Upload")).toBeUndefined()
    expect(buttonNamed(dom(ed, VIDEO), "Choose from Media")).toBeUndefined()
    expect(buttonNamed(dom(ed, IMAGE), "Replace")).toBeUndefined()
    expect((dom(ed, FILE).querySelector("input.editor-media__label") as HTMLInputElement).readOnly).toBe(true)
  })
})
