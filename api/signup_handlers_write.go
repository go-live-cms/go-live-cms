// signup_handlers_write implements optional open signup (#191).
//
// Accounts normally come from invitations (#148). When an admin turns on Settings ›
// "Allow anyone to sign up" (settings.allow_signup, off by default), anyone may
// ask for an account at POST /auth/register; it is created, as a contributor, only
// when the link emailed to the address is confirmed (POST /auth/register/verify).
// Until then there is no user row, so nothing can sign in with the details, and
// an unconfirmed signup holds no username or address someone else needs.
//
// # Signup off
//
// Both routes answer 403 with code "signup_disabled", not the unknown-route 404:
// GET /settings shows allow_signup to anyone (the sign-in page needs it to decide
// whether to offer "Create an account"), so a 404 would hide nothing, and the code
// lets the pages say signup is closed. A link emailed while it was on stops working
// when it is turned off: closing signup means no new accounts.
//
// # No account enumeration
//
// The answer to a well-formed request is the same 202 whether or not the address
// has an account. Everything that depends on the address (the lookup, bcrypt, the
// token and the email) runs after the response (runInBackground), so its timing
// doesn't tell either. An address that has an account gets a note instead ("someone
// tried to sign up with your address"), so its owner hears about it.
//
// A taken username can't be hidden the same way: the person signing up has to
// pick another one, and usernames already show in bylines and author pages. It
// gets a generic 409 "username_unavailable", checked before the response, which
// says nothing about the email. A username taken between the request and the
// confirmation fails the confirmation the same way.
//
// # Abuse
//
// A per-IP limit (the register limiter, middleware), a per-email limit checked
// once the body is bound (so one address can't be flooded from many IPs), and at
// most one signup email a minute per address, dropped silently like
// forgot-password's cooldown. No CAPTCHA.
package api

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
	"github.com/go-live-cms/go-live-cms/util"
)

const (
	// signupLinkTTL is how long a signup confirmation link works.
	signupLinkTTL = 24 * time.Hour

	// Pages the signup emails link to (web/src/pages).
	verifyEmailPath    = "/verify-email"
	forgotPasswordPath = "/forgot-password"
)

// signupMessage is the answer to every accepted signup.
const signupMessage = "Check your email for a link to finish creating your account."

// respondSignupDisabled is the answer of both signup routes while signup is off.
func respondSignupDisabled(c *gin.Context) {
	c.JSON(http.StatusForbidden, gin.H{"error": "sign-up is closed on this site", "code": "signup_disabled"})
}

// respondUsernameUnavailable is the one answer for a username someone has.
func respondUsernameUnavailable(c *gin.Context) {
	c.JSON(http.StatusConflict, gin.H{
		"error":  "that username isn't available",
		"code":   "username_unavailable",
		"fields": gin.H{"username": "isn't available"},
	})
}

// signupAllowed reports whether open signup is on, answering 403 (off) or 500
// (settings unreadable) and returning false otherwise.
func (server *Server) signupAllowed(c *gin.Context) bool {
	settings, err := server.store.GetSettings(c.Request.Context())
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		server.requestLog(c).Error("signup: reading settings failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check whether sign-up is open"})
		return false
	}
	if err != nil || !settings.AllowSignup {
		respondSignupDisabled(c)
		return false
	}
	return true
}

// pendingSignup is a validated signup request, for the work after the response.
type pendingSignup struct {
	username string
	fullName string
	email    string
	password string
}

// register asks for an account (open signup, #191): it emails a confirmation link
// to the address, or a note when the address already has an account.
//
// Request body: {"username", "full_name", "email", "password"}
//
// Returns:
//   - 202 Accepted: {"message", "expires_in_seconds"}, for any address
//   - 400 Bad Request: invalid fields (the password rules of #329 included)
//   - 403 Forbidden: code "signup_disabled", signup is off
//   - 409 Conflict: code "username_unavailable"
//   - 429 Too Many Requests: per-IP or per-email limit
func (server *Server) register(c *gin.Context) {
	if !server.signupAllowed(c) {
		return
	}
	var req RegisterRequest
	if !bindJSON(c, &req) {
		return
	}
	signup := pendingSignup{
		username: normUsername(req.Username),
		fullName: strings.TrimSpace(req.FullName),
		email:    normEmail(req.Email),
		password: req.Password,
	}
	if len([]rune(signup.username)) < 3 || len([]rune(signup.fullName)) < 2 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username must be at least 3 characters and full name at least 2"})
		return
	}
	if !checkUsernameFormat(c, signup.username) {
		return
	}
	if !checkPasswordDetails(c, signup.password, signup.email, signup.username, signup.fullName) {
		return
	}
	// Per address, whoever sends it: caps the emails one inbox gets.
	if !server.rateLimits.registerEmail.allow(c, signup.email) {
		return
	}

	if _, err := server.store.GetUserByUsername(c.Request.Context(), signup.username); err == nil {
		respondUsernameUnavailable(c)
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		server.requestLog(c).Error("signup: username lookup failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create the account"})
		return
	}

	logger := server.requestLog(c)
	server.runInBackground(requestIDFromContext(c), c.FullPath(), func() { server.processSignup(logger, signup) })

	c.JSON(http.StatusAccepted, gin.H{
		"message":            signupMessage,
		"expires_in_seconds": int64(signupLinkTTL / time.Second),
	})
}

// processSignup does a signup's work after the response. Errors are only logged:
// the requester was already answered. Logs carry no email or username.
func (server *Server) processSignup(logger *slog.Logger, signup pendingSignup) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*mailSendTimeout)
	defer cancel()

	// One signup email a minute per address, silently (see the file header).
	if !server.rateLimits.signupMail.allowSilently(ctx, signup.email) {
		logger.Info("signup email skipped: one was sent to the address less than a minute ago")
		return
	}

	existing, err := server.store.GetUserByEmail(ctx, signup.email)
	if err == nil {
		server.sendSignupExistingNotice(ctx, logger, existing)
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		logger.Error("signup: address lookup failed", "error", err)
		return
	}

	hashedPassword, err := util.HashPassword(signup.password)
	if err != nil {
		logger.Error("signup: hashing the password failed", "error", err)
		return
	}
	token, hash, err := newAccountToken()
	if err != nil {
		logger.Error("signup: token generation failed", "error", err)
		return
	}
	request, err := server.store.RequestSignupTx(ctx, db.CreateSignupRequestParams{
		Email:          signup.email,
		Username:       signup.username,
		FullName:       signup.fullName,
		HashedPassword: hashedPassword,
		TokenHash:      hash,
		ExpiresAt:      time.Now().Add(signupLinkTTL),
	})
	if err != nil {
		logger.Error("signup: storing the request failed", "error", err)
		return
	}

	msg, err := mailer.RenderSignupVerify(signup.email, mailer.SignupVerify{
		SiteTitle: server.siteTitle(ctx),
		Username:  signup.username,
		Link:      server.accountLink(verifyEmailPath, token),
		ExpiresIn: signupLinkTTL,
	})
	if err == nil {
		err = server.sendMail(ctx, msg)
	}
	if err != nil {
		logger.Error("signup confirmation email failed", "signup_request_id", request.ID, "error", err)
		return
	}
	logger.Info("signup confirmation email sent", "signup_request_id", request.ID)
}

// sendSignupExistingNotice tells an account's owner that someone tried to sign
// up with its address.
func (server *Server) sendSignupExistingNotice(ctx context.Context, logger *slog.Logger, user db.User) {
	msg, err := mailer.RenderSignupExisting(user.Email, mailer.SignupExisting{
		SiteTitle: server.siteTitle(ctx),
		Username:  user.Username,
		Link:      server.publicURL + forgotPasswordPath,
	})
	if err == nil {
		err = server.sendMail(ctx, msg)
	}
	if err != nil {
		logger.Error("signup existing-account notice failed", "user_id", user.ID, "error", err)
		return
	}
	logger.Info("signup existing-account notice sent", "user_id", user.ID)
}

// confirmSignup redeems a signup link: it creates the account (contributor) with
// the details the signup gave. The person then signs in normally.
//
// Request body: {"token": "..."}
//
// Returns:
//   - 201 Created: {"user": ...}
//   - 400 Bad Request: invalid body, or code "invalid_token" (unknown, expired,
//     used, or replaced by a newer signup for the address)
//   - 403 Forbidden: code "signup_disabled", signup was turned off since
//   - 409 Conflict: code "email_registered" (an account has the address now) or
//     "username_unavailable" (someone took the username since)
//   - 429 Too Many Requests: per-IP limit
func (server *Server) confirmSignup(c *gin.Context) {
	if !server.signupAllowed(c) {
		return
	}
	var req ConfirmSignupRequest
	if !bindJSON(c, &req) {
		return
	}
	hash, ok := parseAccountToken(req.Token)
	if !ok {
		respondInvalidAccountToken(c)
		return
	}

	user, err := server.store.ConfirmSignupTx(c.Request.Context(), hash)
	if err != nil {
		switch {
		case errors.Is(err, db.ErrTokenInvalid):
			respondInvalidAccountToken(c)
		case errors.Is(err, db.ErrEmailTaken):
			c.JSON(http.StatusConflict, gin.H{"error": "an account with this email already exists", "code": "email_registered"})
		case errors.Is(err, db.ErrUsernameTaken):
			respondUsernameUnavailable(c)
		default:
			server.requestLog(c).Error("signup confirmation failed", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create the account"})
		}
		return
	}

	server.requestLog(c).Info("signup confirmed", "user_id", user.ID)
	// Unauthenticated route: the new member is the actor.
	server.recordRequestActivity(c, activityEvent{
		ActorID:    user.ID,
		Verb:       db.ActivitySignedUp,
		ObjectType: db.ActivityObjectUser,
		ObjectID:   user.ID,
		Payload:    map[string]any{"role": user.Role},
	})
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"user": toPrivateUser(user)})
}
