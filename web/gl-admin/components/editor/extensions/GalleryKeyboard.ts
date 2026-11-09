import { Extension } from "@tiptap/core"
import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state"
import { chooseGalleryImages } from "../blocks/mediaPicking"
import { refOfBlock, selectedBlock, siblingBlock } from "../utils/blockTree"
import { moveGalleryImage, requestGalleryAltFocus } from "../utils/galleryActions"

/**
 * The gallery's keys (#424, the canvas's "Keyboard", "Inside blocks"). Editor only (no
 * schema), before the text keymaps (priority 200, like `DetailsKeyboard`), and only on a
 * selected gallery image or in a gallery's captions; anywhere else they return false, so
 * #417's keys and the lists' run as before. No appendTransaction (rule 7).
 *
 * - **← →** on a selected image: the image before or after it (↑ ↓ too, #417's sibling keys).
 * - **⌘⇧← →** on a selected image: move it earlier or later (`moveGalleryImage`: one Yjs
 *   transaction, its id kept).
 * - **↵** on a selected image: the panel's Block tab, focus in that image's alt text; on a
 *   selected empty gallery, the picker (#417's ↵ steps into the first image of a gallery with some).
 * - **↵** in the gallery's caption: a new line under the gallery. In an image's caption: back to
 *   the image (a new paragraph can't go between images).
 * - **⌫** at the start of the gallery's caption does nothing, except in an empty gallery
 *   with an empty caption, which it removes.
 */
export const GalleryKeyboard = Extension.create({
  name: "galleryKeyboard",
  priority: 200,

  addKeyboardShortcuts() {
    const selectedImage = () => {
      const block = selectedBlock(this.editor.state)
      return block && block.node.type.name === "image" && block.holder.type.name === "gallery" ? block : null
    }

    const step = (dir: -1 | 1) => () => {
      const block = selectedImage()
      if (!block) return false
      const { state, view } = this.editor
      const sibling = siblingBlock(state.doc, block, dir)
      // At the first or last image the selection stays.
      if (sibling) view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, sibling.pos)).scrollIntoView())
      return true
    }

    const reorder = (dir: -1 | 1) => () => {
      const block = selectedImage()
      if (!block || !this.editor.isEditable) return false
      moveGalleryImage(this.editor, refOfBlock(block), dir)
      // Never the browser's "select to the start" at the first image.
      return true
    }

    const enter = () => {
      const { state, view } = this.editor
      const image = selectedImage()
      if (image) {
        const id = image.node.attrs["data-block-id"]
        const storage = (this.editor.storage as unknown as Record<string, { openBlockSettings?: (() => void) | null }>).blockNavigationKeys
        const open = storage?.openBlockSettings
        if (!open || typeof id !== "string") return false
        requestGalleryAltFocus(this.editor, id)
        open()
        return true
      }
      const selected = selectedBlock(state)
      // One with images never gets here: #417's ↵ steps into its first image.
      if (selected?.node.type.name === "gallery") return this.editor.isEditable && chooseGalleryImages(this.editor, selected.pos)
      const { $from, $to, empty } = state.selection
      if (!this.editor.isEditable) return false
      if ($from.parent.type.name === "galleryCaption" && $to.parent === $from.parent) {
        // The caption is one line: on to a new paragraph under the gallery.
        const after = $from.after($from.depth - 1)
        const tr = empty ? state.tr : state.tr.deleteSelection()
        const at = tr.mapping.map(after)
        tr.insert(at, state.schema.nodes.paragraph.create())
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView())
        return true
      }
      if ($from.parent.type.name === "imageCaption" && $from.depth >= 2 && $from.node($from.depth - 2).type.name === "gallery") {
        // ImageCaption's own Enter would put a paragraph inside the gallery, which can't hold one.
        view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, $from.before($from.depth - 1))).scrollIntoView())
        return true
      }
      return false
    }

    const backspace = () => {
      const { state, view } = this.editor
      const { $from, empty } = state.selection
      if (!this.editor.isEditable || !empty || $from.parentOffset !== 0 || $from.parent.type.name !== "galleryCaption") return false
      const gallery = $from.node($from.depth - 1)
      if ($from.parent.content.size > 0 || gallery.childCount > 1) return true
      const pos = $from.before($from.depth - 1)
      const tr = state.tr.replaceWith(pos, pos + gallery.nodeSize, state.schema.nodes.paragraph.create())
      view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(pos + 1))).scrollIntoView())
      return true
    }

    return {
      ArrowLeft: step(-1),
      ArrowRight: step(1),
      "Mod-Shift-ArrowLeft": reorder(-1),
      "Mod-Shift-ArrowRight": reorder(1),
      Enter: enter,
      Backspace: backspace,
    }
  },
})
