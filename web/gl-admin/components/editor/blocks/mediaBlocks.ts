import type { Block } from "./index"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { getMediaURL } from "@gl-admin/lib/api"
import { createPostMedia } from "@gl-admin/lib/api/posts"
import type { Media } from "@gl-admin/lib/api/types"

export const createImagePlaceholder = (editor: TiptapEditor, range: { from: number; to: number }) => {
  const placeholderSrc =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='200' viewBox='0 0 400 200'%3E%3Crect width='400' height='200' fill='%23f3f4f6' stroke='%23d1d5db' stroke-width='2' stroke-dasharray='5,5'/%3E%3Cg transform='translate(200,100)'%3E%3Ccircle cx='0' cy='-20' r='20' fill='%23a3a3a3'/%3E%3Cpath d='M-15,-10 L-5,-10 L0,-5 L5,-10 L15,-10 L15,10 L-15,10 Z' fill='%23a3a3a3'/%3E%3C/g%3E%3Ctext x='50%25' y='70%25' dominant-baseline='middle' text-anchor='middle' fill='%23666' font-family='system-ui' font-size='14'%3EClick to select image from library%3C/text%3E%3C/svg%3E"

  editor
    .chain()
    .focus()
    .deleteRange(range)
    .setImage({
      src: placeholderSrc,
    })
    .run()
}

export const isImagePlaceholder = (src: string): boolean => {
  return src.includes("data:image/svg+xml") && src.includes("Click to select image from library")
}

export class MediaBlockManager {
  private editor: TiptapEditor
  private postId?: number
  private onShowMediaSelector: (position: number) => void
  private cleanupImageClick?: () => void

  constructor(editor: TiptapEditor, postId?: number, onShowMediaSelector?: (position: number) => void) {
    this.editor = editor
    this.postId = postId
    this.onShowMediaSelector = onShowMediaSelector || (() => {})
    this.setupImageClickHandling()
  }

  private setupImageClickHandling() {
    const handleImageClick = (event: MouseEvent) => {
      const target = event.target as HTMLImageElement
      if (target.tagName === "IMG" && isImagePlaceholder(target.src)) {
        event.preventDefault()
        event.stopPropagation()

        const { view } = this.editor
        const { state } = view
        const { doc } = state

        let imagePos: number | null = null

        doc.descendants((node, pos) => {
          if (node.type.name === "image" && isImagePlaceholder(node.attrs.src)) {
            const domPos = view.domAtPos(pos)
            if (domPos.node.contains && domPos.node.contains(target)) {
              imagePos = pos
              return false
            }
          }
        })

        if (imagePos !== null) {
          this.onShowMediaSelector(imagePos)
        }
      }
    }

    const editorElement = this.editor.view.dom
    editorElement.addEventListener("click", handleImageClick)

    this.cleanupImageClick = () => {
      editorElement.removeEventListener("click", handleImageClick)
    }
  }

  async handleMediaSelect(media: Media, imagePosition: number): Promise<void> {
    const imageUrl = getMediaURL(media.media_path)
    const { view } = this.editor
    const { state } = view
    const { doc } = state
    const resolvedPos = doc.resolve(imagePosition)
    const imageNode = resolvedPos.nodeAfter

    if (imageNode && imageNode.type.name === "image") {
      const transaction = state.tr.setNodeMarkup(imagePosition, imageNode.type, {
        src: imageUrl,
        alt: media.alt || media.description || "",
        title: media.name || "",
        mediaId: media.id,
      })
      view.dispatch(transaction)

      if (this.postId) {
        try {
          await createPostMedia(this.postId, media.id, 1)
          console.log(`Successfully linked media ${media.id} to post ${this.postId} as content image`)
        } catch (error) {
          console.error("Failed to link media to post:", error)
        }
      }
    }
  }

  destroy() {
    if (this.cleanupImageClick) {
      this.cleanupImageClick()
    }
  }
}

export const createMediaBlocks = (): Block[] => [
  {
    title: "Image",
    description: "Add an image from media library",
    icon: "🖼️",
    command: ({ editor, range }) => {
      createImagePlaceholder(editor, range)
    },
    aliases: ["img", "image", "picture"],
  },
]
