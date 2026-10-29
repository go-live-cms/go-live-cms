import Image from "@tiptap/extension-image"
import { mergeAttributes, Node } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, TextSelection, type EditorState } from "@tiptap/pm/state"
import { CAPTION_MARKS, isImageAlign, type ImageAlign } from "@gl-admin/lib/blocks-spec"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    imageWithMediaId: {
      /** Set the selected image's width (#346). */
      setImageAlign: (align: ImageAlign) => ReturnType
      /** Add an empty caption to the selected image and put the cursor in it, or remove its caption. */
      toggleImageCaption: () => ReturnType
    }
  }
}

/** An <img>'s `data-media-id` as the number the media sync needs, else null. */
function mediaIdFromHTML(img: Element): number | null {
  const value = img.getAttribute("data-media-id")
  return value && /^\d+$/.test(value) ? Number(value) : null
}

/**
 * The image the selection is on (a NodeSelection) or in (the cursor in its caption).
 */
export function findSelectedImage(state: EditorState): { pos: number; node: PMNode } | null {
  const { selection } = state
  if (selection instanceof NodeSelection && selection.node.type.name === "image") {
    return { pos: selection.from, node: selection.node }
  }
  const { $from } = selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === "image") return { pos: $from.before(depth), node }
  }
  return null
}

/**
 * An image's caption (#346): the image node's only, optional child. Its own node, not
 * an attribute, so two people typing in one caption merge like any other text (Yjs),
 * and not the image's own inline content, which would make the image a textblock that
 * "turn into" and the slash menu could replace. Plain text runs with bold, italic and
 * link marks only (`CAPTION_MARKS`); Block Spec stores the runs as the image block's
 * `attrs.caption` (blockBridge.ts).
 */
export const ImageCaption = Node.create({
  name: "imageCaption",
  content: "text*",
  marks: CAPTION_MARKS.join(" "),
  // No group: it can only be the image's child.
  defining: true,

  parseHTML() {
    // Only inside an image: a pasted <figcaption> on its own (the paste sanitizer drops
    // images) must stay text, not get wrapped in an empty image.
    return [{ tag: "figcaption", context: "image/" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["figcaption", mergeAttributes(HTMLAttributes, { class: "editor-image__caption" }), 0]
  },

  addKeyboardShortcuts() {
    const inCaption = () => this.editor.state.selection.$from.parent.type.name === this.name
    return {
      // Enter leaves the caption for a new paragraph under the image (a caption is one
      // line, and splitting it would split the image).
      Enter: () => {
        if (!inCaption()) return false
        const { state, view } = this.editor
        const { $from } = state.selection
        const after = $from.after($from.depth - 1)
        const tr = state.tr.insert(after, state.schema.nodes.paragraph.create())
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView())
        return true
      },
      // Backspace in an empty caption removes it and selects the image.
      Backspace: () => {
        const { state, view } = this.editor
        const { $from, empty } = state.selection
        if (!inCaption() || !empty || $from.parent.content.size > 0) return false
        const imagePos = $from.before($from.depth - 1)
        const tr = state.tr.delete($from.before(), $from.after())
        view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, imagePos)))
        return true
      },
    }
  },
})

/**
 * Extended Image node that includes mediaId attribute
 * This allows us to track which media library item is used in each image
 *
 * Plus (#346) the width (`align`, "inline" by default) and an optional caption child
 * (`imageCaption`). An image without a caption has no child at all, as every image did
 * before #346, so old Yjs docs stay valid.
 */
export const ImageWithMediaId = Image.extend({
  content: "imageCaption?",
  // Backspace/Delete next to the image never join a paragraph into the caption.
  isolating: true,

  addExtensions() {
    return [ImageCaption]
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      mediaId: {
        default: null,
        // A number, like the attr the media picker sets: Block Spec v1 and the API's
        // media sync only accept numeric ids.
        parseHTML: (element) => mediaIdFromHTML(element),
        renderHTML: (attributes) => {
          if (!attributes.mediaId) {
            return {}
          }
          return {
            "data-media-id": attributes.mediaId,
          }
        },
      },
      align: {
        default: "inline",
        parseHTML: (element) => {
          const value = (element.closest("figure") ?? element).getAttribute("data-align")
          return isImageAlign(value) ? value : "inline"
        },
        // On the <figure> (renderHTML below), not the <img>.
        renderHTML: () => ({}),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: "figure",
        // The caption only: the <img> is this node itself.
        contentElement: (element) => {
          const wrapper = element.ownerDocument.createElement("div")
          const caption = element.querySelector("figcaption")
          if (caption) wrapper.appendChild(caption.cloneNode(true))
          return wrapper
        },
        getAttrs: (element) => {
          const img = (element as HTMLElement).querySelector("img[src]")
          const src = img?.getAttribute("src")
          if (!img || !src || (!this.options.allowBase64 && src.startsWith("data:"))) return false
          return {
            src,
            alt: img.getAttribute("alt"),
            title: img.getAttribute("title"),
            mediaId: mediaIdFromHTML(img),
          }
        },
      },
      ...(this.parent?.() ?? []),
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    const align = isImageAlign(node.attrs.align) ? node.attrs.align : "inline"
    return [
      "figure",
      { class: "editor-image__figure", "data-align": align },
      ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)],
      ["div", { class: "editor-image__caption-slot" }, 0],
    ]
  },

  addCommands() {
    return {
      ...this.parent?.(),
      setImageAlign:
        (align) =>
        ({ state, tr, dispatch }) => {
          const image = findSelectedImage(state)
          if (!image || !isImageAlign(align)) return false
          if (dispatch) {
            tr.setNodeMarkup(image.pos, undefined, { ...image.node.attrs, align })
            if (state.selection instanceof NodeSelection) tr.setSelection(NodeSelection.create(tr.doc, image.pos))
          }
          return true
        },
      toggleImageCaption:
        () =>
        ({ state, tr, dispatch }) => {
          const image = findSelectedImage(state)
          if (!image) return false
          if (dispatch) {
            const captionPos = image.pos + 1
            if (image.node.childCount > 0) {
              tr.delete(captionPos, captionPos + image.node.child(0).nodeSize)
              tr.setSelection(NodeSelection.create(tr.doc, image.pos))
            } else {
              tr.insert(captionPos, state.schema.nodes.imageCaption.create())
              tr.setSelection(TextSelection.create(tr.doc, captionPos + 1))
            }
          }
          return true
        },
    }
  },
})
