// invitations_handlers_write implements invite-only sign-up (#148): admins invite an
// email with a role, and the invitee accepts by choosing a username and
// password. The invitation's email and role are what the account gets; the
// accept request can't change them.
package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
	"github.com/go-live-cms/go-live-cms/util"
)

// emailInvitation sends the invitation email for inv with its raw token and
// reports whether it went out. The stated lifetime is the configured TTL,
// which is what the link was just given (create or resend). A failure is logged, not returned: the
// invitation exists either way, and the admin can resend it.
func (server *Server) emailInvitation(c *gin.Context, inv db.UserInvitation, token string) bool {
	msg, err := mailer.RenderInvitation(inv.Email, mailer.Invitation{
		SiteTitle: server.siteTitle(c.Request.Context()),
		Role:      inv.Role,
		Link:      server.accountLink(acceptInvitePath, token),
		ExpiresIn: server.config.InvitationLinkTTL(),
	})
	if err == nil {
		err = server.sendMail(c.Request.Context(), msg)
	}
	if err != nil {
		server.requestLog(c).Error("invitation email failed", "invitation_id", inv.ID, "error", err)
		return false
	}
	server.requestLog(c).Info("invitation email sent", "invitation_id", inv.ID)
	return true
}

// createInvitation invites an email address with a role. Any open invitation
// for the same email is revoked: only the newest link works.
//
// Request body: {"email": "...", "role": "admin|editor|contributor"}
//
// Authentication: Bearer token + admin role
//
// Returns:
//   - 201 Created: {"invitation": ..., "email_sent": bool}. email_sent false
//     means the invitation was saved but the email failed: resend it.
//   - 400 Bad Request: invalid email or role
//   - 409 Conflict: a user with this email already exists
func (server *Server) createInvitation(c *gin.Context) {
	var req CreateInvitationRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	email := normEmail(req.Email)

	if _, err := server.store.GetUserByEmail(c.Request.Context(), email); err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "a user with this email already exists", "code": "email_registered"})
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check email"})
		return
	}

	token, hash, err := newAccountToken()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create invitation"})
		return
	}
	now := time.Now()
	inv, err := server.store.CreateUserInvitationTx(c.Request.Context(), db.CreateUserInvitationParams{
		Email:     email,
		Role:      req.Role,
		TokenHash: hash,
		InvitedBy: sql.NullInt64{Int64: caller.ID, Valid: true},
		ExpiresAt: now.Add(server.config.InvitationLinkTTL()),
	})
	if err != nil {
		if isUniqueViolation(err) {
			// Another admin invited the same email at the same moment.
			c.JSON(http.StatusConflict, gin.H{"error": "this email was just invited, refresh and try again"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create invitation"})
		return
	}

	sent := server.emailInvitation(c, inv, token)
	c.JSON(http.StatusCreated, gin.H{"invitation": toInvitationResponse(inv, now), "email_sent": sent})
}

func invitationIDParam(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid invitation ID"})
		return 0, false
	}
	return id, true
}

// resendInvitation emails an open invitation again with a new link and a
// fresh expiry; the previous link stops working.
//
// Authentication: Bearer token + admin role
//
// Returns:
//   - 200 OK: {"invitation": ..., "email_sent": bool}
//   - 404 Not Found: no open invitation with this id (accepted or revoked)
func (server *Server) resendInvitation(c *gin.Context) {
	id, ok := invitationIDParam(c)
	if !ok {
		return
	}
	token, hash, err := newAccountToken()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to resend invitation"})
		return
	}
	now := time.Now()
	inv, err := server.store.RenewUserInvitation(c.Request.Context(), db.RenewUserInvitationParams{
		ID:        id,
		TokenHash: hash,
		ExpiresAt: now.Add(server.config.InvitationLinkTTL()),
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "invitation not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to resend invitation"})
		return
	}
	sent := server.emailInvitation(c, inv, token)

	c.JSON(http.StatusOK, gin.H{"invitation": toInvitationResponse(inv, now), "email_sent": sent})
}

// revokeInvitation invalidates an open invitation's link.
//
// Authentication: Bearer token + admin role
//
// Returns:
//   - 200 OK: revoked
//   - 404 Not Found: no open invitation with this id
func (server *Server) revokeInvitation(c *gin.Context) {
	id, ok := invitationIDParam(c)
	if !ok {
		return
	}
	rows, err := server.store.RevokeUserInvitation(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to revoke invitation"})
		return
	}
	if rows == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "invitation not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "invitation revoked"})
}

// acceptInvite redeems an invitation: it creates the user with the invited
// email and role and the chosen username, full name and password (the same
// rules as admin user creation). The link can't be used again. The invitee
// then signs in normally.
//
// Request body: {"token", "username", "full_name", "password"}
//
// Returns:
//   - 201 Created: {"user": ...}
//   - 400 Bad Request: invalid fields, or code "invalid_token"
//   - 409 Conflict: code "username_taken", or "email_registered" when an
//     account with the invited email was created meanwhile
//   - 429 Too Many Requests: per-IP limit
func (server *Server) acceptInvite(c *gin.Context) {
	var req AcceptInvitationRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(req.Password) > maxPasswordBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "password must be at most 72 bytes", "code": "password_too_long"})
		return
	}
	username := normUsername(req.Username)
	fullName := strings.TrimSpace(req.FullName)
	if len([]rune(username)) < 3 || len([]rune(fullName)) < 2 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username must be at least 3 characters and full name at least 2"})
		return
	}
	hash, ok := parseAccountToken(req.Token)
	if !ok {
		respondInvalidAccountToken(c)
		return
	}

	hashedPassword, err := util.HashPassword(req.Password)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to hash password"})
		return
	}

	result, err := server.store.AcceptInvitationTx(c.Request.Context(), db.AcceptInvitationTxParams{
		TokenHash:      hash,
		Username:       username,
		FullName:       fullName,
		HashedPassword: hashedPassword,
	})
	if err != nil {
		switch {
		case errors.Is(err, db.ErrTokenInvalid):
			respondInvalidAccountToken(c)
		case isUniqueViolation(err) && strings.Contains(err.Error(), "email"):
			c.JSON(http.StatusConflict, gin.H{"error": "an account with this email already exists", "code": "email_registered"})
		case isUniqueViolation(err):
			c.JSON(http.StatusConflict, gin.H{"error": "that username is taken", "code": "username_taken"})
		default:
			server.requestLog(c).Error("accepting invitation failed", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to accept invitation"})
		}
		return
	}

	server.requestLog(c).Info("invitation accepted", "invitation_id", result.Invitation.ID, "user_id", result.User.ID)
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"user": toPrivateUser(result.User)})
}
