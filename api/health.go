// Package api — health endpoints (#142).
//
//   - GET /health and GET /api/v1/health: LIVENESS. The process is up and
//     serving HTTP; no dependency is checked. Use it for probes that restart
//     the container (a DB outage must not restart every API replica).
//   - GET /readyz: READINESS. Also pings Postgres with a short timeout and
//     answers 503 when it can't. Use it for Docker/compose healthchecks
//     (what `depends_on: condition: service_healthy` waits on) and for
//     load-balancer target checks.
//
// Both are outside the rate-limited groups, and their responses never
// include error details (the reason is logged instead).
package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// readinessTimeout bounds the DB ping, so a hung database fails the check
// instead of hanging the healthcheck.
const readinessTimeout = 2 * time.Second

// healthCheck returns basic liveness info and API version.
func (server *Server) healthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":  "ok",
		"message": "Gin CMS API is running",
		"version": "v0.0.1",
	})
}

// readinessCheck answers 200 when the database answers a ping within
// readinessTimeout, else 503.
func (server *Server) readinessCheck(c *gin.Context) {
	if server.pingDB == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "unavailable", "checks": gin.H{"database": "unchecked"}})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), readinessTimeout)
	defer cancel()
	if err := server.pingDB(ctx); err != nil {
		server.logger.LogAttrs(c.Request.Context(), slog.LevelWarn, "readiness_check_failed",
			slog.String(requestIDKey, requestIDFromContext(c)),
			slog.String("check", "database"),
			slog.String("error", err.Error()),
		)
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "unavailable", "checks": gin.H{"database": "down"}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok", "checks": gin.H{"database": "ok"}})
}
