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
  type GroupAlign,
  type GroupStyle,
} from "@gl-admin/lib/blocks-spec"

const blockNodeViewsKey = new PluginKey("blockNodeViews")

/**
 * The editor's views of the image (figure, width, caption), quote (citation input) and
 * group (width and background, #414) nodes (#346). Editor only: the schema (ImageWithMediaId, QuoteCitation) has no DOM
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
            callout: (node, view, getPos) => new CalloutView(node, view, getPos as () => number | undefined),
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
            if (selection instanceof NodeSelection && selection.node.type.name === "group") mark(selection.from, selection.node)
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
const MARKED_WHILE_IN = new Set(["blockquote", "pullQuote", "group", "callout"])

/** The `data-block-id` the node's renderHTML would put on it (BlockIdExtension). */
function setBlockId(dom: HTMLElement, node: PMNode) {
  const id = node.attrs["data-block-id"]
  if (typeof id === "string" && id) dom.setAttribute("data-block-id", id)
  else dom.removeAttribute("data-block-id")
}

class ImageView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private img: HTMLImageElement
  private addCaption: HTMLButtonElement

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
    this.addCaption.hidden = this.node.childCount > 0 || !this.view.editable
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target as globalThis.Node | null
    if (target && this.addCaption.contains(target)) return true
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
    this.settings = document.createElement("div")
    this.settings.className = "editor-group__settings"
    this.settings.contentEditable = "false"
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

  private set(attr: "align" | "style", value: string) {
    // `editable` can change without an update (a demotion, #313).
    if (!this.view.editable) return
    const pos = this.getPos()
    const current = pos === undefined ? null : this.view.state.doc.nodeAt(pos)
    if (pos === undefined || !current || current.type.name !== "group" || current.attrs[attr] === value) return
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, [attr]: value }))
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
