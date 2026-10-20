// internal_routes registers server-to-server endpoints that are not called by
// browsers or API clients.
//
// # Authentication
//
// These routes do NOT use authMiddleware or PASETO tokens. The caller is another
// GoLive process (today: the collab WebSocket server) and authenticates with a
// shared secret: "Authorization: Bearer <ROLE_LOOKUP_SECRET>". This decouples
// the WS server's authorization from API token audiences (#223): a WS-only
// ticket (audience golive.admin-ws) is rejected by authMiddleware, so the WS
// server can't look up the caller's role with it via /users/me.
package api

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// RegisterInternalRoutes configures the shared-secret internal endpoints.
//
// Route Structure:
//   - GET /internal/users/:id/role?issued_at=<unix seconds> (WS role lookup)
func (server *Server) RegisterInternalRoutes(v1 *gin.RouterGroup) {
	internal := v1.Group("/internal")
	internal.Use(requireInternalSecret(server.config.RoleLookupSecret))

	internal.GET("/users/:id/role", server.getInternalUserRole) // GET /api/v1/internal/users/123/role?issued_at=1760000000
}

// requireInternalSecret rejects requests that don't carry
// "Authorization: Bearer <secret>" with 401. The comparison is constant-time.
// An empty secret rejects everything (NewServer refuses to start without one,
// so this is only a second line of defense).
func requireInternalSecret(secret string) gin.HandlerFunc {
	expected := []byte("Bearer " + secret)
	return func(c *gin.Context) {
		got := []byte(strings.TrimSpace(c.GetHeader(authorizationHeaderKey)))
		if secret == "" || subtle.ConstantTimeCompare(got, expected) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Next()
	}
}
