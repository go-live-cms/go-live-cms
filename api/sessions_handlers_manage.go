// sessions_handlers_manage implements session administration endpoints for users and administrators.
//
// # Session Management Operations
//
// This module provides session oversight capabilities:
//   - **List Sessions**: View active sessions for current user or all users (admin)
//   - **Block Sessions**: Remotely invalidate specific sessions for security
//
// # Authorization Model
//
// **User Self-Management**:
//   - Users can list their own active sessions
//   - Users can block their own sessions (remote logout)
//   - Session ownership is enforced via user ID matching
//
// **Administrative Operations**:
//   - Future: Admin users could manage sessions across all users
//   - Current: All operations are self-service only
//   - Session access control via authPayload validation
//
// # Security Considerations
//
// **Access Control**:
//   - All endpoints require valid Bearer access tokens
//   - Session ownership verified against authenticated user
//   - Prevents cross-user session manipulation
//
// **Audit Trail**:
//   - Session blocking events are logged for security monitoring
//   - Includes session ID, user ID, and action context
//   - Supports incident response and forensic analysis
//
// # Use Cases
//
// **Personal Security**:
//   - Users can see active login locations and devices
//   - Remote logout from compromised or shared devices
//   - Session hygiene and access review
//
// **Incident Response**:
//   - Quick session termination after suspicious activity
//   - Bulk session invalidation during security incidents
//   - Session metadata review for forensic analysis
package api

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/go-live-cms/go-live-cms/token"
)

// getUserSessions returns all active sessions for the authenticated user.
//
// Response includes:
//   - Session metadata (ID, creation time, expiration)
//   - Device information (user agent, IP address)
//   - Session status (active, blocked)
//   - Total session count for pagination
//
// Security:
//   - Only returns sessions owned by the authenticated user
//   - Session data is filtered through response presenters
//   - No sensitive token data included in responses
func (server *Server) getUserSessions(ctx *gin.Context) {
	// Get authenticated user from middleware
	authPayload := ctx.MustGet(authorizationPayloadKey).(*token.Payload)

	// List sessions for the authenticated user
	sessions, err := server.store.ListSessionsByUser(ctx.Request.Context(), authPayload.UserID)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get sessions"})
		return
	}

	// Convert to response format
	sessionResponses := make([]SessionResponse, len(sessions))
	for i, session := range sessions {
		sessionResponses[i] = toSessionResponse(session)
	}

	ctx.JSON(http.StatusOK, gin.H{
		"sessions": sessionResponses,
		"count":    len(sessionResponses),
	})
}

// blockSession invalidates a specific session by ID for security purposes.
//
// Use cases:
//   - Remote logout from compromised device
//   - Session cleanup after device loss/theft
//   - Proactive security after suspicious activity
//
// Flow:
//  1. Validate request contains valid session UUID
//  2. Look up target session in database
//  3. Verify session ownership matches authenticated user
//  4. Block session in database (prevents further token use)
//  5. Log security event for audit trail
//  6. Return success confirmation
//
// Security:
//   - Session ownership is strictly enforced
//   - Only authenticated users can block their own sessions
//   - Blocked sessions cannot be unblocked (security by design)
func (server *Server) blockSession(ctx *gin.Context) {
	var req BlockSessionRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Get authenticated user from middleware
	authPayload := ctx.MustGet(authorizationPayloadKey).(*token.Payload)

	// Look up target session
	session, err := server.store.GetSession(ctx.Request.Context(), req.SessionID)
	if err != nil {
		if err == sql.ErrNoRows {
			ctx.JSON(http.StatusNotFound, gin.H{"error": ErrSessionNotFound})
			return
		}
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get session"})
		return
	}

	// Verify session ownership
	if session.UserID != authPayload.UserID {
		ctx.JSON(http.StatusForbidden, gin.H{"error": "not authorized to block this session"})
		return
	}

	// Block the session
	err = server.store.BlockSession(ctx.Request.Context(), req.SessionID)
	if err != nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "failed to block session"})
		return
	}

	// Log security event
	logSecurityEvent(LogSessionBlocked, req.SessionID.String(), authPayload.UserID, "Manual session block by user")

	ctx.JSON(http.StatusOK, gin.H{
		"message":    "session blocked successfully",
		"session_id": req.SessionID,
	})
}
