// account_handlers_password implements forgot/reset password (#148).
//
// Forgot never says whether an email belongs to an account: the response is
// the same 200 either way, and all the work (lookup, token, email) happens
// after it is sent, so its timing doesn't tell either.
package api

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
	"github.com/go-live-cms/go-live-cms/util"
)

// forgotPasswordMessage is the answer to every well-formed forgot request.
const forgotPasswordMessage = "If an account uses that email, we've sent it a link to reset the password."

// passwordResetCooldown is the minimum gap between two reset emails to one
// user. Requests inside it are dropped silently, so the forgot form can't be
// used to flood someone's inbox from many IPs.
const passwordResetCooldown = time.Minute

// maxPasswordBytes is bcrypt's input limit (util.HashPassword enforces it);
// checked up front for a 400 instead of a hashing failure.
const maxPasswordBytes = 72

// forgotPassword emails a password reset link to the account with this email,
// if there is one.
//
// Request body: {"email": "..."}
//
// Returns:
//   - 200 OK: always, for any valid email address (no account enumeration)
//   - 400 Bad Request: missing or malformed email
//   - 429 Too Many Requests: per-IP limit
func (server *Server) forgotPassword(c *gin.Context) {
	var req ForgotPasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "a valid email is required"})
		return
	}

	email := normEmail(req.Email)
	logger := server.requestLog(c)
	server.runInBackground(func() { server.sendPasswordResetEmail(logger, email) })

	c.JSON(http.StatusOK, gin.H{"message": forgotPasswordMessage})
}

// sendPasswordResetEmail does the forgot-password work after the response.
// Errors are only logged: the requester was already answered.
func (server *Server) sendPasswordResetEmail(logger *slog.Logger, email string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*mailSendTimeout)
	defer cancel()

	user, err := server.store.GetUserByEmail(ctx, email)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			logger.Error("password reset: user lookup failed", "error", err)
		}
		return
	}

	now := time.Now()
	recent, err := server.store.CountPasswordResetTokensSince(ctx, db.CountPasswordResetTokensSinceParams{
		UserID:    user.ID,
		CreatedAt: now.Add(-passwordResetCooldown),
	})
	if err != nil {
		logger.Error("password reset: cooldown check failed", "user_id", user.ID, "error", err)
		return
	}
	if recent > 0 {
		logger.Info("password reset email skipped: one was sent less than a minute ago", "user_id", user.ID)
		return
	}

	token, hash, err := newAccountToken()
	if err != nil {
		logger.Error("password reset: token generation failed", "error", err)
		return
	}
	ttl := server.config.PasswordResetLinkTTL()
	if _, err := server.store.CreatePasswordResetToken(ctx, db.CreatePasswordResetTokenParams{
		UserID:    user.ID,
		TokenHash: hash,
		ExpiresAt: now.Add(ttl),
	}); err != nil {
		logger.Error("password reset: storing the token failed", "user_id", user.ID, "error", err)
		return
	}

	msg, err := mailer.RenderPasswordReset(user.Email, mailer.PasswordReset{
		SiteTitle: server.siteTitle(ctx),
		Username:  user.Username,
		Link:      server.accountLink(resetPasswordPath, token),
		ExpiresIn: ttl,
	})
	if err == nil {
		err = server.sendMail(ctx, msg)
	}
	if err != nil {
		logger.Error("password reset email failed", "user_id", user.ID, "error", err)
		return
	}
	logger.Info("password reset email sent", "user_id", user.ID)
}

// resetPassword sets a new password with an emailed reset token.
//
// Like a password change (UpdateUserTx), it blocks every session the user
// holds and makes authMiddleware reject access tokens issued before it
// (ResetPasswordTx). The caller is not signed in: they sign in with the new
// password, and any refresh cookie this browser had is cleared.
//
// Request body: {"token": "...", "password": "..."}
//
// Returns:
//   - 200 OK: password changed
//   - 400 Bad Request: invalid body, or (code "invalid_token") a token that is
//     unknown, expired or already used
//   - 429 Too Many Requests: per-IP limit
func (server *Server) resetPassword(c *gin.Context) {
	var req ResetPasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "token and a password of at least 6 characters are required"})
		return
	}
	if len(req.Password) > maxPasswordBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "password must be at most 72 bytes", "code": "password_too_long"})
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

	user, err := server.store.ResetPasswordTx(c.Request.Context(), db.ResetPasswordTxParams{
		TokenHash:      hash,
		HashedPassword: hashedPassword,
	})
	if err != nil {
		if errors.Is(err, db.ErrTokenInvalid) {
			respondInvalidAccountToken(c)
			return
		}
		server.requestLog(c).Error("password reset failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to reset password"})
		return
	}

	logSecurityEvent(c, LogPasswordChanged, "all", user.ID, "Reset with an emailed link")
	server.clearRefreshCookie(c)
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"message": "password reset, sign in with your new password"})
}
