// sessions_routes wires authentication and session management endpoints with appropriate middleware.
//
// # Route Architecture
//
// This file establishes two logical route groups:
//   - /auth — Public authentication flows (login/refresh/logout)
//   - /sessions — Protected session administration (list/block)
//
// # Authentication Routes (/api/v1/auth)
//
// **Login Flow** (POST /login):
//   - No authentication required
//   - Validates username/password against database
//   - Creates session record and tokens
//   - Sets httpOnly refresh cookie
//
// **Token Refresh** (POST /refresh):
//   - Cookie-based authentication (refresh token)
//   - Implements automatic token rotation
//   - Includes reuse detection security
//   - Updates session record
//
// **Logout** (POST /logout):
//   - Requires valid access token via Bearer header
//   - Blocks current session in database
//   - Clears refresh cookie
//   - Prevents further token use
//
// # Session Management Routes (/api/v1/sessions)
//
// **List Sessions** (GET /):
//   - Auth required: users see own sessions, admins see all
//   - Paginated response with metadata
//   - Includes session details (IP, user agent, status)
//
// **Block Session** (PUT /block):
//   - Auth required: users can block own sessions, admins any
//   - Immediately invalidates refresh tokens
//   - Useful for remote logout scenarios
//
// # Middleware Strategy
//
// - Authentication routes (/auth) mix public and protected endpoints
// - Session routes (/sessions) uniformly require authentication
// - Bearer token validation via authMiddleware for protected endpoints
// - Cookie parsing handled within individual refresh/logout handlers
package api

import "github.com/gin-gonic/gin"

// RegisterSessionRoutes configures all session and authentication endpoints
// on the provided router group with appropriate middleware protection.
//
// Route registration follows the principle of least privilege:
//   - Public routes allow unauthenticated access for login/refresh
//   - Protected routes require valid Bearer access tokens
//   - Session routes use group-level middleware for uniform protection
func (server *Server) RegisterSessionRoutes(v1 *gin.RouterGroup) {
	// Authentication endpoints - mixed access patterns
	auth := v1.Group("/auth")
	auth.POST("/register", server.register)                                    // POST /api/v1/auth/register
	auth.POST("/login", server.loginUser)                                      // POST /api/v1/auth/login
	auth.POST("/refresh", server.renewAccessToken)                             // POST /api/v1/auth/refresh
	auth.POST("/logout", authMiddleware(server.tokenMaker), server.logoutUser) // POST /api/v1/auth/logout

	// Session management endpoints - uniformly protected
	sessions := v1.Group("/sessions")
	sessions.Use(authMiddleware(server.tokenMaker))
	sessions.GET("", server.getUserSessions)    // GET /api/v1/sessions
	sessions.PUT("/block", server.blockSession) // PUT /api/v1/sessions/block
}
