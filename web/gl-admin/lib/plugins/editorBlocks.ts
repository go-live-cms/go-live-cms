import type { Node } from "@tiptap/core"
import type { ThemeBlockEditor } from "../theme-blocks/editor"
import { installedPluginBlocks, pluginBlockPathParts, type InstalledPluginBlock } from "./blocks"

// Every installed plugin block's editor half (plugins/<slug>/blocks/<Name>/editor.ts),
// resolved when the admin is built (#456), beside the theme blocks' (theme-blocks/
// editorBlocks.ts). The editor adds every installed plugin block to its schema, enabled or
// not (design 5.3); only enabled plugins' entries are offered in the block menus
// (components/editor/blocks/catalog.ts, `menuEntries`).

const EDITORS = import.meta.glob<{ default?: unknown }>("../../../plugins/*/blocks/*/editor.ts", { eager: true })

const isEditor = (value: unknown): value is ThemeBlockEditor =>
  !!value && typeof value === "object" && typeof (value as ThemeBlockEditor).type === "string" && !!(value as ThemeBlockEditor).extension

/**
 * The editors in `modules`, checked against the installed definitions: each must be for the
 * block whose block.json is in the same directory, with a node of the same name. An editor
 * of a plugin that isn't installed (plugin_api outside core's range) is left out. Throws
 * otherwise (themeBlocks.loadable.test.ts runs it over the repository's plugins).
 */
export function collectPluginBlockEditors(
  modules: Record<string, { default?: unknown }>,
  definitions: InstalledPluginBlock[] = installedPluginBlocks,
): ThemeBlockEditor[] {
  const editors: ThemeBlockEditor[] = []
  for (const [path, module] of Object.entries(modules)) {
    const parts = pluginBlockPathParts(path)
    if (!parts) throw new Error(`plugin block ${path}: not under plugins/<slug>/blocks/<Name>/`)
    if (!definitions.some((d) => d.plugin === parts.slug)) continue
    const editor = module.default
    if (!isEditor(editor)) throw new Error(`plugin block ${path}: editor.ts must default-export pluginBlockEditor(...)`)
    if (!definitions.some((d) => d.type === editor.type && d.dir === `${parts.slug}/${parts.dir}`)) {
      throw new Error(`plugin block ${path}: "${editor.type}" has no block.json in the same directory`)
    }
    if (editor.extension.name !== editor.type) throw new Error(`plugin block ${path}: the node must be named "${editor.type}"`)
    editors.push(editor)
  }
  return editors.sort((a, b) => (a.type < b.type ? -1 : 1))
}

export const installedPluginBlockEditors: ThemeBlockEditor[] = collectPluginBlockEditors(EDITORS)

/**
 * The editor's node for every installed plugin block, in the installed order (by type): its
 * editor's node view when it has one, else the headless node, so the editor's schema always
 * equals the collab schema (rule 10) even for a block whose editor.ts is missing
 * (themeBlocks.loadable.test.ts refuses that in the repository).
 */
export function pluginBlockExtensions(
  definitions: InstalledPluginBlock[] = installedPluginBlocks,
  editors: ThemeBlockEditor[] = installedPluginBlockEditors,
): Node[] {
  return definitions.map((definition) => editors.find((editor) => editor.type === definition.type)?.extension ?? definition.node)
}
