// Package api wires HTTP routes, middleware, and server lifecycle for Go Live CMS.
// This file assembles the Gin engine, CORS, versioned API groups, and health checks.
package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"time"

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
	store  db.Store
	router *gin.Engine
	// internalRouter serves server-to-server routes on a separate listener
	// (INTERNAL_SERVER_ADDRESS) that is never published to the internet.
	internalRouter *gin.Engine
	config         util.Config
	tokenMaker     token.Maker
	ctx            context.Context

	// Collab (WebSocket) ticket minting; see collab_routes.go.
	collabTickets collabTicketMaker

	// Per-client request limits; see ratelimit.go.
	rateLimits rateLimits

	// Observability (observability.go, metrics.go, health.go).
	logger        *slog.Logger
	metrics       *httpMetrics
	errorReporter ErrorReporter
	// pingDB backs /readyz; set from the store when it is a db.SQLStore.
	pingDB func(ctx context.Context) error
}

// NewServer constructs the Server, initializes a PASETO v4 maker from config,
// registers routes/middleware, and (when GIN_MODE=debug, unless test mode) seeds
// dev data via devModeUtil.
//
// Returns an initialized server ready to Start.
//
// Notes:
//   - Outside debug mode (and tests), it returns an error if a dev seeded
//     account still has its seeded password (checkSeededAccounts).
//   - Dev seeding runs only when shouldSeedDevData(config) is true. It reads the
//     config, not gin.Mode(), so the global Gin mode can't enable it by accident.
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
	// The collab WS server can't authorize any connection without the internal
	// role lookup, so refuse to start rather than silently lock every editor out.
	// Trimmed once here (the WS server trims its copy too), so stray whitespace in
	// app.env can't make the two sides disagree and turn every lookup into a 401.
	config.RoleLookupSecret = strings.TrimSpace(config.RoleLookupSecret)
	if config.RoleLookupSecret == "" {
		return nil, errors.New("ROLE_LOOKUP_SECRET is required (shared with the collab WebSocket server)")
	}
	limits, err := newRateLimits(config)
	if err != nil {
		return nil, err
	}
	server := &Server{
		store:      store,
		config:     config,
		tokenMaker: tokenMaker,
		ctx:        context.Background(),

		collabTickets: tokenMaker,
		rateLimits:    limits,

		logger:        slog.Default(),
		metrics:       newHTTPMetrics(),
		errorReporter: noopErrorReporter{},
	}
	if pinger, ok := store.(dbPinger); ok {
		server.pingDB = pinger.Ping
	}

	if shouldCheckSeededAccounts(config) {
		if err := checkSeededAccounts(server.store); err != nil {
			return nil, err
		}
	}

	if warning := server.ignoredCookieDomainWarning(); warning != "" {
		server.logger.Warn(warning)
	}

	if err := server.setupRoutes(); err != nil {
		return nil, err
	}

	// Sync themes from filesystem on startup (skip in test mode)
	if !config.IsTestMode {
		themesPath := filepath.Join("web", "themes")
		discoveredThemes, err := ScanThemesDirectory(themesPath)
		if err != nil {
			server.logger.Warn("failed to scan themes directory", "path", themesPath, "error", err)
		} else {
			server.logger.Info("scanned themes directory", "path", themesPath, "themes", len(discoveredThemes))
			if err := server.SyncThemesToDatabase(discoveredThemes); err != nil {
				server.logger.Warn("failed to sync themes", "error", err)
			}
		}
	}

	if shouldSeedDevData(config) {
		devModeUtil.CreateDefaultAdminUser(server.store)
		devModeUtil.CreateDummyData(server.store, server.config)
	}

	return server, nil
}

// shouldSeedDevData reports whether startup should create the default admin
// (admin/123456) and dummy content: only with GIN_MODE=debug and outside tests.
func shouldSeedDevData(config util.Config) bool {
	return config.IsDebugMode() && !config.IsTestMode
}

// shouldCheckSeededAccounts reports whether startup must verify that no dev
// seeded account still has its seeded password: outside debug mode and tests.
func shouldCheckSeededAccounts(config util.Config) bool {
	return !config.IsDebugMode() && !config.IsTestMode
}

// seededAccountsCheckTimeout bounds the startup lookups of seeded accounts.
const seededAccountsCheckTimeout = 30 * time.Second

// checkSeededAccounts returns an error if any account the dev seeders create
// (admin/123456 and the dummy users) still has its seeded password. Before
// #228 every deployment ran in debug mode and got these accounts, and their
// passwords are public, so startup refuses to run until they are rotated.
// A store error also fails the check: an unverified start is not allowed.
func checkSeededAccounts(store db.Store) error {
	ctx, cancel := context.WithTimeout(context.Background(), seededAccountsCheckTimeout)
	defer cancel()

	usernames, err := devModeUtil.FindSeededAccountsWithSeededPasswords(ctx, store)
	if err != nil {
		return fmt.Errorf("cannot verify that dev seeded accounts are disabled: %w", err)
	}
	if len(usernames) > 0 {
		return fmt.Errorf(
			"refusing to start: account(s) %s still have the publicly known password the dev seeders gave them "+
				"(created by an older version that always ran in debug mode). Change their passwords, "+
				"see \"Seeded dev accounts in production\" in readme.md for the steps",
			strings.Join(usernames, ", "),
		)
	}
	return nil
}

// devCORSOrigins are the local frontend origins allowed in debug mode.
var devCORSOrigins = []string{
	"http://localhost:4321",
	"http://127.0.0.1:4321",
	"http://0.0.0.0:4321",
	"http://web:4321",
}

// corsOrigins returns the origins allowed to make credentialed cross-origin
// requests: CORS_ALLOWED_ORIGINS, plus the local dev origins in debug mode.
func corsOrigins(config util.Config) []string {
	origins := config.AllowedOrigins()
	if config.IsDebugMode() {
		origins = append(origins, devCORSOrigins...)
	}
	return origins
}

// setupRoutes configures the Gin engine:
//
//   - Request ID, structured access log + metrics, panic recovery
//     (observability.go); gin's text logger is not used
//   - Security headers on every response (securityHeadersMiddleware); HSTS
//     outside debug mode only
//   - CORS:
//   - Origins from CORS_ALLOWED_ORIGINS, plus the localhost :4321 origins in
//     debug mode (corsOrigins); credentials allowed
//   - None configured (release without CORS_ALLOWED_ORIGINS): no CORS
//     middleware, same-origin only
//   - /health, /api/v1/health (public): liveness; /readyz: readiness (DB
//     ping). See health.go for which one healthchecks should use.
//   - Rate limits (ratelimit.go): general per-IP limit on /api/v1 and /public,
//     stricter ones on login/register/refresh and self password changes
//   - /api/v1/auth: register, login, refresh, logout (logout requires auth)
//   - /api/v1/sessions: list/block (auth required)
//   - /api/v1/users: CRUD; some endpoints require auth (see handlers)
//   - /api/v1/posts: CRUD, meta, media links, featured image helpers
//   - /api/v1/post-types: read-only lookup
//   - /api/v1/taxonomy-types: CRUD/lookup
//   - /api/v1/taxonomy-terms: CRUD, lookup, popular, search, posts
//   - /api/v1/taxonomies: legacy aliases for terms (back-compat)
//   - /api/v1/media: upload/batch, search, popular, CRUD, relations
//   - /api/v1/collab: collab socket ticket minting (the WS server verifies and burns them)
//   - Static /uploads → ./uploads (serve uploaded files)
//
// Auth:
//   - Endpoints wrapped with authMiddleware require a valid *access* token
//     (Bearer scheme). Payload is available under context key "authorization_payload".
//
// It fails only on an invalid TRUSTED_PROXIES list.
func (server *Server) setupRoutes() error {
	router := gin.New()

	// Only believe X-Forwarded-For / X-Real-IP from TRUSTED_PROXIES (none by
	// default), so a client can't pick its own ClientIP and dodge rate limits.
	if err := router.SetTrustedProxies(server.config.TrustedProxyList()); err != nil {
		return fmt.Errorf("invalid TRUSTED_PROXIES: %w", err)
	}

	// Request id, access log and recovery come first, so every response
	// (preflights, 429s, panics) is logged and carries an X-Request-ID.
	router.Use(
		requestIDMiddleware(),
		server.requestLogger(server.logger, server.metrics),
		server.recoveryMiddleware(server.logger),
	)

	// Next, so CORS preflights (answered by the CORS middleware without
	// calling Next) and rate-limited 429s get the headers too.
	router.Use(securityHeadersMiddleware(server.config))

	// No origins configured (release without CORS_ALLOWED_ORIGINS) means
	// same-origin only: skip the middleware rather than send CORS headers.
	if origins := corsOrigins(server.config); len(origins) > 0 {
		router.Use(cors.New(cors.Config{
			AllowOrigins:     origins,
			AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
			AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization", "If-Match", "ETag", "X-Revision", requestIDHeader},
			ExposeHeaders:    []string{requestIDHeader},
			AllowCredentials: true,
		}))
	}

	// The general per-IP limit runs after CORS (so preflights aren't counted
	// and 429s carry CORS headers) and before any route's own middleware.
	// /health, /readyz and /uploads are left unlimited.
	generalLimit := server.rateLimits.general.perIP(server.rateLimits.generalExempt...)
	v1 := router.Group("/api/v1", generalLimit)
	public := router.Group("/public", generalLimit) // Public API group for SSR/public content

	router.GET("/health", server.healthCheck)
	router.GET("/api/v1/health", server.healthCheck) // same liveness check, reachable through the web /api proxy
	router.GET("/readyz", server.readinessCheck)

	// Session and authentication module routes (see sessions_routes.go for complete definitions)
	server.RegisterSessionRoutes(v1)

	// User management module routes (see users_routes.go for complete definitions)
	server.RegisterUserRoutes(v1)

	// Posts module routes (see posts_routes.go for complete definitions)
	server.RegisterPostRoutes(v1)

	// Legacy taxonomy association route (moved from posts section)
	posts := v1.Group("/posts")
	posts.GET("/:id/taxonomies", server.getPostTaxonomyTerms) // GET /api/v1/posts/:id/taxonomies

	postTypes := v1.Group("/post-types")
	postTypes.GET("", server.getPostTypes)                                                                                    // GET /api/v1/post-types
	postTypes.GET("/:name", server.getPostType)                                                                               // GET /api/v1/post-types/:name
	postTypes.POST("", authMiddleware(server.tokenMaker, server.store), requireSiteAdmin(server), server.createPostType)      // POST /api/v1/post-types (admin)
	postTypes.PUT("/:name", authMiddleware(server.tokenMaker, server.store), requireSiteAdmin(server), server.updatePostType) // PUT /api/v1/post-types/:name (admin)

	// Taxonomy module routes (see taxonomy_routes.go for complete definitions)
	server.RegisterTaxonomyRoutes(v1)

	// Media module routes (see media_routes.go for complete definitions)
	server.registerMediaRoutes(v1)

	// Settings module routes (see settings_routes.go for complete definitions)
	server.RegisterSettingsRoutes(v1)

	// Theme module routes (see themes_routes.go for complete definitions)
	server.registerThemeRoutes(v1)

	// Collaboration (WebSocket) ticket routes (see collab_routes.go)
	server.registerCollabRoutes(v1)

	// Public API routes for SSR/public content
	server.registerPublicRoutes(public)

	router.Static("/uploads", filepath.Dir(server.config.UploadPath))

	//v1.GET("/test-log", server.testLog) // Temporary log endpoint for testing

	server.router = router

	// Server-to-server routes live on their own engine/listener, not under
	// /api/v1, so they never share the public port (see internal_routes.go).
	server.internalRouter = server.newInternalRouter()
	return nil
}

// temp log to test server reload
/* func (server *Server) testLog(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"message":   "🔥 Live reload is working! Updated message",
		"timestamp": time.Now().Format(time.RFC3339),
	})
} */

// Start begins serving HTTP on the given address (e.g., ":8080").
// Blocks until the server is shut down.
func (server *Server) Start(address string) error {
	return server.router.Run(address)
}

// StartInternal serves the server-to-server routes (internal_routes.go) on
// address, e.g. "0.0.0.0:8081". Run it alongside Start; the port must only be
// reachable from the private network (Docker doesn't publish it).
// Blocks until the listener fails.
func (server *Server) StartInternal(address string) error {
	return server.internalRouter.Run(address)
}
