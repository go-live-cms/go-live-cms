import type { ComponentType } from "react"
import type { Node } from "@tiptap/core"
import { ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react"
import type { BlockGroup, CatalogEntry } from "../../components/editor/blocks/catalog"
import { pluginOfBlockType, themeOfBlockType } from "../blocks-spec/themeBlocks"
import type { ThemeBlockDefinition } from "./define"

// The admin-only half of a theme block (#376): its node with a React NodeView, and its
// entry in the block catalog (#415), which the slash and + menus offer while the block's
// theme is active. A theme block's editor.ts default-exports themeBlockEditor(...). The
// collab server never imports this (it bundles index.ts only), so React stays out of it.

export interface ThemeBlockEditor {
  type: string
  /** The definition's node with the NodeView: the same schema, so the collab schema matches the editor's. */
  extension: Node
  /** The block catalog entry (components/editor/blocks/catalog.ts), offered only while this block's theme is active. */
  entry: CatalogEntry
}

export interface ThemeBlockEditorOptions {
  nodeView: ComponentType<ReactNodeViewProps>
  /** A short glyph shown in the menu's icon tile. */
  icon: string
  /** What the block is for. The menus don't show it (they list names, #415). */
  description?: string
  /** The menu group it's listed in: text (the default), media, layout or embeds. */
  group?: Exclude<BlockGroup, "advanced">
  /** Words the menus' search also matches, by prefix. */
  keywords?: string[]
  /** Older name for `keywords`; both are searched. */
  aliases?: string[]
}

const GROUPS: readonly BlockGroup[] = ["text", "media", "layout", "embeds"]

export function themeBlockEditor(definition: ThemeBlockDefinition, options: ThemeBlockEditorOptions): ThemeBlockEditor {
  const extension = definition.node.extend({
    addNodeView() {
      return ReactNodeViewRenderer(options.nodeView)
    },
  })
  // Advanced is admins only and not for theme blocks: an unknown group lands in Text.
  const group = options.group && GROUPS.includes(options.group) ? options.group : "text"
  return {
    type: definition.type,
    extension,
    entry: {
      id: definition.type,
      type: definition.type,
      name: definition.title,
      group,
      keywords: [...new Set([...(options.keywords ?? []), ...(options.aliases ?? [])])],
      icon: { glyph: options.icon },
      // The block's extension (#452): a theme block follows the active theme, a plugin
      // block never does (its type has no theme).
      theme: themeOfBlockType(definition.type) ?? undefined,
      plugin: pluginOfBlockType(definition.type) ?? undefined,
      // The attrs come from the schema's defaults (the Block Spec's).
      insert: (editor, range) => {
        editor.chain().focus().deleteRange(range).insertContent({ type: definition.type }).run()
      },
    },
  }
}
