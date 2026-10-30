/**
 * Picks a theme layout from a build-time glob (#272, #345): the active theme's
 * layouts/{kind}/{variant}.astro, then its default variant, then the default theme's.
 * Pages pass their own import.meta.glob map, whose keys are relative to the page.
 */
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
      console.warn(`Failed to load layout ${path}:`, error)
    }
  }
  return null
}

// Folders under layouts/ that hold page layouts rather than a post type's (home, archive,
// error, author, term, search): a post type with one of these names must not pick them up.
export const RESERVED_LAYOUT_KINDS = new Set(["home", "archive", "error", "author", "term", "search"])

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
