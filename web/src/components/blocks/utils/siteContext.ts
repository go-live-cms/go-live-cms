import { createContext, useContext } from "react"
import type { BlockDocV1 } from "@gl-admin/lib/blocks-spec"
import type { BlockMedia } from "./responsiveImage"

/**
 * What the site blocks (#488, design `docs/design/theme-builder.md` 4.1–4.3) read on the
 * page. SSR fills it **before** the synchronous render (`src/lib/siteRenderContext.ts`
 * `loadSiteRenderContext`): React's server render can't wait for data, so every menu, the
 * logo and every part a template names are loaded first, and a block only looks its data
 * up here. Browser-safe: no Node or fetch imports, so the admin's revision preview can
 * render site blocks too (as nothing).
 *
 * **Outside a template or a part there is none, and every site block renders nothing**: a
 * post's body never gets one, so a site block written into a post's Yjs doc stores and
 * shows nothing (design 4.2). `BlockTemplateLayout` (#491) provides it; a post's own body
 * rendered inside a template (`post_content`, #489) must clear it again (`site={null}` on
 * its `BlockRenderer`), or that post's site blocks would come alive there.
 */

/** A menu link as `src/lib/menus.ts` normalizes it (every href checked), current page marked. */
export interface SiteMenuLink {
  id: number
  label: string
  url: string
  children: SiteMenuLink[]
  current?: boolean
}

export interface SiteMenu {
  name: string
  items: SiteMenuLink[]
}

export interface SiteRenderContext {
  /** Always true: a context that isn't for a template or a part is no context. */
  inTemplate: true
  /** A block template, or a part rendered inside one (a part can't hold a part). */
  kind: "template" | "part"
  /** Settings › General: the title and the tagline ("" = none). */
  site: { title: string; tagline: string }
  /** The site logo (`settings.site_logo_media_id`) with its media, or null for none. */
  logo: { media: BlockMedia; alt: string } | null
  /** Menus by theme location (`/public/menus/:location`); null when none is assigned or it failed. */
  menusByLocation: Readonly<Record<string, SiteMenu | null>>
  /**
   * Menus by id, only the ones a published template or part names, attached by the resolve
   * route (#491, design 3.3): no public route serves an arbitrary menu by id. Missing = the
   * menu was deleted, and the block renders nothing.
   */
  menusById: Readonly<Record<string, SiteMenu | null>>
  /** The resolved parts by slug (#491): the published override, the theme's, or core's starter. */
  parts: Readonly<Record<string, BlockDocV1 | null>>
  /** The page being rendered (its path), for `aria-current`. */
  currentPath?: string
}

export const SiteContext = createContext<SiteRenderContext | null>(null)

/** The context a site block renders from, or null, in which case it renders nothing. */
export function useSiteRenderContext(): SiteRenderContext | null {
  const site = useContext(SiteContext)
  return site?.inTemplate === true ? site : null
}

/** "/", without the query or hash: what the home link and `aria-current` compare. */
export function isHomePath(path: string | undefined): boolean {
  return typeof path === "string" && path.startsWith("/") && path.split(/[?#]/)[0].replace(/\/+$/, "") === ""
}
