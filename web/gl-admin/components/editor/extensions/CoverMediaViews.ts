import type { Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection } from "@tiptap/pm/state"
import type { EditorView, NodeView } from "@tiptap/pm/view"
import { getMediaVariantPreviewURL } from "@gl-admin/lib/api/media"
import type { Media } from "@gl-admin/lib/api/types"
import {
  COVER_ALIGNS,
  focalFromMedia,
  focalOfNodeAttrs,
  focalPosition,
  isBlockDecorative,
  isCoverAlign,
  isMediaTextPosition,
  MEDIA_BLOCK_ICONS,
  MEDIA_KIND_ACCEPT,
  needsAltText,
  normalizeCoverOverlay,
  type CoverAlign,
  type MediaTextPosition,
} from "@gl-admin/lib/blocks-spec"
import { chooseMediaFor, uploadMediaFor } from "../blocks/mediaPicking"
import { keepBlockSelected } from "../utils/blockTree"
import { requestGalleryAltFocus } from "../utils/galleryActions"
import { segment, selectBlockAgain, toolbarKeys } from "./LayoutBlockViews"
import { button, MediaLookupTracker, mediaIcon, missingPanel, MISSING_TEXT, setBlockId, UNKNOWN_TEXT } from "./MediaBlockViews"

// The editor's views of cover and media & text (#427, the canvas's "Editor · cover, media &
// text" and "Errors & empty states"): plain DOM, from BlockNodeViews' plugin, so the schema
// (CoverMediaBlocks.ts) stays DOM-free and the collab server can build it.
//
// Each shows its image from the media library (`lookup` below: empty, loading, filled, missing,
// unknown) behind or beside its blocks, and its toolbar while the cursor is in it or it's selected.
// Every control is one ordinary transaction from the user's own input (no appendTransaction,
// rule 7), found again by position when pressed. Upload and Choose find the block by id when
// the file arrives (`mediaPicking.ts`).

const WIDTH_LABELS: Record<CoverAlign, string> = { content: "Content", wide: "Wide", full: "Full" }
const POSITION_ICONS: Record<MediaTextPosition, string> = {
  left: "M3 5h8v14H3zM14 8h7M14 12h7M14 16h5",
  right: "M13 5h8v14h-8zM3 8h7M3 12h7M3 16h5",
}
const WARNING_ICON = "M12 3 2 20h20zM12 10v4M12 17h.01"

export const COVER_EMPTY_TEXT = "Choose a background image, then write on top of it."

type Kind = "cover" | "mediaText"

export class CoverMediaView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private kind: Kind
  private frame: HTMLElement
  private media: HTMLElement
  private toolbar: HTMLElement
  private replace: HTMLButtonElement
  private altButton: HTMLButtonElement
  private flag: HTMLButtonElement
  private status: HTMLElement
  private fileInput: HTMLInputElement
  private options = new Map<string, HTMLButtonElement>()
  private image: HTMLImageElement | null = null
  private lookup: MediaLookupTracker
  private rendered = ""

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private editor: Editor,
  ) {
    this.kind = node.type.name as Kind
    const doc = view.dom.ownerDocument
    const name = this.kind === "cover" ? "Cover" : "Media and text"
    const base = this.kind === "cover" ? "editor-cover" : "editor-media-text"

    this.dom = doc.createElement("div")
    this.dom.className = base
    this.dom.dataset.type = this.kind === "cover" ? "cover" : "media-text"
    // Remote carets' name labels flip at this edge (#417, utils/cursorAwareness.ts).
    this.dom.setAttribute("data-collab-bounds", "")

    this.toolbar = doc.createElement("div")
    this.toolbar.className = `${base}__toolbar`
    this.toolbar.contentEditable = "false"
    this.toolbar.setAttribute("role", "toolbar")
    this.toolbar.setAttribute("aria-label", name)
    // Tab from its drag handle lands here (#417, ui/DragHandle.tsx).
    this.toolbar.setAttribute("data-block-toolbar", "")

    this.replace = button("Replace", "editor-group__option")
    this.replace.addEventListener("click", () => this.choose())
    this.altButton = button("", "editor-group__option")
    this.altButton.append(mediaIcon(WARNING_ICON, 14), doc.createTextNode("Add alt text"))
    this.altButton.setAttribute("aria-label", "Alt text missing. Add alt text")
    this.altButton.addEventListener("click", () => this.openAltText())

    if (this.kind === "cover") {
      const width = segment(
        doc,
        "Width",
        "Cover",
        COVER_ALIGNS.map((value) => ({ value, text: WIDTH_LABELS[value], onClick: () => this.setAttr("align", value) })),
      )
      this.options = width.buttons
      this.toolbar.append(this.replace, this.altButton, width.field)
    } else {
      const position = doc.createElement("div")
      position.className = "editor-group__field"
      position.setAttribute("role", "group")
      position.setAttribute("aria-label", "Media position")
      for (const value of ["left", "right"] as const) {
        const option = button("", "editor-group__option")
        option.append(mediaIcon(POSITION_ICONS[value], 16))
        option.setAttribute("aria-label", value === "left" ? "Media on the left" : "Media on the right")
        option.title = value === "left" ? "Media on the left" : "Media on the right"
        option.addEventListener("click", () => this.setAttr("position", value))
        this.options.set(value, option)
        position.append(option)
      }
      this.toolbar.append(position, this.replace, this.altButton)
    }
    toolbarKeys(this.toolbar, () => {
      const pos = this.getPos()
      if (pos !== undefined) selectBlockAgain(this.view, pos, this.kind)
    })

    this.frame = doc.createElement("div")
    this.frame.className = `${base}__frame`
    this.media = doc.createElement("div")
    this.media.className = `${base}__media`
    this.media.contentEditable = "false"
    this.flag = button("", "editor-cover-flag")
    this.flag.contentEditable = "false"
    this.flag.append(mediaIcon(WARNING_ICON, 14), doc.createTextNode("No alt text"))
    this.flag.addEventListener("click", () => this.openAltText())
    this.contentDOM = doc.createElement("div")
    this.contentDOM.className = `${base}__content`
    this.status = doc.createElement("p")
    this.status.className = "editor-media__status"
    this.status.setAttribute("role", "status")
    this.status.contentEditable = "false"
    this.fileInput = doc.createElement("input")
    this.fileInput.type = "file"
    this.fileInput.hidden = true
    this.fileInput.accept = MEDIA_KIND_ACCEPT.image
    this.fileInput.setAttribute("aria-label", "Upload an image")
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0]
      this.fileInput.value = ""
      if (file) void this.upload(file)
    })

    this.frame.append(this.media, this.flag, this.contentDOM)
    this.dom.append(this.toolbar, this.frame, this.status, this.fileInput)

    // A click on the image, or a drop zone's own padding, selects the block.
    this.media.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest("button, input")) return
      event.preventDefault()
      const pos = this.getPos()
      if (pos === undefined) return
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
      this.view.focus()
    })

    this.lookup = new MediaLookupTracker(() => this.render(true))
    this.render()
  }

  private choose() {
    if (!this.view.editable) return
    const pos = this.getPos()
    if (pos !== undefined) chooseMediaFor(this.editor, pos)
  }

  private async upload(file: File) {
    const pos = this.getPos()
    if (pos === undefined || !this.view.editable) return
    this.status.textContent = `Uploading ${file.name}…`
    try {
      await uploadMediaFor(this.editor, pos, file)
      this.status.textContent = ""
    } catch (error) {
      this.status.textContent = `Upload failed: ${error instanceof Error ? error.message : "the file couldn't be uploaded"}`
    }
  }

  /** "The flag is a button: it opens the panel with focus in Alt text" ("Errors & empty states"). */
  private openAltText() {
    const pos = this.getPos()
    if (pos === undefined) return
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
    const id = this.node.attrs["data-block-id"]
    const storage = (this.editor.storage as unknown as Record<string, { openBlockSettings?: (() => void) | null }>).blockNavigationKeys
    if (typeof id === "string" && id) requestGalleryAltFocus(this.editor, id)
    storage?.openBlockSettings?.()
  }

  private setAttr(attr: "align" | "position", value: string) {
    // `editable` can change without an update (a demotion, #313).
    if (!this.view.editable) return
    const pos = this.getPos()
    const current = pos === undefined ? null : this.view.state.doc.nodeAt(pos)
    if (pos === undefined || !current || current.type.name !== this.kind || current.attrs[attr] === value) return
    const { state } = this.view
    this.view.dispatch(keepBlockSelected(state, pos, state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, [attr]: value })))
  }

  private render(force = false) {
    setBlockId(this.dom, this.node)
    const attrs = this.node.attrs
    const editable = this.view.editable
    this.lookup.track(attrs.mediaId)
    const state = this.lookup.state
    const status = state?.status ?? "empty"
    const media = state?.status === "found" ? state.media : null
    this.dom.dataset.state = status

    if (this.kind === "cover") {
      const align = isCoverAlign(attrs.align) ? attrs.align : "content"
      this.dom.dataset.align = align
      this.frame.style.setProperty("--dim", String(normalizeCoverOverlay(attrs.overlay) / 100))
      for (const [value, option] of this.options) option.setAttribute("aria-pressed", String(value === align))
    } else {
      const position = isMediaTextPosition(attrs.position) ? attrs.position : "left"
      this.dom.dataset.position = position
      for (const [value, option] of this.options) option.setAttribute("aria-pressed", String(value === position))
    }

    // A cover nobody has given an image is the drop zone only, as drawn; its first line shows
    // once the cursor is in it (the `has-selection` decoration).
    const only = this.node.childCount === 1 ? this.node.firstChild : null
    this.dom.toggleAttribute("data-blank", status === "empty" && only?.type.name === "paragraph" && only.content.size === 0)

    this.replace.textContent = typeof attrs.mediaId === "number" ? (this.kind === "cover" ? "Replace image" : "Replace") : "Choose from Media"
    const flagged = media !== null && needsAltText(attrs.alt, isBlockDecorative(this.kind === "cover" ? "cover" : "media_text", attrs.decorative), media.decorative === true)
    this.altButton.hidden = !flagged
    this.flag.hidden = !flagged

    const key = `${editable}|${status}|${media ? `${media.id}:${media.changed_at}` : ""}`
    if (force || key !== this.rendered) {
      this.rendered = key
      this.renderMedia(status, media, editable)
    }
    if (this.image && media) {
      this.image.style.objectPosition = focalPosition(focalOfNodeAttrs(attrs) ?? focalFromMedia(media.focal_point))
    }
  }

  private renderMedia(status: string, media: Media | null, editable: boolean) {
    this.image = null
    this.media.replaceChildren()
    const doc = this.dom.ownerDocument
    if (status === "empty") {
      this.media.append(this.dropZone(editable))
      return
    }
    if (status === "missing" || status === "unknown") {
      const { dom, replace } = missingPanel("image", status, status === "missing" ? MISSING_TEXT : UNKNOWN_TEXT, () => this.choose())
      replace.hidden = !editable
      this.media.append(dom)
      return
    }
    if (status === "loading" || !media) {
      const loading = doc.createElement("div")
      loading.className = "editor-media__loading"
      loading.textContent = "Loading the image…"
      this.media.append(loading)
      return
    }
    const image = doc.createElement("img")
    image.className = this.kind === "cover" ? "editor-cover__image" : "editor-media-text__image"
    image.alt = ""
    image.draggable = false
    image.src = getMediaVariantPreviewURL(media, "large")
    this.image = image
    this.media.append(image)
  }

  private dropZone(editable: boolean): HTMLElement {
    const doc = this.dom.ownerDocument
    const drop = doc.createElement("div")
    drop.className = "editor-media__drop"
    const head = doc.createElement("div")
    head.className = "editor-media__drop-head"
    head.append(mediaIcon(this.kind === "cover" ? MEDIA_BLOCK_ICONS.cover : MEDIA_BLOCK_ICONS.image, 16), this.kind === "cover" ? "Cover" : "Image")
    drop.append(head)
    if (this.kind === "cover" || !editable) {
      const text = doc.createElement("p")
      text.textContent = editable ? COVER_EMPTY_TEXT : "No image yet."
      drop.append(text)
    }
    if (editable) {
      const actions = doc.createElement("div")
      actions.className = "editor-media__actions"
      const upload = button("Upload")
      upload.addEventListener("click", () => this.view.editable && this.fileInput.click())
      const choose = button(this.kind === "cover" ? "Choose from Media" : "From Media")
      choose.addEventListener("click", () => this.choose())
      actions.append(upload, choose)
      drop.append(actions)
    }
    return drop
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target as globalThis.Node | null
    if (!target || this.contentDOM.contains(target)) return false
    if (this.toolbar.contains(target) || this.flag.contains(target) || this.fileInput === target) return true
    return this.media.contains(target)
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    if (mutation.type === "selection") return false
    return !this.contentDOM.contains(mutation.target)
  }

  destroy() {
    this.lookup.destroy()
  }
}
