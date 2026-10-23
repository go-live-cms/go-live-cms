// internal_routes registers server-to-server endpoints that are not called by
// browsers or API clients.
//
// # Exposure
//
// These routes are served by a SEPARATE Gin engine on INTERNAL_SERVER_ADDRESS
// (default 0.0.0.0:8081), not under /api/v1 on the public listener. Docker
// publishes only the public port, so the internal one is reachable from the
// compose network (the collab WS server) but not from the internet. A leaked
// secret therefore isn't enough on its own to query it from outside.
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

// newInternalRouter builds the internal engine.
//
// Route Structure:
//   - GET /internal/users/:id/access?doc=post-<id>&issued_at=<unix seconds>
//     (WS per-connection document access check, #135)
//   - GET /internal/posts/:id/collab, PUT /internal/posts/:id/collab
//     (Hocuspocus load/store of block_doc + Yjs state, #206/#280;
//     internal_handlers_collab.go)
//   - GET /metrics (Prometheus text, public router's request counts and
//     latency; metrics.go). Unauthenticated: the listener being unreachable
//     from the internet is what restricts it.
func (server *Server) newInternalRouter() *gin.Engine {
	router := gin.New()
	// Nothing proxies this listener; log the real peer, not a header.
	if err := router.SetTrustedProxies(nil); err != nil {
		panic(err) // nil can't fail to parse
	}
	// Same request id / structured log / recovery as the public router (the WS
	// server forwards its connection's X-Request-ID on the role lookup), but no
	// metrics: they describe public traffic only.
	router.Use(
		requestIDMiddleware(trustRequestIDs),
		server.requestLogger(server.logger, nil),
		server.recoveryMiddleware(server.logger),
	)

	router.GET("/metrics", server.metrics.handler)

	internal := router.Group("/internal")
	internal.Use(requireInternalSecret(server.config.RoleLookupSecret))
	internal.GET("/users/:id/access", server.getInternalDocAccess)  // GET /internal/users/123/access?doc=post-7&issued_at=1760000000
	internal.GET("/posts/:id/collab", server.getInternalPostCollab) // collab server load (#280)
	internal.PUT("/posts/:id/collab", server.putInternalPostCollab) // collab server store (#280; hocuspocus only)

	return router
}

// requireInternalSecret rejects requests that don't carry
// "Authorization: Bearer <secret>" with 401. The comparison is constant-time.
// The secret is already trimmed by NewServer. An empty secret rejects
// everything (NewServer refuses to start without one, so this is only a
// second line of defense).
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
