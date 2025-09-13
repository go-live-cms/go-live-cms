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
//   - File properties: media_path, file_size, mime_type
//   - Media dimensions: width, height, duration
//   - Original filename reference
//
// # Validation Rules
//   - String fields have min/max length constraints when provided
//   - Numeric fields must be non-negative when provided
//   - Empty/null values are ignored (no update performed)
//
// # Security Notes
//   - media_path updates should be restricted in production
//   - file_size/mime_type changes don't affect actual file
//   - Consider permission checks for sensitive field updates
//
// # Example Usage
//   curl -X PUT /api/v1/media/123 \
//     -H "Content-Type: application/json" \
//     -d '{"name": "Updated Hero Image", "alt": "New description"}'
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
