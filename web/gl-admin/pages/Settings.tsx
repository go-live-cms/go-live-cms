import React, { useEffect, useState } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import { getSettings, updateSettings, type Settings } from "@gl-admin/lib/api/settings"
import { authManager } from "@gl-admin/lib/auth"
import { toast } from "@gl-admin/components/ui/Toast"
import Input from "@gl-admin/components/ui/Input"
import RadioGroup from "@gl-admin/components/ui/RadioGroup"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import Button from "@gl-admin/components/ui/Button"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import UnsavedChangesBar from "@gl-admin/components/ui/UnsavedChangesBar"
import { errorMessage } from "@gl-admin/lib/api/errors"
import {
  POSTS_PER_PAGE_MAX,
  changedFields,
  toDraft,
  unsavedMessage,
  validateDraft,
  type SettingsDraft,
} from "@gl-admin/lib/settingsForm"
import "@gl-admin/assets/styles/pages/workspace.scss"

// Settings (restyled in #343, the Settings board): the General section. Changes wait
// in the sticky unsaved-changes bar until saved or discarded.
//
// Hidden until #330: the tagline, language, time zone and date format, the Editor
// section and the sections nav (General is the only section). Hidden until #331: the
// "URLs & redirects" section and the link to it from the post URL structure.

const URL_OPTIONS = [
  {
    value: "slug",
    label: "By slug",
    description: <span className="gl-workspace__mono">/post/my-first-post</span>,
  },
  {
    value: "id",
    label: "By ID",
    description: <span className="gl-workspace__mono">/post/42</span>,
  },
]

const SettingsPage: React.FC = () => {
  const { baseTitle } = useGoLive()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    document.title = `${baseTitle} Settings`
    fetchSettings()
  }, [baseTitle])

  const fetchSettings = async () => {
    setLoadError(null)
    try {
      const token = authManager.getState().accessToken || undefined
      const data = await getSettings(token)
      setSettings(data)
      setDraft(toDraft(data))
    } catch (error) {
      console.error("Failed to fetch settings:", error)
      setLoadError(error)
    }
  }

  const saved = settings ? toDraft(settings) : null
  const changed = draft ? changedFields(saved, draft) : []

  const update = (patch: Partial<SettingsDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev))
    setSaveError(null)
  }

  const handleSave = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!draft || changed.length === 0 || saving) return
    const invalid = validateDraft(draft)
    if (invalid) {
      setSaveError(invalid)
      return
    }

    try {
      setSaving(true)
      const token = authManager.getState().accessToken || undefined
      const updatedSettings = await updateSettings(draft, token)

      setSettings(updatedSettings)
      setDraft(toDraft(updatedSettings))
      toast.success("Settings saved")

      // Note: In dev mode, changes take effect immediately
      // In production, you'll need to trigger a rebuild
      if (draft.post_url_structure !== settings?.post_url_structure) {
        toast.info("URL structure changed. Restart dev server to see changes.", { duration: 5000 })
      }
    } catch (error) {
      console.error("Failed to save settings:", error)
      setSaveError(`Couldn't save. ${errorMessage(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDiscard = () => {
    if (saved) setDraft(saved)
    setSaveError(null)
  }

  const header = (
    <header className="gl-workspace__header">
      <div className="gl-workspace__heading">
        <h1>Settings</h1>
      </div>
    </header>
  )

  if (loadError) {
    return (
      <div className="gl-workspace gl-workspace--medium">
        {header}
        <EmptyState
          variant="error"
          icon="close"
          title="Couldn't load settings"
          description={errorMessage(loadError)}
          action={
            <Button variant="primary" onClick={fetchSettings}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  if (!draft) {
    return (
      <div className="gl-workspace gl-workspace--medium" aria-busy="true">
        {header}
        <div className="gl-workspace__fields" aria-hidden="true">
          <Skeleton height={60} />
          <Skeleton height={60} />
          <Skeleton height={96} className="is-wide" />
        </div>
      </div>
    )
  }

  return (
    <div className="gl-settings">
      <div className="gl-workspace gl-workspace--medium">
        {header}

        <form
          className="gl-workspace__section"
          onSubmit={handleSave}
          // Enter in a field saves, as before; the bar's buttons are outside the form.
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
              e.preventDefault()
              handleSave()
            }
          }}
          noValidate
          aria-labelledby="gl-settings-general"
        >
          <div>
            <h2 className="gl-workspace__section-title" id="gl-settings-general">
              General
            </h2>
            <p className="gl-workspace__section-intro">How your site is named and how posts are listed.</p>
          </div>
          <div className="gl-workspace__fields">
            <Input
              title="Site title"
              type="text"
              unmasked
              name="site_title"
              hint="Appears in browser tabs and search results."
              maxLength={200}
              value={draft.site_title}
              onChange={(e: any) => update({ site_title: e.currentTarget?.value ?? e.target?.value ?? "" })}
            />
            <Input
              title="Posts per page"
              unmasked
              name="posts_per_page"
              inputMode="numeric"
              hint={`On the blog home and archive pages, 1 to ${POSTS_PER_PAGE_MAX}.`}
              value={Number.isNaN(draft.posts_per_page) ? "" : String(draft.posts_per_page)}
              onChange={(e: any) => update({ posts_per_page: parseInt(e.currentTarget?.value ?? e.target?.value ?? "", 10) })}
            />
            <div className="is-wide">
              <RadioGroup
                legend="Post URL structure"
                variant="card"
                className="gl-settings__url"
                options={URL_OPTIONS}
                value={draft.post_url_structure}
                onChange={(value) => update({ post_url_structure: value as SettingsDraft["post_url_structure"] })}
              />
              <span className="gl-workspace-field__hint">
                Applies to every post. A post without a slug keeps its ID in the address.
              </span>
            </div>
          </div>
        </form>
      </div>

      <UnsavedChangesBar
        visible={changed.length > 0}
        message={unsavedMessage(changed)}
        error={saveError}
        saving={saving}
        onSave={() => handleSave()}
        onDiscard={handleDiscard}
      />
    </div>
  )
}

export default SettingsPage
