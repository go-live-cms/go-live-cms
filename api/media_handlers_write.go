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
// Replace: POST /media/:id/replace swaps the stored file in place, keeping the id and metadata.
// File validation: extension allowlist, content sniffing, size limit (validateMediaUpload).
//
// # Update Operations
//
// Metadata updates: PUT /media/:id for name, description, alt text changes.
// File fields (media_path, size, MIME type, dimensions) are server-owned and
// rejected with 400. Who may update which media: see Ownership Policy below.
//
// # Delete Operations
//
// Deletion: DELETE /media/:id removes database records and unlinks from posts
// in one transaction, then removes the stored file from the upload directory
// (best effort, and only for paths inside UploadPath; see removeMediaFile).
//
// # Ownership Policy (PUT, DELETE and POST /media/:id/replace)
//
// All three routes sit behind requireContentEditor, so only admins and editors
// reach these handlers today. Within them:
//   - admin:  may update/delete any media (moderation)
//   - editor: may update/delete any media (moderation; editors can already
//     delete any post)
//   - any other role admitted later: own media only (403 otherwise)
//
// All three handlers decide through canWriteMedia (auth_roles.go). Media is
// publicly readable, so answering 403 (not 404) for someone else's media
// reveals nothing.
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
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"database/sql"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

// createMedia handles POST /media - single file upload with metadata.
// Accepts multipart form with required file + optional name, description, alt text.
// Can optionally link to existing post via post_id parameter.
// The file must be an allowed type whose bytes match its extension (400
// otherwise) and at most MaxUploadSize (413 otherwise); see validateMediaUpload.
// Auth: Requires Bearer token. Returns 201 with media JSON or error.
func (server *Server) createMedia(c *gin.Context) {
	limitUploadBody(c, server.maxUploadBytes, 1)

	// Validate request fields BEFORE saving the file to avoid orphaned uploads.
	// Binding also parses the multipart form.
	var req CreateMediaRequest
	if err := c.ShouldBind(&req); err != nil {
		if isBodyTooLarge(err) {
			server.respondUploadTooLarge(c)
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	file, header, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file is required"})
		return
	}
	defer file.Close()

	mimeType, err := validateMediaUpload(file, header, server.maxUploadBytes)
	if err != nil {
		server.respondUploadError(c, err)
		return
	}

	mediaPath, actualFilename, err := saveUploadedFileWithOriginalName(file, header, server.config.UploadPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save file"})
		return
	}

	var width, height int32
	if isImageFile(actualFilename) {
		w, h, imgErr := getImageDimensions(mediaPath)
		if imgErr == nil {
			width, height = w, h
		}
	}

	// Strip the original's metadata and generate its variants (#255).
	fileSize, staged := prepareStoredImage(server.requestLog(c), server.config.UploadPath, mediaPath, mimeType, header.Size)
	variants := staged.commitForNewRow(server.requestLog(c))
	removeStored := func() {
		os.Remove(mediaPath)
		removeMediaVariants(server.config.UploadPath, mediaPath)
	}

	authPayload := c.MustGet(authorizationPayloadKey).(*token.Payload)
	userID := authPayload.UserID

	name := req.Name
	if name == "" {
		name = strings.TrimSuffix(actualFilename, filepath.Ext(actualFilename))
	}
	description := req.Description
	if description == "" {
		description = fmt.Sprintf("Uploaded file: %s", actualFilename)
	}
	alt := req.Alt
	if alt == "" {
		alt = strings.TrimSuffix(actualFilename, filepath.Ext(actualFilename))
	}

	mediaParams := db.CreateMediaParams{
		Name:             name,
		Description:      description,
		Alt:              alt,
		MediaPath:        mediaPath,
		FileSize:         fileSize,
		MimeType:         mimeType,
		Width:            width,
		Height:           height,
		Duration:         0,
		UserID:           userID,
		OriginalFilename: actualFilename,
		Variants:         variants,
	}

	// If post_id is provided, create media and link to post atomically.
	if req.PostID != nil {
		order := int32(0)
		if req.Order != nil {
			order = *req.Order
		}
		result, txErr := server.store.CreateMediaAndLinkTx(c.Request.Context(), db.CreateMediaAndLinkTxParams{
			Name:             mediaParams.Name,
			Description:      mediaParams.Description,
			Alt:              mediaParams.Alt,
			MediaPath:        mediaParams.MediaPath,
			UserID:           mediaParams.UserID,
			FileSize:         mediaParams.FileSize,
			MimeType:         mediaParams.MimeType,
			Width:            mediaParams.Width,
			Height:           mediaParams.Height,
			Duration:         mediaParams.Duration,
			OriginalFilename: mediaParams.OriginalFilename,
			PostID:           *req.PostID,
			Order:            order,
			Variants:         mediaParams.Variants,
		})
		if txErr != nil {
			removeStored()
			if strings.Contains(txErr.Error(), "post not found") || strings.Contains(txErr.Error(), "no rows") {
				c.JSON(http.StatusBadRequest, gin.H{"error": txErr.Error()})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create media record"})
			return
		}
		c.JSON(http.StatusCreated, gin.H{"media": toMediaResponse(result.Media)})
		return
	}

	media, err := server.store.CreateMedia(c.Request.Context(), mediaParams)
	if err != nil {
		removeStored()
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create media record"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"media": toMediaResponse(media)})
}

// maxBulkFiles is the most files one bulk upload may carry.
const maxBulkFiles = 20

// createMediaBulk handles POST /media/bulk - multiple file upload with error collection.
// Accepts multipart form with multiple files, processes each independently.
// Each file is validated like a single upload (validateMediaUpload); a bad
// one is reported in errors without sinking the batch. A body larger than
// maxBulkFiles maximum-size files gets 413.
// Returns partial success: {success: [], errors: [], meta: {total, successful, failed}}.
// Auth: Requires Bearer token. Individual file failures don't abort batch.
func (server *Server) createMediaBulk(c *gin.Context) {
	limitUploadBody(c, server.maxUploadBytes, maxBulkFiles)

	if err := c.Request.ParseMultipartForm(server.maxUploadBytes); err != nil {
		if isBodyTooLarge(err) {
			server.respondUploadTooLarge(c)
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid multipart form"})
		return
	}

	form := c.Request.MultipartForm
	files := form.File["files"]

	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no files provided"})
		return
	}

	if len(files) > maxBulkFiles {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("too many files. Maximum %d files per batch", maxBulkFiles)})
		return
	}

	authPayload := c.MustGet(authorizationPayloadKey).(*token.Payload)
	userID := authPayload.UserID

	var successfulMedia []MediaResponse
	var errors []string

	for _, fileHeader := range files {
		media, errMsg := server.createBulkMediaItem(c, fileHeader, userID)
		if errMsg != "" {
			errors = append(errors, errMsg)
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

// createBulkMediaItem validates, stores and records one file of a bulk
// upload. It returns the created row, or a client-facing error message.
func (server *Server) createBulkMediaItem(c *gin.Context, fileHeader *multipart.FileHeader, userID int64) (db.Medium, string) {
	file, err := fileHeader.Open()
	if err != nil {
		return db.Medium{}, fmt.Sprintf("failed to open file %s: %v", fileHeader.Filename, err)
	}
	defer file.Close()

	mimeType, err := validateMediaUpload(file, fileHeader, server.maxUploadBytes)
	switch {
	case err == nil:
	case errors.Is(err, errUnsupportedMediaType):
		return db.Medium{}, fmt.Sprintf("invalid file type for %s", fileHeader.Filename)
	case errors.Is(err, errMediaContentMismatch):
		return db.Medium{}, fmt.Sprintf("file content of %s does not match its extension", fileHeader.Filename)
	case errors.Is(err, errMediaTooLarge):
		return db.Medium{}, fmt.Sprintf("file %s too large. Maximum size is %s", fileHeader.Filename, server.config.MaxUploadSize)
	default:
		return db.Medium{}, fmt.Sprintf("failed to read %s", fileHeader.Filename)
	}

	mediaPath, actualFilename, err := saveUploadedFileWithOriginalName(file, fileHeader, server.config.UploadPath)
	if err != nil {
		return db.Medium{}, fmt.Sprintf("failed to save %s: %v", fileHeader.Filename, err)
	}

	var width, height int32
	if isImageFile(actualFilename) {
		w, h, err := getImageDimensions(mediaPath)
		if err == nil {
			width, height = w, h
		}
	}

	fileSize, staged := prepareStoredImage(server.requestLog(c), server.config.UploadPath, mediaPath, mimeType, fileHeader.Size)

	media, err := server.store.CreateMedia(c.Request.Context(), db.CreateMediaParams{
		Name:             strings.TrimSuffix(actualFilename, filepath.Ext(actualFilename)),
		Description:      fmt.Sprintf("Uploaded file: %s", fileHeader.Filename),
		Alt:              strings.TrimSuffix(fileHeader.Filename, filepath.Ext(fileHeader.Filename)),
		MediaPath:        mediaPath,
		FileSize:         fileSize,
		MimeType:         mimeType,
		Width:            width,
		Height:           height,
		Duration:         0, // Set to 0 for non-video files
		UserID:           userID,
		OriginalFilename: actualFilename,
		Variants:         staged.commitForNewRow(server.requestLog(c)),
	})
	if err != nil {
		os.Remove(mediaPath)
		removeMediaVariants(server.config.UploadPath, mediaPath)
		return db.Medium{}, fmt.Sprintf("failed to create media record for %s: %v", fileHeader.Filename, err)
	}
	return media, ""
}

// replaceMedia handles POST /media/:id/replace - swaps the stored file of an
// existing media row for a new upload (multipart field "file").
//
// The row keeps its id, so every reference (post_media, _thumbnail_id, image
// blocks' mediaId) still points at it, and keeps name, description and alt.
// The file is validated like any upload and must be the same type as the
// current one (400 otherwise). It is written over the stored file at the
// same media_path, so the URL that posts and block docs already embed shows
// the new file (/uploads is served with Cache-Control: no-cache, so
// browsers revalidate rather than show a cached copy). Size, dimensions and
// original_filename are updated.
//
// The original is moved aside rather than deleted until the database update
// succeeds, and put back if it fails, so a failed replace loses nothing. A
// row whose media_path isn't inside UploadPath (seeded or legacy data) gets
// the new file stored as a fresh upload instead, and the old path is left
// alone.
//
// Auth: same as PUT /media/:id (editor-or-admin route; admins and editors may
// replace any media, other roles only their own). Returns 200 with the
// updated media JSON.
func (server *Server) replaceMedia(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid media ID"})
		return
	}

	caller, ok := server.callerUser(c)
	if !ok {
		return
	}

	limitUploadBody(c, server.maxUploadBytes, 1)
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		if isBodyTooLarge(err) {
			server.respondUploadTooLarge(c)
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "file is required"})
		return
	}
	defer file.Close()

	mimeType, err := validateMediaUpload(file, header, server.maxUploadBytes)
	if err != nil {
		server.respondUploadError(c, err)
		return
	}

	server.mediaReplaceMu.Lock()
	defer server.mediaReplaceMu.Unlock()

	// Read under the lock: the path and type checked below must be the ones
	// the swap acts on.
	media, err := server.store.GetMedia(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "media not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get media"})
		return
	}
	if !canWriteMedia(caller, media) {
		c.JSON(http.StatusForbidden, gin.H{"error": "you can only replace your own media"})
		return
	}
	if mimeType != media.MimeType {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": fmt.Sprintf("replacement must be the same file type as the original (%s, got %s); upload a different type as new media", media.MimeType, mimeType),
		})
		return
	}

	ext := filepath.Ext(header.Filename)
	params := db.ReplaceMediaFileParams{
		ID:               id,
		MediaPath:        media.MediaPath,
		FileSize:         header.Size,
		MimeType:         mimeType,
		Duration:         media.Duration,
		OriginalFilename: cleanFilename(strings.TrimSuffix(header.Filename, ext)) + ext,
	}

	// In place when the current file is ours, else as a new upload.
	var swap *fileSwap
	storedPath := media.MediaPath
	if target, err := resolveInUploadDir(server.config.UploadPath, media.MediaPath); err == nil {
		swap, err = swapInFile(target, file)
		if err != nil {
			server.requestLog(c).Error("media replace: writing file failed", "media_id", id, "media_path", media.MediaPath, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save file"})
			return
		}
	} else {
		newPath, actualFilename, err := saveUploadedFileWithOriginalName(file, header, server.config.UploadPath)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save file"})
			return
		}
		params.MediaPath = newPath
		params.OriginalFilename = actualFilename
		storedPath = newPath
	}

	if isImageFile(storedPath) {
		if w, h, err := getImageDimensions(storedPath); err == nil {
			params.Width, params.Height = w, h
		}
	}

	// New variants are staged aside; the old ones stay until the row is
	// updated, so a failed replace leaves the original and its variants.
	var staged *stagedVariants
	params.FileSize, staged = prepareStoredImage(server.requestLog(c), server.config.UploadPath, storedPath, mimeType, header.Size)
	params.Variants = staged.column()

	updated, err := server.store.ReplaceMediaFile(c.Request.Context(), params)
	if err != nil {
		staged.discard()
		var undoErr error
		if swap != nil {
			undoErr = swap.rollback()
		} else {
			undoErr = os.Remove(storedPath)
		}
		if undoErr != nil {
			server.requestLog(c).Error("media replace: undoing file swap after failed update", "media_id", id, "media_path", storedPath, "error", undoErr)
		}
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "media not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update media"})
		return
	}

	if swap != nil {
		if err := swap.commit(); err != nil {
			server.requestLog(c).Warn("media replaced but old file not removed", "media_id", id, "media_path", storedPath, "error", err)
		}
	}
	// Swaps the old variants for the new ones (or removes them if the new
	// file has none).
	if err := staged.commit(); err != nil {
		server.requestLog(c).Warn("media replaced but variants not moved into place", "media_id", id, "media_path", storedPath, "error", err)
	}

	c.JSON(http.StatusOK, gin.H{"media": toMediaResponse(updated)})
}

// updateMedia handles PUT /media/:id - metadata updates for existing media.
// Accepts JSON with optional name, description, alt and focal_point
// ({"x", "y"} in 0..1; null clears it, absent keeps it). The file fields
// (media_path, file_size, mime_type, width, height, duration,
// original_filename, variants) are server-owned: a request that sets any of
// them gets 400 and nothing is written.
// Only updates provided fields, preserves existing values for omitted fields.
// Auth: Requires Bearer token + editor-or-admin role. Admins and editors may
// update any media; other roles only their own (see Ownership Policy above).
// Returns 200 with updated media JSON or error.
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
	if fields := req.serverOwnedFields(); len(fields) > 0 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": fmt.Sprintf("%s cannot be updated: file fields are set on upload", strings.Join(fields, ", ")),
		})
		return
	}
	setFocal, focal, err := req.focalPointUpdate()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	caller, ok := server.callerUser(c)
	if !ok {
		return
	}

	// Moderators may update any media, so only owner-scoped callers need the
	// row read for the ownership decision; moderators stay at one query.
	if !canModerateMedia(caller) {
		existingMedia, err := server.store.GetMedia(c.Request.Context(), id)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "media not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get media"})
			return
		}
		if !canWriteMedia(caller, existingMedia) {
			c.JSON(http.StatusForbidden, gin.H{"error": "you can only update your own media"})
			return
		}
	}

	// One statement that only touches name/description/alt: the file columns
	// can't be written through this path, and concurrent partial updates
	// don't overwrite each other's fields with a stale read. Empty strings
	// are passed as NULL, which keeps the current value.
	params := db.UpdateMediaMetadataParams{
		ID:            id,
		Name:          sql.NullString{String: req.Name, Valid: req.Name != ""},
		Description:   sql.NullString{String: req.Description, Valid: req.Description != ""},
		Alt:           sql.NullString{String: req.Alt, Valid: req.Alt != ""},
		SetFocalPoint: setFocal,
	}
	if focal != nil {
		params.FocalX = sql.NullFloat64{Float64: focal.X, Valid: true}
		params.FocalY = sql.NullFloat64{Float64: focal.Y, Valid: true}
	}
	updatedMedia, err := server.store.UpdateMediaMetadata(c.Request.Context(), params)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "media not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update media"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"media": toMediaResponse(updatedMedia),
	})
}

// deleteMedia handles DELETE /media/:id - deletion with filesystem cleanup.
// Removes database record, unlinks from posts, then deletes the physical file.
// Uses database transaction for data consistency and automatic rollback.
// Auth: Requires Bearer token + editor-or-admin role. Admins and editors may
// delete any media; other roles only their own (see Ownership Policy above).
// Returns 200 with success message.
func (server *Server) deleteMedia(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid media ID"})
		return
	}

	caller, ok := server.callerUser(c)
	if !ok {
		return
	}

	// The row is read up front for the ownership decision (same as PUT) and
	// for the file path to remove after the delete commits.
	media, err := server.store.GetMedia(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "media not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get media"})
		return
	}

	if !canWriteMedia(caller, media) {
		c.JSON(http.StatusForbidden, gin.H{"error": "you can only delete your own media"})
		return
	}

	// DeleteMediaTx re-checks ownership inside the transaction (skipped for
	// moderators), so a concurrent delete or owner change between the read
	// above and the delete still resolves to 404/403 rather than 500.
	err = server.store.DeleteMediaTx(c.Request.Context(), db.DeleteMediaTxParams{
		MediaID:  id,
		UserID:   caller.ID,
		AnyOwner: canModerateMedia(caller),
	})
	if err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows):
			c.JSON(http.StatusNotFound, gin.H{"error": "media not found"})
		case errors.Is(err, db.ErrMediaNotOwned):
			c.JSON(http.StatusForbidden, gin.H{"error": "you can only delete your own media"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete media"})
		}
		return
	}

	// Best effort: the row is gone either way. A leftover file is logged, not
	// surfaced, because the delete itself succeeded and cannot be retried.
	if err := removeMediaFile(server.config.UploadPath, media.MediaPath); err != nil {
		server.requestLog(c).Warn("media deleted but file not removed", "media_id", id, "media_path", media.MediaPath, "error", err)
	} else if err := removeMediaVariants(server.config.UploadPath, media.MediaPath); err != nil {
		server.requestLog(c).Warn("media deleted but variants not removed", "media_id", id, "media_path", media.MediaPath, "error", err)
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "media deleted successfully",
	})
}
