// users_handlers_read implements user profile retrieval and listing operations.
//
// Handles read-only user operations with appropriate privacy controls and access restrictions.
// Uses different response formats based on caller's relationship to requested data.
//
// # Access Patterns
//
// - **Public Access**: Profile discovery by username (limited data)
// - **Self Access**: Complete profile data for authenticated user
// - **Admin Access**: Full administrative access to any user data
//
// # Privacy Controls
//
// Email addresses and other sensitive data are only exposed to authorized viewers.
// Public endpoints return sanitized profile information safe for general consumption.
//
// # Pagination Support
//
// List endpoints support limit/offset pagination with configurable sorting options.
// Maximum page sizes prevent resource exhaustion and ensure reasonable response times.
package api

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

// getUserByUsername retrieves public user profile by username.
//
// Public endpoint that returns sanitized user information safe for general consumption.
// Does not require authentication and excludes sensitive data like email addresses.
//
// Path parameters:
//   - username: User's unique username identifier
//
// Returns:
//   - 200 OK: Public user profile data
//   - 400 Bad Request: Missing username parameter
//   - 404 Not Found: User does not exist
//   - 500 Internal Server Error: Database query failure
func (server *Server) getUserByUsername(c *gin.Context) {
	username := c.Param("username")
	if username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username is required"})
		return
	}

	user, err := server.store.GetUserByUsername(c.Request.Context(), username)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"user": toPublicUser(user),
	})
}

// getMe retrieves the current authenticated user's complete profile.
//
// Returns private profile data including email address for the authenticated user.
// Uses Bearer token to identify the requesting user.
//
// Authentication: Required (Bearer token)
//
// Returns:
//   - 200 OK: Complete user profile with private data
//   - 401 Unauthorized: Invalid or missing authentication token
//   - 404 Not Found: Authenticated user account not found
//   - 500 Internal Server Error: Database query failure
func (server *Server) getMe(c *gin.Context) {
	auth := c.MustGet(authorizationPayloadKey).(*token.Payload)

	user, err := server.store.GetUser(c.Request.Context(), auth.UserID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"user": toPrivateUser(user),
	})
}

// getUserByID retrieves user profile by database ID (admin only).
//
// Administrative endpoint for user management operations. Returns complete
// user profile including sensitive data like email addresses.
//
// Path parameters:
//   - id: User's database primary key
//
// Authentication: Required (Bearer token + admin role)
//
// Returns:
//   - 200 OK: Complete user profile data
//   - 400 Bad Request: Invalid user ID parameter
//   - 401 Unauthorized: Invalid authentication token
//   - 403 Forbidden: Insufficient permissions (non-admin)
//   - 404 Not Found: User does not exist
//   - 500 Internal Server Error: Database query failure
func (server *Server) getUserByID(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user ID"})
		return
	}

	user, err := server.store.GetUser(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"user": toPrivateUser(user),
	})
}

// getUserByEmail retrieves user profile by email address (admin only).
//
// Sensitive administrative endpoint for user lookup by email. Email addresses
// are considered private data requiring administrative access.
//
// Path parameters:
//   - email: User's email address
//
// Authentication: Required (Bearer token + admin role)
//
// Returns:
//   - 200 OK: Complete user profile data
//   - 400 Bad Request: Missing email parameter
//   - 401 Unauthorized: Invalid authentication token
//   - 403 Forbidden: Insufficient permissions (non-admin)
//   - 404 Not Found: User does not exist
//   - 500 Internal Server Error: Database query failure
func (server *Server) getUserByEmail(c *gin.Context) {
	email := c.Param("email")
	if email == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email is required"})
		return
	}

	user, err := server.store.GetUserByEmail(c.Request.Context(), email)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"user": toPrivateUser(user),
	})
}

// getUsers retrieves paginated list of users with sorting options (admin only).
//
// Administrative endpoint for user management and system oversight. Returns
// complete user profiles with pagination support for large user bases.
//
// Query parameters:
//   - limit: Number of users per page (default: 10, max: 100)
//   - offset: Page offset for pagination (default: 0)
//   - sort: Sort option (default: date_desc)
//
// Sort options:
//   - date_asc, date_desc: Account creation chronology
//   - username_asc, username_desc: Alphabetical username sorting
//   - email_asc, email_desc: Alphabetical email sorting
//   - role_asc, role_desc: Role-based sorting
//   - id_asc, id_desc: Database primary key sorting
//
// Authentication: Required (Bearer token + admin role)
//
// Returns:
//   - 200 OK: Paginated user list with metadata
//   - 400 Bad Request: Invalid query parameters
//   - 401 Unauthorized: Invalid authentication token
//   - 403 Forbidden: Insufficient permissions (non-admin)
//   - 500 Internal Server Error: Database query failure
func (server *Server) getUsers(c *gin.Context) {
	// Parse pagination parameters
	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")
	sortBy := c.DefaultQuery("sort", "date_desc")

	// Validate sort parameter to prevent SQL injection
	if !isValidUserSortOption(sortBy) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid sort parameter"})
		return
	}

	// Parse and validate limit
	limit, err := strconv.ParseInt(limitStr, 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 100 {
		limit = 100 // Enforce maximum page size
	}

	// Parse and validate offset
	offset, err := strconv.ParseInt(offsetStr, 10, 32)
	if err != nil || offset < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid offset parameter"})
		return
	}

	// Query users with pagination
	users, err := server.store.ListUsers(c.Request.Context(), db.ListUsersParams{
		LimitCount:  int32(limit),
		OffsetCount: int32(offset),
		SortBy:      sortBy,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list users"})
		return
	}

	// Convert to response format (admin sees full details)
	userResponses := make([]PrivateUserResponse, len(users))
	for i, user := range users {
		userResponses[i] = toPrivateUser(user)
	}

	// Get total count for pagination metadata
	totalCount, err := server.store.CountTotalUsers(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count total users"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"users": userResponses,
		"meta": gin.H{
			"limit":  limit,
			"offset": offset,
			"count":  len(userResponses),
			"total":  totalCount,
			"sort":   sortBy,
		},
	})
}
