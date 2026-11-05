// Package api — Posts route registration
//
// Registers all post-related HTTP routes. Every route here needs a Bearer
// access token and a content role (#393).
//
// Route Structure
//   - Reads: GET /posts, /posts/counts, /posts/:id, /posts/type/:type, /posts/user/:id,
//     /posts/:id/{meta,featured-image,media}. They serve the admin's working copy
//     (every status, working title/excerpt/meta), so contributors read only their own
//     posts and published ones (canReadPost, postsViewerID). The public site reads
//     published snapshots from /public (public_routes.go), never these.
//   - Writes: POST/PUT/DELETE /posts, meta, featured image, media links
//
// Middleware Behavior
//   - authMiddleware + requireContentAuthor on every route; the handler then
//     decides per post (auth_posts.go)
//   - publish/unpublish/revisions: requireContentEditor
package api

import "github.com/gin-gonic/gin"

// RegisterPostRoutes configures all post-related routes on the provided router group.
func (server *Server) RegisterPostRoutes(rg *gin.RouterGroup) {
	posts := rg.Group("/posts")
	// Every post route serves or changes the working copy (#393), so every one
	// takes a token and a content role; the handlers' per-post rules build on it.
	auth := server.requireAuth()
	author := requireContentAuthor(server)
	{
		// Reads (put static routes before the greedy :id route)
		posts.GET("", auth, author, server.getPosts)
		posts.GET("/counts", auth, author, server.getPostCounts)
		// The list's Author filter (#327, posts_trash.go)
		posts.GET("/authors", auth, author, server.listCreditedAuthors)
		// The admin list's search box (#145)
		posts.GET("/search", auth, author, server.searchPosts)
		posts.GET("/type/:type", auth, author, server.getPostsByType)
		posts.GET("/user/:id", auth, author, server.getPostsByUser)
		// Who can be credited in a byline (#319, posts_authors.go)
		posts.GET("/author-candidates", auth, author, server.listAuthorCandidates)
		// Who can be asked for a review (#323, review_requests.go)
		posts.GET("/reviewers", auth, author, server.listReviewers)
		posts.GET("/slug/:slug", auth, author, server.getPostBySlug)
		posts.GET("/:id", auth, author, server.getPostByID)

		// Writes. Any content role reaches them; the handler decides per
		// post (auth_posts.go: contributors only their own, #135)
		posts.POST("", auth, author, server.createPost)
		// Bulk actions from the posts list (#327, posts_trash.go): each post is
		// checked on its own, so any content role reaches it.
		posts.POST("/bulk", auth, author, server.bulkPosts)
		posts.PUT("/:id", auth, author, server.updatePost)
		// DELETE moves the post to the trash (#327); restore and permanent delete
		// take it out again. Permanent delete is admins' and editors' only.
		posts.DELETE("/:id", auth, author, server.deletePost)
		posts.POST("/:id/restore", auth, author, server.restorePost)
		posts.DELETE("/:id/permanent", auth, requireContentEditor(server), server.deletePostPermanently)
		// A draft copy owned by the caller (#354); the handler checks read access.
		posts.POST("/:id/duplicate", auth, author, server.duplicatePost)

		// Post meta operations
		posts.GET("/:id/meta", auth, author, server.getPostMeta)
		posts.POST("/:id/meta", auth, author, server.createOrUpdatePostMeta)
		posts.DELETE("/:id/meta/:key", auth, author, server.deletePostMetaByKey)

		// Featured image operations
		posts.GET("/:id/featured-image/full", auth, author, server.getFeaturedImageFull)
		posts.GET("/:id/featured-image", auth, author, server.getFeaturedImageQuick)
		posts.POST("/:id/featured-image", auth, author, server.setFeaturedImage)
		posts.DELETE("/:id/featured-image", auth, author, server.removeFeaturedImage)

		// Post-Media link operations
		posts.GET("/:id/media", auth, author, server.getPostMedia)
		posts.POST("/:id/media", auth, author, server.createPostMedia)
		posts.DELETE("/:id/media/:media_id", auth, author, server.deletePostMedia)

		// Block Spec v1 operations. The working copy is read with canReadPost;
		// only the collab server writes it (PUT /internal/posts/:id/collab, #206).
		posts.GET("/:id/blocks", auth, author, server.getPostBlocks)
		posts.POST("/:id/publish", auth, requireContentEditor(server), server.publishPost)
		posts.POST("/:id/unpublish", auth, requireContentEditor(server), server.unpublishPost)
		// Scheduled publishing (#147, posts_schedule.go): same rule as publishing
		posts.PUT("/:id/schedule", auth, requireContentEditor(server), server.schedulePost)
		posts.DELETE("/:id/schedule", auth, requireContentEditor(server), server.cancelPostSchedule)
		// A published post's scheduled update (#335, posts_scheduled_update.go): same rule
		posts.PUT("/:id/scheduled-update", auth, requireContentEditor(server), server.scheduleUpdate)
		posts.DELETE("/:id/scheduled-update", auth, requireContentEditor(server), server.cancelScheduledUpdate)

		// Revisions (#136): published snapshots; restoring the blocks happens in the
		// editor, the settings (#358) come back through restore-settings
		posts.GET("/:id/versions", auth, requireContentEditor(server), server.listPostVersions)
		posts.GET("/:id/versions/:version_no", auth, requireContentEditor(server), server.getPostVersion)
		posts.POST("/:id/versions/:version_no/restore-settings", auth, requireContentEditor(server), server.restorePostVersionSettings)

		// SEO settings (#357): editors and admins; contributors see them read-only
		posts.PUT("/:id/seo", auth, requireContentEditor(server), server.updatePostSEO)

		// Byline authors (#319): read with canReadPost, set with canEditPostDetails
		posts.GET("/:id/authors", auth, author, server.getPostAuthors)
		posts.PUT("/:id/authors", auth, author, server.setPostAuthors)

		// Working vs published settings (#358): whether a settings change waits for Update
		posts.GET("/:id/settings", auth, author, server.getPostSettingsState)

		// Review requests (#323, review_requests.go): asked by anyone who may edit the
		// post; resolving them is under /review-requests/:id
		posts.GET("/:id/review-request", auth, author, server.getPostReviewRequest)
		posts.POST("/:id/review-request", auth, author, server.requestReview)

	}
}
