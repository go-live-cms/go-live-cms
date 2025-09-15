// Package api — Posts media association handlers
//
// Manages post-media link operations: create associations, list media for posts,
// delete associations, with optional featured image filtering.
//
// Query Parameters
//   - ?featured=true: Filter to featured image only (order=0)
//   - Default: Return all media associated with post
package api

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// createPostMedia handles POST /posts/:id/media
func (server *Server) createPostMedia(c *gin.Context) {
	postIDStr := c.Param("id")
	postID, err := strconv.ParseInt(postIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	var req PostMediaRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	postMedia, err := server.store.CreatePostMedia(c.Request.Context(), db.CreatePostMediaParams{
		PostID:  postID,
		MediaID: req.MediaID,
		Order:   req.Order,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create post media association"})
		return
	}

	c.JSON(http.StatusCreated, postMedia)
}

// getPostMedia handles GET /posts/:id/media with optional featured filtering
func (server *Server) getPostMedia(c *gin.Context) {
	postIDStr := c.Param("id")
	postID, err := strconv.ParseInt(postIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	featured := c.Query("featured") == "true"

	if featured {
		// Return featured image only (order=0)
		featuredImage, err := server.store.GetFeaturedImage(c.Request.Context(), postID)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusOK, gin.H{"data": nil})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get featured image"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": featuredImage})
	} else {
		// Return all media associated with post
		postMedia, err := server.store.GetPostMedia(c.Request.Context(), postID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post media"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": postMedia})
	}
}

// deletePostMedia handles DELETE /posts/:id/media/:media_id
func (server *Server) deletePostMedia(c *gin.Context) {
	postIDStr := c.Param("id")
	mediaIDStr := c.Param("media_id")

	postID, err := strconv.ParseInt(postIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	mediaID, err := strconv.ParseInt(mediaIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid media ID"})
		return
	}

	err = server.store.DeletePostMedia(c.Request.Context(), db.DeletePostMediaParams{
		PostID:  postID,
		MediaID: mediaID,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete post media association"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "post media association deleted"})
}