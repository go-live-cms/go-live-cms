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

// previewInvite tells the accept page what a valid invitation is for, so it
// can show the email and role (and spot a dead link) before the form.
//
// Request body: {"token": "..."}
//
// Returns:
//   - 200 OK: {"email", "role", "expires_at"}
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
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"email": inv.Email, "role": inv.Role, "expires_at": inv.ExpiresAt})
}
