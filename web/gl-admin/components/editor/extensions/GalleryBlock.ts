import { mergeAttributes, Node } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import { CAPTION_MARKS, containerContent, GALLERY_DEFAULT_COLUMNS, normalizeGalleryColumns } from "@gl-admin/lib/blocks-spec"
import { editorBlockAtSelection, holderAcceptsType } from "../utils/blockTree"

/** What an image block in a gallery starts from: the media's URL, alt text, name and id. */
export interface GalleryImageAttrs {
  src: string
  alt: string
  title: string
  mediaId: number
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    gallery: {
      /** The menus' Gallery: an empty gallery on the caret's empty line, else after its block, the caret in its caption. */
      insertGallery: () => ReturnType
      /** Adds image blocks at the end of the gallery at `pos`, in one transaction (the picker's choice). */
      addGalleryImages: (pos: number, images: GalleryImageAttrs[]) => ReturnType
    }
  }
}

/**
 * A gallery's caption (#424): always its last child, empty = none. A part of the block, not
 * a block: no id (`isBlockNode`), and in Block Spec its runs are the gallery's `attrs.caption`.
 * Its own node so two people typing in it merge per character (Yjs), with bold, italic and
 * link only (`CAPTION_MARKS`, the API's `sanitizeCaption`). `isolating`: Backspace at its
 * start never joins it into an image.
 */
export const GalleryCaption = Node.create({
  name: "galleryCaption",
  content: "text*",
  marks: CAPTION_MARKS.join(" "),
  // No group: it can only be a gallery's last child.
  defining: true,
  isolating: true,
  selectable: false,

  parseHTML() {
    return [{ tag: 'div[data-type="gallery-caption"]', context: "gallery/" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "gallery-caption", class: "editor-gallery__caption" }), 0]
  },
})

/**
 * Gallery (#424, Block Spec `gallery`), the third container (`nesting.ts`): image blocks,
 * none is fine, then the caption. Each image is the ordinary image block (alt, caption, media
 * id; `ImageWithMediaId.ts`), with its own id and its own entry in "Used in". `columns` is 2–4
 * (a node attribute, last writer wins). It has no width of its own: it's a block of the post.
 *
 * Not in the `block` group (like Group and Details): a quote, a list item or a theme block
 * can't hold it, so its images never hide in another block's `pm`. Schema and commands only,
 * no DOM code: the collab server builds it too. The editor's view is `BlockNodeViews.ts`, its
 * keys `GalleryKeyboard.ts`.
 */
export const Gallery = Node.create({
  name: "gallery",
  content: containerContent("gallery"),
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      columns: {
        default: GALLERY_DEFAULT_COLUMNS,
        parseHTML: (element) => {
          const value = element.getAttribute("data-columns")
          return normalizeGalleryColumns(value === null ? undefined : Number(value))
        },
        renderHTML: (attributes) => ({ "data-columns": normalizeGalleryColumns(attributes.columns) }),
      },
    }
  },

  addExtensions() {
    return [GalleryCaption]
  },

  parseHTML() {
    return [{ tag: 'div[data-type="gallery"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "gallery", class: "editor-gallery" }, HTMLAttributes), 0]
  },

  addCommands() {
    return {
      insertGallery:
        () =>
        ({ state, tr, dispatch }) => {
          const block = editorBlockAtSelection(state)
          if (!block || !holderAcceptsType(block.holder.type.name, "gallery")) return false
          const node = state.schema.nodes.gallery.createAndFill()
          if (!node) return false
          if (dispatch) {
            const emptyLine = block.node.type.name === "paragraph" && block.node.content.size === 0
            const at = emptyLine ? block.pos : block.pos + block.node.nodeSize
            if (emptyLine) tr.replaceWith(at, at + block.node.nodeSize, node)
            else tr.insert(at, node)
            tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView()
          }
          return true
        },
      addGalleryImages:
        (pos, images) =>
        ({ state, tr, dispatch }) => {
          const gallery = state.doc.nodeAt(pos)
          if (!gallery || gallery.type.name !== "gallery" || images.length === 0) return false
          if (dispatch) {
            const nodes = images.map((attrs) => state.schema.nodes.image.create(attrs))
            tr.insert(galleryImagesEnd(pos, gallery), nodes)
          }
          return true
        },
    }
  },
})

/** Where a gallery's images end: right before its caption, its last child. */
export function galleryImagesEnd(pos: number, gallery: PMNode): number {
  return pos + gallery.nodeSize - 1 - (gallery.lastChild?.type.name === "galleryCaption" ? gallery.lastChild.nodeSize : 0)
}

/** The image blocks of a gallery node, with their document positions (`pos` is the gallery's). */
export function galleryImages(pos: number, gallery: PMNode): { node: PMNode; pos: number }[] {
  const images: { node: PMNode; pos: number }[] = []
  gallery.forEach((child, offset) => {
    if (child.type.name === "image") images.push({ node: child, pos: pos + 1 + offset })
  })
  return images
}

/** "6 images", "1 image", "No images": the panel's line under the gallery's name. */
export function galleryImageCount(gallery: PMNode): string {
  const count = galleryImages(0, gallery).length
  return count === 0 ? "No images" : count === 1 ? "1 image" : `${count} images`
}

/** The canvas's copy for a gallery with no images ("Editor · image, gallery…", "Errors & empty states"). */
export const GALLERY_EMPTY_FRESH = "Add two or more images. You can reorder them after."
export const GALLERY_EMPTY_TITLE = "This gallery has no images"
export const GALLERY_EMPTY_TEXT = "Add images, or remove the block if you no longer need it."
