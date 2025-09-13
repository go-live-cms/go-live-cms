// media_presenters.go contains response mappers that convert DB rows to public JSON shapes for media resources.
//
// # Response Strategy
//
// This file transforms internal database models into clean, consistent JSON responses
// for API consumers. It handles optional field mapping, type conversions, and
// maintains backward compatibility for API contracts.
//
// # JSON Field Conventions
//
//   - id: Primary key (int64)
//   - Timestamps: ISO 8601 format (time.Time serializes automatically)
//   - Optional fields: Use pointers, omitempty tags for clean JSON
//   - Paths: Relative format ("uploads/file.jpg") for client URL construction
//   - Counts: Include for listing views, omit for detail views
//
// # URL Construction
//
// media_path field returns relative paths like "uploads/filename.jpg".
// Clients should construct full URLs: http://domain.com/{media_path}
// This allows deployment flexibility and CDN integration.
//
// # Example Response
//
//	{
//	  "id": 123,
//	  "name": "Hero Image",
//	  "description": "Homepage banner",
//	  "alt": "Company logo on blue background",
//	  "media_path": "uploads/hero-image.jpg",
//	  "mime_type": "image/jpeg",
//	  "file_size": 245760,
//	  "width": 1920,
//	  "height": 1080,
//	  "user_id": 456,
//	  "created_at": "2023-01-15T10:30:00Z",
//	  "changed_at": "2023-01-15T10:30:00Z",
//	  "original_filename": "hero-image.jpg"
//	}
package api

import (
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// MediaResponse represents the public JSON structure for media resources.
// Includes file metadata, dimensions, and optional post count for listing views.
//
// Fields with zero values are conditionally included:
//   - width, height, duration: Omitted if zero (not applicable for file type)
//   - post_count: Only included in listing contexts with relationship data
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

// PopularMediaResponse extends MediaResponse with guaranteed post_count field.
// Used by GET /media/popular endpoint where usage statistics are always included
// and represent the core value of the "popular" designation.
type PopularMediaResponse struct {
	ID               int64     `json:"id"`
	Name             string    `json:"name"`
	Description      string    `json:"description"`
	Alt              string    `json:"alt"`
	MediaPath        string    `json:"media_path"`
	UserID           int64     `json:"user_id"`
	CreatedAt        time.Time `json:"created_at"`
	ChangedAt        time.Time `json:"changed_at"`
	PostCount        int64     `json:"post_count"` // Always present, never omitted
	FileSize         int64     `json:"file_size"`
	MimeType         string    `json:"mime_type"`
	Width            *int32    `json:"width,omitempty"`
	Height           *int32    `json:"height,omitempty"`
	Duration         *int32    `json:"duration,omitempty"`
	OriginalFilename string    `json:"original_filename"`
}

// PostWithMediaOrderResponse combines post data with media relationship metadata.
// Used by GET /media/:id/posts to show how media is used within content,
// including display order and relationship type for gallery/attachment features.
type PostWithMediaOrderResponse struct {
	Post             PostResponse `json:"post"`
	MediaOrder       int32        `json:"media_order"`
	RelationshipType string       `json:"relationship_type"`
}

// toMediaResponse converts a database Medium record to the public MediaResponse format.
// Handles optional field mapping for dimensions that may be zero/empty.
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

// toMediaFromListRow converts a ListMediaRow (with post count) to MediaResponse.
// Used by paginated listing endpoints that include relationship statistics.
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

// toMediaFromUserRow converts GetMediaByUserRow to MediaResponse.
// Includes post count statistics for user-specific media listings.
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

// toMediaFromSearchRow converts SearchMediaByNameRow to MediaResponse.
// Used by search endpoints that include post count in results.
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

// toPopularMediaResponse converts GetPopularMediaRow to PopularMediaResponse.
// Post count is always included as it defines the "popularity" ranking.
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

// toPostResponseFromMediaRow converts GetPostsByMediaRow to PostWithMediaOrderResponse.
// Includes media relationship metadata for gallery ordering and attachment types.
func toPostResponseFromMediaRow(row db.GetPostsByMediaRow) PostWithMediaOrderResponse {
	var postParent *int64
	if row.PostParent.Valid {
		postParent = &row.PostParent.Int64
	}

	return PostWithMediaOrderResponse{
		Post: PostResponse{
			ID:          row.ID,
			Title:       row.Title,
			Description: row.Description,
			Content:     row.Content,
			UserID:      row.UserID,
			Username:    row.Username,
			Url:         row.Url,
			PostType:    row.PostType,
			PostStatus:  row.PostStatus,
			PostParent:  postParent,
			MenuOrder:   row.MenuOrder,
			CreatedAt:   row.CreatedAt,
			ChangedAt:   row.ChangedAt,
		},
		MediaOrder:       row.MediaOrder,
		RelationshipType: row.RelationshipType,
	}
}
