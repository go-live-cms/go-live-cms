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
