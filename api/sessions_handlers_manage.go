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
	"bytes"
	"database/sql"
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
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
		if !server.config.IsDebugMode() {
			// No raw IPs outside debug (#155, #334).
			sessionResponses[i].ClientIP = ""
		}
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
	if !bindJSON(ctx, &req) {
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
	logSecurityEvent(ctx, LogSessionBlocked, req.SessionID.String(), authPayload.UserID, "Manual session block by user")

	ctx.JSON(http.StatusOK, gin.H{
		"message":    "session blocked successfully",
		"session_id": req.SessionID,
	})
}

// listMyDevices answers Profile's "other devices" (#334): the caller's sessions that
// can still refresh, newest first, which of them is this browser's (from the
// refresh cookie, which is why the route is under /auth: the dev cookie's Path is
// /api/v1/auth), and how many others there are. No IPs outside debug.
//
// Returns 200 {"sessions": [DeviceSessionResponse], "other_count": n}.
func (server *Server) listMyDevices(c *gin.Context) {
	payload := getAuthPayload(c)
	sessions, err := server.store.ListActiveSessionsByUser(c.Request.Context(), payload.UserID)
	if err != nil {
		server.requestLog(c).Error("listing sessions failed", "user_id", payload.UserID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get sessions"})
		return
	}

	var current []byte
	if cookie := server.readRefreshCookie(c); cookie != "" {
		current = token.HashRefresh(cookie)
	}
	debug := server.config.IsDebugMode()
	devices := make([]DeviceSessionResponse, len(sessions))
	others := 0
	for i, s := range sessions {
		isCurrent := current != nil && bytes.Equal(s.RefreshTokenHash, current)
		if !isCurrent {
			others++
		}
		devices[i] = toDeviceSessionResponse(s, isCurrent, debug)
	}

	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"sessions": devices, "other_count": others})
}

// signOutOtherDevices blocks every session of the caller except this browser's
// (the one its refresh cookie names), revoking their refresh tokens (#334).
// Access tokens already issued to the other devices stay valid until they expire
// (ACCESS_TOKEN_DURATION), as after a logout; only a password change cuts them short.
//
// Returns:
//   - 200 OK: {"signed_out": n}
//   - 409 Conflict: (code "session_not_active") no refresh cookie, or its session
//     isn't an active one of the caller's (the client should sign in again)
func (server *Server) signOutOtherDevices(c *gin.Context) {
	payload := getAuthPayload(c)
	cookie := server.readRefreshCookie(c)
	if cookie == "" {
		respondSessionNotActive(c)
		return
	}

	result, err := server.store.SignOutOtherSessionsTx(c.Request.Context(), db.SignOutOtherSessionsTxParams{
		UserID:           payload.UserID,
		RefreshTokenHash: token.HashRefresh(cookie),
	})
	if err != nil {
		if errors.Is(err, db.ErrSessionNotActive) {
			respondSessionNotActive(c)
			return
		}
		server.requestLog(c).Error("signing out other sessions failed", "user_id", payload.UserID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to sign out other devices"})
		return
	}

	logSecurityEvent(c, LogOtherSessionsOut, result.KeptSessionID.String(), payload.UserID, fmt.Sprintf("Blocked %d other sessions", result.Blocked))
	c.JSON(http.StatusOK, gin.H{"signed_out": result.Blocked})
}

func respondSessionNotActive(c *gin.Context) {
	c.JSON(http.StatusConflict, gin.H{"error": "this browser's session has ended; sign in again", "code": "session_not_active"})
}
