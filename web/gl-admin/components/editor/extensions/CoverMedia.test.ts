import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { Editor } from "@tiptap/core"
import { NodeSelection, TextSelection } from "@tiptap/pm/state"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"
import { pmToBlockDoc } from "@gl-admin/lib/collaboration/blockBridge"
import { stubJsdomRangeLayout } from "@gl-admin/lib/collaboration/testHelpers"
import { validateBlockDoc } from "@gl-admin/lib/blocks-spec"
import { resetMediaLookups, rememberMedia } from "@gl-admin/lib/mediaLookup"
import { ApiError } from "@gl-admin/lib/api/errors"
import type { Media } from "@gl-admin/lib/api/types"
import { BlockNodeViews } from "./BlockNodeViews"
import { BlockNavigationKeys, BlockSelectionKeys } from "./BlockNavigation"
import { EmptyContainerFill } from "./CoverMediaBlocks"
import { COVER_EMPTY_TEXT } from "./CoverMediaViews"
import { PasteSanitizer, sanitizePastedHTML } from "./PasteSanitizer"
import { applyMediaToBlock, chooseMediaFor, registerMediaPickerHost, uploadMediaFor, type MediaPickRequest } from "../blocks/mediaPicking"
import { CORE_BLOCKS, menuEntries, slotAcceptsAt } from "../blocks/catalog"
import { duplicateBlock } from "../utils/blockActions"
import { editorBlockById, removalRange, selectedBlock, holderAcceptsType, deleteBlockTr, dropTargetFor } from "../utils/blockTree"

// Cover and media & text in the editor (#427; the canvas's "Editor · cover, media & text",
// "Keyboard" and "Errors & empty states"): the menus, the toolbar, the shared picker and
// missing media, the nesting limits at a drop or an insert, and the local fill.

const api = vi.hoisted(() => ({ getMediaById: vi.fn(), createMedia: vi.fn() }))
vi.mock("@gl-admin/lib/api/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gl-admin/lib/api/media")>()),
  getMediaById: api.getMediaById,
  createMedia: api.createMedia,
}))

stubJsdomRangeLayout()

let editor: Editor | null = null

const COVER = "cover-aaaa-0000000000"
const MEDIA = "media-aaaa-0000000000"
const HEAD = "head-aaaa-00000000000"
const PARA = "para-aaaa-00000000000"
const AFTER = "para-bbbb-00000000000"
const GROUP = "group-aaaa-0000000000"

function makeEditor(content: object): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  editor = new Editor({
    element,
    extensions: [...Object.values(schemaExtensions({ collaborating: false })), BlockNodeViews, BlockSelectionKeys, BlockNavigationKeys, EmptyContainerFill, PasteSanitizer],
    content,
  })
  return editor
}

const para = (id: string, text = "") => ({ type: "paragraph", attrs: { "data-block-id": id }, ...(text ? { content: [{ type: "text", text }] } : {}) })
const heading = (id: string, text: string) => ({ type: "heading", attrs: { "data-block-id": id, level: 2 }, content: [{ type: "text", text }] })

const coverDoc = (attrs: Record<string, unknown> = {}, children: object[] = [heading(HEAD, "Notes"), para(PARA, "Updates")]) => ({
  type: "doc",
  content: [{ type: "cover", attrs: { "data-block-id": COVER, mediaId: 1, ...attrs }, content: children }, para(AFTER, "after")],
})
const mediaDoc = (attrs: Record<string, unknown> = {}) => ({
  type: "doc",
  content: [{ type: "mediaText", attrs: { "data-block-id": MEDIA, mediaId: 2, ...attrs }, content: [heading(HEAD, "Faster"), para(PARA, "More")] }, para(AFTER, "after")],
})

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
const nodeOf = (e: Editor, id: string) => e.state.doc.nodeAt(posOf(e, id))!
const key = (e: Editor, name: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init })
  let handled = false
  e.view.someProp("handleKeyDown", (f) => (f(e.view, event) ? (handled = true) : false))
  return handled
}
const select = (e: Editor, id: string) => e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, posOf(e, id))))
const dom = (e: Editor, selector: string) => e.view.dom.querySelector(selector) as HTMLElement

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

describe("the catalog and the insert commands (#427)", () => {
  it("/cover and /media are in the Media group", () => {
    expect(CORE_BLOCKS.find((item) => item.id === "cover")).toMatchObject({ type: "cover", name: "Cover", group: "media" })
    expect(CORE_BLOCKS.find((item) => item.id === "media-text")).toMatchObject({ type: "media_text", name: "Media & text", group: "media" })
  })

  it("Cover replaces the empty line it's typed on, with the caret in its first block", () => {
    const e = makeEditor({ type: "doc", content: [para(PARA)] })
    e.commands.setTextSelection(1)
    CORE_BLOCKS.find((item) => item.id === "cover")!.insert(e, { from: 1, to: 1 })
    const cover = e.state.doc.child(0)
    expect(cover.type.name).toBe("cover")
    expect(cover.attrs).toMatchObject({ decorative: true, overlay: 55, align: "content", mediaId: null })
    expect(cover.childCount).toBe(1)
    expect(e.state.selection.$from.parent.type.name).toBe("paragraph")
    expect(e.state.selection.$from.depth).toBe(2)
  })

  it("Media & text after a line with text, not decorative", () => {
    const e = makeEditor({ type: "doc", content: [para(PARA, "keep")] })
    e.commands.setTextSelection(5)
    CORE_BLOCKS.find((item) => item.id === "media-text")!.insert(e, { from: 5, to: 5 })
    expect(e.state.doc.child(0).textContent).toBe("keep")
    expect(e.state.doc.child(1).type.name).toBe("mediaText")
    expect(e.state.doc.child(1).attrs).toMatchObject({ decorative: false, position: "left" })
  })

  it("the slash menu offers a cover only at the top, media & text at the top and in a group", () => {
    const e = makeEditor({ type: "doc", content: [{ type: "group", attrs: { "data-block-id": GROUP }, content: [para(PARA)] }, para(AFTER)] })
    const offered = () => menuEntries({ role: "editor", accepts: slotAcceptsAt(e) }).map((item) => item.id)
    e.commands.setTextSelection(posOf(e, PARA) + 1)
    expect(offered()).toContain("media-text")
    expect(offered()).not.toContain("cover")
    e.commands.setTextSelection(posOf(e, AFTER) + 1)
    expect(offered()).toEqual(expect.arrayContaining(["media-text", "cover"]))
  })

  it("insertCover refuses inside a group; the nesting table is what says so", () => {
    const e = makeEditor({ type: "doc", content: [{ type: "group", attrs: { "data-block-id": GROUP }, content: [para(PARA)] }] })
    e.commands.setTextSelection(posOf(e, PARA) + 1)
    expect(e.commands.insertCover()).toBe(false)
    expect(holderAcceptsType("group", "cover")).toBe(false)
    expect(holderAcceptsType("group", "media_text")).toBe(true)
    expect(holderAcceptsType("doc", "cover")).toBe(true)
    expect(holderAcceptsType("column", "media_text")).toBe(false)
    expect(holderAcceptsType("mediaText", "cover")).toBe(false)
  })
})

describe("the nesting limits (#427)", () => {
  it("a drop never puts a cover inside another block, however it's aimed", () => {
    const e = makeEditor({
      type: "doc",
      content: [
        { type: "cover", attrs: { "data-block-id": COVER }, content: [para(PARA, "on top")] },
        { type: "group", attrs: { "data-block-id": GROUP }, content: [para(HEAD, "in group")] },
      ],
    })
    const cover = editorBlockById(e.state.doc, COVER)!
    const inGroup = editorBlockById(e.state.doc, HEAD)!
    // Aimed inside the group: the nearest allowed place is beside the group, at the top.
    const target = dropTargetFor(e.state.doc, cover, inGroup, "after")!
    expect(target.holderPos).toBe(-1)
  })

  it("media & text may be dropped into a group but never into a cover", () => {
    const e = makeEditor({
      type: "doc",
      content: [
        { type: "mediaText", attrs: { "data-block-id": MEDIA }, content: [para(PARA, "x")] },
        { type: "cover", attrs: { "data-block-id": COVER }, content: [para(AFTER, "y")] },
        { type: "group", attrs: { "data-block-id": GROUP }, content: [para(HEAD, "z")] },
      ],
    })
    const block = editorBlockById(e.state.doc, MEDIA)!
    expect(dropTargetFor(e.state.doc, block, editorBlockById(e.state.doc, HEAD)!, "after")!.holderPos).toBe(posOf(e, GROUP))
    expect(dropTargetFor(e.state.doc, block, editorBlockById(e.state.doc, AFTER)!, "after")!.holderPos).toBe(-1)
  })

  it("deleting a cover's last block leaves it an empty line, never the cover gone", () => {
    const e = makeEditor(coverDoc({}, [para(PARA, "only")]))
    const block = editorBlockById(e.state.doc, PARA)!
    expect(removalRange(e.state.doc, block)).toMatchObject({ fill: true })
    e.view.dispatch(deleteBlockTr(e.state, block)!)
    const cover = e.state.doc.child(0)
    expect(cover.type.name).toBe("cover")
    expect(cover.childCount).toBe(1)
    expect(cover.child(0).content.size).toBe(0)
    expect(cover.attrs.mediaId).toBe(1)
  })

  it("cutting its only block keeps a line, with the caret in it", () => {
    const e = makeEditor(coverDoc({}, [para(PARA, "only")]))
    select(e, PARA)
    e.view.dispatch(e.state.tr.deleteSelection())
    const cover = e.state.doc.child(0)
    expect(cover.type.name).toBe("cover")
    expect(cover.childCount).toBe(1)
    expect(cover.child(0).type.name).toBe("paragraph")
    expect(cover.child(0).content.size).toBe(0)
    expect(e.state.selection.$from.parent).toBe(cover.child(0))
    expect(cover.attrs.mediaId).toBe(1)
  })

  it("a selection across its blocks, deleted, keeps a block too", () => {
    const e = makeEditor(coverDoc())
    const from = posOf(e, HEAD) + 1
    const to = posOf(e, PARA) + 1 + nodeOf(e, PARA).content.size
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, from, to)))
    e.commands.deleteSelection()
    expect(e.state.doc.child(0).childCount).toBe(1)
    expect(e.state.doc.child(0).type.name).toBe("cover")
  })

  it("a stored doc with a cover has what the validator wants", () => {
    const e = makeEditor(coverDoc({ focalX: 10, focalY: 90, alt: "Towers", decorative: false }))
    expect(() => validateBlockDoc(pmToBlockDoc(e.state.doc))).not.toThrow()
  })
})

describe("the keyboard (\"Keyboard\" › Moving between blocks)", () => {
  it("↵ on the selected cover steps into its first block; Esc back selects the cover", () => {
    const e = makeEditor(coverDoc())
    select(e, COVER)
    expect(key(e, "Enter")).toBe(true)
    expect(selectedBlock(e.state)?.node.attrs["data-block-id"]).toBe(HEAD)
    expect(key(e, "Escape")).toBe(true)
    expect(selectedBlock(e.state)?.node.attrs["data-block-id"]).toBe(COVER)
  })

  it("↵ on selected media & text does the same", () => {
    const e = makeEditor(mediaDoc())
    select(e, MEDIA)
    key(e, "Enter")
    expect(selectedBlock(e.state)?.node.attrs["data-block-id"]).toBe(HEAD)
  })

  it("a duplicate gets fresh ids for its blocks", () => {
    const e = makeEditor(coverDoc())
    duplicateBlock(e, { id: COVER, pos: posOf(e, COVER) })
    const ids = new Set<string>()
    e.state.doc.descendants((node) => {
      const id = node.attrs["data-block-id"]
      if (id) {
        expect(ids.has(id)).toBe(false)
        ids.add(id)
      }
    })
    expect(e.state.doc.child(0).type.name).toBe("cover")
    expect(e.state.doc.child(1).type.name).toBe("cover")
  })
})

describe("the views", () => {
  it("an empty cover is the drop zone, its first line hidden until the cursor is in it", async () => {
    const e = makeEditor({ type: "doc", content: [{ type: "cover", attrs: { "data-block-id": COVER, mediaId: null }, content: [para(PARA)] }, para(AFTER)] })
    await flush()
    const cover = dom(e, ".editor-cover")
    expect(cover.dataset.state).toBe("empty")
    expect(cover.hasAttribute("data-blank")).toBe(true)
    expect(cover.textContent).toContain(COVER_EMPTY_TEXT)
    expect(Array.from(cover.querySelectorAll(".editor-media__button")).map((b) => b.textContent)).toEqual(["Upload", "Choose from Media"])
  })

  it("a cover that has text in it isn't blank", async () => {
    const e = makeEditor(coverDoc({ mediaId: null }))
    await flush()
    expect(dom(e, ".editor-cover").hasAttribute("data-blank")).toBe(false)
  })

  it("empty media & text offers Upload and From Media, beside its text", async () => {
    const e = makeEditor(mediaDoc({ mediaId: null }))
    await flush()
    const block = dom(e, ".editor-media-text")
    expect(Array.from(block.querySelectorAll(".editor-media__button")).map((b) => b.textContent)).toEqual(["Upload", "From Media"])
    expect(block.textContent).toContain("Faster")
  })

  it("a filled cover shows its image, darkened by its overlay, at its focal point", async () => {
    const e = makeEditor(coverDoc({ overlay: 40, focalX: 10, focalY: 90 }))
    await flush()
    const cover = dom(e, ".editor-cover")
    expect(cover.dataset.state).toBe("found")
    const img = cover.querySelector("img") as HTMLImageElement
    expect(img.getAttribute("src")).toContain("/uploads/media/photo-1.jpg")
    expect(img.style.objectPosition).toBe("10% 90%")
    expect((cover.querySelector(".editor-cover__frame") as HTMLElement).style.getPropertyValue("--dim")).toBe("0.4")
  })

  it("with no focal point of its own, it follows the media's", async () => {
    api.getMediaById.mockImplementation(async (id: number) => ({ media: media(Number(id), { focal_point: { x: 0.25, y: 0.75 } }) }))
    const e = makeEditor(coverDoc())
    await flush()
    expect((dom(e, ".editor-cover img") as HTMLImageElement).style.objectPosition).toBe("25% 75%")
  })

  it("media & text says where its media sits; the toolbar's Left and Right change it", async () => {
    const e = makeEditor(mediaDoc())
    await flush()
    const block = dom(e, ".editor-media-text")
    expect(block.dataset.position).toBe("left")
    const right = block.querySelector('[aria-label="Media on the right"]') as HTMLButtonElement
    expect(right.getAttribute("aria-pressed")).toBe("false")
    right.click()
    expect(nodeOf(e, MEDIA).attrs.position).toBe("right")
    expect(dom(e, ".editor-media-text").dataset.position).toBe("right")
  })

  it("the toolbar's Width changes a cover's align", async () => {
    const e = makeEditor(coverDoc())
    await flush()
    const wide = Array.from(dom(e, ".editor-cover__toolbar").querySelectorAll("button")).find((b) => b.textContent === "Wide")!
    wide.click()
    expect(nodeOf(e, COVER).attrs.align).toBe("wide")
  })

  it("a read-only view changes nothing", async () => {
    const e = makeEditor(mediaDoc())
    await flush()
    e.setEditable(false)
    ;(dom(e, ".editor-media-text").querySelector('[aria-label="Media on the right"]') as HTMLButtonElement).click()
    expect(nodeOf(e, MEDIA).attrs.position).toBe("left")
  })
})

describe("the shared picker and missing media (#423)", () => {
  it("Choose from Media opens the image picker and points the block at the file by id", async () => {
    const e = makeEditor(coverDoc({ mediaId: null, alt: "old" }))
    const opened: MediaPickRequest[] = []
    const applied: Media[] = []
    registerMediaPickerHost(e, { open: (request) => opened.push(request), applied: (m) => applied.push(m) })
    expect(chooseMediaFor(e, posOf(e, COVER))).toBe(true)
    expect(opened[0].kind).toBe("image")
    // A collaborator's edit moved it before the file arrives: found again by id.
    e.commands.insertContentAt(0, { type: "paragraph" })
    opened[0].onPick(media(9, { alt: "New alt" }))
    expect(nodeOf(e, COVER).attrs).toMatchObject({ mediaId: 9, alt: "New alt", decorative: true })
    expect(applied.map((m) => m.id)).toEqual([9])
  })

  it("Replace resets the focal point and takes the new image's alt text; media & text its decorative flag", async () => {
    const e = makeEditor(mediaDoc({ focalX: 1, focalY: 2, alt: "Old", decorative: true }))
    await flush()
    expect(applyMediaToBlock(e, { id: MEDIA, pos: 0 }, media(5, { alt: "New", decorative: false }))).toBe(true)
    expect(nodeOf(e, MEDIA).attrs).toMatchObject({ mediaId: 5, alt: "New", decorative: false, focalX: null, focalY: null })
  })

  it("a decorative media gives a cover no alt text, and the cover keeps its own switch", () => {
    const e = makeEditor(coverDoc({ decorative: false, alt: "Old" }))
    applyMediaToBlock(e, { id: COVER, pos: 0 }, media(6, { alt: "Ignored", decorative: true }))
    expect(nodeOf(e, COVER).attrs).toMatchObject({ mediaId: 6, alt: null, decorative: false })
  })

  it("Upload points the block at what was uploaded", async () => {
    const e = makeEditor(coverDoc({ mediaId: null }))
    api.createMedia.mockResolvedValue({ media: media(7) })
    registerMediaPickerHost(e, { open: () => {} })
    await uploadMediaFor(e, posOf(e, COVER), new File(["x"], "a.jpg", { type: "image/jpeg" }))
    expect(nodeOf(e, COVER).attrs.mediaId).toBe(7)
  })

  it("a deleted file shows \"The image file is missing\" with Replace; the blocks stay", async () => {
    api.getMediaById.mockRejectedValue(new ApiError("not found", 404))
    const e = makeEditor(coverDoc())
    await flush()
    await flush()
    const cover = dom(e, ".editor-cover")
    expect(cover.dataset.state).toBe("missing")
    expect(cover.textContent).toContain("The image file is missing")
    expect(cover.querySelector(".editor-media__missing button")?.textContent).toBe("Replace")
    expect(cover.textContent).toContain("Notes")
  })

  it("a lookup that failed some other way is not shown as missing", async () => {
    api.getMediaById.mockRejectedValue(new ApiError("server", 500))
    const e = makeEditor(mediaDoc())
    await flush()
    await flush()
    const block = dom(e, ".editor-media-text")
    expect(block.dataset.state).toBe("unknown")
    expect(block.textContent).not.toContain("missing")
  })
})

describe("the alt text flag (#325, \"An image without alt text\")", () => {
  it("is on the block and in its toolbar while the image has none and isn't decorative", async () => {
    api.getMediaById.mockImplementation(async (id: number) => ({ media: media(Number(id), { alt: "" }) }))
    const e = makeEditor(mediaDoc())
    await flush()
    const block = dom(e, ".editor-media-text")
    expect((block.querySelector(".editor-cover-flag") as HTMLElement).hidden).toBe(false)
    expect(Array.from(block.querySelectorAll("[data-block-toolbar] button")).some((b) => !(b as HTMLElement).hidden && b.textContent === "Add alt text")).toBe(true)
  })

  it("isn't, once it has alt text or is marked decorative", async () => {
    api.getMediaById.mockImplementation(async (id: number) => ({ media: media(Number(id), { alt: "" }) }))
    const e = makeEditor(mediaDoc({ alt: "Dunes" }))
    await flush()
    expect((dom(e, ".editor-cover-flag") as HTMLElement).hidden).toBe(true)
    e.view.dispatch(e.state.tr.setNodeMarkup(posOf(e, MEDIA), undefined, { ...nodeOf(e, MEDIA).attrs, alt: null, decorative: true }))
    await flush()
    expect((dom(e, ".editor-cover-flag") as HTMLElement).hidden).toBe(true)
  })

  it("a cover is decorative by default, so it isn't flagged", async () => {
    api.getMediaById.mockImplementation(async (id: number) => ({ media: media(Number(id), { alt: "" }) }))
    const e = makeEditor(coverDoc())
    await flush()
    expect((dom(e, ".editor-cover-flag") as HTMLElement).hidden).toBe(true)
  })

  it("the flag opens the panel and asks for focus in Alt text", async () => {
    api.getMediaById.mockImplementation(async (id: number) => ({ media: media(Number(id), { alt: "" }) }))
    rememberMedia(media(2, { alt: "" }))
    const e = makeEditor(mediaDoc())
    const open = vi.fn()
    ;(e.storage as any).blockNavigationKeys.openBlockSettings = open
    await flush()
    ;(dom(e, ".editor-cover-flag") as HTMLButtonElement).click()
    expect(open).toHaveBeenCalledOnce()
    expect(selectedBlock(e.state)?.node.attrs["data-block-id"]).toBe(MEDIA)
  })
})

describe("paste (#128)", () => {
  it("keeps a valid cover and media & text, without their image", () => {
    expect(sanitizePastedHTML('<div data-type="cover" data-overlay="40" data-align="wide" data-media-id="9" data-alt="x" data-focal-x="5"><p>Hi</p></div>')).toBe('<div data-type="cover" data-overlay="40" data-align="wide"><p>Hi</p></div>')
    expect(sanitizePastedHTML('<div data-type="media-text" data-position="right" data-media-id="9"><p>Hi</p></div>')).toBe('<div data-type="media-text" data-position="right"><p>Hi</p></div>')
  })

  it("clamps an overlay and drops bad values", () => {
    expect(sanitizePastedHTML('<div data-type="cover" data-overlay="500"></div>')).toContain('data-overlay="80"')
    expect(sanitizePastedHTML('<div data-type="cover" data-overlay="bad"></div>')).not.toContain("data-overlay")
    expect(sanitizePastedHTML('<div data-type="cover" data-align="huge"></div>')).not.toContain("data-align")
    expect(sanitizePastedHTML('<div data-type="media-text" data-position="middle"></div>')).not.toContain("data-position")
    expect(sanitizePastedHTML('<div data-overlay="40"></div>')).not.toContain("data-overlay")
  })

  it("a pasted cover parses to an empty-image cover with its text and fresh ids, in place", () => {
    const e = makeEditor({ type: "doc", content: [para(PARA)] })
    e.commands.setTextSelection(1)
    e.view.pasteHTML('<div data-type="cover" data-overlay="40" data-align="wide"><h2>Hello</h2></div><p>after</p>', new Event("paste") as ClipboardEvent)
    const cover = e.state.doc.child(0)
    expect(cover.type.name).toBe("cover")
    expect(cover.attrs).toMatchObject({ mediaId: null, overlay: 40, align: "wide" })
    expect(cover.textContent).toBe("Hello")
    expect(cover.attrs["data-block-id"]).not.toBe(PARA)
  })
})
