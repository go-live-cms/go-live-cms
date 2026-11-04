// email_change_handlers_write changes a user's own email address (#334).
//
// A signed-in user asks for the change with their current password; the API emails
// a confirmation link to the NEW address and nothing changes until it is used. Then
// the old address gets a notice. It reuses the emailed-token model of invitations and
// password resets (account_tokens_utils.go): 32 random bytes, only the SHA-256
// stored, single use, an expiry, the token in the link's #fragment.
//
// Never an enumeration oracle: once the password is right, the answer is the same
// 202 whether the new address is free or another account's, and the lookup, token
// and email all happen after the response (runInBackground), so timing doesn't tell
// either. A taken address just gets no email.
//
// Other sessions are not revoked: the issue doesn't ask for it, the password is
// unchanged, and the old address is told. Pending password reset links are used up
// (they went to the old address), and a password change or reset ends any pending
// email change (UpdateUserTx, ResetPasswordTx).
package api

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
	"github.com/go-live-cms/go-live-cms/util"
)

const (
	// emailChangeLinkTTL is how long a confirmation link works.
	emailChangeLinkTTL = 24 * time.Hour

	// confirmEmailPath is the web page the confirmation link opens.
	confirmEmailPath = "/confirm-email"
)

// emailChangeMessage is the answer to every accepted request.
const emailChangeMessage = "Check the new address for a link to confirm the change. Your email stays the same until then."

// requestEmailChange emails a confirmation link to the caller's new address.
//
// Request body: {"current_password": "...", "new_email": "..."}
//
// Returns:
//   - 202 Accepted: {"message", "expires_in_seconds"}, for any new address
//   - 400 Bad Request: invalid body, or (code "same_email") the address it has
//   - 403 Forbidden: current password missing or wrong (codes as PUT /users/:id)
//   - 429 Too Many Requests: the per user+IP password-check limit
func (server *Server) requestEmailChange(c *gin.Context) {
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	var req RequestEmailChangeRequest
	if !bindJSON(c, &req) {
		return
	}

	// The same allowance as a self password change: both check the current
	// password, so guesses through either count against one limit.
	if !server.rateLimits.passwordChange.allow(c, strconv.FormatInt(caller.ID, 10)+"|"+clientKey(c.ClientIP())) {
		return
	}
	if err := util.CheckPassword(req.CurrentPassword, caller.HashedPassword); err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "current password is incorrect", "code": "current_password_incorrect"})
		return
	}

	newEmail := normEmail(req.NewEmail)
	if newEmail == normEmail(caller.Email) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "that is already your email address", "code": "same_email"})
		return
	}

	logger := server.requestLog(c)
	user := caller
	server.runInBackground(requestIDFromContext(c), c.FullPath(), func() { server.sendEmailChangeLink(logger, user, newEmail) })

	c.JSON(http.StatusAccepted, gin.H{
		"message":            emailChangeMessage,
		"expires_in_seconds": int64(emailChangeLinkTTL / time.Second),
	})
}

// sendEmailChangeLink does the request's work after the response. Errors are only
// logged: the requester was already answered.
func (server *Server) sendEmailChangeLink(logger *slog.Logger, user db.User, newEmail string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*mailSendTimeout)
	defer cancel()

	if _, err := server.store.GetUserByEmail(ctx, newEmail); err == nil {
		logger.Info("email change link not sent: the address belongs to another account", "user_id", user.ID)
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		logger.Error("email change: address lookup failed", "user_id", user.ID, "error", err)
		return
	}

	token, hash, err := newAccountToken()
	if err != nil {
		logger.Error("email change: token generation failed", "error", err)
		return
	}
	if _, err := server.store.RequestEmailChangeTx(ctx, db.RequestEmailChangeTxParams{
		CreateEmailChangeTokenParams: db.CreateEmailChangeTokenParams{
			UserID:    user.ID,
			NewEmail:  newEmail,
			TokenHash: hash,
			ExpiresAt: time.Now().Add(emailChangeLinkTTL),
		},
		// The password this request proved: if it changed meanwhile, no link.
		PasswordChangedAt: user.PasswordChangedAt,
	}); err != nil {
		if errors.Is(err, db.ErrPasswordChangedSince) {
			logger.Info("email change link not sent: the password changed after the request", "user_id", user.ID)
			return
		}
		logger.Error("email change: storing the token failed", "user_id", user.ID, "error", err)
		return
	}

	msg, err := mailer.RenderEmailChange(newEmail, mailer.EmailChange{
		SiteTitle: server.siteTitle(ctx),
		Username:  user.Username,
		Link:      server.accountLink(confirmEmailPath, token),
		ExpiresIn: emailChangeLinkTTL,
	})
	if err == nil {
		err = server.sendMail(ctx, msg)
	}
	if err != nil {
		logger.Error("email change link email failed", "user_id", user.ID, "error", err)
		return
	}
	logger.Info("email change link sent", "user_id", user.ID)
}

// confirmEmailChange redeems an emailed confirmation token: the account's email
// becomes the new address, and the old one gets a notice. The caller need not be
// signed in (the link may be opened on another device).
//
// Request body: {"token": "..."}
//
// Returns:
//   - 200 OK: {"message", "email"} (the new address, which the link was sent to)
//   - 400 Bad Request: invalid body, or (code "invalid_token") a token that is
//     unknown, expired or already used
//   - 409 Conflict: (code "email_taken") another account took the address since
//   - 429 Too Many Requests: per-IP limit
func (server *Server) confirmEmailChange(c *gin.Context) {
	var req ConfirmEmailChangeRequest
	if !bindJSON(c, &req) {
		return
	}
	hash, ok := parseAccountToken(req.Token)
	if !ok {
		respondInvalidAccountToken(c)
		return
	}

	result, err := server.store.ConfirmEmailChangeTx(c.Request.Context(), hash)
	if err != nil {
		switch {
		case errors.Is(err, db.ErrTokenInvalid):
			respondInvalidAccountToken(c)
		case errors.Is(err, db.ErrEmailTaken), isUniqueViolation(err):
			c.JSON(http.StatusConflict, gin.H{"error": "another account uses this address now", "code": "email_taken"})
		default:
			server.requestLog(c).Error("email change confirmation failed", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to change the email address"})
		}
		return
	}

	logSecurityEvent(c, LogEmailChanged, "", result.User.ID, "Confirmed with an emailed link")
	logger := server.requestLog(c)
	user, oldEmail := result.User, result.OldEmail
	server.runInBackground(requestIDFromContext(c), c.FullPath(), func() { server.sendEmailChangedNotice(logger, user, oldEmail) })

	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"message": "email address changed", "email": result.User.Email})
}

// sendEmailChangedNotice tells the old address about a confirmed change.
func (server *Server) sendEmailChangedNotice(logger *slog.Logger, user db.User, oldEmail string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*mailSendTimeout)
	defer cancel()

	msg, err := mailer.RenderEmailChanged(oldEmail, mailer.EmailChanged{
		SiteTitle: server.siteTitle(ctx),
		Username:  user.Username,
		NewEmail:  user.Email,
	})
	if err == nil {
		err = server.sendMail(ctx, msg)
	}
	if err != nil {
		logger.Error("email changed notice failed", "user_id", user.ID, "error", err)
		return
	}
	logger.Info("email changed notice sent", "user_id", user.ID)
}
