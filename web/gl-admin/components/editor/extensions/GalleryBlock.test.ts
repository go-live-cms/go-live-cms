import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { TEXT_PART_NODE_NAMES, validateBlockDoc } from "@gl-admin/lib/blocks-spec"
import { resetMediaLookups } from "@gl-admin/lib/mediaLookup"
import { ApiError } from "@gl-admin/lib/api/errors"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import type { Media } from "@gl-admin/lib/api/types"
import { BlockNodeViews } from "./BlockNodeViews"
import { GalleryKeyboard } from "./GalleryKeyboard"
import { BlockNavigationKeys, BlockSelectionKeys } from "./BlockNavigation"
import { GALLERY_EMPTY_FRESH, GALLERY_EMPTY_TEXT, GALLERY_EMPTY_TITLE } from "./GalleryBlock"
import { PasteSanitizer, sanitizePastedHTML } from "./PasteSanitizer"
import { addMediaToGallery, chooseGalleryImages, registerMediaPickerHost, type MediaPickRequest } from "../blocks/mediaPicking"
import { CORE_BLOCKS, menuEntries, slotAcceptsAt } from "../blocks/catalog"
import { duplicateBlock } from "../utils/blockActions"
import { editorBlockAtSelection, removalRange, selectedBlock } from "../utils/blockTree"
import { imageCaptionTr, moveGalleryImage, removeGalleryImage, takeGalleryAltFocus } from "../utils/galleryActions"

// The Gallery block in the editor (#424; the canvas's "Editor · image, gallery…", "Keyboard"
// and "Errors & empty states"): inserting one, adding several images in one transaction,
// reordering by keyboard and from the tile, removing to the empty state, the keys, the
// views, missing media per image, paste, and fresh ids for a duplicate.

const api = vi.hoisted(() => ({ getMediaById: vi.fn(), createMedia: vi.fn() }))
vi.mock("@gl-admin/lib/api/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gl-admin/lib/api/media")>()),
  getMediaById: api.getMediaById,
  createMedia: api.createMedia,
}))

stubJsdomRangeLayout()

let editor: Editor | null = null

const G = "gallery-aaaa-00000000"
const A = "image-aaaa-0000000000"
const B = "image-bbbb-0000000000"
const C = "image-cccc-0000000000"
const P = "para-aaaa-00000000000"

function makeEditor(content: object): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  editor = new Editor({
    element,
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: false })),
      BlockNodeViews,
      GalleryKeyboard,
      BlockSelectionKeys,
      BlockNavigationKeys,
      PasteSanitizer,
    ],
    content,
  })
  return editor
}

const image = (id: string, mediaId: number, extra: Record<string, unknown> = {}, caption?: string) => ({
  type: "image",
  attrs: { "data-block-id": id, mediaId, src: `/uploads/${mediaId}.jpg`, alt: "", ...extra },
  ...(caption ? { content: [{ type: "imageCaption", content: [{ type: "text", text: caption }] }] } : {}),
})

const doc = (images: object[], caption?: string, columns = 3) => ({
  type: "doc",
  content: [
    {
      type: "gallery",
      attrs: { "data-block-id": G, columns },
      content: [...images, { type: "galleryCaption", ...(caption ? { content: [{ type: "text", text: caption }] } : {}) }],
    },
    { type: "paragraph", attrs: { "data-block-id": P }, content: [{ type: "text", text: "after" }] },
  ],
})

const three = () => doc([image(A, 1), image(B, 2), image(C, 3)], "Six covers")

function media(id: number, extra: Partial<Media> = {}): Media {
  return {
    id,
    name: `photo-${id}`,
    description: "",
    alt: `Alt ${id}`,
    media_path: `/uploads/media/photo-${id}.jpg`,
    user_id: 1,
    created_at: "2026-11-01T00:00:00Z",
    changed_at: "2026-11-01T00:00:00Z",
    file_size: 1024,
    mime_type: "image/jpeg",
    original_filename: `photo-${id}.jpg`,
    ...extra,
  } as Media
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const posOf = (e: Editor, id: string) => {
  let at = -1
  e.state.doc.descendants((node, pos) => {
    if (node.attrs["data-block-id"] === id) at = pos
  })
  if (at === -1) throw new Error(`no ${id}`)
  return at
}
const order = (e: Editor) => {
  const out: string[] = []
  e.state.doc.child(0).forEach((child) => {
    if (child.type.name === "image") out.push(child.attrs["data-block-id"])
  })
  return out
}
const selectImage = (e: Editor, id: string) => e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, posOf(e, id))))
const key = (e: Editor, name: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init })
  let handled = false
  e.view.someProp("handleKeyDown", (f) => (f(e.view, event) ? (handled = true) : false))
  return handled
}
const selectedId = (e: Editor) => (e.state.selection as NodeSelection).node?.attrs["data-block-id"]

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
  resetMediaLookups()
  api.getMediaById.mockReset()
  api.createMedia.mockReset()
  api.getMediaById.mockImplementation(async (id: number) => ({ media: media(Number(id)) }))
})
afterEach(() => {
  const element = editor?.options.element as HTMLElement | undefined
  editor?.destroy()
  element?.remove()
  editor = null
  vi.restoreAllMocks()
})

describe("the schema (#424)", () => {
  it("holds image blocks and a last caption; the caption is a text part with no block menu", () => {
    const e = makeEditor(three())
    expect(e.state.doc.child(0).type.name).toBe("gallery")
    expect(e.state.doc.child(0).lastChild?.type.name).toBe("galleryCaption")
    e.state.doc.check()
    expect(TEXT_PART_NODE_NAMES.has("galleryCaption")).toBe(true)
    const { paragraph, image: imageNode, gallery, galleryCaption } = e.schema.nodes
    expect(gallery.validContent(gallery.schema.nodes.doc.schema.nodes.galleryCaption.create().content)).toBe(false)
    expect(gallery.contentMatch.matchType(paragraph)).toBeNull()
    expect(gallery.contentMatch.matchType(imageNode)).not.toBeNull()
    expect(gallery.contentMatch.matchType(galleryCaption)).not.toBeNull()
  })

  it("is in the media group of the menus, at the top level and not inside a group", () => {
    const entry = CORE_BLOCKS.find((item) => item.id === "gallery")!
    expect(entry).toMatchObject({ type: "gallery", name: "Gallery", group: "media" })
    const e = makeEditor({ type: "doc", content: [{ type: "paragraph" }] })
    expect(menuEntries({ role: "editor", accepts: slotAcceptsAt(e) }).some((item) => item.id === "gallery")).toBe(true)
    e.commands.setContent({ type: "doc", content: [{ type: "group", content: [{ type: "paragraph" }] }] })
    e.commands.setTextSelection(2)
    expect(menuEntries({ role: "editor", accepts: slotAcceptsAt(e) }).some((item) => item.id === "gallery")).toBe(false)
  })
})

describe("insert and add images (#424)", () => {
  it("inserts an empty gallery on the empty line, the caret in its caption", () => {
    const e = makeEditor({ type: "doc", content: [{ type: "paragraph" }] })
    e.commands.setTextSelection(1)
    CORE_BLOCKS.find((item) => item.id === "gallery")!.insert(e, { from: 1, to: 1 })
    const gallery = e.state.doc.child(0)
    expect(gallery.type.name).toBe("gallery")
    expect(gallery.attrs.columns).toBe(3)
    expect(gallery.childCount).toBe(1)
    expect(e.state.selection.$from.parent.type.name).toBe("galleryCaption")
    expect(gallery.attrs["data-block-id"]).toEqual(expect.any(String))
    expect(() => validateBlockDoc(pmToBlockDoc(e.state.doc))).not.toThrow()
  })

  it("adds several images from the picker in one transaction, each with its media's alt and name, in order", () => {
    const e = makeEditor(doc([image(A, 1)]))
    let transactions = 0
    e.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) transactions++
    })
    const requests: MediaPickRequest[] = []
    const applied: number[] = []
    registerMediaPickerHost(e, { open: (request) => requests.push(request), applied: (m) => applied.push(m.id) })

    expect(chooseGalleryImages(e, posOf(e, G))).toBe(true)
    expect(requests[0]).toMatchObject({ kind: "image", multiple: true })
    requests[0].onPickMany!([media(4), media(5, { alt: "  ", decorative: false }), media(6, { alt: "Skip me", decorative: true })])

    const gallery = e.state.doc.child(0)
    expect(gallery.childCount).toBe(5)
    expect(gallery.child(1).attrs).toMatchObject({ mediaId: 4, alt: "Alt 4", src: "/uploads/media/photo-4.jpg", title: "photo-4" })
    expect(gallery.child(2).attrs.alt).toBe("")
    expect(gallery.child(3).attrs.alt).toBe("")
    expect(gallery.lastChild?.type.name).toBe("galleryCaption")
    // The images and BlockIdExtension's ids are the one change.
    expect(transactions).toBe(1)
    expect(new Set(order(e)).size).toBe(4)
    expect(order(e).every((id) => typeof id === "string" && id.length >= 10)).toBe(true)
    expect(applied).toEqual([4, 5, 6])
  })

  it("adds nothing when the gallery is gone or the choice is empty", () => {
    const e = makeEditor(doc([]))
    expect(addMediaToGallery(e, { id: "no-such-gallery-00", pos: 0 }, [media(4)])).toBe(false)
    expect(addMediaToGallery(e, { id: G, pos: 0 }, [])).toBe(false)
  })
})

describe("reorder and remove (#424)", () => {
  it("⌘⇧→ and ⌘⇧← move the selected image, ids kept", () => {
    const e = makeEditor(three())
    selectImage(e, A)
    expect(key(e, "ArrowRight", { ctrlKey: true, shiftKey: true })).toBe(true)
    expect(order(e)).toEqual([B, A, C])
    expect(selectedId(e)).toBe(A)
    expect(key(e, "ArrowLeft", { ctrlKey: true, shiftKey: true })).toBe(true)
    expect(order(e)).toEqual([A, B, C])
    // At the ends it stays where it is, and the key is still taken.
    expect(key(e, "ArrowLeft", { ctrlKey: true, shiftKey: true })).toBe(true)
    expect(order(e)).toEqual([A, B, C])
  })

  it("← → walk the images; the arrows stop at the ends", () => {
    const e = makeEditor(three())
    selectImage(e, B)
    key(e, "ArrowRight")
    expect(selectedId(e)).toBe(C)
    key(e, "ArrowRight")
    expect(selectedId(e)).toBe(C)
    key(e, "ArrowLeft")
    key(e, "ArrowLeft")
    expect(selectedId(e)).toBe(A)
  })

  it("the arrows leave a block that isn't a gallery image to the editor", () => {
    const e = makeEditor(three())
    e.commands.setTextSelection(posOf(e, P) + 2)
    expect(key(e, "ArrowLeft")).toBe(false)
  })

  it("moveGalleryImage finds the image by id and refuses what isn't one", () => {
    const e = makeEditor(three())
    expect(moveGalleryImage(e, { id: C, pos: 0 }, -1)).toBe(true)
    expect(order(e)).toEqual([A, C, B])
    expect(moveGalleryImage(e, { id: G, pos: 0 }, 1)).toBe(false)
  })

  it("removing the last image leaves the gallery with its caption: nothing is deleted with it", () => {
    const e = makeEditor(doc([image(A, 1)], "Kept"))
    const block = (() => {
      selectImage(e, A)
      return selectedBlock(e.state)!
    })()
    expect(removalRange(e.state.doc, block)).toEqual({ from: block.pos, to: block.pos + block.node.nodeSize })
    expect(removeGalleryImage(e, { id: A, pos: 0 })).toBe(true)
    expect(e.state.doc.child(0).type.name).toBe("gallery")
    expect(e.state.doc.child(0).lastChild?.textContent).toBe("Kept")
    expect(order(e)).toEqual([])
    expect(() => validateBlockDoc(pmToBlockDoc(e.state.doc))).not.toThrow()
  })

  it("Backspace on a selected image removes it (#417's key), the gallery stays", () => {
    const e = makeEditor(three())
    selectImage(e, B)
    expect(key(e, "Backspace")).toBe(true)
    expect(order(e)).toEqual([A, C])
  })

  it("a duplicated gallery gets fresh ids for itself and every image", () => {
    const e = makeEditor(three())
    duplicateBlock(e, { id: G, pos: 0 })
    const ids: string[] = []
    e.state.doc.forEach((node) => {
      if (node.type.name !== "gallery") return
      ids.push(node.attrs["data-block-id"])
      node.forEach((child) => child.type.name === "image" && ids.push(child.attrs["data-block-id"]))
    })
    expect(ids).toHaveLength(8)
    expect(new Set(ids).size).toBe(8)
  })
})

describe("the keys in the captions and on a selected image (#424)", () => {
  it("↵ on a selected image asks for the panel with focus in that image's alt text", () => {
    const e = makeEditor(three())
    const open = vi.fn()
    ;(e.storage as any).blockNavigationKeys.openBlockSettings = open
    selectImage(e, B)
    expect(key(e, "Enter")).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    expect(takeGalleryAltFocus(e, A)).toBe(false)
    expect(takeGalleryAltFocus(e, B)).toBe(true)
    expect(takeGalleryAltFocus(e, B)).toBe(false)
  })

  it("↵ on a selected gallery steps into its first image (#417's key)", () => {
    const e = makeEditor(three())
    e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, posOf(e, G))))
    expect(key(e, "Enter")).toBe(true)
    expect(selectedId(e)).toBe(A)
  })

  it("↵ in the gallery's caption goes to a new line under the gallery", () => {
    const e = makeEditor(three())
    const captionText = posOf(e, P) - 3
    e.commands.setTextSelection(captionText)
    expect(e.state.selection.$from.parent.type.name).toBe("galleryCaption")
    expect(key(e, "Enter")).toBe(true)
    expect(e.state.doc.child(0).lastChild?.textContent).toBe("Six covers")
    expect(e.state.doc.child(1).type.name).toBe("paragraph")
    expect(e.state.doc.child(1).content.size).toBe(0)
    expect(e.state.selection).toBeInstanceOf(TextSelection)
    expect(editorBlockAtSelection(e.state)?.node.type.name).toBe("paragraph")
  })

  it("↵ in an image's caption goes back to the image: no paragraph can go in a gallery", () => {
    const e = makeEditor(doc([image(A, 1, {}, "October"), image(B, 2)]))
    e.commands.setTextSelection(posOf(e, A) + 3)
    expect(e.state.selection.$from.parent.type.name).toBe("imageCaption")
    expect(key(e, "Enter")).toBe(true)
    expect(selectedId(e)).toBe(A)
    expect(e.state.doc.child(0).childCount).toBe(3)
  })

  it("⌫ at the start of a filled caption does nothing; in an empty gallery with an empty caption it removes it", () => {
    const e = makeEditor(three())
    const firstCharacter = posOf(e, P) - 2 - "Six covers".length
    e.commands.setTextSelection(firstCharacter)
    expect(e.state.selection.$from.parentOffset).toBe(0)
    expect(key(e, "Backspace")).toBe(true)
    expect(e.state.doc.child(0).type.name).toBe("gallery")

    e.commands.setContent(doc([]))
    e.commands.setTextSelection(2)
    expect(e.state.selection.$from.parent.type.name).toBe("galleryCaption")
    expect(key(e, "Backspace")).toBe(true)
    expect(e.state.doc.child(0).type.name).toBe("paragraph")
  })
})

describe("the view (#424)", () => {
  const dom = (e: Editor) => e.view.dom as HTMLElement
  const texts = (e: Editor) => dom(e).querySelector(".editor-gallery__empty")?.textContent ?? ""

  it("a gallery nobody added to offers Upload and Choose from Media", () => {
    const e = makeEditor(doc([]))
    expect(texts(e)).toContain("Gallery")
    expect(texts(e)).toContain(GALLERY_EMPTY_FRESH)
    const buttons = Array.from(dom(e).querySelectorAll(".editor-gallery__empty button")).map((b) => b.textContent)
    expect(buttons).toEqual(["Upload", "Choose from Media"])
  })

  it("with a caption, or once its images were removed, says it has none, with Add images and Remove block", () => {
    const withCaption = makeEditor(doc([], "Six covers"))
    expect(texts(withCaption)).toContain(GALLERY_EMPTY_TITLE)
    expect(texts(withCaption)).toContain(GALLERY_EMPTY_TEXT)
    withCaption.destroy()

    const e = makeEditor(doc([image(A, 1)]))
    expect((dom(e).querySelector(".editor-gallery__empty") as HTMLElement).hidden).toBe(true)
    removeGalleryImage(e, { id: A, pos: 0 })
    expect(texts(e)).toContain(GALLERY_EMPTY_TITLE)
    const buttons = Array.from(dom(e).querySelectorAll<HTMLButtonElement>(".editor-gallery__empty button"))
    expect(buttons.map((b) => b.textContent)).toEqual(["Add images", "Remove block"])
    buttons[1].click()
    expect(e.state.doc.child(0).type.name).toBe("paragraph")
    expect(e.getText()).toBe("after")
  })

  it("sets the grid's columns and shows no Add caption on a tile", () => {
    const e = makeEditor(doc([image(A, 1)], undefined, 4))
    const grid = dom(e).querySelector(".editor-gallery__grid") as HTMLElement
    expect(grid.style.getPropertyValue("--gallery-columns")).toBe("4")
    expect((dom(e).querySelector(".editor-image__add-caption") as HTMLElement).hidden).toBe(true)
  })

  it("a tile's buttons move and remove it; Add images opens the picker", () => {
    const e = makeEditor(three())
    const requests: MediaPickRequest[] = []
    registerMediaPickerHost(e, { open: (request) => requests.push(request) })
    selectImage(e, B)
    const tools = dom(e).querySelector(`[data-block-id="${B}"] .editor-gallery-image__tools`) as HTMLElement
    const buttons = Array.from(tools.querySelectorAll("button"))
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Move image earlier", "Move image later", "Remove image from gallery"])
    buttons[1].click()
    expect(order(e)).toEqual([A, C, B])

    const remove = dom(e).querySelector(`[data-block-id="${C}"] .editor-gallery-image__tools`)!.querySelectorAll("button")[2] as HTMLButtonElement
    remove.click()
    expect(order(e)).toEqual([A, B])

    ;(dom(e).querySelector(".editor-gallery__toolbar button") as HTMLButtonElement).click()
    expect(requests[0]).toMatchObject({ multiple: true })
  })

  it("an image whose media was deleted says so on its own tile; the others are untouched", async () => {
    api.getMediaById.mockImplementation(async (id: number) => {
      if (Number(id) === 2) throw new ApiError("not found", 404)
      return { media: media(Number(id)) }
    })
    const e = makeEditor(three())
    await flush()
    await flush()
    const tile = (id: string) => dom(e).querySelector(`[data-block-id="${id}"]`) as HTMLElement
    expect(tile(B).classList.contains("is-missing")).toBe(true)
    expect(tile(B).textContent).toContain("The image file is missing")
    expect(tile(A).classList.contains("is-missing")).toBe(false)
    expect(tile(C).classList.contains("is-missing")).toBe(false)
  })
})

describe("the caption field's changes (#424)", () => {
  const blockOf = (e: Editor, id: string) => {
    selectImage(e, id)
    return selectedBlock(e.state)!
  }

  it("adds the caption node for the first character and removes it when emptied", () => {
    const e = makeEditor(three())
    e.view.dispatch(imageCaptionTr(e.state, blockOf(e, A), "O")!)
    expect(e.state.doc.child(0).child(0).firstChild?.type.name).toBe("imageCaption")
    e.view.dispatch(imageCaptionTr(e.state, blockOf(e, A), "")!)
    expect(e.state.doc.child(0).child(0).childCount).toBe(0)
    expect(imageCaptionTr(e.state, blockOf(e, A), "")).toBeNull()
  })

  it("touches only the characters that changed, and the selected image stays selected", () => {
    const e = makeEditor(doc([image(A, 1, {}, "Cover")]))
    const block = blockOf(e, A)
    const tr = imageCaptionTr(e.state, block, "Covers")!
    expect(tr.steps).toHaveLength(1)
    const step = tr.steps[0].toJSON() as { from: number; to: number }
    expect(step.to - step.from).toBe(0)
    e.view.dispatch(tr)
    expect(e.state.doc.child(0).child(0).textContent).toBe("Covers")
    expect(selectedId(e)).toBe(A)
  })

  it("keeps the marks on the text it doesn't change", () => {
    const e = makeEditor(
      doc([{ type: "image", attrs: { "data-block-id": A, mediaId: 1, src: "/a.jpg" }, content: [{ type: "imageCaption", content: [{ type: "text", marks: [{ type: "bold" }], text: "Bold" }, { type: "text", text: " end" }] }] }]),
    )
    e.view.dispatch(imageCaptionTr(e.state, blockOf(e, A), "Bold ending")!)
    const caption = e.state.doc.child(0).child(0).child(0)
    expect(caption.textContent).toBe("Bold ending")
    expect(caption.child(0).marks.map((mark) => mark.type.name)).toEqual(["bold"])
    expect(caption.child(0).text).toBe("Bold")
  })

  it("never splits a surrogate pair", () => {
    const e = makeEditor(doc([image(A, 1, {}, "x😀y")]))
    e.view.dispatch(imageCaptionTr(e.state, blockOf(e, A), "x😁y")!)
    expect(e.state.doc.child(0).child(0).textContent).toBe("x😁y")
  })
})

describe("paste (#424)", () => {
  it("keeps a gallery's type and valid columns, drops an invalid one, and never the images", () => {
    const html = sanitizePastedHTML(
      '<div data-type="gallery" data-columns="4"><figure><img src="/a.jpg"></figure><div data-type="gallery-caption">Cap</div></div><div data-type="gallery" data-columns="9"></div><p data-columns="2">x</p>',
    )
    expect(html).toContain('data-columns="4"')
    expect(html).not.toContain('data-columns="9"')
    expect(html).not.toContain('<p data-columns')
    expect(html).not.toContain("<img")
    expect(html).toContain('data-type="gallery-caption"')
  })
})
