import { mergeAttributes, Node } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import { DEFAULT_SPACER_SIZE, isSpacerSize, normalizeSpacerSize, type SpacerSize } from "@gl-admin/lib/blocks-spec"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    spacer: {
      /** A spacer for the caret's line (the menus' Spacer), at the default height. */
      insertSpacer: () => ReturnType
      /** The height of the spacer at `pos`, one of the theme's steps. */
      setSpacerSize: (pos: number, size: SpacerSize) => ReturnType
    }
  }
}

/**
 * Spacer (#426, Block Spec `spacer`): empty space, `size` a step of the theme's spacing
 * scale (never pixels: `SPACER_STEPS`). An atom, flow, outside the `block` group (like the
 * table). Schema and commands only (no DOM): the collab server builds it too. The view and
 * its handle (↑ ↓ one step) are `LayoutBlockViews.ts`.
 */
export const Spacer = Node.create({
  name: "spacer",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      size: {
        default: DEFAULT_SPACER_SIZE,
        parseHTML: (element) => normalizeSpacerSize(element.getAttribute("data-size")),
        renderHTML: (attributes) => ({ "data-size": normalizeSpacerSize(attributes.size) }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="spacer"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "spacer", class: "editor-spacer" }, HTMLAttributes)]
  },

  addCommands() {
    return {
      insertSpacer:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
      setSpacerSize:
        (pos, size) =>
        ({ state, tr, dispatch }) => {
          const node = state.doc.nodeAt(pos)
          if (!node || node.type.name !== this.name || !isSpacerSize(size)) return false
          if (dispatch && node.attrs.size !== size) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, size })
            if (state.selection instanceof NodeSelection && state.selection.from === pos) {
              tr.setSelection(NodeSelection.create(tr.doc, pos))
            }
          }
          return true
        },
    }
  },
})
