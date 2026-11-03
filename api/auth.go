// Package api contains HTTP handlers and middleware for Go Live CMS.
// This file defines an authentication middleware that validates Bearer access tokens
// and injects the verified token payload into the request context.
package api

import (
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

// Authorization header parsing constants used by the auth middleware.
const (
	authorizationHeaderKey  = "authorization"
	authorizationTypeBearer = "bearer"
	authorizationPayloadKey = "authorization_payload"
	authorizationUserKey    = "authorization_user"
)

// authMiddleware returns a Gin middleware that enforces Bearer auth using the provided token.Maker.
//
// Behavior:
//   - Expects header: "Authorization: Bearer <access-token>"
//   - Verifies the token cryptographically via tokenMaker.VerifyToken
//   - Requires payload.TokenType == "access"
//   - Loads the caller's CURRENT database row and rejects tokens issued
//     before the user's latest password change (see issuedBeforePasswordChange)
//   - On success: stores *token.Payload under context key "authorization_payload"
//     and the db.User under "authorization_user" (read back via callerUser,
//     so requireRole does not query the user a second time)
//   - On failure: aborts with 401 JSON { "error": "<reason>" }; 403 if the
//     token's user no longer exists; 500 if the user lookup fails
//
// Notes:
//   - Only access tokens are accepted (refresh tokens are rejected).
//   - Access tokens are stateless, so the password-change check is what makes
//     a password change end every existing login immediately instead of
//     leaving stolen access tokens usable until they expire.
//   - Error messages are intentionally generic to avoid leaking details.
//   - Handlers can retrieve the payload with:
//     payload, _ := ctx.Get("authorization_payload")
//     claims := payload.(*token.Payload)
//
// Example (route protection):
//
//	r := gin.Default()
//	r.GET("/me", server.requireAuth(), func(c *gin.Context) { /* ... */ })
//
// lastActiveInterval > 0 also stamps the caller's last_active_at (#333) when the
// loaded row says it is at least that old (recordActivity), so it writes at most
// once per interval per user; 0 (a zero Config: tests) turns that off.
func authMiddleware(tokenMaker token.Maker, store db.Store, lastActiveInterval time.Duration) gin.HandlerFunc {
	return gin.HandlerFunc(func(ctx *gin.Context) {
		authorizationHeader := ctx.GetHeader(authorizationHeaderKey)

		if len(authorizationHeader) == 0 {
			err := errors.New("authorization header is not provided")
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}

		fields := strings.Fields(authorizationHeader)
		if len(fields) < 2 {
			err := errors.New("invalid authorization header format")
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}

		authorizationType := strings.ToLower(fields[0])
		if authorizationType != authorizationTypeBearer {
			err := fmt.Errorf("unsupported authorization type %s", authorizationType)
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}

		accessToken := fields[1]
		payload, err := tokenMaker.VerifyToken(accessToken)
		if err != nil {
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}

		if payload.TokenType != "access" {
			err := errors.New("invalid token type")
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}

		user, err := store.GetUser(ctx.Request.Context(), payload.UserID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				ctx.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "forbidden"})
				return
			}
			ctx.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "failed to verify user"})
			return
		}

		if issuedBeforePasswordChange(payload.IssuedAt, user.PasswordChangedAt) {
			err := errors.New("token was issued before the latest password change")
			ctx.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}

		if lastActiveStale(user, lastActiveInterval, time.Now()) {
			recordActivity(ctx, store, user.ID, lastActiveInterval)
		}

		// make payload and caller available to handlers
		ctx.Set(authorizationPayloadKey, payload)
		ctx.Set(authorizationUserKey, user)
		ctx.Next()
	})
}

// requireAuth is authMiddleware with this server's token maker, store and
// last-active interval: what every authenticated route group uses.
func (server *Server) requireAuth() gin.HandlerFunc {
	return authMiddleware(server.tokenMaker, server.store, server.config.LastActiveInterval)
}

// lastActiveStale reports whether the user's last_active_at is at least interval
// old (or unset), i.e. whether this request should stamp it. interval 0 = never.
func lastActiveStale(user db.User, interval time.Duration, now time.Time) bool {
	if interval <= 0 {
		return false
	}
	return !user.LastActiveAt.Valid || now.Sub(user.LastActiveAt.Time) >= interval
}

// recordActivity stamps last_active_at (#333). TouchUserLastActive re-checks the
// age in SQL, so concurrent requests still write once, and skips a row another
// transaction has locked instead of waiting for it. It never fails the request:
// "last active" is informational.
func recordActivity(ctx *gin.Context, store db.Store, userID int64, interval time.Duration) {
	if interval <= 0 {
		return
	}
	_, err := store.TouchUserLastActive(ctx.Request.Context(), db.TouchUserLastActiveParams{
		ID:            userID,
		MinAgeSeconds: interval.Seconds(),
	})
	if err != nil {
		slog.Warn("last_active_update_failed",
			requestIDKey, requestIDFromContext(ctx),
			"user_id", userID,
			"error", err.Error())
	}
}

// issuedBeforePasswordChange reports whether a token predates the user's
// latest password change and must therefore be rejected.
//
// The comparison is at whole-second granularity: PASETO v4 serializes iat as
// RFC 3339 without fractional seconds, while password_changed_at keeps
// microseconds. Comparing the raw values would reject the fresh session a
// self password change issues in the same request (its tokens' iat truncates
// to the start of that second, i.e. before password_changed_at). The cost is
// that a token issued earlier within the very same second as the change
// survives it.
func issuedBeforePasswordChange(issuedAt, passwordChangedAt time.Time) bool {
	return issuedAt.Unix() < passwordChangedAt.Unix()
}
