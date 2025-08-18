package api

import (
	"database/sql"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

type CreateMediaRequest struct {
	Name        string `form:"name" binding:"required,min=2,max=255"`
	Description string `form:"description" binding:"required,min=5,max=500"`
	Alt         string `form:"alt" binding:"required,min=2,max=255"`
	PostID      *int64 `form:"post_id" binding:"omitempty"`
	Order       *int32 `form:"order" binding:"omitempty,min=0"`
}

type UpdateMediaRequest struct {
	Name             string `json:"name" binding:"omitempty,min=2,max=255"`
	Description      string `json:"description" binding:"omitempty,min=5,max=500"`
	Alt              string `json:"alt" binding:"omitempty,min=2,max=255"`
	MediaPath        string `json:"media_path" binding:"omitempty,min=1,max=500"`
	FileSize         *int64 `json:"file_size" binding:"omitempty,min=0"`
	MimeType         string `json:"mime_type" binding:"omitempty"`
	Width            *int32 `json:"width" binding:"omitempty,min=0"`
	Height           *int32 `json:"height" binding:"omitempty,min=0"`
	Duration         *int32 `json:"duration" binding:"omitempty,min=0"`
	OriginalFilename string `json:"original_filename" binding:"omitempty"`
}

type MediaResponse struct {
	ID               int64     `json:"id"`
	Name             string    `json:"name"`
	Description      string    `json:"description"`
	Alt              string    `json:"alt"`
	MediaPath        string    `json:"media_path"`
	UserID           int64     `json:"user_id"`
	CreatedAt        time.Time `json:"created_at"`
	ChangedAt        time.Time `json:"changed_at"`
	PostCount        *int64    `json:"post_count,omitempty"`
	FileSize         int64     `json:"file_size"`
	MimeType         string    `json:"mime_type"`
	Width            *int32    `json:"width,omitempty"`
	Height           *int32    `json:"height,omitempty"`
	Duration         *int32    `json:"duration,omitempty"`
	OriginalFilename string    `json:"original_filename"`
}

type PopularMediaResponse struct {
	ID               int64     `json:"id"`
	Name             string    `json:"name"`
	Description      string    `json:"description"`
	Alt              string    `json:"alt"`
	MediaPath        string    `json:"media_path"`
	UserID           int64     `json:"user_id"`
	CreatedAt        time.Time `json:"created_at"`
	ChangedAt        time.Time `json:"changed_at"`
	PostCount        int64     `json:"post_count"`
	FileSize         int64     `json:"file_size"`
	MimeType         string    `json:"mime_type"`
	Width            *int32    `json:"width,omitempty"`
	Height           *int32    `json:"height,omitempty"`
	Duration         *int32    `json:"duration,omitempty"`
	OriginalFilename string    `json:"original_filename"`
}

func toMediaResponse(media db.Medium) MediaResponse {
	var width, height, duration *int32
	if media.Width != 0 {
		width = &media.Width
	}
	if media.Height != 0 {
		height = &media.Height
	}
	if media.Duration != 0 {
		duration = &media.Duration
	}

	return MediaResponse{
		ID:               media.ID,
		Name:             media.Name,
		Description:      media.Description,
		Alt:              media.Alt,
		MediaPath:        media.MediaPath,
		UserID:           media.UserID,
		CreatedAt:        media.CreatedAt,
		ChangedAt:        media.ChangedAt,
		FileSize:         media.FileSize,
		MimeType:         media.MimeType,
		Width:            width,
		Height:           height,
		Duration:         duration,
		OriginalFilename: media.OriginalFilename,
	}
}

func toMediaFromListRow(row db.ListMediaRow) MediaResponse {
	var width, height, duration *int32
	if row.Width != 0 {
		width = &row.Width
	}
	if row.Height != 0 {
		height = &row.Height
	}
	if row.Duration != 0 {
		duration = &row.Duration
	}

	return MediaResponse{
		ID:               row.ID,
		Name:             row.Name,
		Description:      row.Description,
		Alt:              row.Alt,
		MediaPath:        row.MediaPath,
		UserID:           row.UserID,
		CreatedAt:        row.CreatedAt,
		ChangedAt:        row.ChangedAt,
		PostCount:        &row.PostCount,
		FileSize:         row.FileSize,
		MimeType:         row.MimeType,
		Width:            width,
		Height:           height,
		Duration:         duration,
		OriginalFilename: row.OriginalFilename,
	}
}

func toMediaFromUserRow(row db.GetMediaByUserRow) MediaResponse {
	var width, height, duration *int32
	if row.Width != 0 {
		width = &row.Width
	}
	if row.Height != 0 {
		height = &row.Height
	}
	if row.Duration != 0 {
		duration = &row.Duration
	}

	return MediaResponse{
		ID:               row.ID,
		Name:             row.Name,
		Description:      row.Description,
		Alt:              row.Alt,
		MediaPath:        row.MediaPath,
		UserID:           row.UserID,
		CreatedAt:        row.CreatedAt,
		ChangedAt:        row.ChangedAt,
		PostCount:        &row.PostCount,
		FileSize:         row.FileSize,
		MimeType:         row.MimeType,
		Width:            width,
		Height:           height,
		Duration:         duration,
		OriginalFilename: row.OriginalFilename,
	}
}

func toMediaFromSearchRow(row db.SearchMediaByNameRow) MediaResponse {
	var width, height, duration *int32
	if row.Width != 0 {
		width = &row.Width
	}
	if row.Height != 0 {
		height = &row.Height
	}
	if row.Duration != 0 {
		duration = &row.Duration
	}

	return MediaResponse{
		ID:               row.ID,
		Name:             row.Name,
		Description:      row.Description,
		Alt:              row.Alt,
		MediaPath:        row.MediaPath,
		UserID:           row.UserID,
		CreatedAt:        row.CreatedAt,
		ChangedAt:        row.ChangedAt,
		PostCount:        &row.PostCount,
		FileSize:         row.FileSize,
		MimeType:         row.MimeType,
		Width:            width,
		Height:           height,
		Duration:         duration,
		OriginalFilename: row.OriginalFilename,
	}
}

func toPopularMediaResponse(row db.GetPopularMediaRow) PopularMediaResponse {
	var width, height, duration *int32
	if row.Width != 0 {
		width = &row.Width
	}
	if row.Height != 0 {
		height = &row.Height
	}
	if row.Duration != 0 {
		duration = &row.Duration
	}

	return PopularMediaResponse{
		ID:               row.ID,
		Name:             row.Name,
		Description:      row.Description,
		Alt:              row.Alt,
		MediaPath:        row.MediaPath,
		UserID:           row.UserID,
		CreatedAt:        row.CreatedAt,
		ChangedAt:        row.ChangedAt,
		PostCount:        row.PostCount,
		FileSize:         row.FileSize,
		MimeType:         row.MimeType,
		Width:            width,
		Height:           height,
		Duration:         duration,
		OriginalFilename: row.OriginalFilename,
	}
}

func (server *Server) createMedia(c *gin.Context) {

	file, header, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file upload is required"})
		return
	}
	defer file.Close()

	if !isValidMediaType(header.Filename) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file type. Supported: jpg, jpeg, png, gif, mp4, mp3, pdf, svg"})
		return
	}

	maxSize, err := parseFileSize(server.config.MaxUploadSize)
	if err != nil {
		maxSize = 10 << 20
	}

	if header.Size > maxSize {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("file too large. Maximum size is %s", server.config.MaxUploadSize)})
		return
	}

	authPayload := c.MustGet(authorizationPayloadKey).(*token.Payload)
	userID := authPayload.UserID

	var req CreateMediaRequest
	if err := c.ShouldBind(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	mediaPath, actualFilename, err := saveUploadedFileWithOriginalName(file, header, server.config.UploadPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save uploaded file"})
		return
	}

	fileSize := header.Size
	mimeType := getFileMimeType(header.Filename)
	originalFilename := header.Filename

	var width, height int32 = 0, 0
	if isImageFile(header.Filename) {
		fullPath := filepath.Join(".", mediaPath)
		if w, h, err := getImageDimensions(fullPath); err == nil {
			width, height = w, h
		}
	}

	var duration int32 = 0

	if req.PostID != nil {
		var order int32
		if req.Order != nil {
			order = *req.Order
		} else {
			order = 0
		}

		result, err := server.store.CreateMediaAndLinkTx(c.Request.Context(), db.CreateMediaAndLinkTxParams{
			Name:             actualFilename,
			Description:      req.Description,
			Alt:              req.Alt,
			MediaPath:        mediaPath,
			UserID:           userID,
			FileSize:         fileSize,
			MimeType:         mimeType,
			Width:            width,
			Height:           height,
			Duration:         duration,
			OriginalFilename: originalFilename,
			PostID:           *req.PostID,
			Order:            order,
		})
		if err != nil {

			os.Remove(filepath.Join(".", mediaPath))
			if containsString(err.Error(), "post not found") {
				c.JSON(http.StatusBadRequest, gin.H{"error": "post not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create media with post link"})
			return
		}

		c.JSON(http.StatusCreated, gin.H{
			"media":      toMediaResponse(result.Media),
			"post_media": result.PostMedia,
		})
	} else {
		media, err := server.store.CreateMedia(c.Request.Context(), db.CreateMediaParams{
			Name:             actualFilename,
			Description:      req.Description,
			Alt:              req.Alt,
			MediaPath:        mediaPath,
			UserID:           userID,
			FileSize:         fileSize,
			MimeType:         mimeType,
			Width:            width,
			Height:           height,
			Duration:         duration,
			OriginalFilename: originalFilename,
		})
		if err != nil {

			os.Remove(filepath.Join(".", mediaPath))
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create media"})
			return
		}

		c.JSON(http.StatusCreated, gin.H{
			"media": toMediaResponse(media),
		})
	}
}

func (server *Server) createMediaBatch(c *gin.Context) {
	form, err := c.MultipartForm()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to parse multipart form"})
		return
	}

	files := form.File["files"]
	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no files provided"})
		return
	}

	if len(files) > 10 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "maximum 10 files per batch"})
		return
	}

	authPayload := c.MustGet(authorizationPayloadKey).(*token.Payload)
	userID := authPayload.UserID

	var results []gin.H
	var errors []string

	for i, fileHeader := range files {
		file, err := fileHeader.Open()
		if err != nil {
			errors = append(errors, fmt.Sprintf("failed to open file %s: %v", fileHeader.Filename, err))
			continue
		}

		if !isValidMediaType(fileHeader.Filename) {
			file.Close()
			errors = append(errors, fmt.Sprintf("invalid file type for %s", fileHeader.Filename))
			continue
		}

		maxSize, _ := parseFileSize(server.config.MaxUploadSize)
		if maxSize == 0 {
			maxSize = 10 << 20
		}

		if fileHeader.Size > maxSize {
			file.Close()
			errors = append(errors, fmt.Sprintf("file %s too large", fileHeader.Filename))
			continue
		}

		mediaPath, actualFilename, err := saveUploadedFileWithOriginalName(file, fileHeader, server.config.UploadPath)
		file.Close()

		if err != nil {
			errors = append(errors, fmt.Sprintf("failed to save %s: %v", fileHeader.Filename, err))
			continue
		}

		fileSize := fileHeader.Size
		mimeType := getFileMimeType(fileHeader.Filename)
		originalFilename := fileHeader.Filename

		var width, height int32 = 0, 0
		if isImageFile(fileHeader.Filename) {
			fullPath := filepath.Join(".", mediaPath)
			if w, h, err := getImageDimensions(fullPath); err == nil {
				width, height = w, h
			}
		}

		media, err := server.store.CreateMedia(c.Request.Context(), db.CreateMediaParams{
			Name:             actualFilename,
			Description:      fmt.Sprintf("Uploaded file: %s", fileHeader.Filename),
			Alt:              strings.TrimSuffix(fileHeader.Filename, filepath.Ext(fileHeader.Filename)),
			MediaPath:        mediaPath,
			UserID:           userID,
			FileSize:         fileSize,
			MimeType:         mimeType,
			Width:            width,
			Height:           height,
			Duration:         0,
			OriginalFilename: originalFilename,
		})

		if err != nil {
			os.Remove(filepath.Join(".", mediaPath))
			errors = append(errors, fmt.Sprintf("failed to create media record for %s: %v", fileHeader.Filename, err))
			continue
		}

		results = append(results, gin.H{
			"media": toMediaResponse(media),
			"index": i,
		})
	}

	response := gin.H{
		"success_count": len(results),
		"error_count":   len(errors),
		"total":         len(files),
		"media":         results,
	}

	if len(errors) > 0 {
		response["errors"] = errors
	}

	c.JSON(http.StatusCreated, response)
}

func isValidMediaType(filename string) bool {
	ext := strings.ToLower(filepath.Ext(filename))
	validExts := []string{
		".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp",
		".mp4", ".mov", ".avi", ".mkv", ".webm",
		".mp3", ".wav", ".ogg", ".m4a",
		".pdf", ".doc", ".docx", ".txt",
		".svg",
	}

	for _, validExt := range validExts {
		if ext == validExt {
			return true
		}
	}
	return false
}

func saveUploadedFileWithOriginalName(file multipart.File, header *multipart.FileHeader, uploadPath string) (string, string, error) {

	uploadsDir := filepath.Join(".", uploadPath)
	if err := os.MkdirAll(uploadsDir, 0755); err != nil {
		return "", "", err
	}

	originalName := strings.TrimSuffix(header.Filename, filepath.Ext(header.Filename))
	ext := filepath.Ext(header.Filename)

	cleanedName := cleanFilename(originalName)

	filename := fmt.Sprintf("%s%s", cleanedName, ext)
	filePath := filepath.Join(uploadsDir, filename)

	counter := 1
	for fileExists(filePath) {
		filename = fmt.Sprintf("%s_%d%s", cleanedName, counter, ext)
		filePath = filepath.Join(uploadsDir, filename)
		counter++
	}

	dst, err := os.Create(filePath)
	if err != nil {
		return "", "", err
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		return "", "", err
	}

	return fmt.Sprintf("%s/%s", uploadPath, filename), filename, nil
}

func fileExists(filepath string) bool {
	_, err := os.Stat(filepath)
	return !os.IsNotExist(err)
}

func cleanFilename(filename string) string {

	re := regexp.MustCompile(`[^a-zA-Z0-9._-]`)
	cleaned := re.ReplaceAllString(filename, "_")

	re2 := regexp.MustCompile(`_+`)
	cleaned = re2.ReplaceAllString(cleaned, "_")

	cleaned = strings.Trim(cleaned, "_")

	if cleaned == "" {
		cleaned = "untitled"
	}

	if len(cleaned) > 100 {
		cleaned = cleaned[:100]
	}

	return cleaned
}

func getFileMimeType(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	mimeTypes := map[string]string{
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".png":  "image/png",
		".gif":  "image/gif",
		".webp": "image/webp",
		".bmp":  "image/bmp",
		".svg":  "image/svg+xml",
		".mp4":  "video/mp4",
		".mov":  "video/quicktime",
		".avi":  "video/x-msvideo",
		".mkv":  "video/x-matroska",
		".webm": "video/webm",
		".mp3":  "audio/mpeg",
		".wav":  "audio/wav",
		".ogg":  "audio/ogg",
		".m4a":  "audio/mp4",
		".pdf":  "application/pdf",
		".doc":  "application/msword",
		".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".txt":  "text/plain",
	}

	if mimeType, exists := mimeTypes[ext]; exists {
		return mimeType
	}
	return "application/octet-stream"
}

func getImageDimensions(filePath string) (int32, int32, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return 0, 0, err
	}
	defer file.Close()

	config, _, err := image.DecodeConfig(file)
	if err != nil {
		return 0, 0, err
	}

	return int32(config.Width), int32(config.Height), nil
}

func isImageFile(filename string) bool {
	ext := strings.ToLower(filepath.Ext(filename))
	imageExts := []string{".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
	for _, imgExt := range imageExts {
		if ext == imgExt {
			return true
		}
	}
	return false
}

func parseFileSize(sizeStr string) (int64, error) {
	if sizeStr == "" {
		return 10 << 20, nil
	}

	sizeStr = strings.ToUpper(strings.TrimSpace(sizeStr))

	var multiplier int64 = 1
	if strings.HasSuffix(sizeStr, "MB") {
		multiplier = 1 << 20
		sizeStr = strings.TrimSuffix(sizeStr, "MB")
	} else if strings.HasSuffix(sizeStr, "KB") {
		multiplier = 1 << 10
		sizeStr = strings.TrimSuffix(sizeStr, "KB")
	} else if strings.HasSuffix(sizeStr, "GB") {
		multiplier = 1 << 30
		sizeStr = strings.TrimSuffix(sizeStr, "GB")
	}

	size, err := strconv.ParseInt(sizeStr, 10, 64)
	if err != nil {
		return 10 << 20, err
	}

	return size * multiplier, nil
}

func (server *Server) getMediaByID(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid media ID"})
		return
	}

	media, err := server.store.GetMedia(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "media not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get media"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"media": toMediaResponse(media),
	})
}

func (server *Server) getMedia(c *gin.Context) {
	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")
	withCounts := c.DefaultQuery("with_counts", "false")

	fileType := c.Query("type")
	userIDStr := c.Query("user_id")
	search := c.Query("search")
	sortBy := c.DefaultQuery("sort", "date_desc")

	if !isValidSortOption(sortBy) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid sort parameter"})
		return
	}

	limit, err := strconv.ParseInt(limitStr, 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 100 {
		limit = 100
	}

	offset, err := strconv.ParseInt(offsetStr, 10, 32)
	if err != nil || offset < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid offset parameter"})
		return
	}

	// Parse optional user_id filter - use 0 for no filter (matches SQL logic)
	var userID int64 = 0
	if userIDStr != "" {
		uid, err := strconv.ParseInt(userIDStr, 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id parameter"})
			return
		}
		userID = uid
	}

	mimeTypeFilter := getMimeTypeFilter(fileType)

	searchTerm := ""
	if search != "" {
		searchTerm = search
	}

	media, err := server.store.ListMedia(c.Request.Context(), db.ListMediaParams{
		Column1: mimeTypeFilter,
		Column2: userID,
		Column3: searchTerm,
		Column4: sortBy,
		Limit:   int32(limit),
		Offset:  int32(offset),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list media"})
		return
	}

	mediaResponses := make([]MediaResponse, len(media))
	for i, m := range media {
		mediaResponses[i] = toMediaFromListRow(m)
	}

	total, err := server.store.CountTotalMedia(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count total media"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"media": mediaResponses,
		"meta": gin.H{
			"limit":       limit,
			"offset":      offset,
			"count":       len(mediaResponses),
			"total":       total,
			"with_counts": withCounts == "true",
			"filters": gin.H{
				"type":    fileType,
				"user_id": userID,
				"search":  search,
				"sort":    sortBy,
			},
		},
	})
}

func (server *Server) getPopularMedia(c *gin.Context) {
	limitStr := c.DefaultQuery("limit", "10")

	limit, err := strconv.ParseInt(limitStr, 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 50 {
		limit = 50
	}

	media, err := server.store.GetPopularMedia(c.Request.Context(), int32(limit))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get popular media"})
		return
	}

	mediaResponses := make([]PopularMediaResponse, len(media))
	for i, m := range media {
		mediaResponses[i] = toPopularMediaResponse(m)
	}

	c.JSON(http.StatusOK, gin.H{
		"media": mediaResponses,
		"meta": gin.H{
			"limit": limit,
			"count": len(mediaResponses),
		},
	})
}

func (server *Server) searchMedia(c *gin.Context) {
	query := c.Query("q")
	if query == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "search query is required"})
		return
	}

	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")

	fileType := c.Query("type")
	userIDStr := c.Query("user_id")
	sortBy := c.DefaultQuery("sort", "date_desc")

	if !isValidSortOption(sortBy) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid sort parameter"})
		return
	}

	limit, err := strconv.ParseInt(limitStr, 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 100 {
		limit = 100
	}

	offset, err := strconv.ParseInt(offsetStr, 10, 32)
	if err != nil || offset < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid offset parameter"})
		return
	}

	var userID int64 = 0
	if userIDStr != "" {
		uid, err := strconv.ParseInt(userIDStr, 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id parameter"})
			return
		}
		userID = uid
	}

	mimeTypeFilter := getMimeTypeFilter(fileType)

	media, err := server.store.SearchMediaByName(c.Request.Context(), db.SearchMediaByNameParams{
		Column1: sql.NullString{String: query, Valid: true},
		Column2: mimeTypeFilter,
		Column3: userID,
		Column4: sortBy,
		Limit:   int32(limit),
		Offset:  int32(offset),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to search media"})
		return
	}

	mediaResponses := make([]MediaResponse, len(media))
	for i, m := range media {
		mediaResponses[i] = toMediaFromSearchRow(m)
	}

	c.JSON(http.StatusOK, gin.H{
		"media": mediaResponses,
		"meta": gin.H{
			"query":  query,
			"limit":  limit,
			"offset": offset,
			"count":  len(mediaResponses),
			"filters": gin.H{
				"type":    fileType,
				"user_id": userID,
				"sort":    sortBy,
			},
		},
	})
}

func (server *Server) getMediaByUser(c *gin.Context) {
	userIDParam := c.Param("id")
	userID, err := strconv.ParseInt(userIDParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user ID"})
		return
	}

	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")

	fileType := c.Query("type")
	search := c.Query("search")
	sortBy := c.DefaultQuery("sort", "date_desc")

	if !isValidSortOption(sortBy) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid sort parameter"})
		return
	}

	limit, err := strconv.ParseInt(limitStr, 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 100 {
		limit = 100
	}

	offset, err := strconv.ParseInt(offsetStr, 10, 32)
	if err != nil || offset < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid offset parameter"})
		return
	}

	_, err = server.store.GetUser(c.Request.Context(), userID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user"})
		return
	}

	mimeTypeFilter := getMimeTypeFilter(fileType)

	searchTerm := ""
	if search != "" {
		searchTerm = search
	}

	media, err := server.store.GetMediaByUser(c.Request.Context(), db.GetMediaByUserParams{
		UserID:  userID,
		Column2: mimeTypeFilter,
		Column3: searchTerm,
		Column4: sortBy,
		Limit:   int32(limit),
		Offset:  int32(offset),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user media"})
		return
	}

	mediaResponses := make([]MediaResponse, len(media))
	for i, m := range media {
		mediaResponses[i] = toMediaFromUserRow(m)
	}

	c.JSON(http.StatusOK, gin.H{
		"media": mediaResponses,
		"meta": gin.H{
			"user_id": userID,
			"limit":   limit,
			"offset":  offset,
			"count":   len(mediaResponses),
			"filters": gin.H{
				"type":   fileType,
				"search": search,
				"sort":   sortBy,
			},
		},
	})
}

func (server *Server) getMediaByPost(c *gin.Context) {
	postIDParam := c.Param("id")
	postID, err := strconv.ParseInt(postIDParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	post, err := server.store.GetPost(c.Request.Context(), postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	media, err := server.store.GetMediaByPost(c.Request.Context(), postID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post media"})
		return
	}

	mediaResponses := make([]MediaResponse, len(media))
	for i, m := range media {
		mediaResponses[i] = toMediaResponse(m)
	}

	c.JSON(http.StatusOK, gin.H{
		"post":  toPostResponse(post),
		"media": mediaResponses,
		"meta": gin.H{
			"post_id": postID,
			"count":   len(mediaResponses),
		},
	})
}

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
		if err == sql.ErrNoRows {
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
		if err == sql.ErrNoRows {
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

func isValidSortOption(sort string) bool {
	validSorts := []string{
		"date_asc", "date_desc",
		"name_asc", "name_desc",
		"size_asc", "size_desc",
		"type_asc", "type_desc",
		"posts_asc", "posts_desc",
	}

	if sort == "" {
		return true
	}

	for _, valid := range validSorts {
		if sort == valid {
			return true
		}
	}
	return false
}

func getMimeTypeFilter(fileType string) string {
	switch fileType {
	case "image":
		return "image/"
	case "video":
		return "video/"
	case "audio":
		return "audio/"
	case "document":
		return "application/"
	case "text":
		return "text/"
	default:
		return ""
	}
}
