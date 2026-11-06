import { useCallback, useEffect, useState } from "react"
import { getActiveTheme, type PageTemplate } from "@gl-admin/lib/api/themes"
import { pageTemplatesOf } from "@gl-admin/lib/pageTemplates"

// The active theme's page templates (#336): null until they load. One request per page
// load for every row and field that shows them. A failed load sets `failed` (callers
// show stored names as they are) and is forgotten, so `retry` (or the next mount)
// asks again.
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

export function usePageTemplates(): { templates: PageTemplate[] | null; failed: boolean; retry: () => void } {
  const [templates, setTemplates] = useState<PageTemplate[] | null>(loaded)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (loaded) {
      setTemplates(loaded)
      return
    }
    let live = true
    setFailed(false)
    loadTemplates().then((t) => {
      if (!live) return
      if (t) setTemplates(t)
      else setFailed(true)
    })
    return () => {
      live = false
    }
  }, [attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { templates, failed, retry }
}
