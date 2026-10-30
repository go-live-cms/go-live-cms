/**
 * Site settings the public site uses (#345, #330): the title and tagline the theme shows,
 * the list and URL settings, and the language, time zone and date format that every date
 * on the site goes through (siteDates.ts).
 */
import { getSettings } from "@/lib/api"
import { SITE_TITLE } from "@/consts"
import { normalizeDateSettings, type DateSettings } from "@/lib/siteDates"

export interface SiteSettings extends DateSettings {
  title: string
  // "" = none.
  tagline: string
  postsPerPage: number
  urlStructure: unknown
}

// Error pages render this too, and an unreachable API is a common cause of a 500: give
// up after a moment and use the defaults rather than hang the page.
const SETTINGS_TIMEOUT_MS = 2000

async function loadSiteSettings(): Promise<SiteSettings> {
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
  const tagline = typeof settings?.site_tagline === "string" ? settings.site_tagline.trim() : ""
  const perPage = Number(settings?.posts_per_page)
  return {
    title,
    tagline,
    postsPerPage: Number.isInteger(perPage) && perPage > 0 ? perPage : 10,
    urlStructure: settings?.post_url_structure,
    ...normalizeDateSettings({
      language: settings?.site_language,
      timeZone: settings?.site_timezone,
      dateFormat: settings?.date_format,
    }),
  }
}

const LOCALS_KEY = "siteSettings"

/**
 * The site settings, fetched once per request when given the request's `Astro.locals`:
 * the layout, the head and every date on a page share one lookup.
 */
export function getSiteSettings(locals?: App.Locals): Promise<SiteSettings> {
  if (!locals) return loadSiteSettings()
  locals[LOCALS_KEY] ??= loadSiteSettings()
  return locals[LOCALS_KEY] as Promise<SiteSettings>
}
