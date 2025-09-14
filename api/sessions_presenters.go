// sessions_presenters handles response formatting and data transformation for session endpoints.
//
// # Response Formatting
//
// This module transforms internal database models into client-facing JSON responses:
//   - Maps database field names to consistent JSON field names
//   - Handles data type conversions and formatting
//   - Excludes sensitive internal fields from responses
//   - Maintains consistent timestamp formatting
//
// # Data Protection
//
// Session responses include sufficient data for client functionality while protecting:
//   - Internal database IDs that shouldn't be exposed
//   - Cryptographic material (refresh token hashes)
//   - Administrative metadata not relevant to clients
//   - Potentially sensitive user agent details (when appropriate)
//
// # Conversion Patterns
//
// All presenters follow consistent patterns:
//   - Accept database model structs as input
//   - Return client-safe response structs
//   - Handle null/optional fields appropriately
//   - Maintain referential consistency with related entities
package api

import (
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/google/uuid"
)

// SessionResponse represents a user session for API consumption.
// Includes session metadata, user identification, and security details.
type SessionResponse struct {
	ID        uuid.UUID `json:"id"`
	UserID    int64     `json:"user_id"`
	Username  string    `json:"username"`
	UserAgent string    `json:"user_agent"`
	ClientIP  string    `json:"client_ip"`
	IsBlocked bool      `json:"is_blocked"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

// toSessionResponse converts database session record to API response format.
// Maps internal field names to consistent JSON structure and excludes sensitive data.
func toSessionResponse(session db.Session) SessionResponse {
	return SessionResponse{
		ID:        session.ID,
		UserID:    session.UserID,
		Username:  session.Username,
		UserAgent: session.UserAgent,
		ClientIP:  session.ClientIp, // Note: maps ClientIp -> client_ip
		IsBlocked: session.IsBlocked,
		ExpiresAt: session.ExpiresAt,
		CreatedAt: session.CreatedAt,
	}
}
