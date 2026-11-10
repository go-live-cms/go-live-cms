import { Extension, mergeAttributes, Node } from "@tiptap/core"
import { normalizeSnippetId } from "@gl-admin/lib/blocks-spec"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    htmlBlock: {
      /** An empty custom HTML block for the caret's line. */
      insertHtmlBlock: () => ReturnType
    }
  }
}

/**
 * Custom HTML (#428, Block Spec `html`): a **snippet id, and never any markup.** The markup
 * is in the API's `post_html_snippets`, written by admins only, so there is none in the Yjs
 * doc for any client to add or change (`blocks-spec/customHtml.ts`).
 *
 * An atom: its one attribute is a node attribute, last writer wins, set once by the admin
 * who first saves it. **Not in the `block` group** (`STANDALONE_FLOW_NODE_NAMES`, like an
 * embed). Schema and commands only, no DOM code: the collab server builds the same schema.
 * The view is `HtmlBlockViews.ts`.
 *
 * It has no parse rule on purpose: no HTML, pasted or otherwise, can make one or name a
 * snippet. `renderHTML` writes an empty element and leaves the id out.
 */
export const HtmlBlock = Node.create({
  name: "html",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      snippetId: {
        default: null,
        rendered: false,
        parseHTML: () => null,
      },
    }
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "html", class: "editor-html" }, HTMLAttributes)]
  },
})

/** Reads a stored node's snippet id through the one rule (`normalizeSnippetId`). */
export const snippetIdOf = (attrs: Record<string, unknown>): string | null => normalizeSnippetId(attrs.snippetId)

/** The commands of the custom HTML block: no schema. One ordinary transaction (rule 7). */
export const HtmlBlockCommands = Extension.create({
  name: "htmlBlockCommands",
  addCommands() {
    return {
      insertHtmlBlock:
        () =>
        ({ state, commands }) => {
          if (!state.schema.nodes.html) return false
          return commands.insertContent({ type: "html" })
        },
    }
  },
})
