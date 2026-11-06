import { useEffect, useState } from "react"
import { Select } from "@gl-admin/components/ui/Select"
import Button from "@gl-admin/components/ui/Button"
import { getPostById, setPageTemplate } from "@gl-admin/lib/api/posts"
import { errorMessage } from "@gl-admin/lib/api/errors"
import { usePageTemplates } from "@gl-admin/lib/hooks/usePageTemplates"
import { describeTemplate, missingTemplateNote, templateOptions, templateRequestValue, templateValue } from "@gl-admin/lib/pageTemplates"

// A page's Template (#336) in the post settings panel: one of the active theme's page
// layouts, saved at once (PUT /posts/:id/template). On a published page it reaches the
// site on Update, like the other settings, so it calls `onSaved` (the "Settings
// changed" state). `settingsKey` changes when a restored version brought its own.

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
  const { templates, failed, retry } = usePageTemplates()
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

  const shown = describeTemplate(templates, stored)
  const hint = shown.missing ? missingTemplateNote(templateValue(stored), shown.label) : shown.description ?? "The layout your theme gives this page."
  return (
    <div>
      <Select
        label="Template"
        options={templates ? templateOptions(templates, stored) : [{ value: templateValue(stored), label: shown.label }]}
        value={templateValue(stored)}
        onChange={(value) => void pick(value)}
        disabled={readOnly || saving || !templates}
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
