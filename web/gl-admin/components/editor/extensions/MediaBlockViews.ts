import type { Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection } from "@tiptap/pm/state"
import type { EditorView, NodeView } from "@tiptap/pm/view"
import { getMediaURL } from "@gl-admin/lib/api"
import { capFileLabel, fileMetaLine, FILE_LABEL_MAX_LENGTH, MEDIA_BLOCK_ICONS, MEDIA_KIND_ACCEPT, formatFileSize } from "@gl-admin/lib/blocks-spec"
import { knownMedia, lookupMedia, type MediaLookup } from "@gl-admin/lib/mediaLookup"
import { formatDimensions, formatDuration } from "@gl-admin/lib/mediaLibrary"
import type { Media } from "@gl-admin/lib/api/types"
import { chooseMediaFor, mediaKindOfNode, uploadMediaFor } from "../blocks/mediaPicking"

// The editor's views of the media blocks (#423; the canvas's "Editor · image, gallery,
// video, audio, file" and "Errors & empty states"): plain DOM, from BlockNodeViews' plugin
// (the schema in MediaBlocks.ts has no DOM code, so the collab server builds it).
//
// A block shows one of four states, from its `mediaId` and the media lookup
// (`lib/mediaLookup.ts`):
// - **empty** (no file yet): "Upload" and "Choose from Media";
// - **filled**: the browser's player (video, audio) or the download row (file);
// - **missing** (the lookup said 404: the media was deleted): "The video file is missing",
//   with Replace. The public page leaves the block out, caption and all;
// - **unknown** (the lookup failed otherwise): a neutral note and Replace, never "missing".
//
// Every change is one transaction the user's own click or typing makes; no
// appendTransaction (rule 7). Upload, Choose and Replace find the block again by its id
// when the file arrives (`mediaPicking.ts`). In a read-only editor the controls are hidden
// and the file label can't be typed in.

const SVG_NS = "http://www.w3.org/2000/svg"

export function mediaIcon(path: string, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg")
  for (const [name, value] of Object.entries({
    width: String(size),
    height: String(size),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.75",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(name, value)
  }
  const shape = document.createElementNS(SVG_NS, "path")
  shape.setAttribute("d", path)
  svg.append(shape)
  return svg
}

export type MediaNode = "image" | "video" | "audio" | "file"

const BLOCK_NAMES: Record<MediaNode, string> = { image: "Image", video: "Video", audio: "Audio", file: "File" }

/** "The video file is missing" ("Errors & empty states", "A media file that's missing"). */
export const MISSING_TITLES: Record<MediaNode, string> = {
  image: "The image file is missing",
  video: "The video file is missing",
  audio: "The audio file is missing",
  file: "The file is missing",
}

export const MISSING_TEXT = "It's no longer in Media. Replace it, or remove the block."
export const UNKNOWN_TEXT = "The file's details couldn't be loaded. It may still be in Media."

const EMPTY_TEXTS: Record<Exclude<MediaNode, "image">, string> = {
  video: "Upload a video or choose one from Media. For YouTube or Vimeo, use their embed blocks.",
  audio: "Upload an audio file or choose one from Media.",
  file: "Upload a document or choose one from Media.",
}

export function button(label: string, className = "editor-media__button"): HTMLButtonElement {
  const el = document.createElement("button")
  el.type = "button"
  el.className = className
  el.textContent = label
  // Never move the editor's selection or focus on press; the click does the work.
  el.addEventListener("mousedown", (event) => event.preventDefault())
  return el
}

/**
 * The missing state's panel (an image's, or a video's, audio's or file's): the icon, the
 * title, one line and Replace. `role="group"` named by the title, so a screen reader
 * hears what's wrong before the button.
 */
export function missingPanel(
  kind: MediaNode,
  state: "missing" | "unknown",
  text: string,
  onReplace: () => void,
): { dom: HTMLElement; replace: HTMLButtonElement } {
  const dom = document.createElement("div")
  dom.className = "editor-media__missing"
  dom.contentEditable = "false"
  dom.setAttribute("role", "group")
  const title = document.createElement("b")
  title.className = "editor-media__missing-title"
  title.id = `missing-${Math.random().toString(36).slice(2, 10)}`
  title.textContent = state === "unknown" ? `${BLOCK_NAMES[kind]}: details unavailable` : MISSING_TITLES[kind]
  dom.setAttribute("aria-labelledby", title.id)
  const line = document.createElement("span")
  line.className = "editor-media__missing-text"
  line.textContent = text
  const replace = button("Replace")
  replace.addEventListener("click", onReplace)
  const icon = mediaIcon(MEDIA_BLOCK_ICONS.missing, kind === "image" ? 28 : 18)
  icon.classList.add("editor-media__missing-icon")
  dom.append(icon, title, line, replace)
  return { dom, replace }
}

/** The `data-block-id` the node's renderHTML would put on it (BlockIdExtension). */
export function setBlockId(dom: HTMLElement, node: PMNode) {
  const id = node.attrs["data-block-id"]
  if (typeof id === "string" && id) dom.setAttribute("data-block-id", id)
  else dom.removeAttribute("data-block-id")
}

/** "1:42 · 18 MB", "PDF · 240 KB": the line under a file's name in the editor (the row, the settings panel). */
export function mediaFileLine(node: MediaNode, media: Media): string {
  if (node === "file") return fileMetaLine(media.original_filename || media.media_path, media.file_size)
  if (node === "image") return [formatDimensions(media), formatFileSize(media.file_size)].filter(Boolean).join(" · ")
  return [formatDuration(media.duration), formatFileSize(media.file_size)].filter(Boolean).join(" · ")
}

/**
 * Follows the media lookup of a block's `mediaId`: `status` is null while there is no id,
 * "loading" while the lookup runs. Calls `onChange` when a lookup the view still wants ends.
 */
export class MediaLookupTracker {
  private id: number | null = null
  state: MediaLookup | { status: "loading" } | null = null

  constructor(private onChange: () => void) {}

  track(mediaId: unknown) {
    const id = typeof mediaId === "number" && Number.isInteger(mediaId) && mediaId > 0 ? mediaId : null
    if (id === this.id) return
    this.id = id
    if (id === null) {
      this.state = null
      return
    }
    this.state = knownMedia(id) ?? { status: "loading" }
    if (this.state.status !== "loading") return
    void lookupMedia(id).then((result) => {
      if (this.id !== id) return
      this.state = result
      this.onChange()
    })
  }

  destroy() {
    this.id = null
  }
}

/**
 * Video, audio and file (#423). Video and audio are figures whose caption (the image's
 * caption node) is the content; a file is an atom whose label is a field in the row.
 */
export class MediaBlockView implements NodeView {
  dom: HTMLElement
  contentDOM?: HTMLElement
  private kind: Exclude<MediaNode, "image">
  private body: HTMLElement
  private addCaption?: HTMLButtonElement
  private fileInput: HTMLInputElement
  private status: HTMLElement
  private labelInput?: HTMLInputElement
  private lookup: MediaLookupTracker
  private rendered = ""

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private editor: Editor,
  ) {
    this.kind = node.type.name as Exclude<MediaNode, "image">
    this.dom = document.createElement(this.kind === "file" ? "div" : "figure")
    this.dom.className = `editor-media editor-media--${this.kind}`
    this.dom.dataset.type = this.kind
    this.body = document.createElement("div")
    this.body.className = "editor-media__body"
    this.body.contentEditable = "false"
    this.status = document.createElement("p")
    this.status.className = "editor-media__status"
    this.status.setAttribute("role", "status")
    this.status.contentEditable = "false"
    this.fileInput = document.createElement("input")
    this.fileInput.type = "file"
    this.fileInput.hidden = true
    this.fileInput.accept = MEDIA_KIND_ACCEPT[mediaKindOfNode(node) ?? "document"]
    this.fileInput.setAttribute("aria-label", `Upload ${this.kind === "audio" ? "an audio file" : `a ${this.kind}`}`)
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0]
      this.fileInput.value = ""
      if (file) void this.upload(file)
    })
    this.dom.append(this.body, this.status, this.fileInput)

    if (this.kind !== "file") {
      this.contentDOM = document.createElement("div")
      this.contentDOM.className = "editor-media__caption-slot"
      this.addCaption = button("Add caption", "editor-image__add-caption")
      this.addCaption.contentEditable = "false"
      this.addCaption.addEventListener("click", () => {
        if (!this.view.editable) return
        const pos = this.getPos()
        if (pos === undefined) return
        this.editor.chain().focus().setNodeSelection(pos).toggleMediaCaption().run()
      })
      this.dom.append(this.contentDOM, this.addCaption)
    }

    // A click on the block (not on its controls) selects it, as an image's does.
    this.body.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest("button, input, video, audio, a")) return
      event.preventDefault()
      this.selectSelf()
    })

    this.lookup = new MediaLookupTracker(() => this.render(true))
    this.render()
  }

  private selectSelf() {
    const pos = this.getPos()
    if (pos === undefined) return
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
    this.view.focus()
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

  private render(force = false) {
    setBlockId(this.dom, this.node)
    const editable = this.view.editable
    this.lookup.track(this.node.attrs.mediaId)
    const state = this.lookup.state
    const key = `${editable}|${state?.status ?? "empty"}|${state && "media" in state ? `${state.media.id}:${state.media.changed_at}` : ""}`
    if (this.addCaption) this.addCaption.hidden = this.node.childCount > 0 || !editable || !state
    this.dom.dataset.state = state?.status ?? "empty"
    if (this.labelInput) this.syncLabel()
    if (!force && key === this.rendered) return
    this.rendered = key
    this.labelInput = undefined
    this.body.replaceChildren()

    if (!state) return this.renderEmpty(editable)
    if (state.status === "missing" || state.status === "unknown") {
      const { dom, replace } = missingPanel(this.kind, state.status, state.status === "missing" ? MISSING_TEXT : UNKNOWN_TEXT, () => this.choose())
      replace.hidden = !editable
      this.body.append(dom)
      return
    }
    if (state.status === "loading") {
      const loading = document.createElement("div")
      loading.className = "editor-media__loading"
      loading.textContent = "Loading the file…"
      this.body.append(loading)
      return
    }
    this.renderFilled(state.media, editable)
  }

  private renderEmpty(editable: boolean) {
    const drop = document.createElement("div")
    drop.className = "editor-media__drop"
    const head = document.createElement("div")
    head.className = "editor-media__drop-head"
    head.append(mediaIcon(MEDIA_BLOCK_ICONS[this.kind], 16), BLOCK_NAMES[this.kind])
    const text = document.createElement("p")
    text.textContent = editable ? EMPTY_TEXTS[this.kind] : "No file yet."
    drop.append(head, text)
    if (editable) {
      const actions = document.createElement("div")
      actions.className = "editor-media__actions"
      const upload = button("Upload")
      upload.addEventListener("click", () => this.view.editable && this.fileInput.click())
      const choose = button("Choose from Media")
      choose.addEventListener("click", () => this.choose())
      actions.append(upload, choose)
      drop.append(actions)
    }
    this.body.append(drop)
  }

  private renderFilled(media: Media, editable: boolean) {
    const url = getMediaURL(media.media_path)
    if (this.kind === "video" || this.kind === "audio") {
      const player = document.createElement(this.kind)
      player.className = `editor-media__player editor-media__player--${this.kind}`
      player.controls = true
      // Never on its own (no autoplay); the editor reads the length, the page loads nothing.
      player.preload = "metadata"
      player.src = url
      player.setAttribute("aria-label", media.name || BLOCK_NAMES[this.kind])
      this.body.append(player)
      return
    }
    const row = document.createElement("div")
    row.className = "editor-media__file"
    const icon = document.createElement("span")
    icon.className = "editor-media__file-icon"
    icon.append(mediaIcon(MEDIA_BLOCK_ICONS.file))
    const text = document.createElement("div")
    text.className = "editor-media__file-text"
    const input = document.createElement("input")
    input.type = "text"
    input.className = "editor-media__label"
    input.maxLength = FILE_LABEL_MAX_LENGTH * 2
    input.placeholder = media.name || media.original_filename || "Link text"
    input.setAttribute("aria-label", "Link text")
    input.addEventListener("focus", () => (input.readOnly = !this.view.editable))
    input.addEventListener("input", () => this.typeLabel(input))
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== "Escape") return
      event.preventDefault()
      this.selectSelf()
    })
    const meta = document.createElement("span")
    meta.className = "editor-media__meta"
    meta.textContent = mediaFileLine("file", media)
    text.append(input, meta)
    const download = document.createElement("span")
    download.className = "editor-media__button editor-media__button--static"
    download.setAttribute("aria-hidden", "true")
    download.textContent = "Download"
    row.append(icon, text, download)
    this.body.append(row)
    this.labelInput = input
    this.syncLabel()
    input.readOnly = !editable
  }

  private syncLabel() {
    const input = this.labelInput
    if (!input || input === document.activeElement) return
    const label = typeof this.node.attrs.label === "string" ? this.node.attrs.label : ""
    if (input.value !== label) input.value = label
  }

  // Stored as typed, capped (trimmed when converted to Block Spec, like a citation).
  private typeLabel(input: HTMLInputElement) {
    if (!this.view.editable) return
    const pos = this.getPos()
    const current = pos === undefined ? null : this.view.state.doc.nodeAt(pos)
    if (pos === undefined || !current) return
    const capped = capFileLabel(input.value)
    if (capped !== input.value) input.value = capped
    const label = capped || null
    if (label === (current.attrs.label ?? null)) return
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, label }))
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  selectNode() {
    this.dom.classList.add("ProseMirror-selectednode")
  }

  deselectNode() {
    this.dom.classList.remove("ProseMirror-selectednode")
  }

  stopEvent(event: Event) {
    const target = event.target as globalThis.Node | null
    if (!target) return false
    if (this.contentDOM?.contains(target)) return false
    // The controls (buttons, the label field, the players) handle their own events.
    if ((target as Element).closest?.("button, input, video, audio")) return true
    if (this.addCaption?.contains(target)) return true
    return event.type === "mousedown" && this.body.contains(target)
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    if (mutation.type === "selection") return false
    return !this.contentDOM || !this.contentDOM.contains(mutation.target)
  }

  destroy() {
    this.lookup.destroy()
  }
}
