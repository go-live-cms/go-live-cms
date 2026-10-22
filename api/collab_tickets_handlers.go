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
// Authentication: Bearer access token, admin or editor (contributors open
// the editor read-only and never connect to the collab server).
//
// Returns:
//   - 200 OK: { "ticket": "v4.public…", "expires_at": "…" }
//   - 400 Bad Request: missing or malformed doc name
//   - 401/403: see authMiddleware and requireContentEditor
func (server *Server) createCollabTicket(c *gin.Context) {
	var req createCollabTicketRequest
	if !bindJSON(c, &req) {
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
