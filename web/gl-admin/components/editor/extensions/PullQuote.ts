import { mergeAttributes, Node } from "@tiptap/core"
import { normalizeCite } from "@gl-admin/lib/blocks-spec"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pullQuote: {
      /** Turn the block holding the selection into a pull quote (the menus' Pull quote). */
      setPullQuote: () => ReturnType
    }
  }
}

/**
 * Pull quote (#419, Block Spec `pull_quote`): a line from the post set large, with an
 * optional citation. A textblock, like a heading, so Turn into works both ways and Enter
 * at its end starts a paragraph. `cite` is plain text by the quote's rules (`normalizeCite`,
 * `CITE_MAX_LENGTH`), a node attribute, last writer wins; the editor's field is in
 * `BlockNodeViews.ts`.
 *
 * Schema only (no DOM code), so the collab server builds the same schema. HTML (the
 * editor's own clipboard) is `<figure data-type="pull-quote" data-cite><blockquote>`.
 */
export const PullQuote = Node.create({
  name: "pullQuote",
  group: "block",
  content: "inline*",
  defining: true,

  addAttributes() {
    return {
      cite: {
        default: null,
        parseHTML: (element) => normalizeCite(element.getAttribute("data-cite")),
        renderHTML: (attributes) => (attributes.cite ? { "data-cite": attributes.cite } : {}),
      },
    }
  },

  parseHTML() {
    // A figure without its blockquote (hand-written HTML) still parses, from the figure.
    return [
      {
        tag: 'figure[data-type="pull-quote"]',
        contentElement: (dom) => (dom as HTMLElement).querySelector(":scope > blockquote") ?? (dom as HTMLElement),
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ["figure", mergeAttributes({ "data-type": "pull-quote", class: "editor-pullquote" }, HTMLAttributes), ["blockquote", 0]]
  },

  addCommands() {
    return {
      setPullQuote:
        () =>
        ({ commands }) =>
          commands.setNode(this.name),
    }
  },
})
