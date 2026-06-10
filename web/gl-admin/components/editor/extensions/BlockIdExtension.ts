import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "prosemirror-state"
import { isChangeOrigin } from "@tiptap/extension-collaboration"

const blockIdPluginKey = new PluginKey("blockId")

// Generate unique block IDs
let idCounter = 0
function generateBlockId(): string {
  idCounter++
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 9)

  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID()
  }

  return `${random}-${timestamp}-${idCounter}`
}

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

          // CRITICAL (collab): never assign block IDs in response to a change that came
          // from the collaboration sync (a remote Yjs update applied by ySyncPlugin).
          // crypto.randomUUID() produces a different id every call, so reacting to a
          // remote update by minting a new id is a *new local* transaction that mirrors
          // straight back into Yjs and is sent to the server; the next 2s resync delivers
          // the server's version again, we mint again, forever. That feedback loop is the
          // "heartbeat" — the editor and server ping-pong (PluginKey ↔ WebsocketProvider),
          // never converge, and the delete-war erases the user's text and images. Block
          // IDs for remote content arrive over the wire as synced node attributes; only
          // the client that ORIGINATES a node needs to assign one, and pmToBlockDoc
          // backfills any still-missing id at save time. isChangeOrigin() is TipTap's
          // official "did this transaction come from Yjs?" check.
          if (transactions.some((tr) => isChangeOrigin(tr))) return null

          let tr = newState.tr
          let hasChanges = false

          let pos = 0
          newState.doc.content.forEach((node, offset, index) => {
            const currentId = node.attrs["data-block-id"]

            // Only assign ID if node doesn't have a valid one
            if (!currentId || typeof currentId !== "string" || currentId.length < 10) {
              // Generate a truly unique ID for new nodes
              const newId = generateBlockId()
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
