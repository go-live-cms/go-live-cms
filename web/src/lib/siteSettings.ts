/**
 * Site settings the default theme's header and footer show (#345).
 */
import { getSettings } from "@/lib/api"
import { SITE_TITLE } from "@/consts"

export interface SiteSettings {
  title: string
  postsPerPage: number
  urlStructure: unknown
}

// Error pages render this too, and an unreachable API is a common cause of a 500: give
// up after a moment and use the defaults rather than hang the page.
const SETTINGS_TIMEOUT_MS = 2000

export async function getSiteSettings(): Promise<SiteSettings> {
  let settings: Record<string, unknown> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    settings = await Promise.race([
      getSettings(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SETTINGS_TIMEOUT_MS)
      }),
    ])
  } catch (error) {
    console.warn("[theme] Could not fetch settings:", error)
  } finally {
    clearTimeout(timer)
  }
  const title = typeof settings?.site_title === "string" && settings.site_title.trim() ? settings.site_title : SITE_TITLE
  const perPage = Number(settings?.posts_per_page)
  return {
    title,
    postsPerPage: Number.isInteger(perPage) && perPage > 0 ? perPage : 10,
    urlStructure: settings?.post_url_structure,
  }
}
