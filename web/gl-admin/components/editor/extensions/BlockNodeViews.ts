import { Extension, type Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView, type NodeView } from "@tiptap/pm/view"
import { CITE_MAX_LENGTH, capCite, isImageAlign } from "@gl-admin/lib/blocks-spec"

const blockNodeViewsKey = new PluginKey("blockNodeViews")

/**
 * The editor's views of the image (figure, width, caption) and quote (citation input)
 * nodes (#346). Editor only: the schema (ImageWithMediaId, QuoteCitation) has no DOM
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
          },
          // Marks the quote the cursor is in, so its empty citation field shows.
          decorations: (state) => {
            if (!editor.isEditable) return null
            const { $from } = state.selection
            for (let depth = $from.depth; depth > 0; depth--) {
              if ($from.node(depth).type.name === "blockquote") {
                const pos = $from.before(depth)
                return DecorationSet.create(state.doc, [
                  Decoration.node(pos, pos + $from.node(depth).nodeSize, { class: "has-selection" }),
                ])
              }
            }
            return null
          },
        },
      }),
    ]
  },
})

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

class QuoteView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private citeWrap: HTMLElement
  private input: HTMLInputElement

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("blockquote")
    this.contentDOM = document.createElement("div")
    this.citeWrap = document.createElement("div")
    this.citeWrap.className = "editor-quote__cite"
    this.citeWrap.contentEditable = "false"
    this.input = document.createElement("input")
    this.input.type = "text"
    // Two UTF-16 units per code point at most; capCite enforces the real cap.
    this.input.maxLength = CITE_MAX_LENGTH * 2
    this.input.placeholder = "Add a citation"
    this.input.setAttribute("aria-label", "Quote citation")
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
