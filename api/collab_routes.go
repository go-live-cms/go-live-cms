// collab_routes registers the collaboration (WebSocket) ticket endpoints.
//
// The collab socket can't send an Authorization header, so its credential
// rides in the URL, where proxy and load balancer access logs record it. The
// editor therefore never puts its access token there. It exchanges the token
// for a short-lived ticket bound to one document (see token/ws_ticket.go).
// The collab server verifies the ticket itself, burns its jti so it is single
// use, and looks up the user's current role on the internal listener (#223).
package api

import (
	"github.com/gin-gonic/gin"
)

// registerCollabRoutes configures:
//   - POST /collab/tickets (admin/editor access token): mint a ticket
func (server *Server) registerCollabRoutes(v1 *gin.RouterGroup) {
	collab := v1.Group("/collab")

	collab.POST("/tickets", authMiddleware(server.tokenMaker, server.store), requireContentEditor(server), server.createCollabTicket)
}
