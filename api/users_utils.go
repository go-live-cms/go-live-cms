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
	"database/sql"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
	"github.com/go-playground/validator/v10"
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

// checkUsernameFormat answers 400 and returns false unless username (already
// trimmed) passes the same `alphanum` rule as loginUser's binding, so every
// account a handler creates or renames can log in.
func checkUsernameFormat(c *gin.Context, username string) bool {
	if binding.Validator.Engine().(*validator.Validate).Var(username, "alphanum") == nil {
		return true
	}
	c.JSON(http.StatusBadRequest, gin.H{
		"error":  "username must contain only letters and digits",
		"fields": gin.H{"username": "must contain only letters and digits"},
	})
	return false
}

// bioMaxChars is the author bio's limit (#350), in characters (code points,
// as Postgres' char_length and the profile form count them).
const bioMaxChars = 300

// rejectProfileField writes a field error in bindJSON's format.
func rejectProfileField(c *gin.Context, field, message string) {
	c.JSON(http.StatusBadRequest, gin.H{
		"error":  field + " " + message,
		"fields": gin.H{field: message},
	})
}

// normalizeBio trims the bio and checks it's plain text of at most
// bioMaxChars. nil (field absent) stays NULL, which keeps the stored value.
func normalizeBio(c *gin.Context, bio *string) (sql.NullString, bool) {
	if bio == nil {
		return sql.NullString{}, true
	}
	text := strings.TrimSpace(strings.ReplaceAll(*bio, "\r\n", "\n"))
	if !utf8.ValidString(text) {
		rejectProfileField(c, "bio", "must be valid text")
		return sql.NullString{}, false
	}
	for _, r := range text {
		// Line breaks and tabs are text; other control characters aren't.
		if (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f {
			rejectProfileField(c, "bio", "must be plain text")
			return sql.NullString{}, false
		}
	}
	if utf8.RuneCountInString(text) > bioMaxChars {
		rejectProfileField(c, "bio", "must be at most 300 characters")
		return sql.NullString{}, false
	}
	return sql.NullString{String: text, Valid: true}, true
}

// normalizeWebsite trims the website and checks it's an http(s) URL; "" clears
// it and nil (absent) keeps the stored value.
func normalizeWebsite(c *gin.Context, website *string) (sql.NullString, bool) {
	if website == nil {
		return sql.NullString{}, true
	}
	url := strings.TrimSpace(*website)
	if url != "" && binding.Validator.Engine().(*validator.Validate).Var(url, "http_url") != nil {
		rejectProfileField(c, "website", "must be an http or https URL")
		return sql.NullString{}, false
	}
	return sql.NullString{String: url, Valid: true}, true
}
