// Client-side rules and wording for admin invitations (#148). The API
// (api/invitations_handlers.go) has the last word; these only catch mistakes
// before a round trip and turn its answers into readable text.
import { ApiError } from "./api"
import type { Invitation, InvitationResult } from "./api/invitations"
import { isValidEmail } from "./profile"
import { USER_ROLE_OPTIONS } from "./roles"

export function validateInvitation(email: string, role: string): string | null {
  if (!isValidEmail(email.trim())) return "Enter the email address to invite."
  if (!USER_ROLE_OPTIONS.some((o) => o.value === role)) return "Choose a role."
  return null
}

export function describeInvitationError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "email_registered") return "A user with this email already exists."
    if (err.status === 404) return "This invitation was already accepted or revoked."
    return err.message
  }
  return err instanceof Error ? err.message : "Something went wrong. Please try again."
}

// The toast after creating or resending: a warning when the invitation was
// saved but its email failed (the admin can resend it).
export function invitationSentNotice(result: InvitationResult): { type: "success" | "warning"; message: string } {
  const { email } = result.invitation
  return result.email_sent
    ? { type: "success", message: `Invitation sent to ${email}.` }
    : { type: "warning", message: `Invitation saved, but the email to ${email} could not be sent. Try resending it.` }
}

// "Expires in 3 days", "Expires in 5 hours", "Expired".
export function describeExpiry(invitation: Pick<Invitation, "expires_at" | "status">, now = Date.now()): string {
  const ms = new Date(invitation.expires_at).getTime() - now
  if (invitation.status === "expired" || !(ms > 0)) return "Expired"
  const hours = Math.floor(ms / 3_600_000)
  // Rounded: a fresh 72h invitation is a few seconds short of 3 days.
  if (hours >= 48) return `Expires in ${Math.round(ms / 86_400_000)} days`
  if (hours >= 1) return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`
  const minutes = Math.max(1, Math.floor(ms / 60_000))
  return `Expires in ${minutes} minute${minutes === 1 ? "" : "s"}`
}
