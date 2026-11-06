package api

import "github.com/gin-gonic/gin"

// registerPublicRoutes configures public API routes for SSR and public content access.
// These endpoints do not require authentication and are intended for public consumption.
func (server *Server) registerPublicRoutes(rg *gin.RouterGroup) {
	posts := rg.Group("/posts")
	{
		// What the public site shows of a post: its published settings (#358).
		// The post page, and the feeds and short lists (RSS, sitemap, latest posts)
		posts.GET("", server.listPublicPosts)
		posts.GET("/slug/:slug", server.getPublicPostBySlug)
		posts.GET("/:id", server.getPublicPost)
		// Published block content for SSR
		posts.GET("/:id/blocks", server.getPublicPostBlocks)
		// Older/newer and related posts for the post page (#351, posts_related.go)
		posts.GET("/:id/adjacent", server.getAdjacentPosts)
		posts.GET("/:id/related", server.getRelatedPosts)
		// Numbered pages of a type's published posts (#349, pagination.go)
		posts.GET("/type/:type", server.getPublicPostsByType)
		// "Written by" cards (#350)
		posts.GET("/:id/authors", server.listPublicPostAuthors)
	}

	// The page shown at / (#336, front_page.go); 404 = the latest posts
	rg.GET("/front-page", server.getPublicFrontPage)

	// Author pages (#350, authors_handlers_read.go)
	authors := rg.Group("/authors")
	{
		authors.GET("", server.listPublicAuthors)
		authors.GET("/:username", server.getPublicAuthor)
		authors.GET("/:username/posts", server.listPublicAuthorPosts)
	}

	// Term archives (#348, terms_public_handlers_read.go)
	rg.GET("/taxonomies/:taxonomy/terms/:slug/posts", server.listPublicTermPosts)
	rg.GET("/terms", server.listPublicTerms)

	// The menu assigned to a theme location (menus_routes.go)
	rg.GET("/menus/:location", server.getPublicMenu)

	// Full-text search of published posts and pages (#145, search_handlers_read.go)
	rg.GET("/search", server.getPublicSearch)

	// Where an address the site would answer 404 for goes (#331, redirects.go)
	rg.GET("/redirects", server.getPublicRedirect)
}
