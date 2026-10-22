import { Node } from "@tiptap/core"

/**
 * The alert block's document schema only: no NodeView, so no React import. The editor
 * extends it with the NodeView (AlertExtension.ts). The collab server (#206) can load
 * this file to check alert blocks like core blocks (`getCollabSchema([AlertSchema])`);
 * without it, it falls back to a permissive stand-in that checks nothing.
 */
export const AlertSchema = Node.create({
  name: "alert",

  group: "block",

  content: "text*",

  addAttributes() {
    return {
      variant: {
        default: "info",
        parseHTML: (element) => element.getAttribute("data-variant"),
        renderHTML: (attributes) => ({
          "data-variant": attributes.variant,
        }),
      },
      message: {
        default: "This is an alert message",
        parseHTML: (element) => element.getAttribute("data-message"),
        renderHTML: (attributes) => ({
          "data-message": attributes.message,
        }),
      },
      "data-block-id": {
        default: null,
        parseHTML: (element) => element.getAttribute("data-block-id"),
        renderHTML: (attributes) => {
          if (!attributes["data-block-id"]) return {}
          return { "data-block-id": attributes["data-block-id"] }
        },
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: "div[data-block-type='alert']",
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", { "data-block-type": "alert", ...HTMLAttributes }, 0]
  },
})
