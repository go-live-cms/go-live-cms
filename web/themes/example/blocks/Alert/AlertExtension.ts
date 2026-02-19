import { Node } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { AlertNodeView } from "./AlertNodeView.tsx"

export const AlertExtension = Node.create({
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

  addNodeView() {
    return ReactNodeViewRenderer(AlertNodeView)
  },
})
