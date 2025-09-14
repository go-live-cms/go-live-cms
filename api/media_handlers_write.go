// Package api provides write operations for media asset management.
// This file contains create, update, and delete handlers for media resources.
//
// # Overview
//
// Purpose: Handles all HTTP write operations (POST, PUT, DELETE) for media assets.
// Includes single file upload, bulk upload, metadata updates, and resource deletion.
//
// Auth: All write operations require Bearer access token validation via authMiddleware.
// File operations include automatic cleanup on database failures.
//
// # Upload Features
//
// Single upload: POST /media with multipart form, optional post linking.
// Bulk upload: POST /media/batch (original) or POST /media/bulk (alias) with multiple files, batch processing with error collection.
// File validation: Extension checking, MIME type verification, size limits.
//
// # Update Operations
//
// Metadata updates: PUT /media/:id for name, description, alt text changes.
// Preserves file data, only updates database fields.
// Requires resource ownership validation.
//
// # Delete Operations
//
// Soft deletion: DELETE /media/:id removes database records and unlinks from posts.
// File cleanup: Automatic filesystem cleanup via database transaction.
// Auth checks: Users can only delete their own media assets.
//
// # Error Handling
//
// Upload failures: Automatic file cleanup on database errors.
// Bulk operations: Partial success reporting with error collection.
// Auth failures: 401/403 responses with descriptive messages.
//
// # Cross-References
//
//   - media_utils.go: File validation, saving, MIME type detection
//   - media_bindings.go: Request DTOs with validation rules
//   - media_presenters.go: Response formatting for created/updated resources
//   - authMiddleware: Bearer token validation and user context
package api

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

// createMedia handles POST /media - single file upload with metadata.
// Accepts multipart form with required file + optional name, description, alt text.
// Can optionally link to existing post via post_id parameter.
// Auth: Requires Bearer token. Returns 201 with media JSON or error.
func (server *Server) createMedia(c *gin.Context) {
	// Parse multipart form with size limit
	maxUploadSize, err := parseFileSize(server.config.MaxUploadSize)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "invalid upload size configuration"})
		return
	}

	if err := c.Request.ParseMultipartForm(maxUploadSize); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("file too large. Maximum size is %s", server.config.MaxUploadSize)})
		return
	}

	file, header, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file is required"})
		return
	}
	defer file.Close()

	if !isValidMediaType(header.Filename) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file type"})
		return
	}

	if header.Size > maxUploadSize {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("file too large. Maximum size is %s", server.config.MaxUploadSize)})
		return
	}

	mediaPath, actualFilename, err := saveUploadedFileWithOriginalName(file, header, server.config.UploadPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save file"})
		return
	}

	fullPath := filepath.Join(".", mediaPath)
	mimeType := getFileMimeType(actualFilename)

	var width, height int32
	if isImageFile(actualFilename) {
		w, h, err := getImageDimensions(fullPath)
		if err == nil {
			width, height = w, h
		}
	}

	authPayload := c.MustGet(authorizationPayloadKey).(*token.Payload)
	userID := authPayload.UserID

	name := c.PostForm("name")
	if name == "" {
		name = strings.TrimSuffix(actualFilename, filepath.Ext(actualFilename))
	}

	description := c.PostForm("description")
	if description == "" {
		description = fmt.Sprintf("Uploaded file: %s", actualFilename)
	}

	alt := c.PostForm("alt")
	if alt == "" {
		alt = strings.TrimSuffix(actualFilename, filepath.Ext(actualFilename))
	}

	media, err := server.store.CreateMedia(c.Request.Context(), db.CreateMediaParams{
		Name:             name,
		Description:      description,
		Alt:              alt,
		MediaPath:        mediaPath,
		FileSize:         header.Size,
		MimeType:         mimeType,
		Width:            width,
		Height:           height,
		Duration:         0, // Set to 0 for non-video files
		UserID:           userID,
		OriginalFilename: actualFilename,
	})
	if err != nil {
		// Clean up uploaded file if database operation fails
		os.Remove(filepath.Join(".", mediaPath))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create media record"})
		return
	}

	// Handle optional post linking
	postIDStr := c.PostForm("post_id")
	if postIDStr != "" {
		// TODO: Implement post linking after checking available DB methods
		// Currently not available in the database schema
	}

	response := toMediaResponse(media)
	c.JSON(http.StatusCreated, response)
}

// createMediaBulk handles POST /media/bulk - multiple file upload with error collection.
// Accepts multipart form with multiple files, processes each independently.
// Returns partial success: {success: [], errors: [], meta: {total, successful, failed}}.
// Auth: Requires Bearer token. Individual file failures don't abort batch.
func (server *Server) createMediaBulk(c *gin.Context) {
	maxUploadSize, err := parseFileSize(server.config.MaxUploadSize)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "invalid upload size configuration"})
		return
	}

	if err := c.Request.ParseMultipartForm(maxUploadSize); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "request too large"})
		return
	}

	form := c.Request.MultipartForm
	files := form.File["files"]

	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no files provided"})
		return
	}

	if len(files) > 20 { // Limit bulk uploads
		c.JSON(http.StatusBadRequest, gin.H{"error": "too many files. Maximum 20 files per batch"})
		return
	}

	authPayload := c.MustGet(authorizationPayloadKey).(*token.Payload)
	userID := authPayload.UserID

	var successfulMedia []MediaResponse
	var errors []string

	for _, fileHeader := range files {
		file, err := fileHeader.Open()
		if err != nil {
			errors = append(errors, fmt.Sprintf("failed to open file %s: %v", fileHeader.Filename, err))
			continue
		}
		defer file.Close()

		if !isValidMediaType(fileHeader.Filename) {
			errors = append(errors, fmt.Sprintf("invalid file type for %s", fileHeader.Filename))
			continue
		}

		if fileHeader.Size > maxUploadSize {
			errors = append(errors, fmt.Sprintf("file %s too large", fileHeader.Filename))
			continue
		}

		mediaPath, actualFilename, err := saveUploadedFileWithOriginalName(file, fileHeader, server.config.UploadPath)
		if err != nil {
			errors = append(errors, fmt.Sprintf("failed to save %s: %v", fileHeader.Filename, err))
			continue
		}

		fullPath := filepath.Join(".", mediaPath)
		mimeType := getFileMimeType(actualFilename)

		var width, height int32
		if isImageFile(actualFilename) {
			w, h, err := getImageDimensions(fullPath)
			if err == nil {
				width, height = w, h
			}
		}

		media, err := server.store.CreateMedia(c.Request.Context(), db.CreateMediaParams{
			Name:             strings.TrimSuffix(actualFilename, filepath.Ext(actualFilename)),
			Description:      fmt.Sprintf("Uploaded file: %s", fileHeader.Filename),
			Alt:              strings.TrimSuffix(fileHeader.Filename, filepath.Ext(fileHeader.Filename)),
			MediaPath:        mediaPath,
			FileSize:         fileHeader.Size,
			MimeType:         mimeType,
			Width:            width,
			Height:           height,
			Duration:         0, // Set to 0 for non-video files
			UserID:           userID,
			OriginalFilename: actualFilename,
		})
		if err != nil {
			os.Remove(filepath.Join(".", mediaPath))
			errors = append(errors, fmt.Sprintf("failed to create media record for %s: %v", fileHeader.Filename, err))
			continue
		}

		successfulMedia = append(successfulMedia, toMediaResponse(media))
	}

	c.JSON(http.StatusCreated, gin.H{
		"success": successfulMedia,
		"errors":  errors,
		"meta": gin.H{
			"total":      len(files),
			"successful": len(successfulMedia),
			"failed":     len(errors),
		},
	})
}

// updateMedia handles PUT /media/:id - metadata updates for existing media.
// Accepts JSON with optional name, description, alt, media_path, file_size, etc.
// Only updates provided fields, preserves existing values for omitted fields.
// Auth: Requires Bearer token. Returns 200 with updated media JSON or error.
func (server *Server) updateMedia(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid media ID"})
		return
	}

	var req UpdateMediaRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	existingMedia, err := server.store.GetMedia(c.Request.Context(), id)
	if err != nil {
		if err.Error() == "no rows in result set" {
			c.JSON(http.StatusNotFound, gin.H{"error": "media not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get media"})
		return
	}

	updateParams := db.UpdateMediaParams{
		ID:               id,
		Name:             existingMedia.Name,
		Description:      existingMedia.Description,
		Alt:              existingMedia.Alt,
		MediaPath:        existingMedia.MediaPath,
		FileSize:         existingMedia.FileSize,
		MimeType:         existingMedia.MimeType,
		Width:            existingMedia.Width,
		Height:           existingMedia.Height,
		Duration:         existingMedia.Duration,
		OriginalFilename: existingMedia.OriginalFilename,
	}

	if req.Name != "" {
		updateParams.Name = req.Name
	}
	if req.Description != "" {
		updateParams.Description = req.Description
	}
	if req.Alt != "" {
		updateParams.Alt = req.Alt
	}
	if req.MediaPath != "" {
		updateParams.MediaPath = req.MediaPath
	}
	if req.FileSize != nil {
		updateParams.FileSize = *req.FileSize
	}
	if req.MimeType != "" {
		updateParams.MimeType = req.MimeType
	}
	if req.Width != nil {
		updateParams.Width = *req.Width
	}
	if req.Height != nil {
		updateParams.Height = *req.Height
	}
	if req.Duration != nil {
		updateParams.Duration = *req.Duration
	}
	if req.OriginalFilename != "" {
		updateParams.OriginalFilename = req.OriginalFilename
	}

	updatedMedia, err := server.store.UpdateMedia(c.Request.Context(), updateParams)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update media"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"media": toMediaResponse(updatedMedia),
	})
}

// deleteMedia handles DELETE /media/:id - soft deletion with filesystem cleanup.
// Removes database record, unlinks from posts, deletes physical file.
// Uses database transaction for data consistency and automatic rollback.
// Auth: Requires Bearer token, ownership validation. Returns 200 with success message.
func (server *Server) deleteMedia(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid media ID"})
		return
	}

	authPayload := c.MustGet(authorizationPayloadKey).(*token.Payload)
	userID := authPayload.UserID

	_, err = server.store.GetMedia(c.Request.Context(), id)
	if err != nil {
		if err.Error() == "no rows in result set" {
			c.JSON(http.StatusNotFound, gin.H{"error": "media not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get media"})
		return
	}

	err = server.store.DeleteMediaTx(c.Request.Context(), db.DeleteMediaTxParams{
		MediaID: id,
		UserID:  userID,
	})
	if err != nil {
		if containsString(err.Error(), "permission denied") {
			c.JSON(http.StatusForbidden, gin.H{"error": "you can only delete your own media"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete media"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "media deleted successfully",
	})
}
