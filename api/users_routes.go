// users_routes implements HTTP route registration with role-based access control.
//
// Organizes user endpoints into three access tiers:
//   - **Signed in**: profiles by username (#393; public author pages are /public/authors)
//   - **Authenticated**: Self-service account management
//   - **Admin**: User administration and system management
//
// # Route Organization
//
// Routes are grouped by access level for clear security boundaries:
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
// No user route is public (#393).
// Admin-only routes are protected by dedicated middleware ensuring proper authorization.
package api

import (
	"github.com/gin-gonic/gin"
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
//   - GET /:username (signed-in profile lookup - registered last to avoid conflicts)
//   - POST / (admin create)
//   - PUT /:id (self or admin update)
//   - DELETE /:id (admin remove, posts reassigned)
//   - PUT /:id/role (admin role change)
//   - GET / (admin list: ?q= search, ?role=, last active, posts owned)
//
// Route Precedence: Static routes (/me, /id/:id, /email/:email) take precedence
// over parameter routes (/:username) due to Gin's routing behavior.
func (server *Server) RegisterUserRoutes(v1 *gin.RouterGroup) {
	users := v1.Group("/users")

	// Authenticated user routes (require valid Bearer token)
	usersAuth := users.Group("")
	usersAuth.Use(server.requireAuth())
	usersAuth.GET("/me", server.getMe) // GET /api/v1/users/me
	// Your own account (#334): avatar and email change.
	usersAuth.PUT("/me/avatar", server.uploadAvatar)       // PUT /api/v1/users/me/avatar (multipart)
	usersAuth.DELETE("/me/avatar", server.deleteAvatar)    // DELETE /api/v1/users/me/avatar
	usersAuth.POST("/me/email", server.requestEmailChange) // POST /api/v1/users/me/email {current_password, new_email}

	// Admin-only routes (require Bearer token + admin role)
	admin := usersAuth.Group("")
	admin.Use(requireSiteAdmin(server))
	admin.POST("", server.createUser)                 // POST /api/v1/users
	admin.GET("", server.getUsers)                    // GET /api/v1/users?limit=10&sort=date_desc
	admin.GET("/id/:id", server.getUserByID)          // GET /api/v1/users/id/123
	admin.GET("/email/:email", server.getUserByEmail) // GET /api/v1/users/email/john@example.com
	admin.DELETE("/:id", server.deleteUser)           // DELETE /api/v1/users/123 {transfer_to_id} (admin only)
	admin.PUT("/:id/role", server.changeUserRole)     // PUT /api/v1/users/123/role {role} (admin only, #333)

	// Self-or-admin update: ownership and the role-change restriction are
	// field-level rules enforced inside the handler, not by middleware.
	usersAuth.PUT("/:id", server.updateUser) // PUT /api/v1/users/123 (self or admin)

	// Profile by username (registered last to avoid parameter conflicts). Signed-in
	// users only (#393): it has the id and role, and would let anyone check which
	// usernames exist. Public author pages use /public/authors (#350).
	usersAuth.GET("/:username", server.getUserByUsername) // GET /api/v1/users/johndoe
}
