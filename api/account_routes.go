// account_routes wires the invite-only account flows (#148).
//
// # Public, rate limited (/api/v1/auth)
//
//   - POST /auth/password/forgot: always 200, emails a reset link if the
//     address belongs to an account (no account enumeration)
//   - POST /auth/password/reset: redeems a reset token; revokes every
//     session and access token, like a password change
//   - POST /auth/invitations/preview: what an invitation is for (email, role)
//   - POST /auth/invitations/accept: redeems an invitation, creating the user
//     with the invited email and role
//
// Tokens travel in request bodies, never in URLs, so they can't end up in
// access logs or Referer headers. The web pages read them from the link's
// #fragment for the same reason.
//
// # Admin (/api/v1/invitations, requireSiteAdmin)
//
//   - GET    /invitations: open invitations (pending or expired)
//   - POST   /invitations: invite an email with a role
//   - POST   /invitations/:id/resend: new link (the old one stops working)
//   - DELETE /invitations/:id: revoke
package api

import "github.com/gin-gonic/gin"

func (server *Server) registerAccountRoutes(v1 *gin.RouterGroup) {
	auth := v1.Group("/auth")
	auth.POST("/password/forgot", server.rateLimits.passwordForgot.perIP(), server.forgotPassword)  // POST /api/v1/auth/password/forgot
	auth.POST("/password/reset", server.rateLimits.accountToken.perIP(), server.resetPassword)      // POST /api/v1/auth/password/reset
	auth.POST("/invitations/preview", server.rateLimits.accountToken.perIP(), server.previewInvite) // POST /api/v1/auth/invitations/preview
	auth.POST("/invitations/accept", server.rateLimits.accountToken.perIP(), server.acceptInvite)   // POST /api/v1/auth/invitations/accept

	invitations := v1.Group("/invitations")
	invitations.Use(authMiddleware(server.tokenMaker, server.store), requireSiteAdmin(server))
	invitations.GET("", server.listInvitations)              // GET /api/v1/invitations
	invitations.POST("", server.createInvitation)            // POST /api/v1/invitations
	invitations.POST("/:id/resend", server.resendInvitation) // POST /api/v1/invitations/:id/resend
	invitations.DELETE("/:id", server.revokeInvitation)      // DELETE /api/v1/invitations/:id
}
