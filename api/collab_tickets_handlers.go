package api

import (
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
// Authentication: Bearer access token. Admins and editors may get a ticket
// for any post, contributors only for their own (canEditPost, #135).
//
// Returns:
//   - 200 OK: { "ticket": "v4.public…", "expires_at": "…" }
//   - 400 Bad Request: missing or malformed doc name
//   - 401/403: see authMiddleware, requireContentAuthor and canEditPost
//   - 404 Not Found: a contributor asked for a post that doesn't exist
func (server *Server) createCollabTicket(c *gin.Context) {
	var req createCollabTicketRequest
	if !bindJSON(c, &req) {
		return
	}
	postID, ok := postIDFromCollabDoc(req.Doc)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid doc name"})
		return
	}

	// Same per-post rule the WS server re-checks on connect (internal access
	// endpoint); failing early here saves the editor a doomed connect.
	if !server.authorizePost(c, postID, canEditPost) {
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
