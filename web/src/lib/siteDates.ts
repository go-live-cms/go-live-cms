/**
 * Dates on the public site (#330): every date a theme shows goes through
 * `formatSiteDate`, with the site's language (month names), time zone (which day it is)
 * and date format preset (the order of day, month and year). Tested in siteDates.test.ts.
 *
 * The lists mirror the API's (api/settings_utils.go); siteDates.test.ts fails if they
 * drift apart.
 */

// The site languages (BCP-47), in the order the Settings page lists them.
export const SITE_LANGUAGES = [
  { tag: "en-US", label: "English (US)" },
  { tag: "en-GB", label: "English (UK)" },
  { tag: "pt-BR", label: "Português (Brasil)" },
  { tag: "pt-PT", label: "Português (Portugal)" },
  { tag: "es-ES", label: "Español" },
  { tag: "fr-FR", label: "Français" },
  { tag: "de-DE", label: "Deutsch" },
  { tag: "it-IT", label: "Italiano" },
  { tag: "nl-NL", label: "Nederlands" },
] as const

export type SiteLanguage = (typeof SITE_LANGUAGES)[number]["tag"]

export const DATE_FORMATS = ["month_day_year", "day_month_year", "iso"] as const
export type DateFormat = (typeof DATE_FORMATS)[number]

export interface DateSettings {
  language: SiteLanguage
  timeZone: string
  dateFormat: DateFormat
}

export const DEFAULT_DATE_SETTINGS: DateSettings = { language: "en-US", timeZone: "UTC", dateFormat: "month_day_year" }

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

// Whatever the API sent, as settings formatSiteDate can use: anything unknown is the
// default (an old API, a zone this Node's ICU doesn't have).
export function normalizeDateSettings(raw: { language?: unknown; timeZone?: unknown; dateFormat?: unknown }): DateSettings {
  const language = SITE_LANGUAGES.find((l) => l.tag === raw.language)?.tag ?? DEFAULT_DATE_SETTINGS.language
  const timeZone = typeof raw.timeZone === "string" && raw.timeZone && isTimeZone(raw.timeZone) ? raw.timeZone : DEFAULT_DATE_SETTINGS.timeZone
  const dateFormat = DATE_FORMATS.find((f) => f === raw.dateFormat) ?? DEFAULT_DATE_SETTINGS.dateFormat
  return { language, timeZone, dateFormat }
}

// "long": October 27, 2026 (posts). "short": Oct 27, 2026 (lists, cards).
export type DateStyle = "long" | "short"

/**
 * The date as the site shows it, or "" for an invalid date.
 *
 * month_day_year / day_month_year: when the language's own format already has that
 * order it is used as is ("27 de outubro de 2026", "27. Oktober 2026"); otherwise the
 * parts are put in the preset's order ("October 27, 2026", "27 October 2026"). iso is
 * 2026-10-27 in any language. The day is the day in the site's time zone.
 */
export function formatSiteDate(date: Date | string | number, settings: DateSettings, style: DateStyle = "long"): string {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ""
  const { language, timeZone, dateFormat } = settings

  if (dateFormat === "iso") {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d)
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
    return `${get("year")}-${get("month")}-${get("day")}`
  }

  const format = new Intl.DateTimeFormat(language, { timeZone, year: "numeric", month: style, day: "numeric" })
  const parts = format.formatToParts(d)
  const order = parts.filter((p) => p.type === "day" || p.type === "month").map((p) => p.type)
  const dayFirst = order[0] === "day"
  if (dayFirst === (dateFormat === "day_month_year")) return format.format(d)

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return dateFormat === "day_month_year"
    ? `${get("day")} ${get("month")} ${get("year")}`
    : `${get("month")} ${get("day")}, ${get("year")}`
}

/** The calendar day in the site's time zone, as YYYY-MM-DD (to compare two dates). */
export function siteDay(date: Date, settings: DateSettings): string {
  return formatSiteDate(date, { ...settings, dateFormat: "iso" })
}
