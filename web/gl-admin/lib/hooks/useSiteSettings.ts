import { useEffect, useState } from "react"
import { getSettings, type Settings } from "@gl-admin/lib/api/settings"
import { DEFAULT_DATE_SETTINGS, normalizeDateSettings, type DateSettings } from "@/lib/siteDates"

// The site settings (title, URL structure), or null until they load. A failed load
// stays null: callers fall back (id URLs, no site name).
export function useSiteSettings(): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    let live = true
    getSettings()
      .then((s) => live && setSettings(s))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  return settings
}

// One request for every pill on a page: list rows each show a scheduled time.
let dateSettingsLoad: Promise<DateSettings | null> | null = null
let dateSettingsLoaded: DateSettings | null = null

export function loadSiteDateSettings(): Promise<DateSettings | null> {
  if (!dateSettingsLoad) {
    dateSettingsLoad = getSettings()
      .then((s) => {
        dateSettingsLoaded = normalizeDateSettings({ language: s.site_language, timeZone: s.site_timezone, dateFormat: s.date_format })
        return dateSettingsLoaded
      })
      .catch(() => {
        // Not loaded: callers keep `loaded: false` (the Schedule dialog can't schedule
        // without the real zone). The next mount tries again.
        dateSettingsLoad = null
        return null
      })
  }
  return dateSettingsLoad
}

// The settings once loaded (null before): the editor's date chips (#320) format with them.
export function loadedSiteDateSettings(): DateSettings | null {
  return dateSettingsLoaded
}

// Forget the cached settings: Settings calls it after a save, so a new time zone shows.
export function resetSiteDateSettings(): void {
  dateSettingsLoad = null
  dateSettingsLoaded = null
}

// The site's language, time zone (#330) and date format, for dates the admin shows in
// site time (scheduled publishing, #147). The defaults (UTC) until they load; `loaded`
// says whether they have (false after a failed load too).
export function useSiteDateSettings(): DateSettings & { loaded: boolean } {
  const [settings, setSettings] = useState<DateSettings | null>(dateSettingsLoaded)

  useEffect(() => {
    // Loaded between this render and this effect: take it now.
    if (dateSettingsLoaded) {
      setSettings(dateSettingsLoaded)
      return
    }
    let live = true
    loadSiteDateSettings().then((s) => live && s && setSettings(s))
    return () => {
      live = false
    }
  }, [])

  return { ...(settings ?? DEFAULT_DATE_SETTINGS), loaded: !!settings }
}
