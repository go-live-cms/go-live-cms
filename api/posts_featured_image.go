// Package api — Posts featured image handlers
//
// Manages featured image operations with post-media associations and meta storage.
// Features quick URL lookup and full media object retrieval.
//
// Featured Image Logic
//   - Stores as order=0 post_media association
//   - Maintains _thumbnail_id and _thumbnail_url meta entries
//   - Supports quick (URL only) and full (complete media object) retrieval
//   - Atomic set/remove operations with transaction safety
package api

import (
	"database/sql"
	"fmt"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// setFeaturedImage handles POST /posts/:id/featured-image
func (server *Server) setFeaturedImage(c *gin.Context) {
	postIDStr := c.Param("id")
	postID, err := strconv.ParseInt(postIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	var req SetFeaturedImageRequest
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
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	media, err := server.store.GetMedia(c.Request.Context(), req.MediaID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "media not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get media"})
		return
	}

	err = server.store.ExecTx(c.Request.Context(), func(q *db.Queries) error {
		// Remove existing featured image association
		err := q.DeletePostMediaByOrder(c.Request.Context(), db.DeletePostMediaByOrderParams{
			PostID: postID,
			Order:  0,
		})
		if err != nil && err != sql.ErrNoRows {
			return fmt.Errorf("failed to remove existing featured image: %w", err)
		}

		// Create new featured image association (order=0)
		_, err = q.CreatePostMedia(c.Request.Context(), db.CreatePostMediaParams{
			PostID:  postID,
			MediaID: req.MediaID,
			Order:   0,
		})
		if err != nil {
			return fmt.Errorf("failed to create media association: %w", err)
		}

		// Store thumbnail ID meta
		_, err = q.UpsertPostMeta(c.Request.Context(), db.UpsertPostMetaParams{
			PostID:    postID,
			MetaKey:   "_thumbnail_id",
			MetaValue: sql.NullString{String: strconv.FormatInt(req.MediaID, 10), Valid: true},
		})
		if err != nil {
			return fmt.Errorf("failed to store thumbnail ID meta: %w", err)
		}

		// Store thumbnail URL meta
		mediaPath := server.thumbnailURL(req.MediaPath, media.MediaPath)
		_, err = q.UpsertPostMeta(c.Request.Context(), db.UpsertPostMetaParams{
			PostID:    postID,
			MetaKey:   "_thumbnail_url",
			MetaValue: sql.NullString{String: mediaPath, Valid: true},
		})
		if err != nil {
			return fmt.Errorf("failed to store thumbnail URL meta: %w", err)
		}

		return nil
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "featured image set successfully",
		"media":   server.mediaResponse(media),
	})
}

// thumbnailURL is the _thumbnail_url stored for a featured image: the
// client's media_path, or the media row's when the client sent none, as the
// URL /uploads serves it at. The row holds a filesystem path, and admins
// before #201 sent that same path back, so both go through publicMediaPath.
func (server *Server) thumbnailURL(requested, stored string) string {
	path := requested
	if path == "" {
		path = stored
	}
	return publicMediaPath(server.config.UploadPath, path)
}

// getFeaturedImageQuick handles GET /posts/:id/featured-image (URL only)
func (server *Server) getFeaturedImageQuick(c *gin.Context) {
	postIDStr := c.Param("id")
	postID, err := strconv.ParseInt(postIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	thumbnailMeta, err := server.store.GetPostMetaByKey(c.Request.Context(), db.GetPostMetaByKeyParams{
		PostID:  postID,
		MetaKey: "_thumbnail_url",
	})
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusOK, gin.H{"featured_image": nil})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get featured image"})
		return
	}

	// Rows set before #201 may hold the filesystem path.
	c.JSON(http.StatusOK, gin.H{
		"featured_image": gin.H{
			"url": publicMediaPath(server.config.UploadPath, thumbnailMeta.MetaValue.String),
		},
	})
}

// getFeaturedImageFull handles GET /posts/:id/featured-image/full (complete media object)
func (server *Server) getFeaturedImageFull(c *gin.Context) {
	postIDStr := c.Param("id")
	postID, err := strconv.ParseInt(postIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	featuredImage, err := server.store.GetFeaturedImage(c.Request.Context(), postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusOK, gin.H{"featured_image": nil})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get featured image"})
		return
	}

	response := gin.H{
		"id":                featuredImage.MediaID,
		"name":              featuredImage.Name,
		"description":       featuredImage.Description,
		"alt":               featuredImage.Alt,
		"media_path":        publicMediaPath(server.config.UploadPath, featuredImage.MediaPath),
		"file_size":         featuredImage.FileSize,
		"mime_type":         featuredImage.MimeType,
		"original_filename": featuredImage.OriginalFilename,
		"created_at":        featuredImage.CreatedAt,
		"changed_at":        featuredImage.ChangedAt,
	}

	if featuredImage.Width != 0 {
		response["width"] = featuredImage.Width
	}
	if featuredImage.Height != 0 {
		response["height"] = featuredImage.Height
	}

	c.JSON(http.StatusOK, gin.H{"featured_image": response})
}

// removeFeaturedImage handles DELETE /posts/:id/featured-image
func (server *Server) removeFeaturedImage(c *gin.Context) {
	postIDStr := c.Param("id")
	postID, err := strconv.ParseInt(postIDStr, 10, 64)
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
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	err = server.store.ExecTx(c.Request.Context(), func(q *db.Queries) error {
		// Remove featured image association (order=0)
		err := q.DeletePostMediaByOrder(c.Request.Context(), db.DeletePostMediaByOrderParams{
			PostID: postID,
			Order:  0,
		})
		if err != nil && err != sql.ErrNoRows {
			return fmt.Errorf("failed to remove featured image association: %w", err)
		}

		// Remove the thumbnail meta. A missing row is not an error (DELETE affects
		// zero rows), so any error here is real; and a failed statement aborts the
		// transaction, so it can't be ignored and committed anyway.
		for _, key := range []string{"_thumbnail_id", "_thumbnail_url"} {
			err = q.DeletePostMeta(c.Request.Context(), db.DeletePostMetaParams{
				PostID:  postID,
				MetaKey: key,
			})
			if err != nil {
				return fmt.Errorf("failed to remove %s meta: %w", key, err)
			}
		}

		return nil
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "featured image removed successfully",
	})
}
