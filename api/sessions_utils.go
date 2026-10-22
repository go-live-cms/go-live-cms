// sessions_utils provides helper functions and constants for session management operations.
//
// # Token Processing Helpers
//
// Utilities for working with Paseto tokens and session data:
//   - JTI extraction from token payloads
//   - Safe type casting and error handling
//   - Token validation and parsing assistance
//
// # Error Messages and Constants
//
// Centralized error messages ensure consistent API responses:
//   - Authentication error messages
//   - Token validation error text
//   - Session management status messages
//
// # Logging and Observability
//
// Session security event logging:
//   - IP and user agent change detection
//   - Session reuse detection alerts
//   - Authentication failure tracking
//   - Configurable log levels and formats
//
// # Feature Flags
//
// Development and debugging controls:
//   - LogUAIPChanges for behavioral monitoring
//   - Development mode session details
//   - Security event verbosity controls
package api

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/go-live-cms/go-live-cms/token"
	"github.com/google/uuid"
)

// Error message constants for consistent API responses
const (
	ErrInvalidCredentials  = "invalid credentials"
	ErrInvalidTokenType    = "invalid token type"
	ErrTokenCreationFailed = "failed to create token"
	ErrSessionNotFound     = "session not found"
	ErrSessionBlocked      = "session is blocked"
)

// Event names (the "event" field) for session security log lines
const (
	LogSessionReuse     = "refresh_token_reuse"
	LogSessionBlocked   = "session_blocked"
	LogUAIPChange       = "session_client_changed"
	LogSessionCreated   = "session_created"
	LogSessionRefreshed = "session_refreshed"
	LogPasswordChanged  = "password_changed"
)

// Feature flags for development and debugging
const (
	LogUAIPChanges = true // Enable user agent and IP change logging
)

// extractJTI safely extracts the JTI (JWT ID) from a token payload.
// Returns the session UUID if present, or an error if extraction fails.
func extractJTI(payload *token.Payload) (uuid.UUID, error) {
	if payload == nil {
		return uuid.Nil, fmt.Errorf("payload is nil")
	}

	if payload.ID == uuid.Nil {
		return uuid.Nil, fmt.Errorf("JTI not found in payload")
	}

	return payload.ID, nil
}

// logSecurityEvent writes a structured session security event (event, session
// id, user id, details) for audit trails. Reuse and blocks are warnings.
// details must not contain IPs, user agents, usernames or tokens (#155); the
// user id is the identifier.
func logSecurityEvent(eventType, sessionID string, userID int64, details string) {
	if !LogUAIPChanges && eventType != LogSessionReuse && eventType != LogSessionBlocked {
		return
	}
	level := slog.LevelInfo
	if eventType == LogSessionReuse || eventType == LogSessionBlocked {
		level = slog.LevelWarn
	}
	slog.Default().LogAttrs(context.Background(), level, "session_security_event",
		slog.String("event", eventType),
		slog.String("session_id", sessionID),
		slog.Int64("user_id", userID),
		slog.String("details", details),
	)
}

// logUserAgentIPChange records that a refreshing session's user agent or IP
// differs from the one it was created with, to help spot hijacked sessions.
// Only whether each changed is logged, never the values (low-PII, #155); the
// sessions table keeps the current ones.
func logUserAgentIPChange(sessionID uuid.UUID, userID int64, oldUA, newUA, oldIP, newIP string) {
	if !LogUAIPChanges {
		return
	}

	details := fmt.Sprintf("user_agent_changed=%t ip_changed=%t", oldUA != newUA, oldIP != newIP)
	logSecurityEvent(LogUAIPChange, sessionID.String(), userID, details)
}
