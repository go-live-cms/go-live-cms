// Package api — Posts module entry
//
// High-level docs for the Posts API (CRUD, listings, meta, featured image, media links).
//
// Purpose
//
//	Manage posts with authorship, taxonomy, media links, and optional meta hydration.
//
// Auth
//
//	Write operations require Bearer access token; reads are public (adjust as needed).
//
// Features
//   - Create/Update/Delete posts
//   - List with filters: type, status, user_id; pagination; sort (date_*, title_*, menu_order_*, id_*)
//   - Optional meta hydration: with_meta=true & meta_level=basic|all
//   - Post meta upsert/list/delete
//   - Featured image helpers: set/get(quick|full)/remove
//   - Post↔Media links: add/list/delete, ?featured=true toggle
//   - Typed listing: GET /posts/type/:type (with optional meta hydration)
//
// Cross-References
//   - DB: CreatePostTx, UpdatePost, DeletePostTx, ListPosts*, GetPost*, meta & post_media queries
//   - Auth: authMiddleware (Bearer)
//   - Media presenters for featured-image responses
//
// Status Codes
//
//	200/201, 400, 404, 409 (URL conflict), 500
//
// This file intentionally contains only documentation.
// See: posts_routes.go, posts_bindings.go, posts_presenters.go,
//
//	posts_handlers_read.go, posts_handlers_write.go,
//	posts_meta_handlers.go, posts_featured_image.go,
//	posts_media_links.go, posts_utils.go.
package api
