// taxonomy_routes wires all taxonomy and content classification endpoints with appropriate middleware.
//
// # Route Architecture & Ordering
//
// This file establishes organized route groups for taxonomy management:
//   - /taxonomy/types — Taxonomy type definitions and configuration
//   - /taxonomy/terms — Term management with static routes before greedy parameters
//   - Cross-module integration for post-taxonomy associations
//
// **Critical Route Ordering**: Static endpoints are registered before parameterized routes
// to prevent greedy parameter matching. For example:
//   - GET /terms/popular (static) must come before GET /terms/:id (parameterized)
//   - GET /terms/search (static) must come before GET /terms/:id (parameterized)
//   - GET /terms/slug/:slug (static path) positioned appropriately
//
// # Authentication Strategy
//
// **Public Read Operations**:
//   - All GET endpoints for browsing types, terms, and associations
//   - Search and discovery functionality for content organization
//   - Popular terms and statistics for trending content
//
// **Protected Write Operations**:
//   - All POST, PUT, DELETE operations require Bearer access tokens
//   - Type creation and term management restricted to authenticated users
//   - Force deletion capabilities for administrative cleanup
//
// # Middleware Application
//
// - Type routes: Mixed access (public reads, protected writes)
// - Term routes: Mixed access with selective middleware application
// - Cross-module routes: Consistent with posts module authentication
//
// # Route Groups Organization
//
// **Taxonomy Types** (/api/v1/taxonomy/types):
//   - Public listing and individual type access
//   - Protected type creation and configuration
//
// **Taxonomy Terms** (/api/v1/taxonomy/terms):
//   - Public discovery, search, and browsing
//   - Protected term creation, updates, and deletion
//   - Static routes (popular, search) positioned before parameterized routes
//
// **Type-Specific Term Browsing** (/api/v1/taxonomy/types/:type):
//   - Public access to terms within specific taxonomy types
//   - Supports pagination, sorting, and filtering
//
// **Cross-Module Integration** (/api/v1/posts):
//   - Bidirectional post-taxonomy term associations
//   - Consistent with posts module routing patterns
package api

import "github.com/gin-gonic/gin"

// RegisterTaxonomyRoutes configures all taxonomy and classification endpoints
// with appropriate authentication middleware and correct route ordering.
//
// Route organization follows security and usability principles:
//   - Public routes enable content discovery and browsing
//   - Protected routes restrict content management to authenticated users
//   - Static routes are positioned before parameterized routes to prevent conflicts
//   - Cross-module routes maintain consistency with related modules
func (server *Server) RegisterTaxonomyRoutes(v1 *gin.RouterGroup) {
	// Taxonomy namespace for organized endpoint grouping
	tg := v1.Group("/taxonomy")

	// Taxonomy Types Management
	// Public: browse and discover taxonomy types
	// Protected: create new taxonomy type definitions
	types := tg.Group("/types")
	types.GET("", server.getTaxonomyTypes)                                       // GET /api/v1/taxonomy/types
	types.POST("", authMiddleware(server.tokenMaker), requireContentEditor(server), server.createTaxonomyType) // POST /api/v1/taxonomy/types

	// Type-Specific Term Browsing (must come before generic type lookup to avoid conflicts)
	// Public: list terms within specific taxonomy types
	types.GET("/:name/terms", server.getTaxonomyTermsByType) // GET /api/v1/taxonomy/types/:name/terms

	// Generic type lookup (must come after specific sub-routes)
	types.GET("/:name", server.getTaxonomyType) // GET /api/v1/taxonomy/types/:name

	// Taxonomy Terms Management
	// CRITICAL: Static routes MUST come before parameterized routes
	// to prevent greedy parameter matching conflicts
	terms := tg.Group("/terms")

	// Static routes (no parameters) - must be first
	terms.GET("/popular", server.getPopularTaxonomyTerms) // GET /api/v1/taxonomy/terms/popular
	terms.GET("/search", server.searchTaxonomyTerms)      // GET /api/v1/taxonomy/terms/search

	// Semi-static routes (fixed path segments)
	terms.GET("/slug/:slug", server.getTaxonomyTermBySlug) // GET /api/v1/taxonomy/terms/slug/:slug

	// Parameterized routes with sub-paths
	terms.GET("/:id/posts", server.getTaxonomyTermPosts) // GET /api/v1/taxonomy/terms/:id/posts

	// Basic parameterized routes (most greedy) - must be last
	terms.GET("/:id", server.getTaxonomyTermByID) // GET /api/v1/taxonomy/terms/:id

	// Protected term management operations (editor-or-admin role)
	terms.POST("", authMiddleware(server.tokenMaker), requireContentEditor(server), server.createTaxonomyTerm)       // POST /api/v1/taxonomy/terms
	terms.PUT("/:id", authMiddleware(server.tokenMaker), requireContentEditor(server), server.updateTaxonomyTerm)    // PUT /api/v1/taxonomy/terms/:id
	terms.DELETE("/:id", authMiddleware(server.tokenMaker), requireContentEditor(server), server.deleteTaxonomyTerm) // DELETE /api/v1/taxonomy/terms/:id

	// Cross-Module Integration
	// Post-taxonomy term associations for bidirectional relationships
	// Note: This could alternatively live in posts_routes.go for module cohesion
	v1.GET("/posts/:id/taxonomy-terms", server.getPostTaxonomyTerms) // GET /api/v1/posts/:id/taxonomy-terms
}
