package api

import "github.com/gin-gonic/gin"

// registerActivityRoutes registers the activity feed and Home's lists (#324).
// Every route takes a content role; what each answers depends on it
// (activity_handlers_read.go).
func (server *Server) registerActivityRoutes(v1 *gin.RouterGroup) {
	v1.GET("/activity", server.requireAuth(), requireContentAuthor(server), server.listActivity)

	home := v1.Group("/home", server.requireAuth(), requireContentAuthor(server))
	{
		home.GET("/continue-editing", server.listContinueEditing)
		home.GET("/needs-attention", server.getNeedsAttention)
	}
}
