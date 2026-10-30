import { useEffect, useState } from "react"
import Input from "@gl-admin/components/ui/Input"
import Textarea from "@gl-admin/components/ui/Textarea"
import Button from "@gl-admin/components/ui/Button"
import Notice from "@gl-admin/components/ui/Notice"
import Skeleton from "@gl-admin/components/ui/Skeleton"
import { CheckIcon } from "@gl-admin/components/ui/icons"
import { ToastContainer, useToast } from "@gl-admin/components/Toast"
import { getMe, updateUser } from "@gl-admin/lib/api/users"
import type { User } from "@gl-admin/lib/api/types"
import { authManager } from "@gl-admin/lib/auth"
import { roleLabel } from "@gl-admin/lib/roles"
import {
  BIO_MAX,
  adoptPasswordChangeSession,
  authorFieldErrors,
  buildProfileUpdate,
  describePasswordChangeError,
  describeProfileError,
  newPasswordChecklist,
  validatePasswordChange,
  validateProfile,
  type PasswordFields,
  type ProfileFields,
} from "@gl-admin/lib/profile"
import "@gl-admin/assets/styles/pages/workspace.scss"
import "@gl-admin/assets/styles/pages/profile.scss"

const EMPTY_PASSWORDS: PasswordFields = { current_password: "", password: "", confirm_password: "" }

function toFields(user: User): ProfileFields {
  return {
    username: user.username || "",
    email: user.email || "",
    full_name: user.full_name || "",
    bio: user.bio || "",
    website: user.website || "",
  }
}

const inputValue = (e: any): string => e.currentTarget?.value ?? e.target?.value ?? ""

// "My profile" (#168, restyled in #343): any signed-in user, contributors included,
// edits their own name, username, bio and website (the public author page, #350) and
// changes their password. This doesn't use
// UserForm: that always sends `role` (403 for non-admins) and saves the password
// together with the profile.
//
// Hidden until #334: the avatar upload, changing the email address (it shows as
// text) and "Sign out of other devices" (a password change already signs out every
// other session). The password checklist shows the API's minimum until #329.
export default function Profile() {
  const { toasts, showSuccess, showError, removeToast } = useToast()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [fields, setFields] = useState<ProfileFields>({ username: "", email: "", full_name: "", bio: "", website: "" })
  // Field errors show once a save was tried, then follow the typing.
  const [showFieldErrors, setShowFieldErrors] = useState(false)
  const [passwords, setPasswords] = useState<PasswordFields>(EMPTY_PASSWORDS)
  const [savingProfile, setSavingProfile] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null)

  useEffect(() => {
    document.title = "GoLive Admin | My profile"
    let cancelled = false
    getMe()
      .then(({ user }) => {
        if (cancelled) return
        setUser(user)
        setFields(toFields(user))
      })
      .catch((err) => {
        console.error("Error loading profile:", err)
        if (!cancelled) showError("Failed to load your profile. Please try again.")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSaveProfile(e?: React.FormEvent) {
    e?.preventDefault()
    if (!user || savingProfile) return

    const invalid = validateProfile(fields)
    if (invalid) {
      setShowFieldErrors(true)
      showError(invalid)
      return
    }
    const update = buildProfileUpdate(toFields(user), fields)
    if (Object.keys(update).length === 0) {
      showSuccess("Nothing to save.")
      return
    }

    setSavingProfile(true)
    try {
      const { user: updated } = await updateUser(user.id, update)
      setUser(updated)
      setFields(toFields(updated))
      // Update the cached user so the sidebar shows the new name.
      authManager.setUser(updated)
      showSuccess("Profile saved.")
    } catch (err) {
      console.error("Error saving profile:", err)
      showError(describeProfileError(err))
    } finally {
      setSavingProfile(false)
    }
  }

  async function handleChangePassword(e?: React.FormEvent) {
    e?.preventDefault()
    if (!user || changingPassword) return
    setPasswordNotice(null)

    const invalid = validatePasswordChange(passwords)
    if (invalid) {
      setPasswordError(invalid)
      return
    }
    setPasswordError(null)

    setChangingPassword(true)
    try {
      const response = await updateUser(user.id, {
        password: passwords.password,
        current_password: passwords.current_password,
      } as Partial<User>)
      setPasswords(EMPTY_PASSWORDS)

      if (adoptPasswordChangeSession(authManager, response) === "reauth") {
        // The change went through but the API couldn't start a new session
        // for this tab, whose token is now revoked: sign in again. AuthGuard
        // redirects, and the login page says the password was changed.
        await authManager.logout("password-changed")
        return
      }
      setPasswordNotice("Password changed. You were signed out on all other devices and browsers.")
      showSuccess("Password changed.")
    } catch (err) {
      console.error("Error changing password:", err)
      setPasswordError(describePasswordChangeError(err))
    } finally {
      setChangingPassword(false)
    }
  }

  const header = (
    <header className="gl-workspace__header">
      <div className="gl-workspace__heading">
        <h1>My profile</h1>
      </div>
    </header>
  )

  if (loading) {
    return (
      <div className="gl-workspace gl-workspace--narrow gl-profile" aria-busy="true">
        {header}
        <div className="gl-workspace__fields" aria-hidden="true">
          <Skeleton height={60} />
          <Skeleton height={60} />
          <Skeleton height={60} />
        </div>
        <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="gl-workspace gl-workspace--narrow gl-profile">
        {header}
        <Notice tone="danger" live="none">
          Your profile could not be loaded. Reload the page to try again.
        </Notice>
        <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
      </div>
    )
  }

  const authorErrors = showFieldErrors ? authorFieldErrors(fields) : {}
  const rules = newPasswordChecklist(passwords.password, passwords.current_password)
  // Only once the confirmation is as long as the password, so typing it isn't an error.
  const mismatch =
    passwords.confirm_password !== "" &&
    passwords.confirm_password.length >= passwords.password.length &&
    passwords.confirm_password !== passwords.password

  return (
    <div className="gl-workspace gl-workspace--narrow gl-profile">
      {header}

      <form className="gl-workspace__section" onSubmit={handleSaveProfile} noValidate aria-labelledby="gl-profile-details">
        <h2 className="gl-workspace__section-title" id="gl-profile-details">
          Your details
        </h2>
        <div className="gl-workspace__fields">
          <Input
            title="Name"
            type="text"
            name="full_name"
            autoComplete="name"
            hint="Shown in bylines and next to your cursor."
            value={fields.full_name}
            onChange={(e: any) => setFields((prev) => ({ ...prev, full_name: inputValue(e) }))}
          />
          <Input
            title="Username"
            type="text"
            name="username"
            autoComplete="username"
            hint="If you change it, sign in with the new one next time."
            value={fields.username}
            onChange={(e: any) => setFields((prev) => ({ ...prev, username: inputValue(e) }))}
          />
          <div className="gl-profile__fact">
            <span className="gl-profile__fact-label">Email</span>
            <span className="gl-profile__fact-value">{user.email}</span>
          </div>
          <div className="gl-profile__fact">
            <span className="gl-profile__fact-label">Role</span>
            <span className="gl-profile__fact-value">{roleLabel(user.role)}</span>
            <span className="gl-workspace-field__hint">Roles are set by an admin in Users.</span>
          </div>
          <Textarea
            label="Bio"
            name="bio"
            optional
            rows={3}
            maxCount={BIO_MAX}
            containerClassName="is-wide"
            hint="Plain text. Shown on your author page and under the posts you wrote."
            error={authorErrors.bio}
            value={fields.bio}
            onChange={(e) => {
              // Read it now: React clears currentTarget before the updater runs.
              const bio = e.currentTarget.value
              setFields((prev) => ({ ...prev, bio }))
            }}
          />
          <Input
            title="Website"
            type="text"
            name="website"
            autoComplete="url"
            inputMode="url"
            unmasked
            placeholder="https://"
            containerClassName="is-wide"
            hint="Linked from your author page."
            error={authorErrors.website}
            value={fields.website}
            onChange={(e: any) => setFields((prev) => ({ ...prev, website: inputValue(e) }))}
          />
        </div>
        <div>
          <Button type="submit" variant="primary" size="lg" loading={savingProfile}>
            Save details
          </Button>
        </div>
      </form>

      <hr className="gl-workspace__rule" />

      <form className="gl-workspace__section" onSubmit={handleChangePassword} noValidate aria-labelledby="gl-profile-password">
        <div>
          <h2 className="gl-workspace__section-title" id="gl-profile-password">
            Password
          </h2>
          <p className="gl-workspace__section-intro">Changing your password signs you out on every other device and browser.</p>
        </div>
        <div className="gl-profile__password">
          <Input
            title="Current password"
            type="password"
            name="current_password"
            autoComplete="current-password"
            value={passwords.current_password}
            onChange={(e: any) => setPasswords((prev) => ({ ...prev, current_password: inputValue(e) }))}
          />
          <div className="gl-profile__new-password">
            <Input
              title="New password"
              type="password"
              name="password"
              autoComplete="new-password"
              aria-describedby="gl-password-rules"
              value={passwords.password}
              onChange={(e: any) => setPasswords((prev) => ({ ...prev, password: inputValue(e) }))}
            />
            <ul className="gl-password-rules" id="gl-password-rules">
              {rules.map((rule, i) => (
                <li key={i} className={rule.met ? "is-met" : undefined}>
                  <span className="gl-password-rules__mark" aria-hidden="true">
                    {rule.met ? <CheckIcon size={12} /> : null}
                  </span>
                  {rule.label}
                  <span className="gl-workspace__sr">{rule.met ? " (done)" : " (not yet)"}</span>
                </li>
              ))}
            </ul>
          </div>
          <Input
            title="Confirm new password"
            type="password"
            name="confirm_password"
            autoComplete="new-password"
            error={mismatch ? "The two passwords don't match." : undefined}
            value={passwords.confirm_password}
            onChange={(e: any) => setPasswords((prev) => ({ ...prev, confirm_password: inputValue(e) }))}
          />
          {passwordError && (
            <Notice tone="danger" live="alert">
              {passwordError}
            </Notice>
          )}
          {passwordNotice && (
            <Notice tone="info" live="status">
              {passwordNotice}
            </Notice>
          )}
          <div>
            <Button type="submit" variant="primary" size="lg" loading={changingPassword}>
              Change password
            </Button>
          </div>
        </div>
      </form>

      <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
    </div>
  )
}
