// sessions_bindings defines request and response structures for session and authentication endpoints.
//
// # Request Validation
//
// All request structures include gin binding tags for automatic validation:
//   - `required` ensures mandatory fields are present
//   - `alphanum` restricts usernames to alphanumeric characters
//   - `min=6` enforces minimum password length
//   - `uuid` validates session ID format
//
// # Response Consistency
//
// Response structures maintain consistent field naming and types:
//   - snake_case JSON field names for API consistency
//   - RFC3339 timestamps for access token expiration
//   - Unix timestamps for compatibility where needed
//   - UUID types for session identification
//
// # Security Considerations
//
// - Passwords are never included in response structures
// - Refresh tokens are cookie-only, not in JSON responses
// - Session responses exclude sensitive internal fields
// - User data is presented via embedded PrivateUserResponse structures
package api

import (
	"time"

	"github.com/google/uuid"
)

// LoginUserRequest contains credentials for user authentication.
// Username must be alphanumeric, password must be at least 6 characters.
type LoginUserRequest struct {
	Username string `json:"username" binding:"required,alphanum"`
	Password string `json:"password" binding:"required,min=6"`
}

// LoginUserResponse returns authentication tokens and user data upon successful login.
// The refresh token is set as an httpOnly cookie, not included in JSON.
type LoginUserResponse struct {
	SessionID            uuid.UUID           `json:"session_id"`
	AccessToken          string              `json:"access_token"`
	AccessTokenExpiresAt time.Time           `json:"access_token_expires_at"`
	ExpiresAt            int64               `json:"expires_at"`
	User                 PrivateUserResponse `json:"user"`
}

// RenewAccessTokenRequest accepts refresh token for access token renewal.
// Currently unused as refresh tokens are read from httpOnly cookies.
type RenewAccessTokenRequest struct {
	RefreshToken string `json:"refresh_token"`
}

// RenewAccessTokenResponse returns new access token after successful refresh.
// New refresh token is set as httpOnly cookie automatically.
type RenewAccessTokenResponse struct {
	AccessToken          string    `json:"access_token"`
	AccessTokenExpiresAt time.Time `json:"access_token_expires_at"`
	ExpiresAt            int64     `json:"expires_at"`
}

// BlockSessionRequest identifies which session to block by UUID.
// Used for remote logout and security incident response.
type BlockSessionRequest struct {
	SessionID uuid.UUID `json:"session_id" binding:"required"`
}
