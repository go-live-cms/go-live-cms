import { useEffect, useState } from "react"
import { getActiveTheme, type PageTemplate } from "@gl-admin/lib/api/themes"
import { pageTemplatesOf } from "@gl-admin/lib/pageTemplates"

// The active theme's page templates (#336), or null until they load. One request per
// page load for every row and field that shows them; a failed load stays null (callers
// show stored names as they are) and the next mount tries again.
let load: Promise<PageTemplate[] | null> | null = null
let loaded: PageTemplate[] | null = null

function loadTemplates(): Promise<PageTemplate[] | null> {
  if (!load) {
    load = getActiveTheme()
      .then((theme) => (loaded = pageTemplatesOf(theme?.config)))
      .catch(() => {
        load = null
        return null
      })
  }
  return load
}

// Forget the cached list: after activating another theme.
export function resetPageTemplates(): void {
  load = null
  loaded = null
}

export function usePageTemplates(): PageTemplate[] | null {
  const [templates, setTemplates] = useState<PageTemplate[] | null>(loaded)
  useEffect(() => {
    if (loaded) {
      setTemplates(loaded)
      return
    }
    let live = true
    loadTemplates().then((t) => live && t && setTemplates(t))
    return () => {
      live = false
    }
  }, [])
  return templates
}
