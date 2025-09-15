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

          newState.doc.content.forEach((node, offset, index) => {
            const pos = offset
            const currentId = node.attrs["data-block-id"]

            if (!currentId || typeof currentId !== "string" || currentId.length < 10) {
              const newId = ensureBlockId(node)

              tr = tr.setNodeAttribute(pos, "data-block-id", newId)
              hasChanges = true
            }
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
