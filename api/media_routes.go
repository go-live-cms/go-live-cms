// media_routes wires all /api/v1/media endpoints and groups them with auth middleware where required.
//
// # Route Overview
//
// This file defines the complete media API surface with clear auth boundaries:
//   - Write operations (POST, PUT, DELETE) require Bearer access tokens
//   - Read operations (GET) are typically public for content consumption
//
// # Auth Matrix
//
//	POST   /media         → Auth Required (file upload)
//	POST   /media/batch   → Auth Required (batch upload)
//	GET    /media         → Public (listing/search)
//	GET    /media/popular → Public (popular media)
//	GET    /media/search  → Public (search by query)
//	GET    /media/:id     → Public (fetch by ID)
//	PUT    /media/:id     → Auth Required (update metadata)
//	DELETE /media/:id     → Auth Required (delete + ownership check)
//	GET    /media/user/:id → Public (user's media)
//	GET    /media/post/:id → Public (post's media)
//	GET    /media/:id/posts → Public (posts using media)
//
// # Integration
//
// Called from server.go setupRoutes() to register under /api/v1 group.
// Auth middleware validates Bearer tokens and injects payload into context.
package api

import "github.com/gin-gonic/gin"

// registerMediaRoutes wires all media endpoints under the /api/v1/media group.
// Separates protected write operations from public read operations for clear
// security boundaries and easier route management.
//
// This function should be called from server.setupRoutes() after creating
// the v1 router group to maintain consistent API versioning.
func (server *Server) registerMediaRoutes(v1 *gin.RouterGroup) {
	media := v1.Group("/media")

	// Write operations - require Bearer authentication
	media.POST("", authMiddleware(server.tokenMaker), server.createMedia)          // Single upload
	media.POST("/bulk", authMiddleware(server.tokenMaker), server.createMediaBulk) // Batch upload (max 20)
	media.PUT("/:id", authMiddleware(server.tokenMaker), server.updateMedia)       // Update metadata
	media.DELETE("/:id", authMiddleware(server.tokenMaker), server.deleteMedia)    // Delete (ownership check)

	// Read operations - public access for content consumption
	media.GET("", server.getMedia)                // List/paginate/filter
	media.GET("/popular", server.getPopularMedia) // Top-N by usage
	media.GET("/search", server.searchMedia)      // Search by name/alt/desc
	media.GET("/:id", server.getMediaByID)        // Fetch by ID

	// Relationship endpoints - public access
	media.GET("/user/:id", server.getMediaByUser) // Media by owner
	media.GET("/post/:id", server.getMediaByPost) // Media by post
	media.GET("/:id/posts", server.getMediaPosts) // Posts using this media
}
