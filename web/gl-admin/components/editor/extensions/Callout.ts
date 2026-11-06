import { mergeAttributes, Node } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import type { EditorState } from "@tiptap/pm/state"
import { isCalloutTone, normalizeCalloutTone, DEFAULT_CALLOUT_TONE, type CalloutTone } from "@gl-admin/lib/blocks-spec"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the selected paragraphs in a callout (the menus' Callout). */
      setCallout: (attrs?: { tone?: CalloutTone }) => ReturnType
      /** Set the tone of the callout the selection is in. */
      setCalloutTone: (tone: CalloutTone) => ReturnType
    }
  }
}

/** The callout the selection is in, or null. */
export function findCallout(state: EditorState): { pos: number; node: PMNode } | null {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === "callout") return { pos: $from.before(depth), node }
  }
  return null
}

/**
 * Callout (#419, Block Spec `callout`): paragraphs set apart from the text, in one of the
 * four tones (`CALLOUT_TONES`). A flow block, like a quote: its paragraphs are its content
 * (in its `pm`, without ids of their own), the tone is a node attribute, last writer wins.
 *
 * Schema only (no DOM code), so the collab server builds the same schema; the editor's
 * view (icon, tone settings) is `BlockNodeViews.ts`. HTML (the editor's own clipboard) is
 * `<div data-type="callout" data-tone>`: an unknown tone parses as `info`.
 */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "paragraph+",
  defining: true,

  addAttributes() {
    return {
      tone: {
        default: DEFAULT_CALLOUT_TONE,
        parseHTML: (element) => normalizeCalloutTone(element.getAttribute("data-tone")),
        renderHTML: (attributes) => ({ "data-tone": normalizeCalloutTone(attributes.tone) }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "callout", class: "editor-callout" }, HTMLAttributes), 0]
  },

  addCommands() {
    return {
      setCallout:
        (attrs) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { tone: normalizeCalloutTone(attrs?.tone) }),
      setCalloutTone:
        (tone) =>
        ({ state, tr, dispatch }) => {
          if (!isCalloutTone(tone)) return false
          const callout = findCallout(state)
          if (!callout) return false
          if (dispatch && callout.node.attrs.tone !== tone) {
            tr.setNodeMarkup(callout.pos, undefined, { ...callout.node.attrs, tone })
          }
          return true
        },
    }
  },
})
