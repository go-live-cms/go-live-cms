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
// Authentication: Bearer access token. For template-<id> (#490): admins only,
// and the template must exist. For post-<id>: admins and editors may get a ticket
// for any post, contributors for their own posts and published ones
// (canReadPost, #135, #206, #393): a read-only live view unless they may edit
// it. The ticket carries no role: the collab server asks the API.
//
// Returns:
//   - 200 OK: { "ticket": "v4.public…", "expires_at": "…" }
//   - 400 Bad Request: missing or malformed doc name
//   - 401/403: see authMiddleware, requireContentAuthor and canReadPost
//   - 404 Not Found: a contributor asked for a post that doesn't exist
func (server *Server) createCollabTicket(c *gin.Context) {
	var req createCollabTicketRequest
	if !bindJSON(c, &req) {
		return
	}
	kind, docID, ok := collabDocRef(req.Doc)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid doc name"})
		return
	}

	user, ok := server.callerUser(c)
	if !ok {
		return
	}

	switch kind {
	case collabDocTemplate:
		// Templates and parts are admins' only (#490, design 7.2 and 12): no read-only
		// view for anyone else, so no ticket either. The collab server checks again.
		if !isSiteAdmin(user) {
			c.JSON(http.StatusForbidden, gin.H{"error": "only admins can edit templates"})
			return
		}
		if _, err := server.store.GetSiteTemplate(c.Request.Context(), docID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get template"})
			return
		}
	default:
		// The collab server also serves read-only connections, so anyone who may
		// read the working copy gets a ticket; the server makes the connection
		// read-only when the access endpoint answers can_edit=false (#206).
		if !server.authorizePost(c, docID, canReadPost) {
			return
		}
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
