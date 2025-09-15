// Package api – Post Types module.
//
// # What this module does
// Exposes read-only endpoints for registered post types and a helper to fetch a post with its meta.
// Shapes DB rows into a clean PostTypeResponse.
//
// # Endpoints (v1)
// - GET /api/v1/post-types        (list all post types)
// - GET /api/v1/post-types/:name  (fetch single post type by machine name)
// - GET /api/v1/posts/:id/with-meta (fetch post plus meta blob helper)
//
// # Auth
// All endpoints are public (no Bearer required). Protect upstream if your deployment requires it.
//
// # Request params
// Path:
//   - :name — string; post type key (e.g., post, page, product)
//   - :id — int64; post ID for with-meta
//
// Query: none.
//
// # Responses
// PostTypeResponse:
//   - id (int64) — internal ID
//   - name (string) — machine name
//   - label (string) — display label
//   - description (string) — optional (empty if NULL)
//   - public (bool)
//   - hierarchical (bool)
//   - has_archive (bool)
//   - menu_position (int32) — optional in DB; zero if NULL
//   - supports ([]string) — currently empty; reserved for future capabilities
//   - created_at (RFC3339)
//
// Get Post with Meta: { "post": <DB-projected post+meta> } (shape comes from store.GetPostWithMeta).
//
// # Status codes
// 200 OK — success | 400 Bad Request — invalid id | 404 Not Found — unknown post type/post | 500 Internal Server Error — datastore failures
//
// Error body: { "error": "message" }
//
// # Notes / Behavior
// - description and menu_position are normalized: empty string / zero when DB NULLs
// - supports is emitted for forward-compat; clients should not assume contents
// - with-meta endpoint is read-through to a store method; its exact JSON may evolve with the DB projection
//
// # Examples
// List: curl https://example.com/api/v1/post-types
// Single: curl https://example.com/api/v1/post-types/product
// Post with meta: curl https://example.com/api/v1/posts/123/with-meta
//
// # Cross-refs
// - DB: ListPostTypes, GetPostType, GetPostWithMeta
// - Related: posts.go for core post CRUD; taxonomy_* for organization
//
// # Future
// Populate supports from DB/feature flags (e.g., title, editor, thumbnail, excerpt).
package api

import (
	"database/sql"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

type PostTypeResponse struct {
	ID           int64     `json:"id"`
	Name         string    `json:"name"`
	Label        string    `json:"label"`
	Description  string    `json:"description"`
	Public       bool      `json:"public"`
	Hierarchical bool      `json:"hierarchical"`
	HasArchive   bool      `json:"has_archive"`
	MenuPosition int32     `json:"menu_position"`
	Supports     []string  `json:"supports"`
	CreatedAt    time.Time `json:"created_at"`
}

func toPostTypeResponse(postType db.PostType) PostTypeResponse {
	return PostTypeResponse{
		ID:           postType.ID,
		Name:         postType.Name,
		Label:        postType.Label,
		Description:  postType.Description.String,
		Public:       postType.Public,
		Hierarchical: postType.Hierarchical,
		HasArchive:   postType.HasArchive,
		MenuPosition: postType.MenuPosition.Int32,
		Supports:     []string{},
		CreatedAt:    postType.CreatedAt,
	}
}

func (server *Server) getPostTypes(c *gin.Context) {
	postTypes, err := server.store.ListPostTypes(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list post types"})
		return
	}

	responses := make([]PostTypeResponse, len(postTypes))
	for i, pt := range postTypes {
		responses[i] = toPostTypeResponse(pt)
	}

	c.JSON(http.StatusOK, gin.H{
		"post_types": responses,
	})
}

func (server *Server) getPostType(c *gin.Context) {
	name := c.Param("name")

	postType, err := server.store.GetPostType(c.Request.Context(), name)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post type not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post type"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"post_type": toPostTypeResponse(postType),
	})
}

func (server *Server) getPostWithMeta(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	result, err := server.store.GetPostWithMeta(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"post": result,
	})
}
