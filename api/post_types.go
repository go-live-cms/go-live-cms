// Package api – Post Types module.
//
// # What this module does
// Exposes endpoints for managing post types (CRUD) and a helper to fetch a post with its meta.
// Shapes DB rows into a clean PostTypeResponse.
//
// # Endpoints (v1)
// - GET    /api/v1/post-types            (list active post types; ?all=true for all)
// - GET    /api/v1/post-types/:name      (fetch single post type by machine name)
// - POST   /api/v1/post-types            (create or upsert a post type — auth required)
// - PUT    /api/v1/post-types/:name      (update a post type — auth required)
// - GET    /api/v1/posts/:id/with-meta   (fetch post plus meta blob helper)
//
// # Auth
// GET endpoints are public. POST/PUT require a valid access token.
//
// # Request params
// Path:
//   - :name — string; post type key (e.g., post, page, product)
//   - :id — int64; post ID for with-meta
//
// Query:
//   - all=true (on list) — include inactive post types
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
//   - supports ([]string) — post type capabilities
//   - is_active (bool) — whether the post type is currently active
//   - registered_by (string) — origin: "system", "theme:<slug>", etc.
//   - created_at (RFC3339)
//
// # Status codes
// 200 OK — success | 201 Created — post type created | 400 Bad Request — invalid input
// 404 Not Found — unknown post type/post | 409 Conflict — name already taken
// 500 Internal Server Error — datastore failures
//
// Error body: { "error": "message" }
package api

import (
	"database/sql"
	"encoding/json"
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
	IsActive     bool      `json:"is_active"`
	RegisteredBy string    `json:"registered_by"`
	CreatedAt    time.Time `json:"created_at"`
}

func toPostTypeResponse(postType db.PostType) PostTypeResponse {
	// Parse supports from JSON
	var supports []string
	if postType.Supports != nil {
		if err := json.Unmarshal(postType.Supports, &supports); err != nil {
			supports = []string{}
		}
	} else {
		supports = []string{}
	}

	return PostTypeResponse{
		ID:           postType.ID,
		Name:         postType.Name,
		Label:        postType.Label,
		Description:  postType.Description.String,
		Public:       postType.Public,
		Hierarchical: postType.Hierarchical,
		HasArchive:   postType.HasArchive,
		MenuPosition: postType.MenuPosition.Int32,
		Supports:     supports,
		IsActive:     postType.IsActive,
		RegisteredBy: postType.RegisteredBy,
		CreatedAt:    postType.CreatedAt,
	}
}

// getPostTypes lists post types. By default returns only active ones.
// Use ?all=true to include inactive post types.
func (server *Server) getPostTypes(c *gin.Context) {
	var postTypes []db.PostType
	var err error

	if c.Query("all") == "true" {
		postTypes, err = server.store.ListPostTypes(c.Request.Context())
	} else {
		postTypes, err = server.store.ListActivePostTypes(c.Request.Context())
	}
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

type createPostTypeRequest struct {
	Name         string   `json:"name" binding:"omitempty,min=2,max=50"`
	Label        string   `json:"label" binding:"required,min=2,max=100"`
	Slug         string   `json:"slug"` // Alias for name (theme API compat)
	Description  string   `json:"description"`
	Public       *bool    `json:"public"`
	Hierarchical *bool    `json:"hierarchical"`
	HasArchive   *bool    `json:"has_archive"`
	MenuPosition *int32   `json:"menu_position"`
	Supports     []string `json:"supports"`
	Icon         string   `json:"icon"`          // Stored in supports or ignored for now
	RegisteredBy string   `json:"registered_by"` // e.g. "theme:example"
}

// createPostType creates or upserts a post type.
// If a post type with the same name already exists, it updates it (upsert).
func (server *Server) createPostType(c *gin.Context) {
	var req createPostTypeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Support "slug" as alias for "name" (theme API sends slug)
	name := req.Name
	if name == "" && req.Slug != "" {
		name = req.Slug
	}

	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name or slug is required"})
		return
	}

	// Prevent overwriting system types
	if name == "post" || name == "page" {
		c.JSON(http.StatusConflict, gin.H{"error": "cannot modify system post types"})
		return
	}

	isPublic := true
	if req.Public != nil {
		isPublic = *req.Public
	}

	isHierarchical := false
	if req.Hierarchical != nil {
		isHierarchical = *req.Hierarchical
	}

	hasArchive := true
	if req.HasArchive != nil {
		hasArchive = *req.HasArchive
	}

	var menuPosition sql.NullInt32
	if req.MenuPosition != nil {
		menuPosition = sql.NullInt32{Int32: *req.MenuPosition, Valid: true}
	}

	supports := req.Supports
	if supports == nil {
		supports = []string{"title", "content", "description"}
	}
	supportsJSON, err := json.Marshal(supports)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to marshal supports"})
		return
	}

	registeredBy := req.RegisteredBy
	if registeredBy == "" {
		registeredBy = "user"
	}

	arg := db.UpsertPostTypeParams{
		Name:         name,
		Label:        req.Label,
		Description:  sql.NullString{String: req.Description, Valid: req.Description != ""},
		Public:       isPublic,
		Hierarchical: isHierarchical,
		HasArchive:   hasArchive,
		MenuPosition: menuPosition,
		Supports:     supportsJSON,
		IsActive:     true,
		RegisteredBy: registeredBy,
	}

	postType, err := server.store.UpsertPostType(c.Request.Context(), arg)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create post type"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"post_type": toPostTypeResponse(postType),
	})
}

type updatePostTypeRequest struct {
	Label        string   `json:"label"`
	Description  string   `json:"description"`
	Public       *bool    `json:"public"`
	Hierarchical *bool    `json:"hierarchical"`
	HasArchive   *bool    `json:"has_archive"`
	MenuPosition *int32   `json:"menu_position"`
	Supports     []string `json:"supports"`
}

// updatePostType updates an existing post type by name.
func (server *Server) updatePostType(c *gin.Context) {
	name := c.Param("name")

	// Prevent modifying system types
	if name == "post" || name == "page" {
		c.JSON(http.StatusConflict, gin.H{"error": "cannot modify system post types"})
		return
	}

	// Check the post type exists
	_, err := server.store.GetPostType(c.Request.Context(), name)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post type not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post type"})
		return
	}

	var req updatePostTypeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var supportsJSON json.RawMessage
	if req.Supports != nil {
		supportsJSON, err = json.Marshal(req.Supports)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to marshal supports"})
			return
		}
	}

	arg := db.UpdatePostTypeParams{
		Name:         name,
		Label:        req.Label,
		Description:  sql.NullString{String: req.Description, Valid: req.Description != ""},
		Public:       req.Public != nil && *req.Public,
		Hierarchical: req.Hierarchical != nil && *req.Hierarchical,
		HasArchive:   req.HasArchive != nil && *req.HasArchive,
		MenuPosition: sql.NullInt32{},
		Supports:     supportsJSON,
	}

	if req.MenuPosition != nil {
		arg.MenuPosition = sql.NullInt32{Int32: *req.MenuPosition, Valid: true}
	}

	postType, err := server.store.UpdatePostType(c.Request.Context(), arg)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update post type"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"post_type": toPostTypeResponse(postType),
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
