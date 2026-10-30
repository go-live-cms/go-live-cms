package api

import "github.com/gin-gonic/gin"

// registerPublicRoutes configures public API routes for SSR and public content access.
// These endpoints do not require authentication and are intended for public consumption.
func (server *Server) registerPublicRoutes(rg *gin.RouterGroup) {
	posts := rg.Group("/posts")
	{
		// Published block content for SSR
		posts.GET("/:id/blocks", server.getPublicPostBlocks)
		// Numbered pages of a type's published posts (#349, pagination.go)
		posts.GET("/type/:type", server.getPublicPostsByType)
		// "Written by" cards (#350)
		posts.GET("/:id/authors", server.listPublicPostAuthors)
	}

	// Author pages (#350, authors_handlers_read.go)
	authors := rg.Group("/authors")
	{
		authors.GET("", server.listPublicAuthors)
		authors.GET("/:username", server.getPublicAuthor)
		authors.GET("/:username/posts", server.listPublicAuthorPosts)
	}

	// The menu assigned to a theme location (menus_routes.go)
	rg.GET("/menus/:location", server.getPublicMenu)
}
