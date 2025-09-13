// Package api wires HTTP routes, middleware, and server lifecycle for Go Live CMS.
// This file assembles the Gin engine, CORS, versioned API groups, and health checks.
package api

import (
	"fmt"
	"net/http"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/devModeUtil"
	"github.com/go-live-cms/go-live-cms/token"
	"github.com/go-live-cms/go-live-cms/util"
)

// Server bundles dependencies (db store, config, token maker) and the Gin router.
// Safe for concurrent requests once constructed.
type Server struct {
	store      db.Store
	router     *gin.Engine
	config     util.Config
	tokenMaker token.Maker
}

// NewServer constructs the Server, initializes a PASETO v4 maker from config,
// registers routes/middleware, and (in Gin debug mode, unless test mode) seeds
// dev data via devModeUtil.
//
// Returns an initialized server ready to Start.
//
// Notes:
//   - Dev seeding runs only when gin.Mode()==gin.DebugMode && !config.IsTestMode.
//   - Token maker uses config PASETO keys (issuer/audience/KIDs) from util.Config.
func NewServer(config util.Config, store db.Store) (*Server, error) {
	tokenMaker, err := token.NewPasetoV4Maker(
		config.PasetoV4PrivateKeyHex,
		config.PasetoV4PublicKeyHex,
		config.PasetoV4LocalKeyHex,
		config.PasetoIssuer,
		config.PasetoAudience,
		config.PasetoAccessKID,
		config.PasetoRefreshKID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create token maker: %w", err)
	}
	server := &Server{
		store:      store,
		config:     config,
		tokenMaker: tokenMaker,
	}

	server.setupRoutes()

	if gin.Mode() == gin.DebugMode && !config.IsTestMode {
		devModeUtil.CreateDefaultAdminUser(server.store)
		devModeUtil.CreateDummyData(server.store, server.config)
	}

	return server, nil
}

// setupRoutes configures the Gin engine:
//
//   - CORS:
//   - Debug: allows localhost origins on :4321 and credentials
//   - Release: allowlist example domain (adjust in production)
//   - /health (public): liveness endpoint
//   - /api/v1/auth: register, login, refresh, logout (logout requires auth)
//   - /api/v1/sessions: list/block (auth required)
//   - /api/v1/users: CRUD; some endpoints require auth (see handlers)
//   - /api/v1/posts: CRUD, meta, media links, featured image helpers
//   - /api/v1/post-types: read-only lookup
//   - /api/v1/taxonomy-types: CRUD/lookup
//   - /api/v1/taxonomy-terms: CRUD, lookup, popular, search, posts
//   - /api/v1/taxonomies: legacy aliases for terms (back-compat)
//   - /api/v1/media: upload/batch, search, popular, CRUD, relations
//   - Static /uploads → ./uploads (serve uploaded files)
//
// Auth:
//   - Endpoints wrapped with authMiddleware require a valid *access* token
//     (Bearer scheme). Payload is available under context key "authorization_payload".
func (server *Server) setupRoutes() {
	router := gin.Default()

	if gin.Mode() == gin.DebugMode {
		// Development CORS allowlist — adjust for your local frontend ports
		router.Use(cors.New(cors.Config{
			AllowOrigins: []string{
				"http://localhost:4321",
				"http://127.0.0.1:4321",
				"http://0.0.0.0:4321",
				"http://web:4321",
			},
			AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
			AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
			AllowCredentials: true,
		}))
	} else {
		// Production CORS — replace with your domain(s)
		router.Use(cors.New(cors.Config{
			AllowOrigins:     []string{"https://yourdomain.com"},
			AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
			AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
			AllowCredentials: true,
		}))
	}

	v1 := router.Group("/api/v1")

	router.GET("/health", server.healthCheck)

	auth := v1.Group("/auth")
	auth.POST("/register", server.register)
	auth.POST("/login", server.loginUser)
	auth.POST("/refresh", server.renewAccessToken)
	auth.POST("/logout", authMiddleware(server.tokenMaker), server.logoutUser)

	sessions := v1.Group("/sessions")
	sessions.Use(authMiddleware(server.tokenMaker))
	sessions.GET("", server.getUserSessions)    // GET /api/v1/sessions
	sessions.PUT("/block", server.blockSession) // PUT /api/v1/sessions/block

	users := v1.Group("/users")
	users.POST("", authMiddleware(server.tokenMaker), server.createUser)                 // POST /api/v1/users
	users.GET("", server.getUsers)                                                       // implement content limiter // GET /api/v1/users
	users.GET("/:id", server.getUserByID)                                                // GET /api/v1/users/:id
	users.GET("/username/:username", server.getUserByUsername)                           // GET /api/v1/users/username/:username
	users.GET("/email/:email", authMiddleware(server.tokenMaker), server.getUserByEmail) // GET /api/v1/users/email/:email
	users.PUT("/:id", authMiddleware(server.tokenMaker), server.updateUser)              // PUT /api/v1/users/:id
	users.DELETE("/:id", authMiddleware(server.tokenMaker), server.deleteUser)           // DELETE /api/v1/users/:id

	posts := v1.Group("/posts")
	posts.POST("", authMiddleware(server.tokenMaker), server.createPost)                          // POST /api/v1/posts
	posts.GET("", server.getPosts)                                                                // GET /api/v1/posts
	posts.GET("/:id", server.getPostByID)                                                         // GET /api/v1/posts/:id
	posts.PUT("/:id", authMiddleware(server.tokenMaker), server.updatePost)                       // PUT /api/v1/posts/:id
	posts.DELETE("/:id", authMiddleware(server.tokenMaker), server.deletePost)                    // DELETE /api/v1/posts/:id
	posts.GET("/user/:id", server.getPostsByUser)                                                 // GET /api/v1/posts/user/:id
	posts.GET("/:id/taxonomies", server.getPostTaxonomyTerms)                                     // GET /api/v1/posts/:id/taxonomies
	posts.GET("/:id/meta", server.getPostMeta)                                                    // GET /api/v1/posts/:id/meta
	posts.POST("/:id/meta", authMiddleware(server.tokenMaker), server.createOrUpdatePostMeta)     // POST /api/v1/posts/:id/meta
	posts.DELETE("/:id/meta/:key", authMiddleware(server.tokenMaker), server.deletePostMetaByKey) // DELETE /api/v1/posts/:id/meta/:key

	posts.POST("/:id/featured-image", authMiddleware(server.tokenMaker), server.setFeaturedImage)      // POST /api/v1/posts/:id/featured-image
	posts.GET("/:id/featured-image", server.getFeaturedImageQuick)                                     // GET /api/v1/posts/:id/featured-image (quick URL access)
	posts.GET("/:id/featured-image/full", server.getFeaturedImageFull)                                 // GET /api/v1/posts/:id/featured-image/full (full media object)
	posts.DELETE("/:id/featured-image", authMiddleware(server.tokenMaker), server.removeFeaturedImage) // DELETE /api/v1/posts/:id/featured-image

	posts.POST("/:id/media", authMiddleware(server.tokenMaker), server.createPostMedia)             // POST /api/v1/posts/:id/media
	posts.GET("/:id/media", server.getPostMedia)                                                    // GET /api/v1/posts/:id/media
	posts.DELETE("/:id/media/:media_id", authMiddleware(server.tokenMaker), server.deletePostMedia) // DELETE /api/v1/posts/:id/media/:media_id

	posts.GET("/type/:type", server.getPostsByType) // GET /api/v1/posts/type/product

	postTypes := v1.Group("/post-types")
	postTypes.GET("", server.getPostTypes)      // GET /api/v1/post-types
	postTypes.GET("/:name", server.getPostType) // GET /api/v1/post-types/product

	taxonomyTypes := v1.Group("/taxonomy-types")
	taxonomyTypes.POST("", authMiddleware(server.tokenMaker), server.createTaxonomyType) // POST /api/v1/taxonomy-types
	taxonomyTypes.GET("", server.getTaxonomyTypes)                                       // GET /api/v1/taxonomy-types
	taxonomyTypes.GET("/:name", server.getTaxonomyType)                                  // GET /api/v1/taxonomy-types/category

	taxonomyTerms := v1.Group("/taxonomy-terms")
	taxonomyTerms.POST("", authMiddleware(server.tokenMaker), server.createTaxonomyTerm)       // POST /api/v1/taxonomy-terms
	taxonomyTerms.GET("/type/:type", server.getTaxonomyTermsByType)                            // GET /api/v1/taxonomy-terms/type/category
	taxonomyTerms.GET("/popular", server.getPopularTaxonomyTerms)                              // GET /api/v1/taxonomy-terms/popular?type=category
	taxonomyTerms.GET("/search", server.searchTaxonomyTerms)                                   // GET /api/v1/taxonomy-terms/search?type=category&q=tech
	taxonomyTerms.GET("/:id", server.getTaxonomyTermByID)                                      // GET /api/v1/taxonomy-terms/:id
	taxonomyTerms.GET("/slug/:slug", server.getTaxonomyTermBySlug)                             // GET /api/v1/taxonomy-terms/slug/technology
	taxonomyTerms.PUT("/:id", authMiddleware(server.tokenMaker), server.updateTaxonomyTerm)    // PUT /api/v1/taxonomy-terms/:id
	taxonomyTerms.DELETE("/:id", authMiddleware(server.tokenMaker), server.deleteTaxonomyTerm) // DELETE /api/v1/taxonomy-terms/:id
	taxonomyTerms.GET("/:id/posts", server.getTaxonomyTermPosts)                               // GET /api/v1/taxonomy-terms/:id/posts

	// Legacy taxonomy endpoints (for backward compatibility - can be deprecated later)
	taxonomies := v1.Group("/taxonomies")
	taxonomies.GET("/:id/posts", server.getTaxonomyTermPosts) // GET /api/v1/taxonomies/:id/posts (redirect to taxonomy-terms)
	taxonomies.GET("", server.getTaxonomyTermsByType)         // GET /api/v1/taxonomies?type=category

	media := v1.Group("/media")
	media.POST("", authMiddleware(server.tokenMaker), server.createMedia) // POST /api/v1/media
	//media.POST("/batch", authMiddleware(server.tokenMaker), server.createMediaBatch) // POST /api/v1/media/batch
	media.GET("", server.getMedia)                                              // GET /api/v1/media
	media.GET("/popular", server.getPopularMedia)                               // GET /api/v1/media/popular
	media.GET("/search", server.searchMedia)                                    // GET /api/v1/media/search
	media.GET("/:id", server.getMediaByID)                                      // GET /api/v1/media/:id
	media.PUT("/:id", authMiddleware(server.tokenMaker), server.updateMedia)    // PUT /api/v1/media/:id
	media.DELETE("/:id", authMiddleware(server.tokenMaker), server.deleteMedia) // DELETE /api/v1/media/:id
	media.GET("/user/:id", server.getMediaByUser)                               // GET /api/v1/media/user/:id
	media.GET("/post/:id", server.getMediaByPost)                               // GET /api/v1/media/post/:id
	media.GET("/:id/posts", server.getMediaPosts)                               // GET /api/v1/media/:id/posts

	router.Static("/uploads", "./uploads")

	//v1.GET("/test-log", server.testLog) // Temporary log endpoint for testing

	server.router = router
}

// healthCheck returns basic liveness info and API version.
// Intended for load balancers and uptime checks.
func (server *Server) healthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":  "ok",
		"message": "Gin CMS API is running",
		"version": "v0.0.1",
	})
}

// temp log to test server reload
/* func (server *Server) testLog(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"message":   "🔥 Live reload is working! Updated message",
		"timestamp": time.Now().Format(time.RFC3339),
	})
} */

func (server *Server) register(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"message": "Register endpoint - coming soon",
	})
}

// Start begins serving HTTP on the given address (e.g., ":8080").
// Blocks until the server is shut down.
func (server *Server) Start(address string) error {
	return server.router.Run(address)
}
