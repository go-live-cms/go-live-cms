import { getActiveTheme } from "@gl-admin/lib/api/themes"
import { getPostTypes } from "@gl-admin/lib/api/postTypes"
import { getTaxonomyTypes } from "@gl-admin/lib/api/taxonomies"
import type { SiteVocabulary } from "@gl-admin/lib/siteDesign"

// What every Site editor screen reads about the active theme and the site (#493): the
// theme's name, the block templates and parts it ships (5.7), and the names of the site's
// types, page layouts and taxonomies the overview lists routes for. Only the theme read
// must succeed; the names fall back to the slugs.

export interface SiteDesignContext {
  themeName: string
  themeSlug: string
  shippedTemplates: Readonly<Record<string, { title?: string; doc?: unknown }>>
  shippedParts: Readonly<Record<string, { title?: string; doc?: unknown }>>
  vocabulary: SiteVocabulary
}

export async function loadSiteDesignContext(): Promise<SiteDesignContext> {
  const [theme, types, taxonomies] = await Promise.all([
    getActiveTheme(),
    getPostTypes().catch(() => null),
    getTaxonomyTypes().catch(() => null),
  ])
  const config = theme.config ?? ({} as typeof theme.config)
  return {
    themeName: theme.name,
    themeSlug: theme.slug,
    shippedTemplates: config.block_templates ?? {},
    shippedParts: config.block_parts ?? {},
    vocabulary: {
      postTypes: (types?.data ?? [])
        .filter((t) => t.name !== "post" && t.name !== "page" && t.public !== false && t.is_active !== false)
        .map((t) => ({ name: t.name, label: t.label || t.name })),
      pageLayouts: (config.page_templates ?? []).map((t) => ({ name: t.name, label: t.label || t.name })),
      taxonomies: (taxonomies?.data ?? []).filter((t) => t.public !== false).map((t) => ({ name: t.name, label: t.label || t.name })),
    },
  }
}
