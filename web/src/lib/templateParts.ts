/**
 * Template parts (#412, docs/design/theme-builder.md 3.5 and 5.1): a header, a footer or
 * any part an admin makes, stored per theme as `site_templates` rows of kind `part`. A code
 * theme wraps its own chrome in `<TemplatePart slug="header">` (src/components/TemplatePart.astro)
 * so admins can customize just that part. Until #491 reads published parts, the component
 * always renders its slot, the theme's own markup.
 */
import { log } from "./log"

/** A part's slug, as `site_templates.slug`'s CHECK allows it. */
export const TEMPLATE_PART_SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/

export function isTemplatePartSlug(slug: unknown): slug is string {
  return typeof slug === "string" && TEMPLATE_PART_SLUG.test(slug)
}

const invalidLogged = new Set<string>()

/**
 * Logs a slug no part could have (a theme's typo), once per slug rather than on every
 * request. The part still renders its slot.
 */
export function checkTemplatePartSlug(slug: unknown): boolean {
  if (isTemplatePartSlug(slug)) return true
  const shown = String(slug).slice(0, 100)
  if (!invalidLogged.has(shown)) {
    invalidLogged.add(shown)
    log.warn("template_part_slug_invalid", { slug: shown })
  }
  return false
}
