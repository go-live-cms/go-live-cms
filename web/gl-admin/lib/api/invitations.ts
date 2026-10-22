// Admin invitations (#148): api/invitations_handlers.go. Admin only.
import { apiCall } from "../api"

export type InvitationRole = "admin" | "editor" | "contributor"

export interface Invitation {
  id: number
  email: string
  role: InvitationRole
  invited_by: number | null
  expires_at: string
  created_at: string
  status: "pending" | "expired"
}

// email_sent false: the invitation was saved but its email failed; resend it.
export interface InvitationResult {
  invitation: Invitation
  email_sent: boolean
}

export async function listInvitations(token?: string): Promise<Invitation[]> {
  const response = await apiCall("/invitations", { token })
  return response.invitations || []
}

export async function createInvitation(
  data: { email: string; role: InvitationRole },
  token?: string,
): Promise<InvitationResult> {
  return apiCall("/invitations", { method: "POST", body: data, token })
}

export async function resendInvitation(id: number, token?: string): Promise<InvitationResult> {
  return apiCall(`/invitations/${id}/resend`, { method: "POST", token })
}

export async function revokeInvitation(id: number, token?: string): Promise<void> {
  await apiCall(`/invitations/${id}`, { method: "DELETE", token })
}
