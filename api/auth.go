// Package api contains HTTP handlers and middleware for Go Live CMS.
// This file defines an authentication middleware that validates Bearer access tokens
// and injects the verified token payload into the request context.
package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/go-live-cms/go-live-cms/token"
)

// Authorization header parsing constants used by the auth middleware.
const (
	authorizationHeaderKey  = "authorization"
	authorizationTypeBearer = "bearer"
	authorizationPayloadKey = "authorization_payload"
)

// authMiddleware returns a Gin middleware that enforces Bearer auth using the provided token.Maker.
//
// Behavior:
//   - Expects header: "Authorization: Bearer <access-token>"
//   - Verifies the token cryptographically via tokenMaker.VerifyToken
//   - Requires payload.TokenType == "access"
//   - On success: stores *token.Payload under context key "authorization_payload"
//   - On failure: aborts with 401 JSON { "error": "<reason>" }
//
// Notes:
//   - Only access tokens are accepted (refresh tokens are rejected).
//   - Error messages are intentionally generic to avoid leaking details.
//   - Handlers can retrieve the payload with:
//     payload, _ := ctx.Get("authorization_payload")
//     claims := payload.(*token.Payload)
//
// Example (route protection):
//
//	r := gin.Default()
//	r.GET("/me", authMiddleware(maker), func(c *gin.Context) { /* ... */ })
func authMiddleware(tokenMaker token.Maker) gin.HandlerFunc {
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

		// make payload available to handlers
		ctx.Set(authorizationPayloadKey, payload)
		ctx.Next()
	})
}
