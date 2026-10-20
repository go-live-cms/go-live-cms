package api

import (
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-live-cms/go-live-cms/token"
)

// collabTicketMaker is the slice of the PASETO v4 maker the collab endpoints
// use. Tickets are v4-only, so it isn't part of token.Maker.
type collabTicketMaker interface {
	CreateWSTicket(userID int64, username, doc string, dur time.Duration) (string, *token.WSTicketPayload, error)
	VerifyWSTicket(tok string) (*token.WSTicketPayload, error)
}

// createCollabTicket mints a collab ticket for the caller and one document.
//
// Authentication: Bearer access token, admin or editor (contributors open
// the editor read-only and never connect to the collab server).
//
// Returns:
//   - 200 OK: { "ticket": "v4.public…", "expires_at": "…" }
//   - 400 Bad Request: missing or malformed doc name
//   - 401/403: see authMiddleware and requireContentEditor
func (server *Server) createCollabTicket(c *gin.Context) {
	var req createCollabTicketRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "doc is required"})
		return
	}
	if !collabDocNamePattern.MatchString(req.Doc) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid doc name"})
		return
	}

	user, ok := server.callerUser(c)
	if !ok {
		return
	}

	ticket, payload, err := server.collabTickets.CreateWSTicket(user.ID, user.Username, req.Doc, collabTicketTTL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create ticket"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"ticket":     ticket,
		"expires_at": payload.ExpiredAt,
	})
}

// redeemCollabTicket is called by the collab server while it handles a
// WebSocket upgrade. It burns the ticket and reports who it belongs to and
// the user's CURRENT role, which the collab server uses to admit only
// admins and editors.
//
// Authentication: "Authorization: Bearer <ticket>". The ticket is the
// credential; access tokens are rejected.
//
// Returns:
//   - 200 OK: { "user": { "id", "username", "role" }, "doc": "post-12" }
//   - 401 Unauthorized: invalid, expired or already redeemed ticket, or one
//     issued before the user's latest password change
//   - 403 Forbidden: the ticket's user no longer exists
//   - 500 Internal Server Error: user lookup failed
func (server *Server) redeemCollabTicket(c *gin.Context) {
	credential := bearerCredential(c.GetHeader(authorizationHeaderKey))
	if credential == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "ticket is not provided"})
		return
	}

	payload, err := server.collabTickets.VerifyWSTicket(credential)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid ticket"})
		return
	}

	// Burn the ticket before anything else can fail, so a ticket that leaked
	// (e.g. into a proxy access log) can never be redeemed a second time,
	// even if this redemption errors out. The editor fetches a new ticket on
	// every reconnect.
	if !server.usedCollabTickets.consume(payload.ID, payload.ExpiredAt, time.Now()) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "ticket already used"})
		return
	}

	user, err := server.store.GetUser(c.Request.Context(), payload.UserID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify user"})
		return
	}

	// Same rule authMiddleware applies to access tokens: a password change
	// ends every login, including tickets minted just before it.
	if issuedBeforePasswordChange(payload.IssuedAt, user.PasswordChangedAt) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "ticket was issued before the latest password change"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"user": gin.H{
			"id":       user.ID,
			"username": user.Username,
			"role":     user.Role,
		},
		"doc": payload.Doc,
	})
}
