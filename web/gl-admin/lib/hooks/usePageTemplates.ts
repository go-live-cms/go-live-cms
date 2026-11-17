import { useCallback, useEffect, useState } from "react"
import { getPageTemplates } from "@gl-admin/lib/api/posts"
import { pageTemplateChoicesOf, type PageTemplateChoices } from "@gl-admin/lib/pageTemplates"

// What a page's Template field offers (#336, #494): the active theme's page layouts and
// its published Site editor page templates, from GET /posts/page-templates; null until
// they load. Rows and fields mounted together share one request. Every mount asks again
// (showing the last answer meanwhile), so a template published in the Site editor, or
// one reset there, shows up without a reload. A failed load with nothing to show sets
// `failed` (callers show stored names as they are); `retry` asks again.
let inflight: Promise<PageTemplateChoices | null> | null = null
let loaded: PageTemplateChoices | null = null
// Bumped by resetPageTemplates: a load started before a reset (another theme's list) is
// never cached, and never clears a newer load's slot.
let generation = 0

function loadChoices(): Promise<PageTemplateChoices | null> {
  if (!inflight) {
    const started = generation
    const load: Promise<PageTemplateChoices | null> = getPageTemplates()
      .then((body) => {
        // Reset meanwhile: this answer may be the old theme's, so ask again.
        if (started !== generation) return loadChoices()
        return (loaded = pageTemplateChoicesOf(body))
      })
      .catch(() => null)
      .finally(() => {
        if (inflight === load) inflight = null
      })
    inflight = load
  }
  return inflight
}

// Forget the cached list: after activating another theme.
export function resetPageTemplates(): void {
  generation++
  inflight = null
  loaded = null
}

export function usePageTemplates(): { choices: PageTemplateChoices | null; failed: boolean; retry: () => void } {
  const [choices, setChoices] = useState<PageTemplateChoices | null>(loaded)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setFailed(false)
    loadChoices().then((next) => {
      if (!live) return
      if (next) setChoices(next)
      else if (!loaded) setFailed(true)
    })
    return () => {
      live = false
    }
  }, [attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { choices, failed, retry }
}
