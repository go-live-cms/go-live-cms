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
//	POST   /media/batch   → Auth Required (batch upload - original path)
//	POST   /media/bulk    → Auth Required (batch upload - alias for compatibility)
//	GET    /media         → Public (listing/search)
//	GET    /media/popular → Public (popular media)
//	GET    /media/search  → Public (search by query)
//	GET    /media/:id     → Public (fetch by ID)
//	PUT    /media/:id     → Auth Required (update metadata; admin/editor: any media)
//	POST   /media/:id/replace → Auth Required (swap the file; same policy as PUT)
//	DELETE /media/:id     → Auth Required (delete; admin/editor: any media)
//	GET    /media/user/:id → Public (user's media)
//	GET    /media/post/:id → Public (post's media)
//	GET    /media/:id/posts → Public (posts using media)
//
// # Media Ownership Policy
//
// All write routes admit any content role (requireContentAuthor), so
// contributors can upload images for their own posts (#135). Admins and
// editors may update and delete media uploaded by anyone (moderation);
// contributors only their own — see canWriteMedia.
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
// **Backward Compatibility**: Both /batch and /bulk paths are registered for
// the bulk upload endpoint to maintain compatibility with existing clients
// while providing a cleaner path structure.
//
// This function should be called from server.setupRoutes() after creating
// the v1 router group to maintain consistent API versioning.
func (server *Server) registerMediaRoutes(v1 *gin.RouterGroup) {
	media := v1.Group("/media")

	// Write operations - require Bearer authentication + editor-or-admin role
	media.POST("", authMiddleware(server.tokenMaker, server.store), requireContentAuthor(server), server.createMedia)              // Single upload
	media.POST("/batch", authMiddleware(server.tokenMaker, server.store), requireContentAuthor(server), server.createMediaBulk)    // Batch upload (original path)
	media.POST("/bulk", authMiddleware(server.tokenMaker, server.store), requireContentAuthor(server), server.createMediaBulk)     // Batch upload (alias for compatibility)
	media.PUT("/:id", authMiddleware(server.tokenMaker, server.store), requireContentAuthor(server), server.updateMedia)           // Update metadata
	media.POST("/:id/replace", authMiddleware(server.tokenMaker, server.store), requireContentAuthor(server), server.replaceMedia) // Swap the file, keep id/metadata
	media.DELETE("/:id", authMiddleware(server.tokenMaker, server.store), requireContentAuthor(server), server.deleteMedia)        // Delete (admin/editor: any media)

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
