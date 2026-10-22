import { useEffect, useState } from "react"
import Input from "@gl-admin/components/ui/Input"
import Button from "@gl-admin/components/ui/Button"
import UserRole from "@gl-admin/components/ui/UserRole"
import { ToastContainer, useToast } from "@gl-admin/components/Toast"
import { getMe, updateUser } from "@gl-admin/lib/api/users"
import type { User } from "@gl-admin/lib/api/types"
import { authManager } from "@gl-admin/lib/auth"
import {
  adoptPasswordChangeSession,
  buildProfileUpdate,
  describePasswordChangeError,
  describeProfileError,
  validatePasswordChange,
  validateProfile,
  type PasswordFields,
  type ProfileFields,
} from "@gl-admin/lib/profile"
import "@gl-admin/assets/styles/pages/profile.scss"

const EMPTY_PASSWORDS: PasswordFields = { current_password: "", password: "", confirm_password: "" }

function toFields(user: User): ProfileFields {
  return { username: user.username || "", email: user.email || "", full_name: user.full_name || "" }
}

const inputValue = (e: any): string => e.currentTarget?.value ?? e.target?.value ?? ""

// "My profile" (#168): any signed-in user, contributors included, edits their
// own name, email and username and changes their password. This doesn't use
// UserForm: that always sends `role` (403 for non-admins) and saves the
// password together with the profile.
export default function Profile() {
  const { toasts, showSuccess, showError, removeToast } = useToast()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [fields, setFields] = useState<ProfileFields>({ username: "", email: "", full_name: "" })
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
      // Re-read the cached user so the sidebar shows the new name.
      await authManager.refreshUser()
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
        // for this tab, whose token is now revoked: sign in again.
        showError("Password changed. Please sign in again with your new password.")
        await authManager.logout()
        window.location.href = `/login?redirect=${encodeURIComponent(window.location.pathname)}`
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

  if (loading) {
    return (
      <div className="user-form-page">
        <div className="page-header">
          <h1>My profile</h1>
        </div>
        <div>Loading profile...</div>
        <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="user-form-page">
        <div className="page-header">
          <h1>My profile</h1>
        </div>
        <div className="message error">Your profile could not be loaded.</div>
        <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
      </div>
    )
  }

  return (
    <div className="user-form profile-page">
      <form onSubmit={handleSaveProfile} noValidate>
        <div className="admin-topbar">
          <h1 className="font-semibold">My profile</h1>
          <div className="ml-auto flex items-center gap-2">
            <UserRole role={user.role} />
            <Button
              type="submit"
              disabled={savingProfile}
              aria-disabled={savingProfile}
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:cursor-not-allowed disabled:bg-gray-100"
            >
              {savingProfile ? "Saving…" : "Save profile"}
            </Button>
          </div>
        </div>

        <div className="user-form__fields grid grid-cols-1 gap-4 md:grid-cols-2">
          <Input
            title="Full name"
            type="text"
            name="full_name"
            autoComplete="name"
            value={fields.full_name}
            onChange={(e: any) => setFields((prev) => ({ ...prev, full_name: inputValue(e) }))}
          />
          <Input
            title="Username"
            type="text"
            name="username"
            autoComplete="username"
            value={fields.username}
            onChange={(e: any) => setFields((prev) => ({ ...prev, username: inputValue(e) }))}
          />
          <Input
            title="Email"
            type="email"
            name="email"
            autoComplete="email"
            value={fields.email}
            onChange={(e: any) => setFields((prev) => ({ ...prev, email: inputValue(e) }))}
          />
        </div>
        <p className="mt-2 text-sm opacity-70">
          Your role can only be changed by an administrator. If you change your username, sign in with the new one next
          time.
        </p>
      </form>

      <form onSubmit={handleChangePassword} noValidate className="user-form__password-section mt-6 border-t pt-6">
        <div className="space-y-4">
          <h3 className="text-lg font-medium">Change password</h3>
          <p className="text-sm opacity-70">Changing your password signs you out on every other device and browser.</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              title="Current password"
              type="password"
              name="current_password"
              autoComplete="current-password"
              value={passwords.current_password}
              onChange={(e: any) => setPasswords((prev) => ({ ...prev, current_password: inputValue(e) }))}
            />
            <Input
              title="New password"
              type="password"
              name="password"
              autoComplete="new-password"
              value={passwords.password}
              onChange={(e: any) => setPasswords((prev) => ({ ...prev, password: inputValue(e) }))}
            />
            <Input
              title="Confirm new password"
              type="password"
              name="confirm_password"
              autoComplete="new-password"
              value={passwords.confirm_password}
              onChange={(e: any) => setPasswords((prev) => ({ ...prev, confirm_password: inputValue(e) }))}
            />
          </div>
          {passwordError && (
            <div className="message error" role="alert">
              {passwordError}
            </div>
          )}
          {passwordNotice && (
            <div className="message success" role="status">
              {passwordNotice}
            </div>
          )}
          <Button
            type="submit"
            disabled={changingPassword}
            aria-disabled={changingPassword}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:cursor-not-allowed disabled:bg-gray-100"
          >
            {changingPassword ? "Changing…" : "Change password"}
          </Button>
        </div>
      </form>

      <ToastContainer toasts={toasts} onRemoveToast={removeToast} />
    </div>
  )
}
