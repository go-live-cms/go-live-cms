import React, { useEffect, useRef, useState } from "react"
import { getSettings, updateSettings, type Settings } from "@gl-admin/lib/api/settings"
import { authManager } from "@gl-admin/lib/auth"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import { toast } from "@gl-admin/components/ui/Toast"
import Input from "@gl-admin/components/ui/Input"
import Textarea from "@gl-admin/components/ui/Textarea"
import RadioGroup from "@gl-admin/components/ui/RadioGroup"
import SegmentedControl from "@gl-admin/components/ui/SegmentedControl"
import Switch from "@gl-admin/components/ui/Switch"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import Button from "@gl-admin/components/ui/Button"
import EmptyState from "@gl-admin/components/ui/EmptyState"
import UnsavedChangesBar from "@gl-admin/components/ui/UnsavedChangesBar"
import { focusFirstInvalid } from "@gl-admin/components/ui/a11y"
import SettingsNav from "@gl-admin/components/settings/SettingsNav"
import PrivacyPageField from "@gl-admin/components/settings/PrivacyPageField"
import {
  DISCUSSION_LIMITS,
  MODERATION_OPTIONS,
  ORDER_OPTIONS,
  THREADING_OPTIONS,
  apiFieldError,
  changedDiscussionFields,
  discussionUnsavedMessage,
  showDiscussionDetails,
  toDiscussionDraft,
  toDiscussionRequest,
  validateDiscussionDraft,
  type DiscussionDraft,
  type DiscussionField,
} from "@gl-admin/lib/discussionSettings"
import { usePageTitle } from "@gl-admin/lib/hooks/usePageTitle"
import "@gl-admin/assets/styles/pages/workspace.scss"

// Settings › Discussion (#527, docs/design/reader-comments.md 12.1; the canvas's "Settings ·
// Discussion" board and the "Discussion settings…" board's off and invalid states): its own
// page after Editor in the Settings menu, grouped Moderation, Display and Privacy, with the
// General page's unsaved-changes bar. Off shows the switch alone. Admins only (the route's
// AdminOnly; PUT /settings is requireSiteAdmin, and GET /settings sends the word lists only
// with an admin's token).
//
// The site switch shows since the moderation queue shipped (#526; design section 17:
// comments can be turned on after phase 3). It starts off (comments_enabled's default).

const inputValue = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => e.currentTarget.value

export default function SettingsDiscussion() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draft, setDraft] = useState<DiscussionDraft | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Partial<Record<DiscussionField, string>>>({})
  // Errors show once a save was tried, then follow the typing.
  const [tried, setTried] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  usePageTitle("Discussion settings")

  const load = async () => {
    setLoadError(null)
    try {
      const data = await getSettings(authManager.getState().accessToken || undefined)
      setSettings(data)
      setDraft(toDiscussionDraft(data))
    } catch (error) {
      setLoadError(error)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const saved = settings ? toDiscussionDraft(settings) : null
  const changed = draft ? changedDiscussionFields(saved, draft) : []

  const update = (patch: Partial<DiscussionDraft>) => {
    if (!draft) return
    const next = { ...draft, ...patch }
    setDraft(next)
    if (tried) setErrors(validateDiscussionDraft(next))
    setSaveError(null)
  }

  // Focus the first invalid field once React has drawn the errors: an effect after that
  // commit, not a frame later (a frame raced the errors under load).
  const [focusRequest, setFocusRequest] = useState(0)
  const focusInvalid = () => setFocusRequest((n) => n + 1)
  useEffect(() => {
    if (focusRequest > 0 && formRef.current) focusFirstInvalid(formRef.current)
  }, [focusRequest])

  const handleSave = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!draft || !saved || changed.length === 0 || saving) return
    setTried(true)
    const invalid = validateDiscussionDraft(draft)
    setErrors(invalid)
    if (Object.keys(invalid).length > 0) {
      setSaveError("Fix the fields marked in red to save.")
      focusInvalid()
      return
    }
    try {
      setSaving(true)
      const updated = await updateSettings(toDiscussionRequest(draft, saved), authManager.getState().accessToken || undefined)
      setSettings(updated)
      setDraft(toDiscussionDraft(updated))
      setTried(false)
      setErrors({})
      toast.success(
        updated.comments_enabled !== settings?.comments_enabled
          ? updated.comments_enabled
            ? "Comments are on"
            : "Comments are off"
          : "Discussion settings saved"
      )
    } catch (error) {
      const fieldError = error instanceof ApiError ? apiFieldError(error.code, error.serverMessage) : null
      if (fieldError) {
        setErrors({ [fieldError.field]: fieldError.message })
        setSaveError("Fix the fields marked in red to save.")
        focusInvalid()
      } else {
        setSaveError(`Couldn't save. ${errorMessage(error)}`)
      }
    } finally {
      setSaving(false)
    }
  }

  const handleDiscard = () => {
    if (saved) setDraft(saved)
    setErrors({})
    setTried(false)
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
          title="Couldn't load the discussion settings"
          description={errorMessage(loadError)}
          action={
            <Button variant="primary" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  if (!draft || !saved) {
    return (
      <div className="gl-workspace gl-workspace--medium" aria-busy="true">
        {header}
        <div className="gl-workspace__fields" aria-hidden="true">
          <Skeleton height={60} className="is-wide" />
          <Skeleton height={120} className="is-wide" />
        </div>
      </div>
    )
  }

  const details = showDiscussionDetails(draft)
  const numberField = (field: "comments_max_links" | "comments_close_after_days" | "comments_per_page", title: string, hint: string) => (
    <Input
      title={title}
      name={field}
      unmasked
      inputMode="numeric"
      hint={hint}
      error={errors[field]}
      value={draft[field]}
      onChange={(e) => update({ [field]: inputValue(e) })}
    />
  )

  return (
    <div className="gl-settings">
      <div className="gl-workspace gl-workspace--medium">
        {header}

        <div className="gl-settings__layout">
          <SettingsNav page="discussion" />

          <div className="gl-settings__content">
            <form
              ref={formRef}
              className="gl-settings__form"
              onSubmit={handleSave}
              onKeyDown={(e) => {
                // Enter in a one-line field saves, as on General; the bar's buttons are outside the form.
                const target = e.target as HTMLElement
                if (e.key === "Enter" && target.tagName === "INPUT" && target.getAttribute("type") !== "radio") {
                  e.preventDefault()
                  void handleSave()
                }
              }}
              noValidate
            >
              <section className="gl-workspace__section" id="gl-settings-discussion" aria-labelledby="gl-settings-discussion-h">
                <div>
                  <h2 className="gl-workspace__section-title" id="gl-settings-discussion-h">
                    Discussion
                  </h2>
                  <p className="gl-workspace__section-intro">
                    Reader comments on published posts. Each post type turns them on in Post types, and each post can open, close or
                    hide its own.
                  </p>
                </div>

                <div className="gl-settings__card">
                  <Switch
                    label="Allow comments on this site"
                    description="Off: no post shows a comments section and none takes new comments. Comments you already have are kept."
                    checked={draft.comments_enabled}
                    onChange={(checked) => update({ comments_enabled: checked })}
                  />
                </div>
                {!details && (
                  <p className="gl-workspace-field__hint">The rest of the settings appear when comments are on.</p>
                )}
              </section>

              {details && (
                <>
                  <section className="gl-workspace__section" aria-labelledby="gl-settings-moderation-h">
                    <h3 className="gl-settings__group-title" id="gl-settings-moderation-h">
                      Moderation
                    </h3>
                    <RadioGroup
                      legend="When a comment waits for review"
                      variant="card"
                      options={MODERATION_OPTIONS}
                      value={draft.comments_moderation}
                      onChange={(value) => update({ comments_moderation: value as DiscussionDraft["comments_moderation"] })}
                    />
                    <div className="gl-workspace__fields">
                      {numberField(
                        "comments_max_links",
                        "Hold a comment with more links than",
                        `${DISCUSSION_LIMITS.comments_max_links[0]} to ${DISCUSSION_LIMITS.comments_max_links[1]}.`
                      )}
                    </div>
                    <div className="gl-workspace__fields">
                      <Textarea
                        label="Hold words"
                        name="comments_hold_words"
                        rows={4}
                        hint={`Comments or names with these wait for review. One per line, up to ${DISCUSSION_LIMITS.word_list_max}.`}
                        error={errors.comments_hold_words}
                        value={draft.comments_hold_words}
                        onChange={(e) => update({ comments_hold_words: inputValue(e) })}
                      />
                      <Textarea
                        label="Spam words"
                        name="comments_spam_words"
                        rows={4}
                        hint="Comments or names with these go straight to Spam. A spam word beats a hold word."
                        error={errors.comments_spam_words}
                        value={draft.comments_spam_words}
                        onChange={(e) => update({ comments_spam_words: inputValue(e) })}
                      />
                    </div>
                  </section>

                  <section className="gl-workspace__section" aria-labelledby="gl-settings-display-h">
                    <h3 className="gl-settings__group-title" id="gl-settings-display-h">
                      Display
                    </h3>
                    <div className="gl-workspace__fields">
                      {numberField(
                        "comments_close_after_days",
                        "Close comments after (days)",
                        "0 keeps them open. Counts from a post’s first publish; a post set to Open ignores it."
                      )}
                      {numberField(
                        "comments_per_page",
                        "Threads per page",
                        `${DISCUSSION_LIMITS.comments_per_page[0]} to ${DISCUSSION_LIMITS.comments_per_page[1]}. Each thread shows with all its replies.`
                      )}
                      <SegmentedControl
                        legend="Replies"
                        options={THREADING_OPTIONS}
                        value={draft.comments_threading}
                        onChange={(value) => update({ comments_threading: value })}
                        hint="Threaded shows a reply under its comment, two levels deep."
                      />
                      <SegmentedControl
                        legend="Order"
                        options={ORDER_OPTIONS}
                        value={draft.comments_order}
                        onChange={(value) => update({ comments_order: value })}
                      />
                    </div>
                  </section>

                  <section className="gl-workspace__section" aria-labelledby="gl-settings-privacy-h">
                    <h3 className="gl-settings__group-title" id="gl-settings-privacy-h">
                      Privacy
                    </h3>
                    <Textarea
                      label="Notice under the comment form"
                      name="comments_notice"
                      rows={3}
                      maxCount={DISCUSSION_LIMITS.notice_max}
                      hint="Plain text, one line. Readers see it under every comment form. Empty uses GoLive’s own notice."
                      error={errors.comments_notice}
                      value={draft.comments_notice}
                      onChange={(e) => update({ comments_notice: inputValue(e) })}
                    />
                    <div className="gl-workspace__fields">
                      <PrivacyPageField
                        value={draft.comments_privacy_page_id}
                        onChange={(id) => update({ comments_privacy_page_id: id })}
                        error={errors.comments_privacy_page_id}
                      />
                    </div>
                  </section>
                </>
              )}
            </form>
          </div>
        </div>
      </div>

      <UnsavedChangesBar
        visible={changed.length > 0}
        message={discussionUnsavedMessage(changed)}
        error={saveError}
        saving={saving}
        onSave={() => void handleSave()}
        onDiscard={handleDiscard}
      />
    </div>
  )
}
