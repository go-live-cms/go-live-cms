/**
 * Site settings the public site uses (#345, #330): the title and tagline the theme shows,
 * the list and URL settings, and the language, time zone and date format that every date
 * on the site goes through (siteDates.ts).
 */
import { getSettings } from "@/lib/api"
import { SITE_TITLE } from "@/consts"
import { normalizeDateSettings, type DateSettings } from "@/lib/siteDates"
import { log } from "@/lib/log"
import { knownEmbedProviders, type EmbedProvider } from "@gl-admin/lib/blocks-spec/embeds"
import type { BlockMedia } from "@/components/blocks/utils/responsiveImage"

export interface SiteSettings extends DateSettings {
  title: string
  // "" = none.
  tagline: string
  postsPerPage: number
  urlStructure: unknown
  // Open signup (#191): the sign-in page offers "Create an account" only when it's on.
  // False when the settings can't be read: the API refuses then anyway.
  allowSignup: boolean
  // The page shown at / (#336), as stored (null = the latest posts). The page route uses
  // it for that page's canonical URL; whether / shows it is /public/front-page's answer.
  frontPageId: number | null
  // The sites embeds may come from (#425): the public CSP's frame-src. Empty when the
  // settings can't be read, so a failed lookup never widens what a page may frame.
  allowedEmbeds: EmbedProvider[]
  // The site logo (#488, `site_logo_media_id`): its media as the API attaches block media,
  // and its alt text. Null for none, a deleted one, or settings that can't be read.
  logo: SiteLogo | null
}

export interface SiteLogo {
  id: number
  media: BlockMedia
  alt: string
}

/** The API's `site_logo` (settings_presenters.go), or null for anything that isn't one. */
export function normalizeSiteLogo(value: unknown): SiteLogo | null {
  if (!value || typeof value !== "object") return null
  const logo = value as Record<string, unknown>
  const id = logo.id
  const path = logo.media_path
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0 || typeof path !== "string" || path === "") return null
  const size = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0)
  return {
    id,
    media: {
      media_path: path,
      width: size(logo.width),
      height: size(logo.height),
      variants: logo.variants && typeof logo.variants === "object" ? (logo.variants as BlockMedia["variants"]) : undefined,
    },
    alt: typeof logo.alt === "string" ? logo.alt.trim() : "",
  }
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
    log.warn("site_settings_fetch_failed", { error })
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
    allowSignup: settings?.allow_signup === true,
    frontPageId: Number.isInteger(settings?.front_page_id) && (settings?.front_page_id as number) > 0 ? (settings?.front_page_id as number) : null,
    allowedEmbeds: knownEmbedProviders(settings?.editor_allowed_embeds),
    logo: normalizeSiteLogo(settings?.site_logo),
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
