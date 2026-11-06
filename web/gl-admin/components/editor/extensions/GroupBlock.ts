import { mergeAttributes, Node } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, type EditorState } from "@tiptap/pm/state"
import {
  containerContent,
  isGroupAlign,
  isGroupStyle,
  topLevelContent,
  type GroupAlign,
  type GroupStyle,
} from "@gl-admin/lib/blocks-spec"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    group: {
      /** Wrap the selected blocks in a group (the slash menu's Group). */
      setGroup: () => ReturnType
      /** Set the style or width of the group the selection is in. */
      setGroupAttrs: (attrs: { style?: GroupStyle; align?: GroupAlign }) => ReturnType
    }
  }
}

/**
 * The doc node, with its content expression from the nesting table (#414): flow
 * (`block`) plus the containers allowed at the top level. Replaces StarterKit's
 * Document (`block+`, configured off in `lib/collaboration/schema.ts`), because a
 * container is not in the `block` group (see Group below).
 */
export const GroupDocument = Node.create({
  name: "doc",
  topNode: true,
  content: topLevelContent(),
})

/** The group the selection is on (a NodeSelection) or in. */
export function findGroup(state: EditorState): { pos: number; node: PMNode } | null {
  const { selection } = state
  if (selection instanceof NodeSelection && selection.node.type.name === "group") {
    return { pos: selection.from, node: selection.node }
  }
  const { $from } = selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === "group") return { pos: $from.before(depth), node }
  }
  return null
}

/**
 * Group (#414, Block Spec `group`), the first container: blocks kept together,
 * optionally on the theme's surface colour (`style: "tinted"`), at the content, wide or
 * full width (`align`). Its children are blocks with their own ids (`isBlockNode`), and
 * Block Spec stores them by id in the group's `children` (`blockBridge.ts`).
 *
 * **Not in the `block` group**, on purpose: the quote (`block+`), the list item
 * (`paragraph block*`) and theme blocks name `block`, and a group inside one of them would
 * hide its blocks inside that block's `pm`, without ids. The doc and the containers that
 * accept it name it instead (`nesting.ts`), and ProseMirror's fitting lifts a pasted group
 * out of anywhere else. Schema only (no DOM code): the collab server builds it too. The
 * editor's view is `BlockNodeViews.ts`.
 */
export const Group = Node.create({
  name: "group",
  content: containerContent("group"),
  // Backspace at the start of the first block doesn't merge the group into the block
  // above, and Enter/paste keep their content inside.
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      style: {
        default: "none",
        parseHTML: (element) => {
          const value = element.getAttribute("data-style")
          return isGroupStyle(value) ? value : "none"
        },
        renderHTML: (attributes) => ({ "data-style": isGroupStyle(attributes.style) ? attributes.style : "none" }),
      },
      align: {
        default: "content",
        parseHTML: (element) => {
          const value = element.getAttribute("data-align")
          return isGroupAlign(value) ? value : "content"
        },
        renderHTML: (attributes) => ({ "data-align": isGroupAlign(attributes.align) ? attributes.align : "content" }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="group"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "group", class: "editor-group" }, HTMLAttributes), 0]
  },

  addCommands() {
    return {
      setGroup:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
      setGroupAttrs:
        (attrs) =>
        ({ state, tr, dispatch }) => {
          const group = findGroup(state)
          if (!group) return false
          const next = { ...group.node.attrs }
          if (attrs.style !== undefined) {
            if (!isGroupStyle(attrs.style)) return false
            next.style = attrs.style
          }
          if (attrs.align !== undefined) {
            if (!isGroupAlign(attrs.align)) return false
            next.align = attrs.align
          }
          if (dispatch) tr.setNodeMarkup(group.pos, undefined, next)
          return true
        },
    }
  },
})
