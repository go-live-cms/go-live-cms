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
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/sqlc-dev/pqtype"
)

// isDuplicateURLError checks if the error is a duplicate URL constraint violation
func isDuplicateURLError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "posts_url_key")
}

// generateUniqueURL generates a unique URL by appending -2, -3, etc. like WordPress
func (server *Server) generateUniqueURL(ctx context.Context, baseURL string) (string, error) {
	// Check if base URL exists
	exists, err := server.store.CheckURLExists(ctx, baseURL)
	if err != nil {
		return "", err
	}

	if !exists {
		return baseURL, nil
	}

	// URL exists, start appending numbers
	counter := 2
	for counter < 100 { // Safety limit to prevent infinite loop
		candidateURL := fmt.Sprintf("%s-%d", baseURL, counter)
		exists, err := server.store.CheckURLExists(ctx, candidateURL)
		if err != nil {
			return "", err
		}

		if !exists {
			return candidateURL, nil
		}

		counter++
	}

	// If we hit the limit, return error
	return "", fmt.Errorf("unable to generate unique URL after %d attempts", counter)
}

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

	// Generate unique URL if there's a conflict
	uniqueURL, err := server.generateUniqueURL(c.Request.Context(), createParams.Url)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate unique URL"})
		return
	}
	createParams.Url = uniqueURL

	// Create the post
	var createdPost db.Post
	if len(req.MediaIDs) > 0 && len(req.TaxonomyIDs) > 0 {
		result, err := server.store.CreatePostTx(c.Request.Context(), db.CreatePostTxParams{
			CreatePostsParams: createParams,
			AuthorIDs:         req.AuthorIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create post"})
			return
		}
		createdPost = result.Post
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
		createdPost = result.Post
	} else if len(req.TaxonomyIDs) > 0 {
		result, err := server.store.CreatePostWithTaxonomyTermsTx(c.Request.Context(), db.CreatePostWithTaxonomyTermsTxParams{
			CreatePostsParams: createParams,
			AuthorIDs:         req.AuthorIDs,
			TaxonomyTermIDs:   req.TaxonomyIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create post with taxonomy terms"})
			return
		}
		createdPost = result.Post
	} else {
		result, err := server.store.CreatePostTx(c.Request.Context(), db.CreatePostTxParams{
			CreatePostsParams: createParams,
			AuthorIDs:         req.AuthorIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create post"})
			return
		}
		createdPost = result.Post
	}

	// If post was created as published, initialize published_block_doc with empty block document
	if createParams.PostStatus == "published" {
		emptyBlockDoc := []byte(`{"doc_version":1,"blocks_order":[],"blocks":{}}`)
		err = server.store.SetPublishedVersionOnPost(c.Request.Context(), db.SetPublishedVersionOnPostParams{
			ID:                 createdPost.ID,
			PublishedVersionID: sql.NullInt64{Valid: false},
			PublishedBlockDoc:  pqtype.NullRawMessage{RawMessage: emptyBlockDoc, Valid: true},
		})
		if err != nil {
			// Log error but don't fail - post was already created
			fmt.Printf("Warning: failed to initialize published_block_doc for new post %d: %v\n", createdPost.ID, err)
		}
		// Update local copy for response
		createdPost.PublishedBlockDoc = pqtype.NullRawMessage{RawMessage: emptyBlockDoc, Valid: true}
	}

	c.JSON(http.StatusCreated, gin.H{
		"post": toPostResponse(createdPost),
	})
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
