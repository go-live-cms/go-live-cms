package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
)

// getInternalDocAccess tells the collab WebSocket server whether a user may
// edit one collab document, for its per-connection check (#216, #223, #135).
//
// The collab server verifies the client's ticket itself and passes the
// ticket's user_id, iat and doc. Everything is read from the database, never
// from the ticket: the user's current role, and (for non-moderators) the
// post's owner, decided by canEditPost.
// issued_at is required so a ticket issued before the user's latest password
// change is refused here exactly as authMiddleware refuses such an access
// token (issuedBeforePasswordChange).
//
// If Hocuspocus lands (#206), its onAuthenticate calls this same endpoint.
//
// Path parameters:
//   - id: User's database primary key (the ticket's user_id claim)
//
// Query parameters:
//   - doc: The collab document name, "post-<id>" (the ticket's doc claim)
//   - issued_at: The ticket's iat as Unix seconds
//
// Authentication: Shared secret (requireInternalSecret), no user token.
//
// Returns:
//   - 200 OK: { "role": "<role>", "can_edit": true|false }
//   - 400 Bad Request: Invalid user ID, doc or issued_at
//   - 401 Unauthorized: Missing or wrong shared secret
//   - 403 Forbidden: The ticket predates the user's latest password change
//   - 404 Not Found: User (or, for a non-moderator, the post) does not exist
//   - 500 Internal Server Error: Database query failure
func (server *Server) getInternalDocAccess(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user ID"})
		return
	}

	postID, ok := postIDFromCollabDoc(c.Query("doc"))
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid doc"})
		return
	}

	issuedAtUnix, err := strconv.ParseInt(c.Query("issued_at"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid issued_at"})
		return
	}

	user, err := server.store.GetUser(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user"})
		return
	}

	if issuedBeforePasswordChange(time.Unix(issuedAtUnix, 0), user.PasswordChangedAt) {
		c.JSON(http.StatusForbidden, gin.H{"error": "token was issued before the latest password change"})
		return
	}

	// Moderators may edit any post; skip the post lookup like authorizePost.
	if canModeratePosts(user) {
		c.JSON(http.StatusOK, gin.H{"role": user.Role, "can_edit": true})
		return
	}

	post, err := server.store.GetPost(c.Request.Context(), postID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"role": user.Role, "can_edit": canEditPost(user, post)})
}
