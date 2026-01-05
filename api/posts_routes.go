// Package api — Posts route registration
//
// Registers all post-related HTTP routes, with auth middleware applied selectively.
//
// Route Structure
//   - Public reads: GET /posts, /posts/:id, /posts/type/:type, /posts/user/:id
//   - Protected writes: POST/PUT/DELETE /posts (require Bearer auth)
//   - Post meta: /posts/:id/meta (GET public, POST/DELETE protected)
//   - Featured images: /posts/:id/featured-image (GET public, POST/DELETE protected)
//   - Media links: /posts/:id/media (GET public, POST/DELETE protected)
//
// Middleware Behavior
//   - authMiddleware: Enforced for create/update/delete operations
//   - No auth middleware: Applied to public read operations (adjust as needed)
package api

import "github.com/gin-gonic/gin"

// RegisterPostRoutes configures all post-related routes on the provided router group.
// Apply auth middleware selectively: writes are protected, reads are public.
func (server *Server) RegisterPostRoutes(rg *gin.RouterGroup) {
	posts := rg.Group("/posts")
	{
		// Public reads (put static routes before the greedy :id route)
		posts.GET("", server.getPosts)
		posts.GET("/type/:type", server.getPostsByType)
		posts.GET("/user/:id", server.getPostsByUser)
		posts.GET("/slug/:slug", server.getPostBySlug)
		posts.GET("/:id", server.getPostByID)

		// Protected writes (require auth)
		posts.POST("", authMiddleware(server.tokenMaker), server.createPost)
		posts.PUT("/:id", authMiddleware(server.tokenMaker), server.updatePost)
		posts.DELETE("/:id", authMiddleware(server.tokenMaker), server.deletePost)

		// Post meta operations
		posts.GET("/:id/meta", server.getPostMeta)
		posts.POST("/:id/meta", authMiddleware(server.tokenMaker), server.createOrUpdatePostMeta)
		posts.DELETE("/:id/meta/:key", authMiddleware(server.tokenMaker), server.deletePostMetaByKey)

		// Featured image operations
		posts.GET("/:id/featured-image/full", server.getFeaturedImageFull)
		posts.GET("/:id/featured-image", server.getFeaturedImageQuick)
		posts.POST("/:id/featured-image", authMiddleware(server.tokenMaker), server.setFeaturedImage)
		posts.DELETE("/:id/featured-image", authMiddleware(server.tokenMaker), server.removeFeaturedImage)

		// Post-Media link operations
		posts.GET("/:id/media", server.getPostMedia)
		posts.POST("/:id/media", authMiddleware(server.tokenMaker), server.createPostMedia)
		posts.DELETE("/:id/media/:media_id", authMiddleware(server.tokenMaker), server.deletePostMedia)

		// Block Spec v1 operations
		posts.GET("/:id/blocks", authMiddleware(server.tokenMaker), server.getPostBlocks)
		posts.PUT("/:id/blocks", authMiddleware(server.tokenMaker), server.updatePostBlocks)
		posts.POST("/:id/publish", authMiddleware(server.tokenMaker), server.publishPost)

	}
}
