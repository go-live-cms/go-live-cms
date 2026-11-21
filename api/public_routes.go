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
		// Reader comments: approved ones only, by page or one thread (#523, discussion_public.go)
		posts.GET("/:id/comments", server.getPublicPostComments)
		// A reader's comment (#524, discussion_write.go). Only the web's /gl-comments
		// endpoint calls it; limited per browser (its X-Forwarded-For), never exempt.
		posts.POST("/:id/comments", server.rateLimits.commentPost.perIP(), server.createPublicReaderComment)
	}

	// Reader comments' confirmation (#524, discussion_write.go): emailed-token endpoints.
	discussion := rg.Group("/discussion", server.rateLimits.commentConfirm.perIP())
	{
		discussion.POST("/confirm", server.confirmPublicReaderComment)
		discussion.POST("/unconfirmed/:id", server.actOnUnconfirmedReaderComment)
		// The reply mail's unsubscribe page (#528, discussion_unsubscribe.go).
		discussion.POST("/unsubscribe", server.unsubscribeReaderComment)
		// "Your comments" (#529, discussion_privacy.go): the request answers the same for
		// any address, and mails, so it has the emailed-token limit.
		discussion.POST("/data-request", server.requestCommenterData)
	}
	// The mailed link's routes (#529): one page deletes a reader's comments one by one,
	// so they have a limit of their own instead of the confirmation's 10 a minute.
	data := rg.Group("/discussion/data", server.rateLimits.commentDataLink.perIP())
	{
		data.POST("", server.readCommenterData)
		data.POST("/delete", server.deleteCommenterData)
		data.POST("/unsubscribe", server.unsubscribeCommenterData)
	}
	// RFC 8058's one-click (#528): mail providers POST it from their own servers, many
	// readers' clicks from one address, so it has only the general /public limit. The
	// token (32 random bytes) is the authority, and it can only stop one comment's mail.
	rg.POST("/discussion/unsubscribe/:token", server.unsubscribeReaderCommentOneClick)

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

	// The block template a route renders, with its parts, media and menus by id: published
	// copies only (#491, site_templates_resolve.go)
	rg.GET("/site-templates/resolve", server.resolvePublicSiteTemplate)

	// Full-text search of published posts and pages (#145, search_handlers_read.go)
	rg.GET("/search", server.getPublicSearch)

	// Where an address the site would answer 404 for goes (#331, redirects.go)
	rg.GET("/redirects", server.getPublicRedirect)
}
