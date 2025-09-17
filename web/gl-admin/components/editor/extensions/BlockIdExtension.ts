import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "prosemirror-state"
import { ensureBlockId } from "@gl-admin/lib/collaboration/blockBridge"

const blockIdPluginKey = new PluginKey("blockId")

/**
 * TipTap extension that ensures all top-level nodes have stable block IDs
 */
export const BlockIdExtension = Extension.create({
  name: "blockId",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockIdPluginKey,

        appendTransaction(transactions, oldState, newState) {
          const docChanged = transactions.some((tr) => tr.docChanged)
          if (!docChanged) return null

          let tr = newState.tr
          let hasChanges = false

          let pos = 0
          newState.doc.content.forEach((node) => {
            const currentId = node.attrs["data-block-id"]

            if (!currentId || typeof currentId !== "string" || currentId.length < 10) {
              const newId = ensureBlockId(node)
              const attrs = { ...node.attrs, "data-block-id": newId }

              tr = tr.setNodeMarkup(pos, node.type, attrs, node.marks)
              hasChanges = true
            }

            pos += node.nodeSize
          })

          return hasChanges ? tr : null
        },

        props: {
          nodeViews: {},
        },
      }),
    ]
  },

  addGlobalAttributes() {
    return [
      {
        types: [
          "paragraph",
          "heading",
          "blockquote",
          "codeBlock",
          "horizontalRule",
          "image",
          "bulletList",
          "orderedList",
          "listItem",
        ],
        attributes: {
          "data-block-id": {
            default: null,
            parseHTML: (element) => element.getAttribute("data-block-id"),
            renderHTML: (attributes) => {
              if (!attributes["data-block-id"]) {
                return {}
              }
              return {
                "data-block-id": attributes["data-block-id"],
              }
            },
          },
        },
      },
    ]
  },
})

export default BlockIdExtension
