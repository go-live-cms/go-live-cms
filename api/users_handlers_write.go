// users_handlers_write implements user creation, modification, and deletion operations.
//
// Handles write operations requiring authentication and appropriate role permissions.
// Includes comprehensive validation, error handling, and security features like session invalidation.
//
// # Security Features
//
// - Password hashing using secure algorithms
// - Unique constraint validation for usernames/emails
// - Role-based access control enforcement
// - Session invalidation on sensitive changes
// - Transaction support for data consistency
//
// # Data Integrity
//
// Uses database transactions to ensure atomic operations and maintain referential integrity.
// Content transfer capabilities preserve data during user account deletion operations.
package api

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
	"github.com/go-live-cms/go-live-cms/util"
)

// createUser creates a new user account with role-based permissions.
//
// Administrative endpoint for user creation with full validation and security checks.
// Supports role assignment and enforces unique constraints on username/email.
//
// Request body:
//   - username: Unique username (3-50 chars)
//   - email: Valid email address
//   - full_name: User's display name (2-100 chars)
//   - password: Secure password (min 6 chars)
//   - role: User role (admin|editor|contributor)
//
// Authentication: Required (Bearer token + admin role)
//
// Returns:
//   - 201 Created: User successfully created
//   - 400 Bad Request: Invalid request data or validation errors
//   - 401 Unauthorized: Invalid authentication token
//   - 403 Forbidden: Insufficient permissions (non-admin)
//   - 409 Conflict: Username or email already exists
//   - 500 Internal Server Error: Password hashing or database failure
func (server *Server) createUser(c *gin.Context) {
	var req CreateUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Hash password before storage
	hashedPassword, err := util.HashPassword(req.Password)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to hash password"})
		return
	}

	// Prepare database parameters
	arg := db.CreateUserParams{
		Username:       normUsername(req.Username),
		Email:          normEmail(req.Email),
		FullName:       req.FullName,
		HashedPassword: hashedPassword,
		Role:           req.Role,
	}

	// Create user in database
	user, err := server.store.CreateUser(c.Request.Context(), arg)
	if err != nil {
		if isUniqueViolation(err) {
			c.JSON(http.StatusConflict, gin.H{"error": "username or email already exists"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create user"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"user": toPrivateUser(user),
	})
}

// updateUser modifies existing user account data with validation.
//
// Self-or-admin endpoint: users may update their own profile, admins may
// update anyone. Changing the role field is admin-only — a self-updater
// sending "role" is rejected even with their current value, closing the
// privilege-escalation hole where any authenticated user could promote
// themselves.
//
// Path parameters:
//   - id: User's database primary key
//
// Request body (all optional):
//   - username: New unique username
//   - full_name: Updated display name
//   - email: New email address
//   - password: New password (triggers hash update)
//   - role: Updated role assignment (admin-only)
//
// Authentication: Required (Bearer token; caller must be the target user or an admin)
//
// Returns:
//   - 200 OK: User successfully updated
//   - 400 Bad Request: Invalid user ID or request data
//   - 401 Unauthorized: Invalid authentication token
//   - 403 Forbidden: Not the account owner, or non-admin changing a role
//   - 404 Not Found: User does not exist
//   - 409 Conflict: Username or email already exists, or demoting the last admin
//   - 500 Internal Server Error: Database transaction failure
func (server *Server) updateUser(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user ID"})
		return
	}

	var req UpdateUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Self-or-admin check against the caller's CURRENT DB role (the token
	// payload carries no trusted role information).
	auth := c.MustGet(authorizationPayloadKey).(*token.Payload)
	caller, err := server.store.GetUser(c.Request.Context(), auth.UserID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify user role"})
		return
	}
	isAdmin := strings.EqualFold(caller.Role, RoleAdmin)
	if !isAdmin && auth.UserID != id {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}
	if !isAdmin && req.Role != "" {
		c.JSON(http.StatusForbidden, gin.H{"error": "only admins can change roles"})
		return
	}

	// Retrieve existing user data
	existingUser, err := server.store.GetUser(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user"})
		return
	}

	// Last-admin guard: demoting the only remaining admin would leave the
	// site with no account able to manage users, themes, or settings.
	demotingAdmin := req.Role != "" &&
		strings.EqualFold(existingUser.Role, RoleAdmin) &&
		!strings.EqualFold(req.Role, RoleAdmin)
	if demotingAdmin {
		adminCount, err := server.store.CountUsersByRole(c.Request.Context(), RoleAdmin)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify admin count"})
			return
		}
		if adminCount <= 1 {
			c.JSON(http.StatusConflict, gin.H{"error": "cannot demote the last admin"})
			return
		}
	}

	// Prepare update parameters with existing values as defaults
	updateParams := db.UpdateUserParams{
		ID:                id,
		Username:          existingUser.Username,
		FullName:          existingUser.FullName,
		Email:             existingUser.Email,
		HashedPassword:    existingUser.HashedPassword,
		Role:              existingUser.Role,
		PasswordChangedAt: existingUser.PasswordChangedAt,
	}

	// Apply updates only for provided fields
	if req.Username != "" {
		updateParams.Username = normUsername(req.Username)
	}
	if req.FullName != "" {
		updateParams.FullName = req.FullName
	}
	if req.Email != "" {
		updateParams.Email = normEmail(req.Email)
	}
	if req.Role != "" {
		updateParams.Role = req.Role
	}
	if req.Password != "" {
		// Hash new password and update timestamp
		hashedPassword, err := util.HashPassword(req.Password)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to hash password"})
			return
		}
		updateParams.HashedPassword = hashedPassword
		updateParams.PasswordChangedAt = time.Now()
	}

	// Execute transactional update with uniqueness checks
	result, err := server.store.UpdateUserTx(c.Request.Context(), db.UpdateUserTxParams{
		UpdateUserParams: updateParams,
		CheckUniqueness:  true,
	})
	if err != nil {
		if isUniqueViolation(err) || containsString(err.Error(), "already exists") {
			c.JSON(http.StatusConflict, gin.H{"error": "username or email already exists"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update user"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"user": toPrivateUser(result.User),
	})
}

// deleteUser removes user account with optional content transfer.
//
// Administrative endpoint for user account deletion supporting data preservation.
// Can transfer user-generated content to another account before deletion.
//
// Path parameters:
//   - id: User's database primary key
//
// Request body (optional):
//   - transfer_to_id: Target user ID for content transfer
//
// Authentication: Required (Bearer token + admin role)
//
// Returns:
//   - 200 OK: User successfully deleted
//   - 400 Bad Request: Invalid user ID parameter
//   - 401 Unauthorized: Invalid authentication token
//   - 403 Forbidden: Insufficient permissions (non-admin)
//   - 404 Not Found: User does not exist
//   - 409 Conflict: Target is the last remaining admin
//   - 500 Internal Server Error: Database transaction failure
func (server *Server) deleteUser(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user ID"})
		return
	}

	var req DeleteUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		// Allow empty request body for simple deletion
		req = DeleteUserRequest{}
	}

	// Verify user exists before attempting deletion
	targetUser, err := server.store.GetUser(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user"})
		return
	}

	// Last-admin guard: deleting the only remaining admin would leave the
	// site with no account able to manage users, themes, or settings.
	if strings.EqualFold(targetUser.Role, RoleAdmin) {
		adminCount, err := server.store.CountUsersByRole(c.Request.Context(), RoleAdmin)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify admin count"})
			return
		}
		if adminCount <= 1 {
			c.JSON(http.StatusConflict, gin.H{"error": "cannot delete the last admin"})
			return
		}
	}

	if req.TransferToID != nil {
		// Delete with content transfer to preserve data
		err = server.store.DeleteUserWithTransferTx(c.Request.Context(), db.DeleteUserWithTransferTxParams{
			UserID:       id,
			TransferToID: *req.TransferToID,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete user with transfer"})
			return
		}
	} else {
		// Simple deletion without content transfer
		err = server.store.DeleteUserTx(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete user"})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "user deleted successfully",
	})
}
