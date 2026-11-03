import { themeOfBlockType } from "../blocks-spec/themeBlocks"
import { blockPathParts, installedThemeBlocks } from "./installed"
import type { ThemeBlockEditor } from "./editor"

// Every installed theme block's editor half (themes/<slug>/blocks/<Name>/editor.ts),
// resolved when the admin is built (#376). The editor adds all of them to its schema, so
// a block of a theme that is not active still loads and edits; only the active theme's
// are offered in the slash menu (themeSlashBlocks).

const EDITORS = import.meta.glob<{ default?: unknown }>("../../../themes/*/blocks/*/editor.ts", { eager: true })

const isEditor = (value: unknown): value is ThemeBlockEditor =>
  !!value && typeof value === "object" && typeof (value as ThemeBlockEditor).type === "string" && !!(value as ThemeBlockEditor).extension

/**
 * The editors in `modules`, checked against the installed definitions: each must be for a
 * block whose index.ts is in the same directory, with a node of the same name. Throws
 * otherwise (themeBlocks.loadable.test.ts runs it over the repository's themes).
 */
export function collectThemeBlockEditors(modules: Record<string, { default?: unknown }>, definitions = installedThemeBlocks): ThemeBlockEditor[] {
  return Object.entries(modules)
    .map(([path, module]) => {
      const editor = module.default
      const parts = blockPathParts(path)
      if (!isEditor(editor)) throw new Error(`theme block ${path}: editor.ts must default-export themeBlockEditor(...)`)
      if (!parts || !definitions.some((d) => d.type === editor.type && d.dir === `${parts.slug}/${parts.dir}`)) {
        throw new Error(`theme block ${path}: "${editor.type}" has no index.ts definition in the same directory`)
      }
      if (editor.extension.name !== editor.type) throw new Error(`theme block ${path}: the node must be named "${editor.type}"`)
      return editor
    })
    .sort((a, b) => (a.type < b.type ? -1 : 1))
}

export const installedThemeBlockEditors: ThemeBlockEditor[] = collectThemeBlockEditors(EDITORS)

/** The slash-menu entries of the active theme's blocks. */
export const themeSlashBlocks = (slug: string) =>
  installedThemeBlockEditors.filter((editor) => themeOfBlockType(editor.type) === slug).map((editor) => editor.slash)
