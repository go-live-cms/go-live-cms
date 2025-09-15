// Package api — Posts write operation handlers
//
// Handles create, update, and delete operations for posts with full transaction support,
// author validation, media/taxonomy associations, and conflict handling.
//
// Features
//   - Primary author validation and username assignment
//   - Conditional transactions based on media/taxonomy presence
//   - URL conflict detection with 409 status
//   - Default values for post_type (post) and post_status (draft)
package api

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// createPost handles POST /posts with author validation and conditional transactions
func (server *Server) createPost(c *gin.Context) {
	var req CreatePostRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if len(req.AuthorIDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "at least one author is required"})
		return
	}

	primaryAuthor, err := server.store.GetUser(c.Request.Context(), req.AuthorIDs[0])
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusBadRequest, gin.H{"error": "primary author not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get primary author"})
		return
	}

	createParams := db.CreatePostsParams{
		Title:       req.Title,
		Content:     req.Content,
		Description: req.Description,
		UserID:      primaryAuthor.ID,
		Username:    primaryAuthor.Username,
		Url:         req.Url,
		PostType:    req.PostType,
		PostStatus:  req.PostStatus,
		MenuOrder:   req.MenuOrder,
	}

	if req.PostParent != nil {
		createParams.PostParent = sql.NullInt64{
			Int64: *req.PostParent,
			Valid: true,
		}
	} else {
		createParams.PostParent = sql.NullInt64{Valid: false}
	}

	if createParams.PostType == "" {
		createParams.PostType = "post"
	}
	if createParams.PostStatus == "" {
		createParams.PostStatus = "draft"
	}

	if len(req.MediaIDs) > 0 && len(req.TaxonomyIDs) > 0 {
		result, err := server.store.CreatePostTx(c.Request.Context(), db.CreatePostTxParams{
			CreatePostsParams: createParams,
			AuthorIDs:         req.AuthorIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create post"})
			return
		}

		c.JSON(http.StatusCreated, gin.H{
			"post": toPostResponse(result.Post),
		})
	} else if len(req.MediaIDs) > 0 {
		result, err := server.store.CreatePostWithMediaTx(c.Request.Context(), db.CreatePostWithMediaTxParams{
			CreatePostsParams: createParams,
			AuthorIDs:         req.AuthorIDs,
			MediaIDs:          req.MediaIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create post with media"})
			return
		}

		c.JSON(http.StatusCreated, gin.H{
			"post": toPostResponse(result.Post),
		})
	} else if len(req.TaxonomyIDs) > 0 {
		result, err := server.store.CreatePostWithTaxonomyTermsTx(c.Request.Context(), db.CreatePostWithTaxonomyTermsTxParams{
			CreatePostsParams: createParams,
			AuthorIDs:         req.AuthorIDs,
			TaxonomyTermIDs:   req.TaxonomyIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create post with taxonomies"})
			return
		}

		c.JSON(http.StatusCreated, gin.H{
			"post": toPostResponse(result.Post),
		})
	} else {
		result, err := server.store.CreatePostTx(c.Request.Context(), db.CreatePostTxParams{
			CreatePostsParams: createParams,
			AuthorIDs:         req.AuthorIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create post"})
			return
		}

		c.JSON(http.StatusCreated, gin.H{
			"post": toPostResponse(result.Post),
		})
	}
}

// updatePost handles PUT /posts/:id with selective field updates and media/taxonomy management
func (server *Server) updatePost(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	var req UpdatePostRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	existingPost, err := server.store.GetPost(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	updateParams := db.UpdatePostParams{
		ID:          id,
		Title:       existingPost.Title,
		Content:     existingPost.Content,
		Description: existingPost.Description,
		UserID:      existingPost.UserID,
		Username:    existingPost.Username,
		Url:         existingPost.Url,
		PostType:    existingPost.PostType,
		PostStatus:  existingPost.PostStatus,
		PostParent:  existingPost.PostParent,
		MenuOrder:   existingPost.MenuOrder,
	}

	if req.Title != "" {
		updateParams.Title = req.Title
	}
	if req.Content != "" {
		updateParams.Content = req.Content
	}
	if req.Description != "" {
		updateParams.Description = req.Description
	}
	if req.Url != "" {
		updateParams.Url = req.Url
	}
	if req.PostType != "" {
		updateParams.PostType = req.PostType
	}
	if req.PostStatus != "" {
		updateParams.PostStatus = req.PostStatus
	}
	if req.PostParent != nil {
		updateParams.PostParent = sql.NullInt64{
			Int64: *req.PostParent,
			Valid: true,
		}
	}
	if req.MenuOrder != 0 {
		updateParams.MenuOrder = req.MenuOrder
	}

	updatedPost, err := server.store.UpdatePost(c.Request.Context(), updateParams)
	if err != nil {
		if containsString(err.Error(), "duplicate key value") || containsString(err.Error(), "unique constraint") {
			c.JSON(http.StatusConflict, gin.H{"error": "URL already exists"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update post"})
		return
	}

	if req.MediaIDs != nil {
		err = server.store.UpdatePostMediaTx(c.Request.Context(), db.UpdatePostMediaTxParams{
			PostID:   id,
			MediaIDs: req.MediaIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update post media"})
			return
		}
	}

	if req.TaxonomyIDs != nil {
		err = server.store.UpdatePostTaxonomyTermsTx(c.Request.Context(), db.UpdatePostTaxonomyTermsTxParams{
			PostID:          id,
			TaxonomyTermIDs: req.TaxonomyIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update post taxonomies"})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"post": toPostResponse(updatedPost),
	})
}

// deletePost handles DELETE /posts/:id with full cascade transaction
func (server *Server) deletePost(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	_, err = server.store.GetPost(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	err = server.store.DeletePostTx(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete post"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "post deleted successfully",
	})
}
