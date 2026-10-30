import React, { useEffect, useMemo, useState } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import { getSettings, updateSettings, type Settings } from "@gl-admin/lib/api/settings"
import { authManager } from "@gl-admin/lib/auth"
import { setEditorSettings } from "@gl-admin/lib/editorSettings"
import { toast } from "@gl-admin/components/ui/Toast"
import Input from "@gl-admin/components/ui/Input"
import RadioGroup from "@gl-admin/components/ui/RadioGroup"
import { Select } from "@gl-admin/components/ui/Select"
import Combobox from "@gl-admin/components/ui/Combobox"
import Switch from "@gl-admin/components/ui/Switch"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import Button from "@gl-admin/components/ui/Button"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import UnsavedChangesBar from "@gl-admin/components/ui/UnsavedChangesBar"
import { CheckIcon, ExternalIcon, WarningIcon } from "@gl-admin/components/ui/icons"
import { errorMessage } from "@gl-admin/lib/api/errors"
import {
  LANGUAGE_OPTIONS,
  POSTS_PER_PAGE_MAX,
  SITE_TAGLINE_MAX,
  changedFields,
  dateFormatOptions,
  siteAddressInfo,
  timeZoneOptions,
  toDraft,
  toUpdateRequest,
  unsavedMessage,
  validateDraft,
  type SettingsDraft,
} from "@gl-admin/lib/settingsForm"
import "@gl-admin/assets/styles/pages/workspace.scss"

// Settings (#343, #330; the Settings board): General and Editor. Changes wait in the
// sticky unsaved-changes bar until saved or discarded. Admins only (the route's
// AdminOnly; the API's requireSiteAdmin).
//
// Hidden until their issues land: "Allowed embeds" (#352: there's no embed block yet;
// the API stores and checks the list), the "URLs & redirects" section and the link to
// it from the post URL structure (#331), and the Media (#325) and Email sections.

// The domain is deploy config, not a setting: "Change domain" opens the runbook.
const CHANGE_DOMAIN_URL = "https://github.com/go-live-cms/go-live-cms/blob/main/docs/operations/deploy.md#change-the-domain"

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "editor", label: "Editor" },
]

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

const inputValue = (e: any): string => e.currentTarget?.value ?? e.target?.value ?? ""

const SettingsPage: React.FC = () => {
  const { baseTitle } = useGoLive()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [section, setSection] = useState("general")

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
  // Today, as the site would show it with the chosen language and time zone.
  const sample = useMemo(() => new Date(), [])
  const timeZones = useMemo(() => timeZoneOptions(settings?.site_timezone ?? ""), [settings?.site_timezone])

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
      const updatedSettings = await updateSettings(toUpdateRequest(draft), token)

      setSettings(updatedSettings)
      setDraft(toDraft(updatedSettings))
      // Editors opened from now on use the new Markdown shortcuts setting.
      setEditorSettings(updatedSettings)
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

  if (!draft || !settings) {
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

  const address = siteAddressInfo(settings.site_address)

  return (
    <div className="gl-settings">
      <div className="gl-workspace gl-workspace--medium">
        {header}

        <div className="gl-settings__layout">
          <nav className="gl-settings__nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#gl-settings-${s.id}`}
                aria-current={section === s.id ? "true" : undefined}
                onClick={() => setSection(s.id)}
              >
                {s.label}
              </a>
            ))}
          </nav>

          <form
            className="gl-settings__content"
            onSubmit={handleSave}
            // Enter in a field saves, as before; the bar's buttons are outside the form.
            onKeyDown={(e) => {
              const target = e.target as HTMLElement
              if (e.key === "Enter" && target.tagName === "INPUT" && target.getAttribute("role") !== "combobox") {
                e.preventDefault()
                handleSave()
              }
            }}
            noValidate
          >
            <section className="gl-workspace__section" id="gl-settings-general" aria-labelledby="gl-settings-general-h">
              <div>
                <h2 className="gl-workspace__section-title" id="gl-settings-general-h">
                  General
                </h2>
                <p className="gl-workspace__section-intro">How your site is named, how dates appear and how posts are listed.</p>
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
                  onChange={(e: any) => update({ site_title: inputValue(e) })}
                />
                <Input
                  title="Tagline"
                  type="text"
                  unmasked
                  name="site_tagline"
                  hint="A line about your site. Themes show it, and search results use it when a page has no description."
                  maxLength={SITE_TAGLINE_MAX}
                  value={draft.site_tagline}
                  onChange={(e: any) => update({ site_tagline: inputValue(e) })}
                />

                <div className="is-wide gl-settings__address-field">
                  <span className="gl-settings__label" id="gl-settings-address-label">
                    Site address
                  </span>
                  <div className="gl-settings__address" aria-labelledby="gl-settings-address-label" role="group">
                    <span className="gl-settings__address-url">{address?.address ?? "Not configured"}</span>
                    {address &&
                      (address.https ? (
                        <span className="gl-settings__https is-on">
                          <CheckIcon size={12} aria-hidden="true" />
                          HTTPS on
                        </span>
                      ) : (
                        <span className="gl-settings__https is-off">
                          <WarningIcon size={12} aria-hidden="true" />
                          No HTTPS
                        </span>
                      ))}
                    <Button
                      as="a"
                      variant="ghost"
                      size="sm"
                      href={CHANGE_DOMAIN_URL}
                      target="_blank"
                      rel="noreferrer"
                      icon={<ExternalIcon size={14} aria-hidden="true" />}
                    >
                      Change domain
                    </Button>
                  </div>
                  <span className="gl-workspace-field__hint">Set when the site is deployed (PUBLIC_BASE_URL).</span>
                </div>

                <Select
                  label="Language"
                  options={LANGUAGE_OPTIONS}
                  value={draft.site_language}
                  onChange={(value) => update({ site_language: value as SettingsDraft["site_language"] })}
                  hint="The language of your site: month names and the page's language for browsers and screen readers."
                />
                <Combobox
                  label="Time zone"
                  options={timeZones}
                  value={draft.site_timezone || null}
                  onChange={(value) => update({ site_timezone: value ?? "" })}
                  placeholder="Search time zones"
                  hint="Dates on your site are shown in this time zone."
                />

                <div className="is-wide">
                  <RadioGroup
                    legend="Date format"
                    className="gl-settings__date-format"
                    options={dateFormatOptions(draft, sample)}
                    value={draft.date_format}
                    onChange={(value) => update({ date_format: value as SettingsDraft["date_format"] })}
                  />
                </div>

                <Input
                  title="Posts per page"
                  unmasked
                  name="posts_per_page"
                  inputMode="numeric"
                  hint={`On the blog home and archive pages, 1 to ${POSTS_PER_PAGE_MAX}.`}
                  value={Number.isNaN(draft.posts_per_page) ? "" : String(draft.posts_per_page)}
                  onChange={(e: any) => update({ posts_per_page: parseInt(inputValue(e), 10) })}
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
            </section>

            <hr className="gl-workspace__rule" />

            <section className="gl-workspace__section" id="gl-settings-editor" aria-labelledby="gl-settings-editor-h">
              <div>
                <h2 className="gl-workspace__section-title" id="gl-settings-editor-h">
                  Editor
                </h2>
                <p className="gl-workspace__section-intro">Applies to everyone in this workspace.</p>
              </div>
              <div className="gl-settings__card">
                <Switch
                  label="Markdown shortcuts"
                  description="Typing #, - or > at the start of a line turns it into a heading, list or quote. Applies to posts opened after you save."
                  checked={draft.editor_markdown_shortcuts}
                  onChange={(checked) => update({ editor_markdown_shortcuts: checked })}
                />
              </div>
            </section>
          </form>
        </div>
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
