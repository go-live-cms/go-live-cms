import { Extension, mergeAttributes, Node } from "@tiptap/core"
import { NodeSelection, type EditorState } from "@tiptap/pm/state"
import type { Node as PMNode } from "@tiptap/pm/model"
import { isEmbedProvider, isValidEmbedRef, normalizeEmbedTitle, type EmbedProvider } from "@gl-admin/lib/blocks-spec"
import { captionOnly, toggleCaptionOf } from "./MediaBlocks"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    embedBlock: {
      /**
       * An empty embed for the caret's line: the provider the menu entry stands for, or null
       * for "Embed a link".
       */
      insertEmbedBlock: (provider: EmbedProvider | null) => ReturnType
      /** Add an empty caption to the selected embed, or remove its caption. */
      toggleEmbedCaption: () => ReturnType
    }
  }
}

/**
 * Embed (#425, Block Spec `embed`): `provider`, `ref` (that provider's id) and a plain-text
 * `title`, each a node attribute, last writer wins, and a caption, the image's own node
 * (`imageCaption`), so two people typing in it merge per character. A provider with no ref
 * is an empty block waiting for its link ("Paste a YouTube link").
 *
 * **Not in the `block` group** (`STANDALONE_FLOW_NODE_NAMES`, like the video block): never
 * part of a quote's or a list item's content, which the public page renders as text only.
 * Schema and commands only, no DOM code: the collab server builds the same schema. The view
 * is `EmbedBlockViews.ts`. Attribute values read from HTML go through the same rules as the
 * Go sanitizer, so nothing pasted can name a player the API would refuse.
 */
export const EmbedBlock = Node.create({
  name: "embed",
  content: "imageCaption?",
  isolating: true,
  defining: true,
  selectable: true,

  addAttributes() {
    return {
      provider: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const provider = element.getAttribute("data-provider")
          return isEmbedProvider(provider) ? provider : null
        },
        renderHTML: (attributes: Record<string, unknown>) => (attributes.provider ? { "data-provider": attributes.provider } : {}),
      },
      ref: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const ref = element.getAttribute("data-ref")
          return isValidEmbedRef(element.getAttribute("data-provider"), ref) ? ref : null
        },
        renderHTML: (attributes: Record<string, unknown>) => (attributes.ref ? { "data-ref": attributes.ref } : {}),
      },
      title: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizeEmbedTitle(element.getAttribute("data-title")),
        renderHTML: (attributes: Record<string, unknown>) => (attributes.title ? { "data-title": attributes.title } : {}),
      },
    }
  },

  parseHTML() {
    // The editor's own markup (renderHTML below).
    return [{ tag: 'figure[data-type="embed"]', priority: 60, contentElement: captionOnly }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["figure", mergeAttributes({ "data-type": "embed", class: "editor-media editor-embed" }, HTMLAttributes), ["div", { class: "editor-media__caption-slot" }, 0]]
  },
})

/** The embed the selection is on, or the caret is in (its caption). */
export function findSelectedEmbed(state: EditorState): { pos: number; node: PMNode } | null {
  const { selection } = state
  if (selection instanceof NodeSelection && selection.node.type.name === "embed") return { pos: selection.from, node: selection.node }
  const { $from } = selection
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === "embed") return { pos: $from.before(depth), node: $from.node(depth) }
  }
  return null
}

/** The commands of the embed block: no schema. Each is one ordinary transaction (rule 7). */
export const EmbedBlockCommands = Extension.create({
  name: "embedBlockCommands",
  addCommands() {
    return {
      insertEmbedBlock:
        (provider) =>
        ({ state, commands }) => {
          if (!state.schema.nodes.embed) return false
          return commands.insertContent({ type: "embed", attrs: { provider } })
        },
      toggleEmbedCaption:
        () =>
        ({ state, tr, dispatch }) => {
          const found = findSelectedEmbed(state)
          if (!found) return false
          if (dispatch) toggleCaptionOf(tr, state, found.pos, found.node)
          return true
        },
    }
  },
})
