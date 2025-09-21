package api

import "github.com/gin-gonic/gin"

// registerPublicRoutes configures public API routes for SSR and public content access.
// These endpoints do not require authentication and are intended for public consumption.
func (server *Server) registerPublicRoutes(rg *gin.RouterGroup) {
	posts := rg.Group("/posts")
	{
		// Published block content for SSR
		posts.GET("/:id/blocks", server.getPublicPostBlocks)
	}
}
