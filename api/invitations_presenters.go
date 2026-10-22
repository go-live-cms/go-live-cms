// invitations_presenters shapes invitations for admin responses.
package api

import (
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// InvitationResponse is an invitation as admins see it. The token (and its
// hash) never leave the server except in the email.
type InvitationResponse struct {
	ID        int64     `json:"id"`
	Email     string    `json:"email"`
	Role      string    `json:"role"`
	InvitedBy *int64    `json:"invited_by"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
	// Status is "pending" or "expired" (accepted and revoked ones aren't listed).
	Status string `json:"status"`
}

func toInvitationResponse(inv db.UserInvitation, now time.Time) InvitationResponse {
	rsp := InvitationResponse{
		ID:        inv.ID,
		Email:     inv.Email,
		Role:      inv.Role,
		ExpiresAt: inv.ExpiresAt,
		CreatedAt: inv.CreatedAt,
		Status:    "pending",
	}
	if inv.InvitedBy.Valid {
		id := inv.InvitedBy.Int64
		rsp.InvitedBy = &id
	}
	if !inv.ExpiresAt.After(now) {
		rsp.Status = "expired"
	}
	return rsp
}
