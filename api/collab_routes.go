// collab_routes registers the collaboration (WebSocket) ticket endpoints.
//
// The collab socket can't send an Authorization header, so its credential
// rides in the URL, where proxy and load balancer access logs record it. The
// editor therefore never puts its access token there. It exchanges the token
// for a short-lived, single-use ticket bound to one document (see
// token/ws_ticket.go), and the collab server redeems that ticket here.
package api

import (
	"github.com/gin-gonic/gin"
)

// registerCollabRoutes configures:
//   - POST /collab/tickets (admin/editor access token): mint a ticket
//   - POST /collab/tickets/redeem (Bearer <ticket>): called by the collab
//     server during the WebSocket upgrade. Burns the ticket and returns the
//     user's CURRENT role. The ticket is the credential, so no access token.
func (server *Server) registerCollabRoutes(v1 *gin.RouterGroup) {
	collab := v1.Group("/collab")

	collab.POST("/tickets", authMiddleware(server.tokenMaker, server.store), requireContentEditor(server), server.createCollabTicket)
	collab.POST("/tickets/redeem", server.redeemCollabTicket)
}
