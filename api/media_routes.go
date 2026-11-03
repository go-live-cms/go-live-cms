// media_routes wires all /api/v1/media endpoints and groups them with auth middleware where required.
//
// # Route Overview
//
// This file defines the complete media API surface with clear auth boundaries:
//   - Every route needs a Bearer access token and a content role (#393). The
//     library's metadata (names, alt text, owners, which posts use a file,
//     including unpublished ones) is the admin's. The public site gets the
//     media it renders from /public (the published blocks' media map) and the
//     files themselves from /uploads.
//
// # Auth Matrix
//
//	POST   /media         → Auth Required (file upload)
//	POST   /media/batch   → Auth Required (batch upload - original path)
//	POST   /media/bulk    → Auth Required (batch upload - alias for compatibility)
//	GET    /media         → Auth Required (listing/search)
//	GET    /media/popular → Auth Required (popular media)
//	GET    /media/missing-alt → Auth Required (images missing alt text, count for Home)
//	GET    /media/search  → Auth Required (search by query)
//	GET    /media/:id     → Auth Required (fetch by ID)
//	PUT    /media/:id     → Auth Required (update metadata; admin/editor: any media)
//	POST   /media/:id/replace → Auth Required (swap the file; same policy as PUT)
//	DELETE /media/:id     → Auth Required (delete; admin/editor: any media)
//	GET    /media/user/:id → Auth Required (user's media)
//	GET    /media/post/:id → Auth Required (post's media; canReadPost)
//	GET    /media/:id/posts → Auth Required (posts using media; only those the caller may read)
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
//
// **Backward Compatibility**: Both /batch and /bulk paths are registered for
// the bulk upload endpoint to maintain compatibility with existing clients
// while providing a cleaner path structure.
//
// This function should be called from server.setupRoutes() after creating
// the v1 router group to maintain consistent API versioning.
func (server *Server) registerMediaRoutes(v1 *gin.RouterGroup) {
	// The whole library is for content roles (#393).
	media := v1.Group("/media", authMiddleware(server.tokenMaker, server.store), requireContentAuthor(server))

	// Write operations
	media.POST("", server.createMedia)              // Single upload
	media.POST("/batch", server.createMediaBulk)    // Batch upload (original path)
	media.POST("/bulk", server.createMediaBulk)     // Batch upload (alias for compatibility)
	media.PUT("/:id", server.updateMedia)           // Update metadata
	media.POST("/:id/replace", server.replaceMedia) // Swap the file, keep id/metadata
	media.DELETE("/:id", server.deleteMedia)        // Delete (admin/editor: any media)

	// The admin home's "N images have no alt text" count (#325).
	media.GET("/missing-alt", server.getMissingAltSummary)

	// Read operations
	media.GET("", server.getMedia)                // List/paginate/filter
	media.GET("/popular", server.getPopularMedia) // Top-N by usage
	media.GET("/search", server.searchMedia)      // Search by name/alt/desc
	media.GET("/:id", server.getMediaByID)        // Fetch by ID

	// Relationship endpoints
	media.GET("/user/:id", server.getMediaByUser) // Media by owner
	media.GET("/post/:id", server.getMediaByPost) // Media by post
	media.GET("/:id/posts", server.getMediaPosts) // Posts using this media
}
