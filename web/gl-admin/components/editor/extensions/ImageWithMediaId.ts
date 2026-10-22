import Image from "@tiptap/extension-image"

/**
 * Extended Image node that includes mediaId attribute
 * This allows us to track which media library item is used in each image
 */
export const ImageWithMediaId = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      mediaId: {
        default: null,
        // A number, like the attr the media picker sets: Block Spec v1 and the API's
        // media sync only accept numeric ids.
        parseHTML: (element) => {
          const value = element.getAttribute("data-media-id")
          return value && /^\d+$/.test(value) ? Number(value) : null
        },
        renderHTML: (attributes) => {
          if (!attributes.mediaId) {
            return {}
          }
          return {
            "data-media-id": attributes.mediaId,
          }
        },
      },
    }
  },
})
