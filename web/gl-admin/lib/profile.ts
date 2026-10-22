// Client-side rules for the "My profile" page (#168). The limits mirror the
// binding tags on UpdateUserRequest in api/users_bindings.go, which stay the
// source of truth: these only catch mistakes before a round trip.
import { ApiError } from "./api"
import type { AuthManager } from "./auth"

export const USERNAME_MIN = 3
export const USERNAME_MAX = 50
export const FULL_NAME_MIN = 2
export const FULL_NAME_MAX = 100
export const PASSWORD_MIN = 6

export type ProfileFields = {
  username: string
  email: string
  full_name: string
}

export type PasswordFields = {
  current_password: string
  password: string
  confirm_password: string
}

// Go's validator counts runes, not UTF-16 code units.
const runeLength = (s: string) => [...s].length

// A loose shape check; the API's `email` tag is stricter and has the last word.
export function isValidEmail(email: string): boolean {
  return /^\S+@\S+\.\S+$/.test(email)
}

// A new password and its confirmation, as typed (the API doesn't trim them
// either). Shared with UserForm so every form applies the API's min=6.
export function validateNewPassword(password: string, confirm: string): string | null {
  if (runeLength(password) < PASSWORD_MIN) {
    return `New password must be at least ${PASSWORD_MIN} characters.`
  }
  if (password !== confirm) {
    return "New passwords do not match."
  }
  return null
}

export function validateProfile(fields: ProfileFields): string | null {
  const username = fields.username.trim()
  const fullName = fields.full_name.trim()
  const email = fields.email.trim()

  if (runeLength(username) < USERNAME_MIN || runeLength(username) > USERNAME_MAX) {
    return `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters.`
  }
  if (!isValidEmail(email)) {
    return "Please provide a valid email."
  }
  // The API keeps the old name when full_name is empty, so an empty field
  // would look saved without being saved: require it instead.
  if (runeLength(fullName) < FULL_NAME_MIN || runeLength(fullName) > FULL_NAME_MAX) {
    return `Full name must be ${FULL_NAME_MIN}–${FULL_NAME_MAX} characters.`
  }
  return null
}

// The PUT body for a profile save: only the fields that changed, trimmed.
// Never includes role (a non-admin sending it gets 403) or any password field.
export function buildProfileUpdate(original: ProfileFields, fields: ProfileFields): Partial<ProfileFields> {
  const update: Partial<ProfileFields> = {}
  for (const key of ["username", "email", "full_name"] as const) {
    const value = fields[key].trim()
    if (value !== (original[key] ?? "").trim()) update[key] = value
  }
  return update
}

// Passwords are sent as typed (the API doesn't trim them either).
export function validatePasswordChange(fields: PasswordFields): string | null {
  if (!fields.current_password) {
    return "Enter your current password."
  }
  const invalid = validateNewPassword(fields.password, fields.confirm_password)
  if (invalid) return invalid
  if (fields.password === fields.current_password) {
    return "New password must be different from the current one."
  }
  return null
}

function retryHint(err: ApiError): string {
  const seconds = err.retryAfterSeconds
  if (seconds == null) return "Please wait a minute and try again."
  if (seconds === 0) return "Please try again."
  return seconds === 1 ? "Try again in 1 second." : `Try again in ${seconds} seconds.`
}

// User-facing text for a failed password change.
export function describePasswordChangeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return `Too many password change attempts. ${retryHint(err)}`
    // Codes from api/users_handlers_write.go, not the English messages.
    if (err.code === "current_password_incorrect") return "Your current password is incorrect."
    if (err.code === "current_password_required") return "Enter your current password."
    if (err.status === 401) return "Your session has expired. Please sign in again."
    return err.message
  }
  return err instanceof Error ? err.message : "Failed to change password. Please try again."
}

// User-facing text for a failed profile save.
export function describeProfileError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return `Too many requests. ${retryHint(err)}`
    if (err.status === 409) return "That username or email is already taken."
    if (err.status === 401) return "Your session has expired. Please sign in again."
    return err.message
  }
  return err instanceof Error ? err.message : "Failed to save profile. Please try again."
}

// After a self password change the API blocks every session and rejects
// every access token issued before it, this tab's included. Its response
// sets a new refresh cookie and carries a new access token for this tab.
// Returns "signed-in" once this tab has switched to it, or "reauth" when
// the API couldn't start the new session (the change still stands) and the
// user has to sign in again with the new password.
export function adoptPasswordChangeSession(
  auth: Pick<AuthManager, "adoptAccessToken">,
  response: { access_token?: string; access_token_expires_at?: string; expires_at?: number } | null | undefined
): "signed-in" | "reauth" {
  if (!response?.access_token) return "reauth"
  auth.adoptAccessToken({
    access_token: response.access_token,
    access_token_expires_at: response.access_token_expires_at,
    expires_at: response.expires_at,
  })
  return "signed-in"
}
