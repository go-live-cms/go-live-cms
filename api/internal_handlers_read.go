package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
)

// getInternalUserRole returns a user's CURRENT role, read from the database, for
// the collab WebSocket server's per-connection role check (#216, #223).
//
// The WS server verifies the client's ticket itself and passes the ticket's
// user_id and iat. The role always comes from the users row, never from the
// ticket's role claim. issued_at is required so a ticket issued before the
// user's latest password change is refused here exactly as authMiddleware
// refuses such an access token (issuedBeforePasswordChange).
//
// Path parameters:
//   - id: User's database primary key (the ticket's user_id claim)
//
// Query parameters:
//   - issued_at: The ticket's iat as Unix seconds
//
// Authentication: Shared secret (requireInternalSecret), no user token.
//
// Returns:
//   - 200 OK: { "role": "<role>" }
//   - 400 Bad Request: Invalid user ID or issued_at
//   - 401 Unauthorized: Missing or wrong shared secret
//   - 403 Forbidden: The ticket predates the user's latest password change
//   - 404 Not Found: User does not exist
//   - 500 Internal Server Error: Database query failure
func (server *Server) getInternalUserRole(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user ID"})
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

	c.JSON(http.StatusOK, gin.H{"role": user.Role})
}
