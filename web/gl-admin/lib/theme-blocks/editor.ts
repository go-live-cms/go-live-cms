import type { ComponentType } from "react"
import type { Node } from "@tiptap/core"
import { ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react"
import type { Block } from "../../components/editor/blocks"
import type { ThemeBlockDefinition } from "./define"

// The admin-only half of a theme block (#376): its node with a React NodeView, and its
// slash-menu entry. A theme block's editor.ts default-exports themeBlockEditor(...). The
// collab server never imports this (it bundles index.ts only), so React stays out of it.

export interface ThemeBlockEditor {
  type: string
  /** The definition's node with the NodeView: the same schema, so the collab schema matches the editor's. */
  extension: Node
  /** The slash-menu entry, offered only while this block's theme is active. */
  slash: Block
}

export interface ThemeBlockEditorOptions {
  nodeView: ComponentType<ReactNodeViewProps>
  icon: string
  description: string
  aliases?: string[]
}

export function themeBlockEditor(definition: ThemeBlockDefinition, options: ThemeBlockEditorOptions): ThemeBlockEditor {
  const extension = definition.node.extend({
    addNodeView() {
      return ReactNodeViewRenderer(options.nodeView)
    },
  })
  return {
    type: definition.type,
    extension,
    slash: {
      title: definition.title,
      icon: options.icon,
      description: options.description,
      aliases: options.aliases ?? [],
      // The attrs come from the schema's defaults (the Block Spec's).
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).insertContent({ type: definition.type }).run()
      },
    },
  }
}
