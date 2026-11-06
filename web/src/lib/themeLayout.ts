/**
 * Picks a theme layout from a build-time glob (#272, #345): the active theme's
 * layouts/{kind}/{variant}.astro, then its default variant, then the default theme's.
 * Pages pass their own import.meta.glob map, whose keys are relative to the page.
 */
import { log } from "./log"

type LayoutGlob = Record<string, () => Promise<unknown>>

export function themeLayoutCandidates(prefix: string, themeSlug: string, kind: string, variant = "default"): string[] {
  const candidates = [
    `${prefix}/${themeSlug}/layouts/${kind}/${variant}.astro`,
    `${prefix}/${themeSlug}/layouts/${kind}/default.astro`,
    `${prefix}/default/layouts/${kind}/${variant}.astro`,
    `${prefix}/default/layouts/${kind}/default.astro`,
  ]
  return [...new Set(candidates)]
}

export async function loadThemeLayout(glob: LayoutGlob, candidates: string[]): Promise<any | null> {
  for (const path of candidates) {
    const load = glob[path]
    if (!load) continue
    try {
      const module = (await load()) as { default?: unknown }
      if (module.default) return module.default
    } catch (error) {
      log.warn("theme_layout_load_failed", { layout: path, error })
    }
  }
  return null
}

// Folders under layouts/ that hold page layouts rather than a post type's (home, archive,
// error, author, term, search): a post type with one of these names must not pick them up.
export const RESERVED_LAYOUT_KINDS = new Set(["home", "archive", "error", "author", "term", "search"])

// A page template's name (#336): a layout file's name, the API's rule
// (api/page_templates.go).
const PAGE_TEMPLATE_NAME = /^[A-Za-z0-9_-]{1,64}$/

// The layout variant a page renders with (#336): its own template (published, from
// /public) when the active theme has that page layout in this build, else the type's
// variant (the theme's layout_variants setting) when it has that one, else "default".
// A template the theme doesn't have (after a theme switch) renders as the default and
// stays stored, so switching back brings it back.
export function pageLayoutVariant(glob: LayoutGlob, prefix: string, themeSlug: string, template: string | undefined, typeVariant: string): string {
  const has = (name: string | undefined): name is string =>
    !!name && PAGE_TEMPLATE_NAME.test(name) && `${prefix}/${themeSlug}/layouts/page/${name}.astro` in glob
  if (has(template)) return template
  if (has(typeVariant)) return typeVariant
  return "default"
}

// The post route's chain: the type's own variant, the theme's generic post layouts, then
// the default theme's.
export function postLayoutCandidates(prefix: string, themeSlug: string, postType: string, variant: string): string[] {
  const own = !RESERVED_LAYOUT_KINDS.has(postType) && postType !== "post"
  return [
    ...new Set([
      ...(own ? [`${prefix}/${themeSlug}/layouts/${postType}/${variant}.astro`] : []),
      `${prefix}/${themeSlug}/layouts/post/${variant}.astro`,
      `${prefix}/${themeSlug}/layouts/post/default.astro`,
      ...(own ? [`${prefix}/default/layouts/${postType}/${variant}.astro`] : []),
      `${prefix}/default/layouts/post/${variant}.astro`,
      `${prefix}/default/layouts/post/default.astro`,
    ]),
  ]
}
