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
	"fmt"
	"log"

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

// Log message constants for session security events
const (
	LogSessionReuse     = "🚨 SECURITY ALERT: Refresh token reuse detected"
	LogSessionBlocked   = "🔒 Session blocked due to security violation"
	LogUAIPChange       = "ℹ️  User agent or IP change detected"
	LogSessionCreated   = "✅ New session created"
	LogSessionRefreshed = "🔄 Session refreshed successfully"
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

// logSecurityEvent logs session security events with consistent formatting.
// Includes session ID, user ID, and event context for audit trails.
func logSecurityEvent(eventType, sessionID string, userID int64, details string) {
	if LogUAIPChanges || eventType == LogSessionReuse || eventType == LogSessionBlocked {
		log.Printf("%s | SessionID: %s | UserID: %d | Details: %s",
			eventType, sessionID, userID, details)
	}
}

// logUserAgentIPChange logs user agent or IP address changes for security monitoring.
// Helps detect potential account compromise or session hijacking attempts.
func logUserAgentIPChange(sessionID uuid.UUID, userID int64, oldUA, newUA, oldIP, newIP string) {
	if !LogUAIPChanges {
		return
	}

	details := fmt.Sprintf("UA: %s -> %s | IP: %s -> %s", oldUA, newUA, oldIP, newIP)
	logSecurityEvent(LogUAIPChange, sessionID.String(), userID, details)
}
