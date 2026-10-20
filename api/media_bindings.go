// media_bindings.go contains request binding structs and validation for media endpoints.
//
// # Request Types
//
// This file defines the data transfer objects (DTOs) for media API requests,
// including validation rules and field constraints to ensure data integrity.
//
// # Validation Strategy
//
//   - Form binding for multipart uploads (CreateMediaRequest)
//   - JSON binding for metadata updates (UpdateMediaRequest)
//   - Field length limits prevent database overflow
//   - Required field validation ensures complete records
//   - Optional fields support partial updates
//
// # Error Handling
//
// Binding errors return structured JSON responses:
//
//	{"error": "validation message"}
//
// Common validation failures:
//   - Missing required fields (name, description, alt, file)
//   - Field length violations (min/max character limits)
//   - Invalid data types or formats
package api

import "encoding/json"

// CreateMediaRequest defines the multipart form data structure for media uploads.
// Used with POST /media for single file uploads with optional post linking.
//
// # Required Fields
//   - name: Display name (2-255 characters)
//   - description: Content description (5-500 characters)
//   - alt: Accessibility text (2-255 characters)
//   - file: The uploaded file (handled separately via c.Request.FormFile)
//
// # Optional Fields
//   - post_id: Link media to existing post
//   - order: Display order when linked to post (default: 0)
//
// # Example Usage
//   curl -X POST /api/v1/media \
//     -F "file=@image.jpg" \
//     -F "name=Hero Image" \
//     -F "description=Homepage banner image" \
//     -F "alt=Company logo on blue background" \
//     -F "post_id=123" \
//     -F "order=1"
type CreateMediaRequest struct {
	Name        string `form:"name" binding:"required,min=2,max=255"`
	Description string `form:"description" binding:"required,min=5,max=500"`
	Alt         string `form:"alt" binding:"required,min=2,max=255"`
	PostID      *int64 `form:"post_id" binding:"omitempty"`
	Order       *int32 `form:"order" binding:"omitempty,min=0"`
}

// UpdateMediaRequest defines JSON structure for updating media metadata via PUT /media/:id.
// All fields are optional for partial updates - only provided fields are modified.
//
// # Supported Updates
//   - Metadata: name, description, alt text
//
// # Server-Owned Fields
//
// media_path, file_size, mime_type, width, height, duration and
// original_filename describe the stored file and are set on upload. They are
// decoded here only so a request that sets them can be rejected with 400
// (see serverOwnedFields): pointing one row's media_path at another row's file
// would let deleting the first row remove the shared file, and the rest could
// fake the file's metadata.
//
// # Validation Rules
//   - String fields have min/max length constraints when provided
//   - Empty/null values are ignored (no update performed)
//
// # Example Usage
//   curl -X PUT /api/v1/media/123 \
//     -H "Content-Type: application/json" \
//     -d '{"name": "Updated Hero Image", "alt": "New description"}'
type UpdateMediaRequest struct {
	Name        string `json:"name" binding:"omitempty,min=2,max=255"`
	Description string `json:"description" binding:"omitempty,min=5,max=500"`
	Alt         string `json:"alt" binding:"omitempty,min=2,max=255"`

	MediaPath        json.RawMessage `json:"media_path"`
	FileSize         json.RawMessage `json:"file_size"`
	MimeType         json.RawMessage `json:"mime_type"`
	Width            json.RawMessage `json:"width"`
	Height           json.RawMessage `json:"height"`
	Duration         json.RawMessage `json:"duration"`
	OriginalFilename json.RawMessage `json:"original_filename"`
}

// serverOwnedFields returns the JSON names of the server-owned file fields the
// request sets (null counts as unset), in a stable order.
func (req UpdateMediaRequest) serverOwnedFields() []string {
	fields := []struct {
		name string
		raw  json.RawMessage
	}{
		{"media_path", req.MediaPath},
		{"file_size", req.FileSize},
		{"mime_type", req.MimeType},
		{"width", req.Width},
		{"height", req.Height},
		{"duration", req.Duration},
		{"original_filename", req.OriginalFilename},
	}

	var set []string
	for _, f := range fields {
		if len(f.raw) > 0 && string(f.raw) != "null" {
			set = append(set, f.name)
		}
	}
	return set
}
