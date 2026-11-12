import { defineExtensionBlock, type ThemeBlockDefinition } from "../theme-blocks/define"
import type { ThemeBlockSpec } from "../blocks-spec/themeBlocks"
import { pluginApiCompatible, validatePluginManifest } from "./manifest"
import { validatePluginBlockJson } from "./blockJson"

// The plugin blocks installed in this build (#456, docs/design/plugin-system.md 5.2): every
// plugins/<slug>/blocks/<Name>/block.json of a plugin whose plugin.json validates and whose
// plugin_api core implements, resolved when the image is built. Vite does it for the admin,
// the SSR server and vitest; the collab server's esbuild bundle with
// collab-server/importMetaGlob.mjs. Both globs read JSON only, so this module and the
// collab bundle carry no plugin JavaScript (rule 13).
//
// "Installed" = in this build, never "enabled" (design 5.3): the editor schema, the collab
// schema, the API and the public renderer know every installed plugin block, so enabling or
// disabling a plugin changes no schema fingerprint and restarts nothing. Only the block
// menus follow the enabled list (catalog.ts, `setEnabledPlugins`).
//
// The API reads the same files at startup with the same rules (api/plugin_blocks.go).

type JsonModules = Record<string, { default?: unknown }>

/** An installed plugin block: its definition and where it lives, `<slug>/<Name>`. */
export interface InstalledPluginBlock extends ThemeBlockDefinition {
  dir: string
  plugin: string
}

const MANIFESTS = import.meta.glob<{ default?: unknown }>("../../../plugins/*/plugin.json", { eager: true })
const BLOCKS = import.meta.glob<{ default?: unknown }>("../../../plugins/*/blocks/*/block.json", { eager: true })

/** `.../plugins/<slug>/plugin.json` → slug. */
export function pluginManifestPathSlug(path: string): string | null {
  return /plugins\/([^/]+)\/plugin\.json$/.exec(path.replaceAll("\\", "/"))?.[1] ?? null
}

/** `.../plugins/<slug>/blocks/<Name>/<file>` → slug and block directory. */
export function pluginBlockPathParts(path: string): { slug: string; dir: string } | null {
  const match = /plugins\/([^/]+)\/blocks\/([^/]+)\/[^/]+$/.exec(path.replaceAll("\\", "/"))
  return match ? { slug: match[1], dir: match[2] } : null
}

/**
 * The plugin block definitions of `manifests` (a glob of plugin.json) and `blocks` (a glob
 * of block.json), sorted by type. Throws on a plugin.json the validator refuses, a block
 * the manifest declares without a block.json or the reverse, or a block.json the validator
 * refuses: a build must not ship a block the editor, collab server and API would disagree
 * about (the API refuses the same plugin as incompatible). A plugin whose plugin_api core
 * doesn't implement contributes no blocks, here and in the API (`incompatible`).
 * themeBlocks.loadable.test.ts runs this over the repository's plugins.
 */
export function collectPluginBlocks(manifests: JsonModules, blocks: JsonModules): InstalledPluginBlock[] {
  const compatible = new Map<string, string[]>()
  for (const [path, module] of Object.entries(manifests)) {
    const slug = pluginManifestPathSlug(path)
    if (!slug) throw new Error(`plugin ${path}: not at plugins/<slug>/plugin.json`)
    const result = validatePluginManifest(module.default, slug)
    if (!result.ok) throw new Error(`plugin ${slug}: plugin.json ${result.field ? `${result.field} ` : ""}${result.message}`)
    if (pluginApiCompatible(result.manifest.plugin_api)) compatible.set(slug, result.manifest.blocks ?? [])
  }

  const found = new Map<string, InstalledPluginBlock>()
  const seen = new Set<string>()
  for (const [path, module] of Object.entries(blocks)) {
    const parts = pluginBlockPathParts(path)
    if (!parts) throw new Error(`plugin block ${path}: not at plugins/<slug>/blocks/<Name>/block.json`)
    const { slug, dir } = parts
    seen.add(`${slug}/${dir}`)
    if (!Object.keys(manifests).some((manifest) => pluginManifestPathSlug(manifest) === slug)) {
      throw new Error(`plugin block ${slug}/${dir}: plugins/${slug} has no plugin.json`)
    }
    const declared = compatible.get(slug)
    if (!declared) continue // incompatible plugin_api: not installed
    if (!declared.includes(dir)) throw new Error(`plugin block ${slug}/${dir}: plugin.json's "blocks" doesn't list ${dir}`)
    const result = validatePluginBlockJson(module.default, slug, dir)
    if (!result.ok) throw new Error(`plugin block ${slug}/${dir}: block.json ${result.field ? `${result.field} ` : ""}${result.message}`)
    const definition = defineExtensionBlock(result.block)
    found.set(definition.type, { ...definition, dir: `${slug}/${dir}`, plugin: slug })
  }

  for (const [slug, declared] of compatible) {
    for (const dir of declared) {
      if (!seen.has(`${slug}/${dir}`)) throw new Error(`plugin block ${slug}/${dir}: declared in plugin.json but has no blocks/${dir}/block.json`)
    }
  }
  return [...found.values()].sort((a, b) => (a.type < b.type ? -1 : 1))
}

export const installedPluginBlocks: InstalledPluginBlock[] = collectPluginBlocks(MANIFESTS, BLOCKS)

/** The block specs only (what the API merges into its theme block specs). */
export const installedPluginBlockSpecs = (): ThemeBlockSpec[] =>
  installedPluginBlocks.map(({ type, version, attrs }) => ({ type, version, attrs }))

/**
 * The installed spec of the block whose block.json is `json` (a plugin's render.tsx imports
 * its block.json and reads its attrs with `themeBlockAttrs(pluginBlockSpec(block), …)`).
 * A block that isn't installed (its plugin's plugin_api isn't core's) gets an empty spec:
 * nothing registers its renderer then.
 */
export function pluginBlockSpec(json: { type: string }): ThemeBlockSpec {
  const block = installedPluginBlocks.find((installed) => installed.type === json.type)
  return block ? { type: block.type, version: block.version, attrs: block.attrs } : { type: json.type, version: 1, attrs: {} }
}
