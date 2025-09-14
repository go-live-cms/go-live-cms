// users_utils provides validation helpers and utility functions for user management.
//
// # Data Normalization
//
// Consistent formatting for user input prevents duplicates and improves data quality:
//   - Email addresses: lowercase and trimmed
//   - Usernames: trimmed whitespace (preserve case sensitivity)
//
// # Validation Functions
//
// - **Sort parameter validation**: Prevents SQL injection via query parameters
// - **Unique constraint detection**: Proper HTTP status codes for conflicts
// - **Role-based access**: Middleware helpers for authorization
//
// # Security Utilities
//
// Database error classification for consistent conflict handling and
// role-based access control enforcement throughout user operations.
package api

import (
	"strings"
)

// normEmail normalizes email addresses for consistent storage and lookup.
//
// Applies lowercase conversion and whitespace trimming to prevent duplicate
// accounts with case variations or spacing differences.
//
// Parameters:
//   - s: Raw email address from user input
//
// Returns:
//   - string: Normalized email address (lowercase, trimmed)
func normEmail(s string) string {
	return strings.TrimSpace(strings.ToLower(s))
}

// normUsername normalizes usernames while preserving intended case.
//
// Trims whitespace but preserves case sensitivity for usernames.
// Prevents accidental leading/trailing spaces in user accounts.
//
// Parameters:
//   - s: Raw username from user input
//
// Returns:
//   - string: Normalized username (trimmed, case preserved)
func normUsername(s string) string {
	return strings.TrimSpace(s)
}

// isValidUserSortOption validates sorting parameters for user listing endpoints.
//
// Prevents SQL injection through sort parameters by allowing only predefined
// sorting options. Empty sort defaults to safe fallback in handlers.
//
// Supported options:
//   - date_asc, date_desc: Sort by account creation date
//   - username_asc, username_desc: Alphabetical username sorting
//   - email_asc, email_desc: Alphabetical email sorting (admin only)
//   - role_asc, role_desc: Sort by user role
//   - id_asc, id_desc: Sort by database primary key
//
// Parameters:
//   - sort: Sort parameter from query string
//
// Returns:
//   - bool: true if sort option is valid, false if potentially dangerous
func isValidUserSortOption(sort string) bool {
	switch sort {
	case "", "date_asc", "date_desc", "username_asc", "username_desc",
		"email_asc", "email_desc", "role_asc", "role_desc", "id_asc", "id_desc":
		return true
	default:
		return false
	}
}

// isUniqueViolation checks if database error indicates unique constraint violation.
//
// Analyzes database error messages to identify duplicate key violations,
// enabling appropriate HTTP status code responses for client applications.
//
// Parameters:
//   - err: Database error to analyze
//
// Returns:
//   - bool: True if error indicates unique constraint violation
func isUniqueViolation(err error) bool {
	return containsString(err.Error(), "duplicate key value") ||
		containsString(err.Error(), "unique constraint")
}
