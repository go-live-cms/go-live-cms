// users_presenters implements response formatting with privacy controls.
//
// Provides two response formats based on access level:
//   - **PublicUserResponse**: Safe for public consumption, excludes email
//   - **PrivateUserResponse**: Complete profile data for self/admin access
//
// # Privacy Protection
//
// Email addresses are considered sensitive and only exposed to:
//   - The user themselves (self-access)
//   - Administrators (user management)
//
// # Response Selection
//
// Use PublicUserResponse for:
//   - Public profile endpoints (/users/:username)
//   - User listings where email privacy matters
//
// Use PrivateUserResponse for:
//   - Self-profile access (/users/me)
//   - Admin user management operations
//   - Account update confirmations
package api

import (
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// PublicUserResponse represents user data safe for public consumption.
//
// Excludes sensitive information like email addresses while providing
// essential profile information for display and identification purposes.
//
// Used for:
//   - Public profile pages
//   - Author attribution on content
//   - User directory listings
//   - Search results
type PublicUserResponse struct {
	ID        int64     `json:"id"`
	Username  string    `json:"username"`
	FullName  string    `json:"full_name"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"created_at"`
}

// PrivateUserResponse represents complete user data for authorized access.
//
// Includes sensitive information like email addresses for users accessing
// their own profile or administrators managing user accounts.
//
// Used for:
//   - Self-profile endpoints (/users/me)
//   - Admin user management interfaces
//   - Account update confirmations
//   - Administrative user listings
type PrivateUserResponse struct {
	ID        int64     `json:"id"`
	Username  string    `json:"username"`
	Email     string    `json:"email"`
	FullName  string    `json:"full_name"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"created_at"`
}

// toPublicUser converts database user record to public response format.
//
// Strips sensitive information for safe public consumption.
// Used when user data is displayed to unauthorized viewers.
//
// Parameters:
//   - user: Database user record with complete information
//
// Returns:
//   - PublicUserResponse: Public-safe user data structure
func toPublicUser(user db.User) PublicUserResponse {
	return PublicUserResponse{
		ID:        user.ID,
		Username:  user.Username,
		FullName:  user.FullName,
		Role:      user.Role,
		CreatedAt: user.CreatedAt,
	}
}

// toPrivateUser converts database user record to private response format.
//
// Includes complete user information including sensitive email address.
// Only use when caller has appropriate access (self or admin).
//
// Parameters:
//   - user: Database user record with complete information
//
// Returns:
//   - PrivateUserResponse: Complete user data structure with email
func toPrivateUser(user db.User) PrivateUserResponse {
	return PrivateUserResponse{
		ID:        user.ID,
		Username:  user.Username,
		Email:     user.Email,
		FullName:  user.FullName,
		Role:      user.Role,
		CreatedAt: user.CreatedAt,
	}
}
