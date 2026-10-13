// auth_roles implements role-based access control middleware.
//
// This is the single place that knows which roles exist and how privilege
// levels map onto them. Route files use the semantic helpers (requireSiteAdmin,
// requireContentEditor) rather than enumerating roles, so introducing custom
// admin-defined roles later (backed by a roles/capabilities table) only
// requires changing this file — no route registration churn.
//
// # Enforcement Model
//
// The caller's role is read from the DATABASE on every request, not from the
// token payload. A demotion or deletion therefore takes effect immediately
// instead of lingering until the access token expires. The cost is one
// indexed GetUser query per protected request.
package api

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/go-live-cms/go-live-cms/token"
)

// Built-in roles, ordered by privilege. Stored as plain strings in users.role;
// values are matched case-insensitively.
const (
	RoleAdmin       = "admin"
	RoleEditor      = "editor"
	RoleContributor = "contributor"
)

// requireSiteAdmin gates site-administration routes: user management,
// theme activation/settings, site settings, and post-type registration.
func requireSiteAdmin(server *Server) gin.HandlerFunc {
	return requireRole(server, RoleAdmin)
}

// requireContentEditor gates content-management routes: posts, media, and
// taxonomy writes. Admins implicitly pass.
func requireContentEditor(server *Server) gin.HandlerFunc {
	return requireRole(server, RoleAdmin, RoleEditor)
}

// requireRole creates middleware that enforces role-based access control.
//
// Must run after authMiddleware (it reads the token payload from the context).
// The user's CURRENT role is fetched from the database via the token's UserID
// and compared case-insensitively against the allowed roles.
//
// Responses:
//   - 403 Forbidden: role not in the allowed set, or the token's user no
//     longer exists (deleted account holding a still-valid token)
//   - 500 Internal Server Error: database failure during the role lookup
func requireRole(server *Server, roles ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		auth := c.MustGet(authorizationPayloadKey).(*token.Payload)

		user, err := server.store.GetUser(c.Request.Context(), auth.UserID)
		if err != nil {
			if err == sql.ErrNoRows {
				c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "forbidden"})
				return
			}
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "failed to verify user role"})
			return
		}

		for _, role := range roles {
			if strings.EqualFold(user.Role, role) {
				c.Next()
				return
			}
		}

		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "forbidden"})
	}
}
