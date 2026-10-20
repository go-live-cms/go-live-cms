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
 * TipTap extension that ensures all top-level nodes, and every listItem of a
 * bulletList/orderedList, have stable, unique block IDs
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

          // Track ids already seen in THIS pass so we can regenerate DUPLICATES, not
          // just missing/too-short ids. Splitting a block (pressing Enter) copies the
          // origin node's attributes — including data-block-id — onto the new node, so a
          // single keystroke silently mints a duplicate id. Duplicates are corrupting: the
          // block_doc `blocks` map is keyed by id, so two blocks sharing an id collapse to
          // one (the other is lost) on every save, and any id-based reconciliation then
          // fights itself. The old guard (`!currentId || length < 10`) never caught this.
          const seenIds = new Set<string>()

          // Stamp top-level nodes AND list items (#238). pmToBlockDoc stores every
          // listItem of a list as its own block, so an item without a stable id (a new
          // item from Enter, paste, or toggling a list has none, or a duplicate copied
          // on split) got a freshly minted id on EVERY save, and setBlockDocV1 then
          // deleted + re-inserted it and rewrote the list's children each time (rule 2).
          // Ids are deduped across the whole doc, in document order, like pmToBlockDoc.
          // setNodeMarkup doesn't change node sizes, so newState positions stay valid.
          newState.doc.descendants((node, pos, parent) => {
            const topLevel = parent === newState.doc
            const listItem =
              node.type.name === "listItem" &&
              (parent?.type.name === "bulletList" || parent?.type.name === "orderedList")

            if (topLevel || listItem) {
              const currentId = node.attrs["data-block-id"]
              const invalid = !currentId || typeof currentId !== "string" || currentId.length < 10
              const duplicate = !invalid && seenIds.has(currentId as string)

              if (invalid || duplicate) {
                const newId = generateBlockId()
                const attrs = { ...node.attrs, "data-block-id": newId }
                tr = tr.setNodeMarkup(pos, node.type, attrs, node.marks)
                hasChanges = true
                seenIds.add(newId)
              } else {
                seenIds.add(currentId as string)
              }
            }

            // Inline content can't hold list items; don't walk it.
            return !node.isTextblock
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
