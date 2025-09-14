// Package api — Posts meta operation handlers
//
// Handles post metadata CRUD operations: list, upsert, delete by key.
// Validates post existence before meta operations.
//
// Meta Operations
//   - GET /posts/:id/meta: List all meta for a post
//   - POST /posts/:id/meta: Upsert meta key-value pair
//   - DELETE /posts/:id/meta/:key: Remove specific meta key
package api

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// getPostMeta handles GET /posts/:id/meta
func (server *Server) getPostMeta(c *gin.Context) {
	idParam := c.Param("id")
	postID, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	_, err = server.store.GetPost(c.Request.Context(), postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify post"})
		return
	}

	metaList, err := server.store.GetPostMeta(c.Request.Context(), postID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post meta"})
		return
	}

	metaResponses := make([]PostMetaResponse, len(metaList))
	for i, meta := range metaList {
		metaResponses[i] = toPostMetaResponse(meta)
	}

	c.JSON(http.StatusOK, gin.H{
		"meta": metaResponses,
	})
}

// createOrUpdatePostMeta handles POST /posts/:id/meta (upsert operation)
func (server *Server) createOrUpdatePostMeta(c *gin.Context) {
	idParam := c.Param("id")
	postID, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	var req CreatePostMetaRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	_, err = server.store.GetPost(c.Request.Context(), postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify post"})
		return
	}

	meta, err := server.store.UpsertPostMeta(c.Request.Context(), db.UpsertPostMetaParams{
		PostID:  postID,
		MetaKey: req.MetaKey,
		MetaValue: sql.NullString{
			String: req.MetaValue,
			Valid:  true,
		},
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save post meta"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"meta": toPostMetaResponse(meta),
	})
}

// deletePostMetaByKey handles DELETE /posts/:id/meta/:key
func (server *Server) deletePostMetaByKey(c *gin.Context) {
	idParam := c.Param("id")
	postID, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	metaKey := c.Param("key")
	if metaKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "meta key is required"})
		return
	}

	_, err = server.store.GetPost(c.Request.Context(), postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify post"})
		return
	}

	_, err = server.store.GetPostMetaByKey(c.Request.Context(), db.GetPostMetaByKeyParams{
		PostID:  postID,
		MetaKey: metaKey,
	})
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "meta not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify meta"})
		return
	}

	err = server.store.DeletePostMeta(c.Request.Context(), db.DeletePostMetaParams{
		PostID:  postID,
		MetaKey: metaKey,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete post meta"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "post meta deleted successfully",
	})
}
