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
	"errors"
	"fmt"
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
//   - password: at least MinPasswordLength characters, not the email, username or name
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
	if !bindJSON(c, &req) {
		return
	}
	// Checked after trimming, as stored (normUsername below).
	if !checkUsernameFormat(c, normUsername(req.Username)) {
		return
	}
	if !checkPasswordDetails(c, req.Password, req.Email, req.Username, req.FullName) {
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

	// An admin adding a member directly (invitations record "joined" instead).
	server.recordRequestActivity(c, activityEvent{Verb: db.ActivityCreated, ObjectType: db.ActivityObjectUser, ObjectID: user.ID, Payload: map[string]any{"role": user.Role}})

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
// A password change blocks every session the target user holds, so stolen
// refresh tokens die with the old password. Changing your OWN password also
// requires current_password; the caller is then issued a fresh session (new
// refresh cookie) so they stay signed in. An admin resetting someone else's
// password needs no current password and gets no new session.
//
// Path parameters:
//   - id: User's database primary key
//
// Request body (all optional):
//   - username: New unique username
//   - full_name: Updated display name
//   - email: New email address
//   - password: New password (hashes it and revokes all the user's sessions)
//   - current_password: Required with password on a self-change
//   - role: Updated role assignment (admin-only)
//
// Authentication: Required (Bearer token; caller must be the target user or an admin)
//
// Returns:
//   - 200 OK: User successfully updated
//   - 400 Bad Request: Invalid user ID or request data
//   - 401 Unauthorized: Invalid authentication token
//   - 403 Forbidden: Not the account owner, non-admin changing a role, or a
//     self password change with a missing or wrong current_password
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

	// Self-or-admin check against the caller's CURRENT DB role (the token
	// payload carries no trusted role information). Runs before binding so a
	// non-owner gets 403 whether or not the body is valid.
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	isAdmin := isSiteAdmin(caller)
	isSelf := caller.ID == id
	if !isAdmin && !isSelf {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}

	var req UpdateUserRequest
	if !bindJSON(c, &req) {
		return
	}

	if !isAdmin && req.Role != "" {
		c.JSON(http.StatusForbidden, gin.H{"error": "only admins can change roles"})
		return
	}

	// A self-update targets the caller's own row, which is already loaded.
	existingUser := caller
	if !isSelf {
		var err error
		existingUser, err = server.store.GetUser(c.Request.Context(), id)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user"})
			return
		}
	}

	// Your own email changes only through POST /users/me/email, which confirms the
	// new address first (#334). An admin may still set someone else's.
	if isSelf && req.Email != "" && normEmail(req.Email) != normEmail(existingUser.Email) {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "change your email from your profile: the new address must be confirmed",
			"code":  "email_change_requires_confirmation",
		})
		return
	}

	// Changing your own password requires the current one, so a leaked
	// access token alone cannot take over the account. Admins resetting
	// someone else's password skip this.
	passwordChanged := req.Password != ""
	// Not the details the account has, nor the ones this request sets. Before
	// the self-change limit, so a refused password doesn't use up the allowance.
	if passwordChanged && !checkPasswordDetails(c, req.Password,
		existingUser.Email, existingUser.Username, existingUser.FullName,
		req.Email, req.Username, req.FullName) {
		return
	}
	if passwordChanged && isSelf {
		// Limited per user and client: guesses at current_password from one
		// address are capped, but a token thief's guesses can't use up the
		// owner's allowance and block the change that would revoke their token.
		if !server.rateLimits.passwordChange.allow(c, strconv.FormatInt(caller.ID, 10)+"|"+clientKey(c.ClientIP())) {
			return
		}
		if req.CurrentPassword == "" {
			c.JSON(http.StatusForbidden, gin.H{"error": "current password is required", "code": "current_password_required"})
			return
		}
		if err := util.CheckPassword(req.CurrentPassword, existingUser.HashedPassword); err != nil {
			c.JSON(http.StatusForbidden, gin.H{"error": "current password is incorrect", "code": "current_password_incorrect"})
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
		// Login only accepts letters and digits, so a new username must too.
		// An unchanged legacy one is let through: the admin form resends it.
		if updateParams.Username != existingUser.Username && !checkUsernameFormat(c, updateParams.Username) {
			return
		}
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
	if updateParams.Bio, ok = normalizeBio(c, req.Bio); !ok {
		return
	}
	if updateParams.Website, ok = normalizeWebsite(c, req.Website); !ok {
		return
	}
	if passwordChanged {
		// password_changed_at is stamped inside UpdateUserTx, under the user
		// row lock, not here: hashing takes long enough for a concurrent
		// refresh to mint a token that would otherwise postdate it.
		hashedPassword, err := util.HashPassword(req.Password)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to hash password"})
			return
		}
		updateParams.HashedPassword = hashedPassword
	}

	// Execute transactional update with uniqueness checks. The transaction
	// also refuses to demote the last admin (db.ErrLastAdmin), which would
	// leave no account able to manage users, themes, settings, or post types,
	// and on a password change blocks every session the user holds.
	result, err := server.store.UpdateUserTx(c.Request.Context(), db.UpdateUserTxParams{
		UpdateUserParams: updateParams,
		CheckUniqueness:  true,
		PasswordChanged:  passwordChanged,
	})
	if err != nil {
		if errors.Is(err, db.ErrLastAdmin) {
			c.JSON(http.StatusConflict, gin.H{"error": "cannot demote the last admin"})
			return
		}
		if isUniqueViolation(err) || containsString(err.Error(), "already exists") {
			c.JSON(http.StatusConflict, gin.H{"error": "username or email already exists"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update user"})
		return
	}

	rsp := gin.H{
		"user": toPrivateUser(result.User),
	}

	// Their open documents follow the new role now, not at the next re-check (#333).
	if roleChanged(existingUser, result.User) {
		server.recheckCollabUser(requestIDFromContext(c), id)
		server.recordRequestActivity(c, activityEvent{
			Verb:       db.ActivityRoleChanged,
			ObjectType: db.ActivityObjectUser,
			ObjectID:   id,
			Payload:    map[string]any{"role": result.User.Role, "previous_role": existingUser.Role},
		})
	}

	if passwordChanged {
		logSecurityEvent(c, LogPasswordChanged, "all", id, fmt.Sprintf("Changed by user %d", caller.ID))

		// The refresh cookie is scoped to /api/v1/auth, so this request
		// cannot say which session it came from. Instead, the self-changer
		// gets a brand-new session (and cookie) to stay signed in; every
		// session that existed before the change is now blocked. Their
		// current access token predates the change too, so authMiddleware
		// now rejects it: hand back a fresh one for the client to adopt.
		// If any of this fails the password change still stands and they
		// sign in again.
		if isSelf {
			if err := server.issueSelfSessionAfterPasswordChange(c, result.User, time.Now(), rsp); err != nil {
				logSecurityEvent(c, LogPasswordChanged, "none", id, fmt.Sprintf("Failed to start a new session for the caller: %v", err))
			}
		}
	}

	c.JSON(http.StatusOK, rsp)
}

// issueSelfSessionAfterPasswordChange starts a fresh refresh session for a
// user who just changed their own password, and adds a new access token to
// rsp under the same keys login uses (access_token, access_token_expires_at,
// expires_at).
func (server *Server) issueSelfSessionAfterPasswordChange(c *gin.Context, user db.User, now time.Time, rsp gin.H) error {
	v4Maker, ok := server.tokenMaker.(*token.PasetoV4Maker)
	if !ok {
		return errors.New(ErrInvalidTokenType)
	}

	if _, err := server.startSession(c, v4Maker, user, now); err != nil {
		return err
	}

	accessToken, err := v4Maker.CreateTokenWithRole(user.ID, user.Username, user.Role, server.config.AccessTokenDuration)
	if err != nil {
		return errors.New(ErrTokenCreationFailed)
	}

	accessExpiresAt := now.Add(server.config.AccessTokenDuration)
	rsp["access_token"] = accessToken
	rsp["access_token_expires_at"] = accessExpiresAt
	rsp["expires_at"] = accessExpiresAt.Unix()
	c.Header("Cache-Control", "no-store")
	return nil
}

// changeUserRole sets a member's role from the Users screen (#333).
//
// Path parameters:
//   - id: User's database primary key
//
// Request body: {"role": "admin" | "editor" | "contributor"}
//
// The last admin can't be moved off admin, themselves included: ChangeUserRoleTx
// locks every admin row and counts inside the transaction, so two concurrent
// demotions of the last two admins can't both succeed. The API reads the role
// from the DB on every request, so the member's access tokens carry the new
// role's rights at once (the token's role claim is informational); their open
// collab connections are re-checked right after the commit (recheckCollabUser).
//
// Authentication: Required (Bearer token + admin role)
//
// Returns:
//   - 200 OK: {"user": ...}
//   - 400 Bad Request: Invalid user ID or role
//   - 403 Forbidden: Insufficient permissions (non-admin)
//   - 404 Not Found: User does not exist
//   - 409 Conflict: {"code": "last_admin"} the user is the only admin
//   - 500 Internal Server Error: Database transaction failure
func (server *Server) changeUserRole(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user ID"})
		return
	}

	var req ChangeUserRoleRequest
	if !bindJSON(c, &req) {
		return
	}

	changed, err := server.store.ChangeUserRoleTx(c.Request.Context(), db.SetUserRoleParams{ID: id, Role: req.Role})
	user := changed.User
	if err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows):
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		case errors.Is(err, db.ErrLastAdmin):
			c.JSON(http.StatusConflict, gin.H{"error": "cannot demote the last admin", "code": "last_admin"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to change role"})
		}
		return
	}

	server.recheckCollabUser(requestIDFromContext(c), id)
	// Setting the role it already had changes nothing: no event.
	if !strings.EqualFold(changed.PreviousRole, user.Role) {
		server.recordRequestActivity(c, activityEvent{
			Verb:       db.ActivityRoleChanged,
			ObjectType: db.ActivityObjectUser,
			ObjectID:   id,
			Payload:    map[string]any{"role": user.Role, "previous_role": changed.PreviousRole},
		})
	}
	c.JSON(http.StatusOK, gin.H{"user": toPrivateUser(user)})
}

// deleteUser removes a member (#333) and hands what they own to another user.
//
// The removal is a hard delete in one transaction (db.RemoveUserTx): their posts
// (posts.user_id), their byline on those posts and the media they uploaded go to
// transfer_to_id; their sessions are deleted, which revokes every refresh token;
// and the user row goes, so any access token they still hold gets 403 at once
// (authMiddleware loads the row). Bylines on other people's posts, reset tokens
// and invitation links go with the row; revisions they published and invitations
// they sent stay, with no author. Their open collab connections are re-checked
// right after the commit and close.
//
// Path parameters:
//   - id: User's database primary key
//
// Request body: {"transfer_to_id": <user id>} (required)
//
// Authentication: Required (Bearer token + admin role)
//
// Returns:
//   - 200 OK: {"message", "posts_reassigned"}
//   - 400 Bad Request: Invalid user ID, missing transfer_to_id, transfer_to_id
//     is the member or doesn't exist ({"code": "invalid_transfer_target"})
//   - 403 Forbidden: Insufficient permissions (non-admin)
//   - 404 Not Found: User does not exist
//   - 409 Conflict: {"code": "last_admin"} the only admin, or
//     {"code": "cannot_remove_self"} the caller's own account
//   - 500 Internal Server Error: Database transaction failure
func (server *Server) deleteUser(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user ID"})
		return
	}

	var req DeleteUserRequest
	if !bindJSON(c, &req) {
		return
	}

	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	// Signing yourself out mid-request with no way back in; another admin can.
	if caller.ID == id {
		c.JSON(http.StatusConflict, gin.H{"error": "you can't remove your own account", "code": "cannot_remove_self"})
		return
	}

	// RemoveUserTx refuses to remove the last admin (db.ErrLastAdmin), which
	// would leave no account able to manage users, themes, settings, or post types.
	result, err := server.store.RemoveUserTx(c.Request.Context(), db.RemoveUserTxParams{
		UserID:     id,
		ReassignTo: *req.TransferToID,
		// The recipient owns their posts from now on: an active member, as for a
		// transfer (#353).
		OwnerRoles: contentRoles,
	})
	if err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows):
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		case errors.Is(err, db.ErrLastAdmin):
			c.JSON(http.StatusConflict, gin.H{"error": "cannot delete the last admin", "code": "last_admin"})
		case errors.Is(err, db.ErrReassignToRemovedUser), errors.Is(err, db.ErrReassignTargetNotFound), errors.Is(err, db.ErrReassignTargetInactive):
			c.JSON(http.StatusBadRequest, gin.H{"error": "choose another member to receive their posts", "code": "invalid_transfer_target"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete user"})
		}
		return
	}

	logSecurityEvent(c, LogUserRemoved, "all", id, fmt.Sprintf("Removed by user %d; posts to user %d", caller.ID, *req.TransferToID))
	server.recheckCollabUser(requestIDFromContext(c), id)
	// The recipient now owns those posts (the reassignment a transfer runs, #353): a
	// contributor's read-only connections to them become read-write at once.
	if result.PostsReassigned > 0 {
		server.recheckCollabUser(requestIDFromContext(c), *req.TransferToID)
	}
	server.removeOldAvatar(c, id, result.AvatarURL)
	server.recordRequestActivity(c, activityEvent{
		Verb:       db.ActivityRemoved,
		ObjectType: db.ActivityObjectUser,
		ObjectID:   id,
		Payload:    map[string]any{"transfer_to_id": *req.TransferToID, "posts_reassigned": result.PostsReassigned},
	})
	c.JSON(http.StatusOK, gin.H{
		"message":          "user deleted successfully",
		"posts_reassigned": result.PostsReassigned,
	})
}
