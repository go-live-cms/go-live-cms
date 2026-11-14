/**
 * Filling the site blocks' render context before the synchronous render (#488, design
 * `docs/design/theme-builder.md` 4.3). A block template's layout (#491) calls
 * `loadSiteRenderContext` with the template's doc and its resolved parts, then hands the
 * result to `BlockRenderer`'s `site`; the blocks only look their data up in it
 * (`src/components/blocks/utils/siteContext.ts`).
 *
 * - The title, tagline and logo are the request's one `/settings` read (`getSiteSettings`).
 * - A menu by **location** is read from `/public/menus/:location` (`getMenu`: 2 s, `null` on a
 *   404 or a failure, logged `menu_fetch_failed`), once per location, whatever number of
 *   blocks name it. A menu by **id** isn't fetched here: no public route serves any menu by
 *   id. The resolve route attaches the ones a published template or part names (#491, 3.3),
 *   and the caller passes them as `menusById`.
 * - Failures fail soft: that block renders nothing, the rest of the page renders.
 */
import { isMenuLocation, isSiteBlockType, normalizeSiteBlockAttrs, type BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import type { SiteMenu, SiteRenderContext } from "@/components/blocks/utils/siteContext"
import { getMenu, withCurrent, type Menu } from "./menus"
import { getSiteSettings } from "./siteSettings"

/** What the site blocks of some docs need loaded: the theme locations, menu ids and part slugs they name. */
export interface SiteBlockNeeds {
  locations: string[]
  menuIds: number[]
  parts: string[]
}

/** Every location, menu id and part slug that `docs`' site blocks name, each once, sorted. */
export function siteBlockNeeds(docs: Iterable<BlockDocV1 | null | undefined>): SiteBlockNeeds {
  const locations = new Set<string>()
  const menuIds = new Set<number>()
  const parts = new Set<string>()
  for (const doc of docs) {
    const blocks = doc?.blocks && typeof doc.blocks === "object" ? Object.values(doc.blocks) : []
    for (const block of blocks) {
      if (!block || typeof block !== "object" || !isSiteBlockType(block.type)) continue
      const attrs = normalizeSiteBlockAttrs(block.type, block.attrs)
      if (block.type === "navigation") {
        if (typeof attrs.menuId === "number") menuIds.add(attrs.menuId)
        else if (isMenuLocation(attrs.location)) locations.add(attrs.location)
      } else if (block.type === "template_part" && typeof attrs.slug === "string") {
        parts.add(attrs.slug)
      }
    }
  }
  return { locations: [...locations].sort(), menuIds: [...menuIds].sort((a, b) => a - b), parts: [...parts].sort() }
}

function siteMenu(menu: Menu | null, currentPath: string | undefined): SiteMenu | null {
  if (!menu) return null
  return { name: menu.name, items: currentPath ? withCurrent(menu.items, currentPath) : menu.items }
}

export interface LoadSiteRenderContextOptions {
  /** The template's doc (and anything else rendered with the context but its parts). */
  docs: Iterable<BlockDocV1 | null | undefined>
  /** The resolved parts by slug (#491). */
  parts?: Readonly<Record<string, BlockDocV1 | null>>
  /** The menus a published template or part names by id, from the resolve route (#491). */
  menusById?: Readonly<Record<string, Menu | null>>
  /** The page's path, for `aria-current`. */
  currentPath?: string
  /** For tests: what reads a menu by location. */
  readMenu?: (location: string) => Promise<Menu | null>
}

/**
 * The context for a block template's render. `locals` is the request's (`Astro.locals`), so
 * the settings are read once per request; the locations of the template's and its parts'
 * navigation blocks are read once each, in parallel.
 */
export async function loadSiteRenderContext(locals: App.Locals | undefined, options: LoadSiteRenderContextOptions): Promise<SiteRenderContext> {
  const parts = options.parts ?? {}
  const docs = [...options.docs, ...Object.values(parts)]
  const { locations } = siteBlockNeeds(docs)
  const readMenu = options.readMenu ?? ((location: string) => getMenu(location))
  const [settings, menus] = await Promise.all([
    getSiteSettings(locals),
    Promise.all(locations.map(async (location) => [location, await readMenu(location).catch(() => null)] as const)),
  ])
  const menusById = Object.fromEntries(Object.entries(options.menusById ?? {}).map(([id, menu]) => [id, siteMenu(menu, options.currentPath)]))
  return {
    inTemplate: true,
    kind: "template",
    site: { title: settings.title, tagline: settings.tagline },
    logo: settings.logo ? { media: settings.logo.media, alt: settings.logo.alt } : null,
    menusByLocation: Object.fromEntries(menus.map(([location, menu]) => [location, siteMenu(menu, options.currentPath)])),
    menusById,
    parts,
    currentPath: options.currentPath,
  }
}
