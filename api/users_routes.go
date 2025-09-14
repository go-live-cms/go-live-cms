// users_routes implements HTTP route registration with role-based access control.
//
// Organizes user endpoints into three access tiers:
//   - **Public**: Profile discovery without authentication
//   - **Authenticated**: Self-service account management
//   - **Admin**: User administration and system management
//
// # Route Organization
//
// Routes are grouped by access level for clear security boundaries:
//   - Public routes require no authentication
//   - Auth routes require valid Bearer token
//   - Admin routes require Bearer token + admin role
//
// # Middleware Stack
//
// - **authMiddleware**: Bearer token validation and payload extraction
// - **requireRole**: Role-based access control enforcement
// - **Route ordering**: Static routes before parameterized routes
//
// # Security Boundaries
//
// Clear separation between public profile access and sensitive operations.
// Admin-only routes are protected by dedicated middleware ensuring proper authorization.
package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/go-live-cms/go-live-cms/token"
)

// RegisterUserRoutes configures user management endpoints with proper access controls.
//
// Implements three-tier access model with appropriate middleware protection.
// Static routes are registered before parameter routes to prevent conflicts.
//
// Route Structure:
//   - GET /me (authenticated self profile)
//   - GET /id/:id (admin lookup by ID)
//   - GET /email/:email (admin lookup by email)
//   - GET /:username (public profile - registered last to avoid conflicts)
//   - POST / (admin create)
//   - PUT /:id (self or admin update)
//   - DELETE /:id (admin delete)
//   - GET / (admin list)
//
// Route Precedence: Static routes (/me, /id/:id, /email/:email) take precedence
// over parameter routes (/:username) due to Gin's routing behavior.
func (server *Server) RegisterUserRoutes(v1 *gin.RouterGroup) {
	users := v1.Group("/users")

	// Authenticated user routes (require valid Bearer token)
	usersAuth := users.Group("")
	usersAuth.Use(authMiddleware(server.tokenMaker))
	usersAuth.GET("/me", server.getMe) // GET /api/v1/users/me

	// Admin-only routes (require Bearer token + admin role)
	admin := usersAuth.Group("")
	admin.Use(requireRole("admin", server))
	admin.POST("", server.createUser)                 // POST /api/v1/users
	admin.GET("", server.getUsers)                    // GET /api/v1/users?limit=10&sort=date_desc
	admin.GET("/id/:id", server.getUserByID)          // GET /api/v1/users/id/123
	admin.GET("/email/:email", server.getUserByEmail) // GET /api/v1/users/email/john@example.com

	// Update/delete routes (self or admin access patterns handled in handlers)
	usersAuth.PUT("/:id", server.updateUser)    // PUT /api/v1/users/123 (self or admin)
	usersAuth.DELETE("/:id", server.deleteUser) // DELETE /api/v1/users/123 (admin only)

	// Public profile access by username (registered last to avoid parameter conflicts)
	users.GET("/:username", server.getUserByUsername) // GET /api/v1/users/johndoe
}

// requireRole creates middleware that enforces role-based access control.
//
// Validates that the authenticated user has the required role for admin operations.
// Retrieves user role from database using the token's UserID for accurate verification.
//
// Parameters:
//   - role: Required role string (typically "admin")
//   - server: Server instance for database access
//
// Returns:
//   - gin.HandlerFunc: Middleware function for route protection
//
// Behavior:
//   - Extracts auth payload from middleware context
//   - Queries database to get current user role
//   - Compares user role against required role (case-insensitive)
//   - Returns 403 Forbidden if role insufficient or 500 on database error
//   - Continues to handler if role matches
func requireRole(role string, server *Server) gin.HandlerFunc {
	return func(c *gin.Context) {
		auth := c.MustGet(authorizationPayloadKey).(*token.Payload)

		// Get user from database to check current role
		user, err := server.store.GetUser(c.Request.Context(), auth.UserID)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "failed to verify user role"})
			return
		}

		// Check if user has required role (case-insensitive)
		if !strings.EqualFold(user.Role, role) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "forbidden"})
			return
		}

		c.Next()
	}
}
