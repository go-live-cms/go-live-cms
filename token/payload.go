package token

import (
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Common token validation errors.
var (
	// ErrInvalidToken is returned when a token is malformed or fails verification.
	ErrInvalidToken = fmt.Errorf("token is invalid")

	// ErrExpiredToken is returned when a token has passed its expiration time.
	ErrExpiredToken = fmt.Errorf("token has expired")
)

// Payload represents the claims contained within a token.
//
// Source of Truth Disclaimer: For v4, the payload struct mirrors claims but
// VerifyToken extracts only what's needed; the signed token is the ground truth.
//
// The payload contains all the information needed to identify and validate
// a user session, including unique identifiers, user information, timing
// data, and token type classification.
//
// Time Semantics: Time fields use wall clock for comparisons. Go time.Time
// contains monotonic components when derived from time.Now() but these are
// truncated during JSON serialization.
//
// Fields:
//   - ID: Unique token identifier for tracking and potential blacklisting
//   - UserID: Database ID of the authenticated user
//   - Username: Human-readable username for logging and debugging
//   - IssuedAt: When the token was created (for audit trails)
//   - ExpiredAt: When the token expires (for validation)
//   - TokenType: Distinguishes between "access" and "refresh" tokens
//
// JSON tags enable serialization for PASETO token bodies.
type Payload struct {
	ID        uuid.UUID `json:"id"`         // Unique token identifier
	UserID    int64     `json:"user_id"`    // User's database ID
	Username  string    `json:"username"`   // User's username
	IssuedAt  time.Time `json:"issued_at"`  // Token creation time
	ExpiredAt time.Time `json:"expired_at"` // Token expiration time
	TokenType string    `json:"token_type"` // "access" or "refresh"
}

// NewPayload creates a new token payload with the specified parameters.
//
// This function generates a unique token ID and sets the issued/expiration
// times based on the current time and provided duration.
//
// Usually you don't build Payload directly in v4 flows; it's useful in v2 or for tests.
//
// Parameters:
//   - userID: The database ID of the user this token represents
//   - username: The username for logging and debugging purposes
//   - duration: How long the token should remain valid
//   - tokenType: Either "access" or "refresh" to distinguish token purposes
//
// Returns:
//   - *Payload: A new payload ready for token encoding
//   - error: Any error from UUID generation
//
// Example:
//
//	payload, err := NewPayload(123, "john_doe", 15*time.Minute, "access")
//	if err != nil {
//	    log.Fatal("Failed to create payload:", err)
//	}
func NewPayload(userID int64, username string, duration time.Duration, tokenType string) (*Payload, error) {
	tokenID, err := uuid.NewRandom()
	if err != nil {
		return nil, err
	}

	payload := &Payload{
		ID:        tokenID,
		UserID:    userID,
		Username:  username,
		IssuedAt:  time.Now(),
		ExpiredAt: time.Now().Add(duration),
		TokenType: tokenType,
	}
	return payload, nil
}

// Valid checks if the token payload is still valid.
//
// This method performs time-based validation to ensure the token hasn't expired.
// Future versions may also check against a token blacklist stored in Redis
// or a database for enhanced security (e.g., after password changes or logout).
//
// Validation checks:
//   - Token expiration time vs current time
//   - TODO: Token blacklist lookup - see Sessions & Blacklist design doc
//
// Blacklist TODO: Intended interface: IsRevoked(jti uuid.UUID) bool
// This will check a Redis/database store for revoked token IDs after
// logout, password changes, or security events.
//
// Returns:
//   - nil: If the token is valid and can be trusted
//   - ErrExpiredToken: If the token has passed its expiration time
//   - ErrInvalidToken: If the token is blacklisted (future implementation)
//
// Example:
//
//	if err := payload.Valid(); err != nil {
//	    if errors.Is(err, ErrExpiredToken) {
//	        // Request new token via refresh flow
//	    } else {
//	        // Token is invalid, require full re-authentication
//	    }
//	    return
//	}
//	// Token is valid, proceed with request
func (payload *Payload) Valid() error {
	if time.Now().After(payload.ExpiredAt) {
		return ErrExpiredToken
	}

	// TODO: Implement token blacklisting when Redis/database is available
	/* if isTokenBlacklisted(payload.ID) {
	    return ErrInvalidToken
	} */

	return nil
}

// TODO: Implement this function with Redis or database
/* func isTokenBlacklisted(tokenID uuid.UUID) bool {
	// Check Redis or database for blacklisted tokens
	return false
} */
