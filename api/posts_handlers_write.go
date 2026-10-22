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

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/sqlc-dev/pqtype"
)

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

// generateUniqueSlug returns baseSlug, or baseSlug-2, -3, ... if another post
// already uses it (the posts.slug unique index would otherwise reject the
// write). excludeID is the post being edited; pass 0 when creating.
func (server *Server) generateUniqueSlug(ctx context.Context, baseSlug string, excludeID int64) (string, error) {
	candidate := baseSlug
	for counter := 2; counter < 100; counter++ { // Safety limit to prevent infinite loop
		exists, err := server.store.CheckSlugExists(ctx, db.CheckSlugExistsParams{Slug: candidate, ExcludeID: excludeID})
		if err != nil {
			return "", err
		}
		if !exists {
			return candidate, nil
		}
		candidate = fmt.Sprintf("%s-%d", baseSlug, counter)
	}
	return "", fmt.Errorf("unable to generate unique slug for %q", baseSlug)
}

// uniqueViolationMessage names the posts unique index a write tripped over.
// The slug and URL are both checked up front, so this is a concurrent writer
// taking the same value in between.
func uniqueViolationMessage(err error) string {
	if containsString(err.Error(), "idx_posts_slug") {
		return "slug already exists"
	}
	return "URL already exists"
}

// createPost handles POST /posts with author validation and conditional transactions
func (server *Server) createPost(c *gin.Context) {
	var req CreatePostRequest
	if !bindJSON(c, &req) {
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
		BlockDoc:    []byte(`{"doc_version":1,"blocks_order":[],"blocks":{}}`),
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

	// Slug from the request if given, else from the title; suffixed -2, -3, ...
	// on a clash so the unique index never rejects the create.
	slugSource := req.Title
	if req.Slug != "" {
		slugSource = req.Slug
	}
	uniqueSlug, err := server.generateUniqueSlug(c.Request.Context(), normalizePostSlug(slugSource), 0)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate unique slug"})
		return
	}
	createParams.Slug = uniqueSlug

	// Create the post
	var createdPost db.Post
	if len(req.MediaIDs) > 0 && len(req.TaxonomyIDs) > 0 {
		result, err := server.store.CreatePostTx(c.Request.Context(), db.CreatePostTxParams{
			CreatePostsParams: createParams,
			AuthorIDs:         req.AuthorIDs,
		})
		if err != nil {
			if isUniqueViolation(err) {
				c.JSON(http.StatusConflict, gin.H{"error": uniqueViolationMessage(err)})
				return
			}
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
			if isUniqueViolation(err) {
				c.JSON(http.StatusConflict, gin.H{"error": uniqueViolationMessage(err)})
				return
			}
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
			if isUniqueViolation(err) {
				c.JSON(http.StatusConflict, gin.H{"error": uniqueViolationMessage(err)})
				return
			}
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
			if isUniqueViolation(err) {
				c.JSON(http.StatusConflict, gin.H{"error": uniqueViolationMessage(err)})
				return
			}
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
			server.requestLog(c).Warn("failed to initialize published_block_doc for new post", "post_id", createdPost.ID, "error", err)
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
	if !bindJSON(c, &req) {
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

	// A slug edit gets the same uniqueness rule as create: normalized, then
	// suffixed -2, -3, ... if another post has it. The response carries the
	// slug actually stored.
	newSlug := ""
	if req.Slug != "" {
		newSlug, err = server.generateUniqueSlug(c.Request.Context(), normalizePostSlug(req.Slug), id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to generate unique slug"})
			return
		}
	}

	// A slug change is written in the same transaction as the other fields, so
	// losing a race for the slug (unique index) rolls the whole update back.
	var updatedPost db.Post
	if newSlug != "" && newSlug != existingPost.Slug {
		updatedPost, err = server.store.UpdatePostWithSlugTx(c.Request.Context(), db.UpdatePostWithSlugTxParams{
			UpdatePostParams: updateParams,
			Slug:             newSlug,
		})
	} else {
		updatedPost, err = server.store.UpdatePost(c.Request.Context(), updateParams)
	}
	if err != nil {
		if isUniqueViolation(err) {
			c.JSON(http.StatusConflict, gin.H{"error": uniqueViolationMessage(err)})
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
