// invitations_handlers_read implements the read-only invitation endpoints:
// the admin list and the accept page's preview (#148).
package api

import (
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// listInvitations returns open invitations, newest first: pending ones and
// ones that expired in the last 30 days (which can still be resent or
// revoked). Capped at 200 (ListOpenUserInvitations).
//
// Authentication: Bearer token + admin role
func (server *Server) listInvitations(c *gin.Context) {
	invitations, err := server.store.ListOpenUserInvitations(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list invitations"})
		return
	}
	now := time.Now()
	rsp := make([]InvitationResponse, 0, len(invitations))
	for _, inv := range invitations {
		rsp = append(rsp, toInvitationResponse(inv, now))
	}
	c.JSON(http.StatusOK, gin.H{"invitations": rsp})
}

// InvitationInviter is who sent an invitation, as the accept page shows it.
type InvitationInviter struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// previewInvite tells the accept page what a valid invitation is for, so it
// can show the email, role and inviter (and spot a dead link) before the form.
// Only the holder of the emailed token gets this far, and the inviter's name
// is what the page shows them ("Ana Costa invited you", #344).
//
// Request body: {"token": "..."}
//
// Returns:
//   - 200 OK: {"email", "role", "expires_at", "invited_by"}; invited_by is
//     {"id", "name"}, or null when the inviter was deleted or can't be loaded
//   - 400 Bad Request: code "invalid_token" for a link that doesn't work
func (server *Server) previewInvite(c *gin.Context) {
	var req PreviewInvitationRequest
	if !bindJSON(c, &req) {
		return
	}
	hash, ok := parseAccountToken(req.Token)
	if !ok {
		respondInvalidAccountToken(c)
		return
	}
	inv, err := server.store.GetValidUserInvitationByTokenHash(c.Request.Context(), hash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondInvalidAccountToken(c)
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load invitation"})
		return
	}
	// The inviter is decoration: a failed lookup leaves it out, never the preview.
	var inviter *InvitationInviter
	if inv.InvitedBy.Valid {
		user, err := server.store.GetUser(c.Request.Context(), inv.InvitedBy.Int64)
		switch {
		case err == nil:
			name := user.FullName
			if name == "" {
				name = user.Username
			}
			inviter = &InvitationInviter{ID: user.ID, Name: name}
		case !errors.Is(err, sql.ErrNoRows):
			// A deleted inviter is expected; anything else is worth knowing about.
			server.requestLog(c).Warn("invitation preview: inviter lookup failed", "invitation_id", inv.ID, "error", err)
		}
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"email": inv.Email, "role": inv.Role, "expires_at": inv.ExpiresAt, "invited_by": inviter})
}
