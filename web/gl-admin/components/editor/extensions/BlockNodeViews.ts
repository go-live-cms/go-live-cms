import { Extension, type Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView, type NodeView } from "@tiptap/pm/view"
import {
  CALLOUT_TONE_ICONS,
  CALLOUT_TONE_LABELS,
  CALLOUT_TONES,
  CITE_MAX_LENGTH,
  capCite,
  normalizeCalloutTone,
  type CalloutTone,
  GROUP_ALIGNS,
  GROUP_STYLES,
  isGroupAlign,
  isGroupStyle,
  isImageAlign,
  MEDIA_BLOCK_ICONS,
  MEDIA_KIND_ACCEPT,
  normalizeGalleryColumns,
  type GroupAlign,
  type GroupStyle,
} from "@gl-admin/lib/blocks-spec"

import { TableView } from "@tiptap/extension-table"
import { hasHeaderRow } from "./TableBlock"
import { DETAILS_OPEN_HELP, DETAILS_OPEN_LABEL } from "./DetailsBlock"
import { button, MediaBlockView, MediaLookupTracker, mediaIcon, missingPanel } from "./MediaBlockViews"
import { EmbedBlockView } from "./EmbedBlockViews"
import { GALLERY_EMPTY_FRESH, GALLERY_EMPTY_TEXT, GALLERY_EMPTY_TITLE } from "./GalleryBlock"
import { chooseGalleryImages, chooseMediaFor, uploadGalleryImages } from "../blocks/mediaPicking"
import { deleteBlockTr, editorBlockAt, refOfBlock } from "../utils/blockTree"
import { moveGalleryImage, removeGalleryImage } from "../utils/galleryActions"
import { focalObjectPosition } from "@gl-admin/lib/mediaLibrary"
import { ButtonsView, ColumnsView, SpacerView } from "./LayoutBlockViews"
import { CoverMediaView } from "./CoverMediaViews"

const blockNodeViewsKey = new PluginKey("blockNodeViews")

/** The grid's narrowest column, in px (TipTap's `cellMinWidth`). */
const TABLE_CELL_MIN_WIDTH = 25

/**
 * TipTap's table view (the grid in a scrolling `tableWrapper`), plus `data-header-row` on
 * the <table>, so the editor styles the header row (#420: the grid's `headerRow` attr; the
 * cells are plain cells).
 */
class GridView extends TableView {
  constructor(node: PMNode, cellMinWidth: number) {
    super(node, cellMinWidth)
    this.mark()
  }

  update(node: PMNode) {
    if (!super.update(node)) return false
    this.mark()
    return true
  }

  private mark() {
    this.table.dataset.headerRow = String(hasHeaderRow(this.node))
  }
}

/**
 * The editor's views of the image (figure, width, caption), quote (citation input) and
 * group (width and background, #414) and details (Open by default, #421) nodes (#346). Editor only: the schema (ImageWithMediaId, QuoteCitation) has no DOM
 * code, so the collab server can build it. The views come from a plugin's `nodeViews`
 * prop, which ProseMirror merges with TipTap's own, so the schema extensions stay as
 * configured in `lib/collaboration/schema.ts`.
 *
 * No appendTransaction: the views only dispatch on the user's own input (rule 7).
 */
export const BlockNodeViews = Extension.create({
  name: "blockNodeViews",

  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: blockNodeViewsKey,
        props: {
          nodeViews: {
            image: (node, view, getPos) => new ImageView(node, view, getPos as () => number | undefined, editor),
            blockquote: (node, view, getPos) => new QuoteView(node, view, getPos as () => number | undefined),
            pullQuote: (node, view, getPos) => new QuoteView(node, view, getPos as () => number | undefined, "pullQuote"),
            group: (node, view, getPos) => new GroupView(node, view, getPos as () => number | undefined),
            details: (node, view, getPos) => new DetailsView(node, view, getPos as () => number | undefined),
            gallery: (node, view, getPos) => new GalleryView(node, view, getPos as () => number | undefined, editor),
            callout: (node, view, getPos) => new CalloutView(node, view, getPos as () => number | undefined),
            // #420: the table block (its toolbar) and the grid, which scrolls in its own box.
            tableBlock: (node, view, getPos) => new TableBlockView(node, view, getPos as () => number | undefined, editor),
            table: (node) => new GridView(node, TABLE_CELL_MIN_WIDTH),
            // #423: video, audio, file (MediaBlockViews.ts).
            video: (node, view, getPos) => new MediaBlockView(node, view, getPos as () => number | undefined, editor),
            audio: (node, view, getPos) => new MediaBlockView(node, view, getPos as () => number | undefined, editor),
            file: (node, view, getPos) => new MediaBlockView(node, view, getPos as () => number | undefined, editor),
            // #425 (EmbedBlockViews.ts): nothing from the provider loads until Load.
            embed: (node, view, getPos) => new EmbedBlockView(node, view, getPos as () => number | undefined, editor),
            // #426: columns, buttons and the spacer (LayoutBlockViews.ts).
            columns: (node, view, getPos) => new ColumnsView(node, view, getPos as () => number | undefined, editor),
            buttons: (node, view, getPos) => new ButtonsView(node, view, getPos as () => number | undefined, editor),
            spacer: (node, view, getPos) => new SpacerView(node, view, getPos as () => number | undefined, editor),
            // #427: cover and media & text (CoverMediaViews.ts).
            cover: (node, view, getPos) => new CoverMediaView(node, view, getPos as () => number | undefined, editor),
            mediaText: (node, view, getPos) => new CoverMediaView(node, view, getPos as () => number | undefined, editor),
          },
          // Marks the quote or pull quote the cursor is in, so its empty citation field
          // shows, and the group or callout it is in (or the selected group), so its
          // settings show.
          decorations: (state) => {
            if (!editor.isEditable) return null
            const { selection } = state
            const { $from } = selection
            const marked: Decoration[] = []
            const seen = new Set<string>()
            const mark = (pos: number, node: PMNode) => {
              if (seen.has(node.type.name)) return
              seen.add(node.type.name)
              marked.push(Decoration.node(pos, pos + node.nodeSize, { class: "has-selection" }))
            }
            if (selection instanceof NodeSelection && MARKED_WHEN_SELECTED.has(selection.node.type.name)) {
              mark(selection.from, selection.node)
            }
            for (let depth = $from.depth; depth > 0; depth--) {
              const name = $from.node(depth).type.name
              if (MARKED_WHILE_IN.has(name)) mark($from.before(depth), $from.node(depth))
            }
            return marked.length > 0 ? DecorationSet.create(state.doc, marked) : null
          },
        },
      }),
    ]
  },
})

/** The nodes whose view shows a field or settings while the cursor is in them. */
const MARKED_WHILE_IN = new Set(["blockquote", "pullQuote", "group", "callout", "tableBlock", "details", "gallery", "columns", "buttons", "cover", "mediaText"])
/** The nodes whose view shows its toolbar while it is selected. */
const MARKED_WHEN_SELECTED = new Set(["group", "tableBlock", "details", "gallery", "columns", "buttons", "cover", "mediaText"])

/** The `data-block-id` the node's renderHTML would put on it (BlockIdExtension). */
function setBlockId(dom: HTMLElement, node: PMNode) {
  const id = node.attrs["data-block-id"]
  if (typeof id === "string" && id) dom.setAttribute("data-block-id", id)
  else dom.removeAttribute("data-block-id")
}

/**
 * An image: the picture, its caption and "Add caption" (#346). Since #423 an image whose
 * media was deleted (the lookup's 404, `lib/mediaLookup.ts`) shows "The image file is
 * missing" with Replace instead of a broken picture; a lookup that failed any other way
 * leaves the image as it is (it still has its src). In a gallery (#424) it is a tile: no "Add
 * caption" (the panel's list has the field), and Move earlier, Move later and Remove while
 * it's selected.
 */
class ImageView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private img: HTMLImageElement
  private addCaption: HTMLButtonElement
  private missing: { dom: HTMLElement; replace: HTMLButtonElement } | null = null
  private lookup = new MediaLookupTracker(() => this.render())
  private tileTools: HTMLElement | null = null

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private editor: Editor,
  ) {
    this.dom = document.createElement("figure")
    this.dom.className = "editor-image__figure"
    this.img = document.createElement("img")
    this.img.className = "editor-image"
    this.img.draggable = false
    this.contentDOM = document.createElement("div")
    this.contentDOM.className = "editor-image__caption-slot"
    this.addCaption = document.createElement("button")
    this.addCaption.type = "button"
    this.addCaption.className = "editor-image__add-caption"
    this.addCaption.contentEditable = "false"
    this.addCaption.textContent = "Add caption"
    this.dom.append(this.img, this.contentDOM, this.addCaption)
    // A node view stays under one parent (a move makes a new one), so this is decided once.
    const at = this.getPos()
    if (at !== undefined && this.view.state.doc.resolve(at).parent.type.name === "gallery") {
      this.tileTools = this.buildTileTools()
      this.dom.append(this.tileTools)
    }

    // The image isn't a leaf any more (it holds its caption), so ProseMirror's click
    // would put a cursor next to it instead of selecting it: select it here.
    this.img.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      const pos = this.getPos()
      if (pos === undefined) return
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
      this.view.focus()
    })
    this.addCaption.addEventListener("mousedown", (event) => event.preventDefault())
    this.addCaption.addEventListener("click", () => {
      // `editable` can change without an update (a demotion, #313): a read-only
      // connection's edits are dropped by the server and would never sync.
      if (!this.view.editable) return
      const pos = this.getPos()
      if (pos === undefined) return
      this.editor.chain().focus().setNodeSelection(pos).toggleImageCaption().run()
    })
    this.render()
  }

  /** A gallery image's own controls (#424, the canvas's selected tile): each one transaction. */
  private buildTileTools(): HTMLElement {
    const tools = document.createElement("div")
    tools.className = "editor-gallery-image__tools"
    tools.contentEditable = "false"
    tools.setAttribute("role", "toolbar")
    tools.setAttribute("aria-label", "Image in gallery")
    // Tab from its drag handle lands here (#417, ui/DragHandle.tsx); Esc goes back.
    tools.setAttribute("data-block-toolbar", "")
    const act = (run: () => void) => () => {
      if (!this.view.editable) return
      run()
      this.view.focus()
    }
    const ref = () => {
      const pos = this.getPos()
      return pos === undefined ? null : refOfBlock({ node: this.node, pos })
    }
    const tool = (label: string, path: string, run: () => void) => {
      const el = button("", "editor-gallery-image__tool")
      el.setAttribute("aria-label", label)
      el.title = label
      el.append(mediaIcon(path, 14))
      el.addEventListener("click", act(run))
      tools.append(el)
    }
    const move = (dir: -1 | 1) => () => {
      const target = ref()
      if (target) moveGalleryImage(this.editor, target, dir)
    }
    tool("Move image earlier", "m15 18-6-6 6-6", move(-1))
    tool("Move image later", "m9 18 6-6-6-6", move(1))
    tool("Remove image from gallery", "M18 6 6 18M6 6l12 12", () => {
      const target = ref()
      if (target) removeGalleryImage(this.editor, target)
    })
    tools.addEventListener("keydown", (event) => {
      const buttons = Array.from(tools.querySelectorAll("button"))
      const index = buttons.indexOf(event.target as HTMLButtonElement)
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault()
        buttons[(index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length]?.focus()
      } else if (event.key === "Escape") {
        event.preventDefault()
        this.view.focus()
      }
    })
    return tools
  }

  private render() {
    const { src, alt, title, mediaId, align } = this.node.attrs
    if (src) this.img.setAttribute("src", src)
    else this.img.removeAttribute("src")
    this.img.alt = alt ?? ""
    if (title) this.img.title = title
    else this.img.removeAttribute("title")
    if (mediaId) this.img.dataset.mediaId = String(mediaId)
    else delete this.img.dataset.mediaId
    this.dom.dataset.align = isImageAlign(align) ? align : "inline"
    setBlockId(this.dom, this.node)
    this.addCaption.hidden = this.node.childCount > 0 || !this.view.editable || this.tileTools !== null
    this.renderMissing()
    // A tile is cropped square, so it needs the media's focal point (#255), as the page does.
    if (this.tileTools) {
      const found = this.lookup.state?.status === "found" ? this.lookup.state.media : null
      this.img.style.objectPosition = found?.focal_point ? focalObjectPosition(found.focal_point) : ""
    }
  }

  private renderMissing() {
    this.lookup.track(this.node.attrs.mediaId)
    const isMissing = this.lookup.state?.status === "missing"
    this.dom.classList.toggle("is-missing", isMissing)
    this.img.hidden = isMissing
    if (!isMissing) {
      this.missing?.dom.remove()
      this.missing = null
      return
    }
    if (!this.missing) {
      const name = typeof this.node.attrs.title === "string" && this.node.attrs.title.trim() ? this.node.attrs.title.trim() : "This image"
      this.missing = missingPanel("image", "missing", `${name} is no longer in Media. Its caption is kept for the replacement.`, () => {
        const pos = this.getPos()
        if (pos !== undefined && this.view.editable) chooseMediaFor(this.editor, pos)
      })
      this.dom.insertBefore(this.missing.dom, this.contentDOM)
    }
    this.missing.replace.hidden = !this.view.editable
  }

  destroy() {
    this.lookup.destroy()
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target as globalThis.Node | null
    if (target && (this.addCaption.contains(target) || this.missing?.dom.contains(target) || this.tileTools?.contains(target))) return true
    return event.type === "mousedown" && target === this.img
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    if (mutation.type === "selection") return false
    return !this.contentDOM.contains(mutation.target)
  }
}

/**
 * A quote (#346) or a pull quote (#419): its text, then the citation field. The two have
 * the same `cite` rules (`normalizeCite`), so they share the view; a pull quote is a
 * textblock, so its text goes straight into its `<blockquote>`.
 */
class QuoteView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private citeWrap: HTMLElement
  private input: HTMLInputElement

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    kind: "quote" | "pullQuote" = "quote",
  ) {
    if (kind === "pullQuote") {
      this.dom = document.createElement("figure")
      this.dom.className = "editor-pullquote"
      this.dom.dataset.type = "pull-quote"
      this.contentDOM = document.createElement("blockquote")
      this.contentDOM.className = "editor-pullquote__text"
    } else {
      this.dom = document.createElement("blockquote")
      this.contentDOM = document.createElement("div")
    }
    this.citeWrap = document.createElement("div")
    this.citeWrap.className = "editor-quote__cite"
    this.citeWrap.contentEditable = "false"
    this.input = document.createElement("input")
    this.input.type = "text"
    // Two UTF-16 units per code point at most; capCite enforces the real cap.
    this.input.maxLength = CITE_MAX_LENGTH * 2
    this.input.placeholder = kind === "pullQuote" ? "Citation (optional)" : "Add a citation"
    this.input.setAttribute("aria-label", kind === "pullQuote" ? "Pull quote citation" : "Quote citation")
    this.citeWrap.append(this.input)
    this.dom.append(this.contentDOM, this.citeWrap)

    // Stored as typed (trimmed when converted to Block Spec): trimming here would eat
    // the space between two words as it's typed.
    // `editable` can change without an update (a demotion to read-only, #313).
    this.input.addEventListener("focus", () => (this.input.readOnly = !this.view.editable))
    this.input.addEventListener("input", () => {
      if (!this.view.editable) return
      const pos = this.getPos()
      const current = pos === undefined ? null : this.view.state.doc.nodeAt(pos)
      if (pos === undefined || !current) return
      // The cap counts code points; the field's maxLength (UTF-16 units) is only a backstop.
      const capped = capCite(this.input.value)
      if (capped !== this.input.value) this.input.value = capped
      const cite = capped || null
      if (cite === (current.attrs.cite ?? null)) return
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, cite }))
    })
    // Enter (or Escape) goes back to the end of the quote.
    this.input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== "Escape") return
      event.preventDefault()
      const pos = this.getPos()
      if (pos === undefined) return
      const end = pos + this.node.nodeSize - 1
      const tr = this.view.state.tr.setSelection(TextSelection.near(this.view.state.doc.resolve(end), -1))
      this.view.dispatch(tr)
      this.view.focus()
    })
    this.render()
  }

  private render() {
    const cite = typeof this.node.attrs.cite === "string" ? this.node.attrs.cite : ""
    if (this.input.value !== cite) {
      // A peer's edit while this user is in the field: keep their caret where it was.
      const focused = this.input.ownerDocument.activeElement === this.input
      const start = this.input.selectionStart
      const end = this.input.selectionEnd
      this.input.value = cite
      if (focused && start !== null && end !== null) this.input.setSelectionRange(start, end)
    }
    this.input.readOnly = !this.view.editable
    setBlockId(this.dom, this.node)
    this.citeWrap.classList.toggle("is-empty", cite === "")
    this.citeWrap.hidden = cite === "" && !this.view.editable
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target as globalThis.Node | null
    return Boolean(target && this.citeWrap.contains(target))
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    if (mutation.type === "selection") return false
    return !this.contentDOM.contains(mutation.target)
  }
}

const GROUP_WIDTH_LABELS: Record<GroupAlign, string> = { content: "Content", wide: "Wide", full: "Full" }
const GROUP_STYLE_LABELS: Record<GroupStyle, string> = { none: "None", tinted: "Tinted" }

/**
 * A group (#414): its blocks, plus its settings while the cursor is in it (or it is
 * selected): Width (Content, Wide, Full) and Background (None, Tinted), as on the
 * canvas's "Editor · columns, group" board. Each button is one `setNodeMarkup`, so one
 * Yjs update; last writer wins, like any node attribute.
 */
class GroupView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private settings: HTMLElement
  private buttons = new Map<string, HTMLButtonElement>()

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("div")
    this.dom.className = "editor-group"
    this.dom.dataset.type = "group"
    // Remote carets' name labels flip at this edge (#417, utils/cursorAwareness.ts).
    this.dom.setAttribute("data-collab-bounds", "")
    this.settings = document.createElement("div")
    this.settings.className = "editor-group__settings"
    this.settings.contentEditable = "false"
    // The group's toolbar (#417): Tab from its drag handle lands here (ui/DragHandle.tsx),
    // ← → move between its buttons, Esc goes back to the group in the text.
    this.settings.setAttribute("role", "toolbar")
    this.settings.setAttribute("aria-label", "Group")
    this.settings.setAttribute("data-block-toolbar", "")
    this.settings.addEventListener("keydown", (event) => this.onToolbarKey(event))
    this.settings.append(
      this.segment("Width", "align", GROUP_ALIGNS, GROUP_WIDTH_LABELS),
      this.segment("Background", "style", GROUP_STYLES, GROUP_STYLE_LABELS),
    )
    this.contentDOM = document.createElement("div")
    this.contentDOM.className = "editor-group__content"
    this.dom.append(this.settings, this.contentDOM)
    this.render()
  }

  private segment<T extends string>(label: string, attr: "align" | "style", values: readonly T[], labels: Record<T, string>) {
    const field = document.createElement("div")
    field.className = "editor-group__field"
    field.setAttribute("role", "group")
    field.setAttribute("aria-label", `Group ${label.toLowerCase()}`)
    const name = document.createElement("span")
    name.className = "editor-group__label"
    name.textContent = label
    name.setAttribute("aria-hidden", "true")
    field.append(name)
    for (const value of values) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "editor-group__option"
      button.textContent = labels[value]
      button.dataset.attr = attr
      button.dataset.value = value
      // Keep the cursor where it is.
      button.addEventListener("mousedown", (event) => event.preventDefault())
      button.addEventListener("click", () => this.set(attr, value))
      this.buttons.set(`${attr}:${value}`, button)
      field.append(button)
    }
    return field
  }

  private onToolbarKey(event: KeyboardEvent) {
    const buttons = Array.from(this.settings.querySelectorAll<HTMLButtonElement>("button"))
    const at = buttons.indexOf(event.target as HTMLButtonElement)
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault()
      const next = (at + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length
      buttons[next]?.focus()
    } else if (event.key === "Escape") {
      event.preventDefault()
      const pos = this.getPos()
      if (pos !== undefined && this.view.state.doc.nodeAt(pos)?.type.name === "group") {
        this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
      }
      this.view.focus()
    }
  }

  private set(attr: "align" | "style", value: string) {
    // `editable` can change without an update (a demotion, #313).
    if (!this.view.editable) return
    const pos = this.getPos()
    const current = pos === undefined ? null : this.view.state.doc.nodeAt(pos)
    if (pos === undefined || !current || current.type.name !== "group" || current.attrs[attr] === value) return
    const { state } = this.view
    const tr = state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, [attr]: value })
    // A selected group stays selected (#417: Tab from its handle selects it, then its toolbar).
    if (state.selection instanceof NodeSelection && state.selection.from === pos) tr.setSelection(NodeSelection.create(tr.doc, pos))
    this.view.dispatch(tr)
  }

  private render() {
    const style = isGroupStyle(this.node.attrs.style) ? this.node.attrs.style : "none"
    const align = isGroupAlign(this.node.attrs.align) ? this.node.attrs.align : "content"
    this.dom.dataset.style = style
    this.dom.dataset.align = align
    setBlockId(this.dom, this.node)
    for (const [key, button] of this.buttons) {
      const [attr, value] = key.split(":")
      button.setAttribute("aria-pressed", String((attr === "align" ? align : style) === value))
    }
    // Not hidden or disabled here: `editable` changes without an update (a demotion or a
    // promotion, #313). The editor's `[contenteditable="false"]` style hides the settings,
    // and `set` checks `editable` when a button is used.
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target as globalThis.Node | null
    return Boolean(target && this.settings.contains(target))
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    if (mutation.type === "selection") return false
    return !this.contentDOM.contains(mutation.target)
  }
}

/**
 * A details (#421): a chevron, its summary and its blocks (the editor always shows them,
 * open or not), plus its toolbar while the cursor is in it (or it is selected): the
 * **Open by default** switch. The switch is one `setNodeMarkup`, so one Yjs update; last
 * writer wins, like any node attribute.
 */
class DetailsView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private toolbar: HTMLElement
  private openSwitch: HTMLButtonElement

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    const doc = view.dom.ownerDocument
    this.dom = doc.createElement("div")
    this.dom.className = "editor-details"
    this.dom.dataset.type = "details"
    // Remote carets' name labels flip at this edge (#417, utils/cursorAwareness.ts).
    this.dom.setAttribute("data-collab-bounds", "")
    const chevron = doc.createElement("span")
    chevron.className = "editor-details__chevron"
    chevron.contentEditable = "false"
    chevron.setAttribute("aria-hidden", "true")
    const svg = doc.createElementNS(SVG_NS, "svg")
    for (const [name, value] of Object.entries({ width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" })) {
      svg.setAttribute(name, value)
    }
    const path = doc.createElementNS(SVG_NS, "path")
    path.setAttribute("d", CHEVRON)
    svg.append(path)
    chevron.append(svg)
    this.toolbar = doc.createElement("div")
    this.toolbar.className = "editor-details__toolbar"
    this.toolbar.contentEditable = "false"
    // Tab from its drag handle lands here (#417, ui/DragHandle.tsx); Esc goes back.
    this.toolbar.setAttribute("role", "toolbar")
    this.toolbar.setAttribute("aria-label", "Details")
    this.toolbar.setAttribute("data-block-toolbar", "")
    this.openSwitch = doc.createElement("button")
    this.openSwitch.type = "button"
    this.openSwitch.className = "editor-details__switch"
    this.openSwitch.setAttribute("role", "switch")
    this.openSwitch.textContent = DETAILS_OPEN_LABEL
    this.openSwitch.title = DETAILS_OPEN_HELP
    // Keep the cursor where it is.
    this.openSwitch.addEventListener("mousedown", (event) => event.preventDefault())
    this.openSwitch.addEventListener("click", () => this.toggleOpen())
    this.toolbar.append(this.openSwitch)
    this.toolbar.addEventListener("keydown", (event) => this.onToolbarKey(event))
    this.contentDOM = doc.createElement("div")
    this.contentDOM.className = "editor-details__content"
    // The chevron sits beside the summary, the first line of the content, whether the
    // toolbar above shows or not.
    const body = doc.createElement("div")
    body.className = "editor-details__body"
    body.append(chevron, this.contentDOM)
    this.dom.append(this.toolbar, body)
    this.render()
  }

  private onToolbarKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return
    event.preventDefault()
    const pos = this.getPos()
    if (pos !== undefined && this.view.state.doc.nodeAt(pos)?.type.name === "details") {
      this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
    }
    this.view.focus()
  }

  private toggleOpen() {
    // `editable` can change without an update (a demotion, #313).
    if (!this.view.editable) return
    const pos = this.getPos()
    const current = pos === undefined ? null : this.view.state.doc.nodeAt(pos)
    if (pos === undefined || !current || current.type.name !== "details") return
    const { state } = this.view
    const tr = state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, open: current.attrs.open !== true })
    // A selected details stays selected (#417: Tab from its handle selects it, then its toolbar).
    if (state.selection instanceof NodeSelection && state.selection.from === pos) tr.setSelection(NodeSelection.create(tr.doc, pos))
    this.view.dispatch(tr)
  }

  private render() {
    const open = this.node.attrs.open === true
    this.dom.dataset.open = String(open)
    setBlockId(this.dom, this.node)
    this.openSwitch.setAttribute("aria-checked", String(open))
    // Like Group's: not hidden here (`editable` changes without an update, #313); the
    // editor's `[contenteditable="false"]` style hides the toolbar, and the click checks.
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target as globalThis.Node | null
    return Boolean(target && this.toolbar.contains(target))
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    if (mutation.type === "selection") return false
    return !this.contentDOM.contains(mutation.target)
  }
}

const GALLERY_ICON = MEDIA_BLOCK_ICONS.gallery
const PLUS_ICON = "M12 5v14M5 12h14"

/**
 * A gallery (#424): its image tiles in a grid of `columns`, its caption under them, "Add
 * images" while the cursor is in it (or it is selected), and with no images the empty state.
 * A gallery nobody has added to yet offers Upload and Choose from Media ("Editor · image,
 * gallery…"); one that had images, or has a caption, says it has none, with Add images and
 * Remove block ("Errors & empty states"). Adding is one transaction (`addGalleryImages`).
 */
class GalleryView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private toolbar: HTMLElement
  private empty: HTMLElement
  private status: HTMLElement
  private fileInput: HTMLInputElement
  private hadImages = false
  private emptyState: "none" | "fresh" | "emptied" | null = null

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private editor: Editor,
  ) {
    const doc = view.dom.ownerDocument
    this.dom = doc.createElement("div")
    this.dom.className = "editor-gallery"
    this.dom.dataset.type = "gallery"
    // Remote carets' name labels flip at this edge (#417, utils/cursorAwareness.ts).
    this.dom.setAttribute("data-collab-bounds", "")
    this.toolbar = doc.createElement("div")
    this.toolbar.className = "editor-gallery__toolbar"
    this.toolbar.contentEditable = "false"
    this.toolbar.setAttribute("role", "toolbar")
    this.toolbar.setAttribute("aria-label", "Gallery")
    // Tab from its drag handle lands here (#417, ui/DragHandle.tsx); Esc goes back.
    this.toolbar.setAttribute("data-block-toolbar", "")
    const add = button("", "editor-gallery__add")
    add.append(mediaIcon(PLUS_ICON, 14), doc.createTextNode("Add images"))
    add.addEventListener("click", () => this.choose())
    this.toolbar.append(add)
    this.toolbar.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      const pos = this.getPos()
      if (pos !== undefined && this.view.state.doc.nodeAt(pos)?.type.name === "gallery") {
        this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
      }
      this.view.focus()
    })
    this.empty = doc.createElement("div")
    this.empty.className = "editor-gallery__empty"
    this.empty.contentEditable = "false"
    this.status = doc.createElement("p")
    this.status.className = "editor-media__status"
    this.status.setAttribute("role", "status")
    this.status.contentEditable = "false"
    this.fileInput = doc.createElement("input")
    this.fileInput.type = "file"
    this.fileInput.multiple = true
    this.fileInput.hidden = true
    this.fileInput.accept = MEDIA_KIND_ACCEPT.image
    this.fileInput.setAttribute("aria-label", "Upload images")
    this.fileInput.addEventListener("change", () => {
      const files = Array.from(this.fileInput.files ?? [])
      this.fileInput.value = ""
      if (files.length > 0) void this.upload(files)
    })
    this.contentDOM = doc.createElement("div")
    this.contentDOM.className = "editor-gallery__grid"
    this.dom.append(this.toolbar, this.empty, this.status, this.fileInput, this.contentDOM)
    this.render()
  }

  private choose() {
    if (!this.view.editable) return
    const pos = this.getPos()
    if (pos !== undefined) chooseGalleryImages(this.editor, pos)
  }

  private async upload(files: File[]) {
    const pos = this.getPos()
    if (pos === undefined || !this.view.editable) return
    this.status.textContent = files.length === 1 ? `Uploading ${files[0].name}…` : `Uploading ${files.length} images…`
    try {
      await uploadGalleryImages(this.editor, pos, files)
      this.status.textContent = ""
    } catch (error) {
      this.status.textContent = `Upload failed: ${error instanceof Error ? error.message : "the file couldn't be uploaded"}`
    }
  }

  private removeBlock() {
    if (!this.view.editable) return
    const pos = this.getPos()
    const block = pos === undefined ? null : editorBlockAt(this.view.state.doc, pos)
    const tr = block ? deleteBlockTr(this.view.state, block) : null
    if (tr) this.view.dispatch(tr)
  }

  private renderEmpty() {
    const images = this.node.childCount - 1
    if (images > 0) this.hadImages = true
    const state = images > 0 ? "none" : this.hadImages || (this.node.lastChild?.content.size ?? 0) > 0 ? "emptied" : "fresh"
    if (state === this.emptyState) return
    this.emptyState = state
    this.empty.replaceChildren()
    this.empty.hidden = state === "none"
    this.empty.dataset.state = state
    if (state === "none") return
    const doc = this.dom.ownerDocument
    const actions = doc.createElement("div")
    actions.className = "editor-media__actions"
    if (state === "fresh") {
      const head = doc.createElement("div")
      head.className = "editor-media__drop-head"
      head.append(mediaIcon(GALLERY_ICON, 16), "Gallery")
      const text = doc.createElement("p")
      text.textContent = GALLERY_EMPTY_FRESH
      const upload = button("Upload")
      upload.addEventListener("click", () => this.view.editable && this.fileInput.click())
      const choose = button("Choose from Media")
      choose.addEventListener("click", () => this.choose())
      actions.append(upload, choose)
      this.empty.append(head, text, actions)
      return
    }
    const icon = mediaIcon(GALLERY_ICON, 28)
    const title = doc.createElement("b")
    title.className = "editor-gallery__empty-title"
    title.textContent = GALLERY_EMPTY_TITLE
    const text = doc.createElement("p")
    text.textContent = GALLERY_EMPTY_TEXT
    const add = button("Add images", "editor-media__button editor-media__button--primary")
    add.addEventListener("click", () => this.choose())
    const remove = button("Remove block", "editor-media__button editor-media__button--danger")
    remove.addEventListener("click", () => this.removeBlock())
    actions.append(add, remove)
    this.empty.append(icon, title, text, actions)
  }

  private render() {
    setBlockId(this.dom, this.node)
    this.contentDOM.style.setProperty("--gallery-columns", String(normalizeGalleryColumns(this.node.attrs.columns)))
    this.renderEmpty()
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target as globalThis.Node | null
    return Boolean(target && (this.toolbar.contains(target) || this.empty.contains(target) || this.fileInput === target))
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    if (mutation.type === "selection") return false
    return !this.contentDOM.contains(mutation.target)
  }
}

const SVG_NS = "http://www.w3.org/2000/svg"

/** The tone's icon, decorative (`aria-hidden`): the tone is said in words beside it. */
export function calloutIcon(tone: CalloutTone, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.setAttribute("width", String(size))
  svg.setAttribute("height", String(size))
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("fill", "none")
  svg.setAttribute("stroke", "currentColor")
  svg.setAttribute("stroke-width", "1.75")
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")
  svg.setAttribute("aria-hidden", "true")
  const path = document.createElementNS(SVG_NS, "path")
  path.setAttribute("d", CALLOUT_TONE_ICONS[tone])
  svg.append(path)
  return svg
}

/**
 * A callout (#419): the tone's icon, its paragraphs, and while the cursor is in it, its
 * Type setting (Info, Success, Warning, Danger), as on the blocks canvas's "Callout" row.
 * The settings are the block's own, like Group's (the post sidebar has no Block tab); the
 * block toolbar has the same choice (`BlockTypeToolbar`). Each button is one
 * `setNodeMarkup`, so one Yjs update; last writer wins, like any node attribute.
 */
class CalloutView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private icon: HTMLElement
  private settings: HTMLElement
  private buttons = new Map<CalloutTone, HTMLButtonElement>()
  private tone: CalloutTone | null = null

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("div")
    this.dom.className = "editor-callout"
    this.dom.dataset.type = "callout"
    this.icon = document.createElement("span")
    this.icon.className = "editor-callout__icon"
    this.icon.contentEditable = "false"
    this.settings = document.createElement("div")
    this.settings.className = "editor-callout__settings"
    this.settings.contentEditable = "false"
    this.settings.setAttribute("role", "group")
    this.settings.setAttribute("aria-label", "Callout type")
    const label = document.createElement("span")
    label.className = "editor-callout__label"
    label.textContent = "Type"
    label.setAttribute("aria-hidden", "true")
    this.settings.append(label)
    for (const tone of CALLOUT_TONES) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "editor-callout__option"
      button.dataset.tone = tone
      button.append(calloutIcon(tone, 14), document.createTextNode(CALLOUT_TONE_LABELS[tone]))
      // Keep the cursor where it is.
      button.addEventListener("mousedown", (event) => event.preventDefault())
      button.addEventListener("click", () => this.set(tone))
      this.buttons.set(tone, button)
      this.settings.append(button)
    }
    this.contentDOM = document.createElement("div")
    this.contentDOM.className = "editor-callout__content"
    this.dom.append(this.icon, this.contentDOM, this.settings)
    this.render()
  }

  private set(tone: CalloutTone) {
    // `editable` can change without an update (a demotion, #313).
    if (!this.view.editable) return
    const pos = this.getPos()
    const current = pos === undefined ? null : this.view.state.doc.nodeAt(pos)
    if (pos === undefined || !current || current.type.name !== "callout" || current.attrs.tone === tone) return
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, tone }))
  }

  private render() {
    const tone = normalizeCalloutTone(this.node.attrs.tone)
    this.dom.dataset.tone = tone
    setBlockId(this.dom, this.node)
    if (tone !== this.tone) {
      this.icon.replaceChildren(calloutIcon(tone))
      this.tone = tone
    }
    for (const [value, button] of this.buttons) button.setAttribute("aria-pressed", String(value === tone))
    // Like Group's: not hidden here (`editable` changes without an update, #313); the
    // editor's `[contenteditable="false"]` style hides the settings, and `set` checks.
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target as globalThis.Node | null
    return Boolean(target && this.settings.contains(target))
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    if (mutation.type === "selection") return false
    return !this.contentDOM.contains(mutation.target)
  }
}

type TableAction = { label: string; run: (editor: Editor) => boolean; can: (editor: Editor) => boolean; danger?: boolean }

/** The Row and Column menus (#420, the canvas's table toolbar), each one command, so one Yjs update. */
const TABLE_MENUS: { label: string; items: (TableAction | "separator")[] }[] = [
  {
    label: "Row",
    items: [
      { label: "Insert row above", run: (e) => e.chain().focus().addTableRow("before").run(), can: (e) => e.can().addTableRow("before") },
      { label: "Insert row below", run: (e) => e.chain().focus().addTableRow("after").run(), can: (e) => e.can().addTableRow("after") },
      "separator",
      { label: "Delete row", danger: true, run: (e) => e.chain().focus().deleteTableRow().run(), can: (e) => e.can().deleteTableRow() },
    ],
  },
  {
    label: "Column",
    items: [
      { label: "Insert column left", run: (e) => e.chain().focus().addTableColumn("before").run(), can: (e) => e.can().addTableColumn("before") },
      { label: "Insert column right", run: (e) => e.chain().focus().addTableColumn("after").run(), can: (e) => e.can().addTableColumn("after") },
      "separator",
      { label: "Delete column", danger: true, run: (e) => e.chain().focus().deleteTableColumn().run(), can: (e) => e.can().deleteTableColumn() },
    ],
  },
]

const CHEVRON = "m6 9 6 6 6-6"

/**
 * A table block (#420): the grid and its caption, plus a toolbar while the cursor is in
 * it (or it is selected), as on the canvas: **Row ▾** (insert above / below, delete),
 * **Column ▾** (insert left / right, delete) and the **Header row** switch. The menus act
 * on the cell the caret is in (their items are disabled in the caption, and Delete when
 * it's the last row or column). ⌥F10 in a cell focuses the toolbar (`TableKeyboard`):
 * ← → move between its buttons, Esc goes back to the text.
 */
class TableBlockView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private toolbar: HTMLElement
  private headerSwitch: HTMLButtonElement
  private menu: { button: HTMLButtonElement; list: HTMLElement } | null = null

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private editor: Editor,
  ) {
    const doc = view.dom.ownerDocument
    this.dom = doc.createElement("figure")
    this.dom.className = "editor-table"
    this.dom.dataset.type = "table"
    this.toolbar = doc.createElement("div")
    this.toolbar.className = "editor-table__toolbar"
    this.toolbar.contentEditable = "false"
    this.toolbar.setAttribute("role", "toolbar")
    this.toolbar.setAttribute("aria-label", "Table")
    // The gutter's Tab reaches it from a selected table (#417, DragHandle's blockToolbarControl).
    this.toolbar.setAttribute("data-block-toolbar", "")
    for (const menu of TABLE_MENUS) this.toolbar.append(this.menuButton(menu))
    const separator = doc.createElement("span")
    separator.className = "editor-table__separator"
    separator.setAttribute("aria-hidden", "true")
    this.headerSwitch = doc.createElement("button")
    this.headerSwitch.type = "button"
    this.headerSwitch.className = "editor-table__switch"
    this.headerSwitch.setAttribute("role", "switch")
    this.headerSwitch.textContent = "Header row"
    this.headerSwitch.title = "Header cells name each column for screen readers"
    this.headerSwitch.addEventListener("mousedown", (event) => event.preventDefault())
    this.headerSwitch.addEventListener("click", () => this.toggleHeaderRow())
    this.toolbar.append(separator, this.headerSwitch)
    this.toolbar.addEventListener("keydown", (event) => this.onToolbarKey(event))
    this.contentDOM = doc.createElement("div")
    this.contentDOM.className = "editor-table__content"
    this.dom.append(this.toolbar, this.contentDOM)
    this.render()
  }

  private menuButton(menu: (typeof TABLE_MENUS)[number]) {
    const doc = this.dom.ownerDocument
    const button = doc.createElement("button")
    button.type = "button"
    button.className = "editor-table__button"
    button.setAttribute("aria-haspopup", "menu")
    button.setAttribute("aria-expanded", "false")
    button.append(doc.createTextNode(menu.label))
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("width", "12")
    svg.setAttribute("height", "12")
    svg.setAttribute("viewBox", "0 0 24 24")
    svg.setAttribute("fill", "none")
    svg.setAttribute("stroke", "currentColor")
    svg.setAttribute("stroke-width", "2")
    svg.setAttribute("aria-hidden", "true")
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", CHEVRON)
    svg.append(path)
    button.append(svg)
    // Keep the caret in its cell: the menu acts on it.
    button.addEventListener("mousedown", (event) => event.preventDefault())
    button.addEventListener("click", () => (this.menu?.button === button ? this.closeMenu(true) : this.openMenu(button, menu)))
    return button
  }

  private openMenu(button: HTMLButtonElement, menu: (typeof TABLE_MENUS)[number], focusFirst = false) {
    this.closeMenu(false)
    const doc = this.dom.ownerDocument
    const list = doc.createElement("div")
    list.className = "editor-table__menu"
    list.setAttribute("role", "menu")
    list.setAttribute("aria-label", menu.label)
    for (const item of menu.items) {
      if (item === "separator") {
        const hr = doc.createElement("div")
        hr.className = "editor-table__menu-separator"
        hr.setAttribute("role", "separator")
        list.append(hr)
        continue
      }
      const option = doc.createElement("button")
      option.type = "button"
      option.className = item.danger ? "editor-table__menu-item is-danger" : "editor-table__menu-item"
      option.setAttribute("role", "menuitem")
      option.textContent = item.label
      // `editable` can change without an update (a demotion, #313).
      const enabled = this.view.editable && item.can(this.editor)
      option.disabled = !enabled
      option.setAttribute("aria-disabled", String(!enabled))
      option.addEventListener("mousedown", (event) => event.preventDefault())
      option.addEventListener("click", () => {
        this.closeMenu(false)
        if (this.view.editable) item.run(this.editor)
      })
      list.append(option)
    }
    list.addEventListener("keydown", (event) => this.onMenuKey(event))
    button.setAttribute("aria-expanded", "true")
    // Under its own button (the toolbar is the positioned box).
    list.style.left = `${button.offsetLeft}px`
    button.after(list)
    this.menu = { button, list }
    // A click anywhere else closes it (the caret leaving the table hides the toolbar).
    doc.addEventListener("mousedown", this.onOutsideDown, true)
    if (focusFirst) list.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
  }

  private closeMenu(refocusButton: boolean) {
    if (!this.menu) return
    const { button, list } = this.menu
    this.menu = null
    this.dom.ownerDocument.removeEventListener("mousedown", this.onOutsideDown, true)
    list.remove()
    button.setAttribute("aria-expanded", "false")
    if (refocusButton) button.focus()
  }

  private onOutsideDown = (event: MouseEvent) => {
    const target = event.target as globalThis.Node | null
    if (this.menu && target && !this.menu.list.contains(target) && !this.menu.button.contains(target)) this.closeMenu(false)
  }

  private onMenuKey(event: KeyboardEvent) {
    if (!this.menu) return
    const items = Array.from(this.menu.list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"))
    const at = items.indexOf(this.dom.ownerDocument.activeElement as HTMLButtonElement)
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : items.length - 1
      items[(at + step + items.length) % items.length]?.focus()
    } else if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      this.closeMenu(true)
    }
  }

  private onToolbarKey(event: KeyboardEvent) {
    if (this.menu?.list.contains(event.target as globalThis.Node)) return
    const buttons = Array.from(this.toolbar.querySelectorAll<HTMLButtonElement>(":scope > button"))
    const at = buttons.indexOf(this.dom.ownerDocument.activeElement as HTMLButtonElement)
    if (at === -1) return
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault()
      buttons[(at + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length].focus()
    } else if (event.key === "ArrowDown" && buttons[at].getAttribute("aria-haspopup") === "menu") {
      event.preventDefault()
      const menu = TABLE_MENUS.find((m) => buttons[at].textContent === m.label)
      if (menu) this.openMenu(buttons[at], menu, true)
    } else if (event.key === "Escape") {
      event.preventDefault()
      this.closeMenu(false)
      this.view.focus()
    }
  }

  private toggleHeaderRow() {
    if (!this.view.editable) return
    const pos = this.getPos()
    const current = pos === undefined ? null : this.view.state.doc.nodeAt(pos)
    const table = current?.firstChild
    if (pos === undefined || !current || current.type.name !== "tableBlock" || table?.type.name !== "table") return
    // One attribute (last writer wins), never the cells.
    this.view.dispatch(this.view.state.tr.setNodeAttribute(pos + 1, "headerRow", !hasHeaderRow(table)))
  }

  private render() {
    const table = this.node.firstChild
    this.headerSwitch.setAttribute("aria-checked", String(table?.type.name === "table" && hasHeaderRow(table)))
    setBlockId(this.dom, this.node)
    // Not hidden or disabled here: `editable` changes without an update (#313). The
    // editor's `[contenteditable="false"]` style hides the toolbar of a read-only view.
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target as globalThis.Node | null
    return Boolean(target && this.toolbar.contains(target))
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }) {
    if (mutation.type === "selection") return false
    return !this.contentDOM.contains(mutation.target)
  }

  destroy() {
    this.closeMenu(false)
  }
}
