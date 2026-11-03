import { themeOfBlockType, type ThemeBlockSpec } from "../blocks-spec/themeBlocks"
import type { ThemeBlockDefinition } from "./define"

// The theme blocks installed in this build (#376): every themes/<slug>/blocks/<Name>/index.ts,
// resolved when the image is built, like the themes' configs and layouts (#272). Vite does
// this for the admin, the SSR server and vitest; the collab server's esbuild bundle and the
// manifest generator do it with collab-server/importMetaGlob.mjs. Nothing imports a theme
// module by URL at runtime: a block added later is simply not in the build.
//
// "Installed" = in this build, whichever theme is active: the editor schema, the collab
// schema, the API manifest and the public renderer all know every installed block, so a
// post keeps working when its theme is switched. Only the slash menu is per active theme.

type BlockModules = Record<string, { default?: unknown }>

/** An installed definition and where it lives: `<slug>/<Name>` (themes/<slug>/blocks/<Name>/). */
export interface InstalledThemeBlock extends ThemeBlockDefinition {
  dir: string
}

const DEFINITIONS = import.meta.glob<{ default?: unknown }>("../../../themes/*/blocks/*/index.ts", { eager: true })

/** `.../themes/<slug>/blocks/<Name>/<file>` → slug and block directory. */
export function blockPathParts(path: string): { slug: string; dir: string } | null {
  const match = /themes\/([^/]+)\/blocks\/([^/]+)\/[^/]+$/.exec(path.replaceAll("\\", "/"))
  return match ? { slug: match[1], dir: match[2] } : null
}

const isDefinition = (value: unknown): value is ThemeBlockDefinition =>
  !!value && typeof value === "object" && typeof (value as ThemeBlockDefinition).type === "string" && !!(value as ThemeBlockDefinition).node

/**
 * The definitions in `modules` (a glob of the blocks' index.ts), sorted by type. Throws on
 * a module without a `defineThemeBlock` default export, a type outside its theme's
 * namespace (`theme:<slug>/…`) or a type declared twice: a build must not ship a block
 * the server, editor and API would disagree about. themeBlocks.loadable.test.ts runs this
 * over the repository's themes.
 */
export function collectThemeBlocks(modules: BlockModules): InstalledThemeBlock[] {
  const byType = new Map<string, InstalledThemeBlock>()
  for (const [path, module] of Object.entries(modules)) {
    const parts = blockPathParts(path)
    const definition = module.default
    if (!parts) throw new Error(`theme block ${path}: not under themes/<slug>/blocks/<Name>/`)
    if (!isDefinition(definition)) throw new Error(`theme block ${path}: index.ts must default-export defineThemeBlock(...)`)
    if (themeOfBlockType(definition.type) !== parts.slug) {
      throw new Error(`theme block ${path}: type "${definition.type}" must be theme:${parts.slug}/<block>`)
    }
    if (byType.has(definition.type)) throw new Error(`theme block ${path}: type "${definition.type}" is declared twice`)
    byType.set(definition.type, { ...definition, dir: `${parts.slug}/${parts.dir}` })
  }
  return [...byType.values()].sort((a, b) => (a.type < b.type ? -1 : 1))
}

export const installedThemeBlocks: InstalledThemeBlock[] = collectThemeBlocks(DEFINITIONS)

/** The block specs only (what the API's manifest carries). */
export const installedThemeBlockSpecs = (): ThemeBlockSpec[] =>
  installedThemeBlocks.map(({ type, version, attrs }) => ({ type, version, attrs }))

