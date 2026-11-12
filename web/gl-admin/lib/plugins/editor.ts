import { themeBlockEditor, type ThemeBlockEditor, type ThemeBlockEditorOptions } from "../theme-blocks/editor"
import { defineExtensionBlock } from "../theme-blocks/define"
import { pluginOfBlockType } from "../blocks-spec/themeBlocks"
import { installedPluginBlocks } from "./blocks"

// The admin-only half of a plugin block (#456, docs/design/plugin-system.md 5.2): a plugin's
// blocks/<Name>/editor.ts default-exports pluginBlockEditor(blockJson, { nodeView, icon, … }).
// It takes a node view and a menu entry only, as themeBlockEditor does, so a plugin can't
// add schema or a ProseMirror plugin through it (rule 7): the node is the installed one,
// built from block.json (lib/plugins/blocks.ts), with the view added. The collab server
// never imports this.

export type PluginBlockEditorOptions = ThemeBlockEditorOptions

/**
 * The editor half of the block whose block.json is `json` (imported by the editor.ts next
 * to it; only its `type` is read). The node is the installed definition's, so the editor's
 * schema is the collab schema by construction. A block that isn't installed (its plugin's
 * plugin_api isn't core's, so its block.json may not even be in a format this build reads)
 * gets a placeholder definition that nothing uses: editorBlocks.ts leaves it out.
 */
export function pluginBlockEditor(json: { type: string }, options: PluginBlockEditorOptions): ThemeBlockEditor {
  if (!pluginOfBlockType(json.type)) throw new Error(`plugin block editor: "${json.type}" is not a plugin:<slug>/<block> type`)
  const definition =
    installedPluginBlocks.find((block) => block.type === json.type) ??
    defineExtensionBlock({ type: json.type, version: 1, title: json.type, content: "" })
  return themeBlockEditor(definition, options)
}
