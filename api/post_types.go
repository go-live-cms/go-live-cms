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
