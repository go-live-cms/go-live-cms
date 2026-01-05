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
        parseHTML: (element) => element.getAttribute("data-media-id"),
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
