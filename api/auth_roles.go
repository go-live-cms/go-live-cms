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
// indexed GetUser query per protected request, run once by authMiddleware
// and shared with requireRole through the request context.
package api

import (
	"database/sql"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
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

// isSiteAdmin reports whether the user holds site-administration privileges.
// Handlers that need an inline admin check (e.g. self-or-admin endpoints) use
// this instead of comparing role strings themselves.
func isSiteAdmin(user db.User) bool {
	return hasRole(user, RoleAdmin)
}

// canModerateMedia reports whether the user may update or delete media
// uploaded by OTHER users. Admins and editors can (content moderation; editors
// can already delete any post, which is more destructive). Any other role that
// reaches a media write handler is limited to its own uploads.
func canModerateMedia(user db.User) bool {
	return hasRole(user, RoleAdmin, RoleEditor)
}

// canWriteMedia reports whether the user may update or delete the given
// media: moderators may touch any media, everyone else only their own
// uploads. PUT and DELETE /media/:id both decide through this.
func canWriteMedia(user db.User, media db.Medium) bool {
	return canModerateMedia(user) || media.UserID == user.ID
}

// hasRole reports whether the user's role matches any of the given roles,
// case-insensitively.
func hasRole(user db.User, roles ...string) bool {
	for _, role := range roles {
		if strings.EqualFold(user.Role, role) {
			return true
		}
	}
	return false
}

// callerUser loads the authenticated caller's CURRENT database row.
//
// Must run after authMiddleware, which already loaded the row for this
// request; that copy is returned without another query. The lookup below
// only runs if it is missing. On failure it aborts with the response
// already written and returns ok=false; the caller just returns:
//   - 403 Forbidden: the token's user no longer exists (deleted account
//     holding a still-valid token)
//   - 500 Internal Server Error: database failure during the lookup
func (server *Server) callerUser(c *gin.Context) (db.User, bool) {
	if cached, exists := c.Get(authorizationUserKey); exists {
		if user, ok := cached.(db.User); ok {
			return user, true
		}
	}

	auth := getAuthPayload(c)

	user, err := server.store.GetUser(c.Request.Context(), auth.UserID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "forbidden"})
			return db.User{}, false
		}
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "failed to verify user role"})
		return db.User{}, false
	}
	return user, true
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
		user, ok := server.callerUser(c)
		if !ok {
			return
		}

		if !hasRole(user, roles...) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "forbidden"})
			return
		}

		c.Next()
	}
}
