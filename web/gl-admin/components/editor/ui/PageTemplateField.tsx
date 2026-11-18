import { useEffect, useState } from "react"
import { Select } from "@gl-admin/components/ui/Select"
import Button from "@gl-admin/components/ui/Button"
import { getPostById, setPageTemplate } from "@gl-admin/lib/api/posts"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { usePageTemplates } from "@gl-admin/lib/hooks/usePageTemplates"
import { describeTemplate, SITE_EDITOR_TAG, templateNote, templateOptions, templateRequestValue, templateValue } from "@gl-admin/lib/pageTemplates"

// A page's Template (#336) in the post settings panel: one of the active theme's page
// layouts or, under their own heading, its published Site editor page templates (#494),
// saved at once (PUT /posts/:id/template). On a published page it reaches the site on
// Update, like the other settings, so it calls `onSaved` (the "Settings changed" state).
// `settingsKey` changes when a restored version brought its own. A stored template the
// page can't use now (not in the theme, or not published there) stays shown, with what
// the page renders with instead.

export default function PageTemplateField({
  postId,
  initial,
  readOnly,
  settingsKey = 0,
  onSaved,
}: {
  postId: number
  initial: string | undefined
  readOnly: boolean
  settingsKey?: number
  onSaved?: () => void
}) {
  const { choices, failed, retry } = usePageTemplates()
  const [stored, setStored] = useState(initial ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (settingsKey === 0) return
    let live = true
    getPostById(postId)
      .then(({ post }) => live && setStored(post.page_template ?? ""))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [postId, settingsKey])

  const pick = async (value: string) => {
    const next = templateRequestValue(value)
    if (next === stored) return
    const previous = stored
    setStored(next)
    setSaving(true)
    setError(null)
    try {
      await setPageTemplate(postId, next)
      onSaved?.()
    } catch (e) {
      setStored(previous)
      setError(errorMessage(e, "Couldn't save the template"))
    } finally {
      setSaving(false)
    }
  }

  const shown = describeTemplate(choices, stored)
  const note = templateNote(choices, stored)
  const hint = note ?? shown.description ?? "The layout your theme gives this page."
  // While the list loads: the stored template alone, as it reads without the list.
  const loading = [{ value: templateValue(stored), label: shown.storedLabel, ...(shown.builder ? { tag: SITE_EDITOR_TAG } : {}) }]
  return (
    <div>
      <Select
        label="Template"
        options={choices ? templateOptions(choices, stored) : loading}
        value={templateValue(stored)}
        onChange={(value) => void pick(value)}
        disabled={readOnly || saving || !choices}
        hint={failed ? "Couldn't load the theme's templates." : hint}
        error={error}
      />
      {failed && (
        <Button variant="ghost" size="sm" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  )
}
