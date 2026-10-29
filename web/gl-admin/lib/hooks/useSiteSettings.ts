import { useEffect, useState } from "react"
import { getSettings, type Settings } from "@gl-admin/lib/api/settings"

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
