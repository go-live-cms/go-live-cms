import type { Settings } from "@gl-admin/lib/api/settings"
import { DATE_FORMATS, SITE_LANGUAGES, formatSiteDate, type DateFormat } from "@/lib/siteDates"

// The Settings form (#343, #330): what the page edits, which fields differ from the
// saved settings, and what the unsaved-changes bar says about them. The value lists
// mirror the API's (api/settings_utils.go); settingsForm.test.ts and siteDates.test.ts
// fail if they drift apart.

export type SettingsDraft = Pick<
  Settings,
  | "site_title"
  | "site_tagline"
  | "site_language"
  | "site_timezone"
  | "date_format"
  | "posts_per_page"
  | "post_url_structure"
  | "editor_markdown_shortcuts"
>

// In form order.
const FIELDS: { key: keyof SettingsDraft; label: string }[] = [
  { key: "site_title", label: "site title" },
  { key: "site_tagline", label: "tagline" },
  { key: "site_language", label: "language" },
  { key: "site_timezone", label: "time zone" },
  { key: "date_format", label: "date format" },
  { key: "posts_per_page", label: "posts per page" },
  { key: "post_url_structure", label: "post URL structure" },
  { key: "editor_markdown_shortcuts", label: "Markdown shortcuts" },
]

// The API's bounds (binding tags on the settings request).
export const POSTS_PER_PAGE_MIN = 1
export const POSTS_PER_PAGE_MAX = 100
export const SITE_TITLE_MAX = 200
export const SITE_TAGLINE_MAX = 160

// The embed providers the API accepts in editor_allowed_embeds. The control stays hidden
// until the embed block (#352) exists.
export const EMBED_PROVIDERS = [
  { id: "youtube", label: "YouTube" },
  { id: "vimeo", label: "Vimeo" },
  { id: "codepen", label: "CodePen" },
  { id: "spotify", label: "Spotify" },
  { id: "soundcloud", label: "SoundCloud" },
  { id: "loom", label: "Loom" },
  { id: "figma", label: "Figma" },
  { id: "x", label: "X (Twitter)" },
] as const

export const LANGUAGE_OPTIONS = SITE_LANGUAGES.map((l) => ({ value: l.tag, label: l.label }))

export function toDraft(settings: Settings): SettingsDraft {
  return {
    site_title: settings.site_title,
    site_tagline: settings.site_tagline ?? "",
    site_language: settings.site_language,
    site_timezone: settings.site_timezone,
    date_format: settings.date_format,
    posts_per_page: settings.posts_per_page,
    post_url_structure: settings.post_url_structure,
    editor_markdown_shortcuts: settings.editor_markdown_shortcuts ?? true,
  }
}

// Labels of the fields that differ, in form order.
export function changedFields(saved: SettingsDraft | null, draft: SettingsDraft): string[] {
  if (!saved) return []
  return FIELDS.filter(({ key }) => saved[key] !== draft[key]).map(({ label }) => label)
}

// "You changed the site title", "… the site title and posts per page", "… 3 settings".
export function unsavedMessage(changed: string[]): string {
  if (changed.length === 0) return ""
  if (changed.length === 1) return `You changed the ${changed[0]}`
  if (changed.length === 2) return `You changed the ${changed[0]} and ${changed[1]}`
  return `You changed ${changed.length} settings`
}

// A message naming the fix, or null. posts_per_page is NaN while the field is empty.
export function validateDraft(draft: SettingsDraft): string | null {
  if (!draft.site_title) return "Enter a site title."
  if ([...draft.site_title].length > SITE_TITLE_MAX) return `The site title can be at most ${SITE_TITLE_MAX} characters.`
  if ([...draft.site_tagline.trim()].length > SITE_TAGLINE_MAX) return `The tagline can be at most ${SITE_TAGLINE_MAX} characters.`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(draft.site_tagline)) return "The tagline must be a single line."
  if (!draft.site_timezone) return "Choose a time zone."
  const n = draft.posts_per_page
  if (!Number.isInteger(n) || n < POSTS_PER_PAGE_MIN || n > POSTS_PER_PAGE_MAX) {
    return `Posts per page must be a whole number from ${POSTS_PER_PAGE_MIN} to ${POSTS_PER_PAGE_MAX}.`
  }
  return null
}

// The PUT body: every edited field (the API keeps what's absent), the tagline trimmed as
// the API stores it.
export function toUpdateRequest(draft: SettingsDraft) {
  return { ...draft, site_tagline: draft.site_tagline.trim() }
}

// "UTC−3", "UTC+5:45", "UTC" for the zone's offset at `at`.
export function utcOffsetLabel(zone: string, at: Date = new Date()): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value
    if (!name || name === "GMT" || name === "GMT+0") return "UTC"
    return name.replace(/^GMT/, "UTC").replace("-", "−")
  } catch {
    return ""
  }
}

// "America/Sao_Paulo" → "America / Sao Paulo (UTC−3)". The offset is today's, so a zone
// with daylight saving time shows the one in effect now.
export function timeZoneLabel(zone: string, at: Date = new Date()): string {
  if (zone === "UTC") return "UTC"
  const name = zone.replace(/_/g, " ").replace(/\//g, " / ")
  const offset = utcOffsetLabel(zone, at)
  return offset ? `${name} (${offset})` : name
}

// The zones this browser knows, UTC first, plus the saved one if the browser lacks it
// (the API checks names against Go's tz database, not the browser's).
export function timeZoneOptions(current: string, at: Date = new Date(), zones?: string[]): { value: string; label: string }[] {
  let names = zones
  if (!names) {
    try {
      names = (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf("timeZone")
    } catch {
      names = []
    }
  }
  const all = ["UTC", ...names.filter((z) => z !== "UTC")]
  if (current && !all.includes(current)) all.push(current)
  return all.map((zone) => ({ value: zone, label: timeZoneLabel(zone, at) }))
}

// The date format choices, each labelled with a sample date in the draft's language and
// time zone, so the radio shows what readers will see.
export function dateFormatOptions(draft: Pick<SettingsDraft, "site_language" | "site_timezone">, sample: Date) {
  return DATE_FORMATS.map((format: DateFormat) => ({
    value: format,
    label: formatSiteDate(sample, { language: draft.site_language, timeZone: draft.site_timezone || "UTC", dateFormat: format }),
  }))
}

// The site address with its HTTPS state, for the read-only row.
export function siteAddressInfo(address: string): { address: string; https: boolean } | null {
  if (!address) return null
  try {
    return { address, https: new URL(address).protocol === "https:" }
  } catch {
    return null
  }
}
