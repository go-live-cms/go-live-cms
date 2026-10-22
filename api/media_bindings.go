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

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
)

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
//
//	curl -X POST /api/v1/media \
//	  -F "file=@image.jpg" \
//	  -F "name=Hero Image" \
//	  -F "description=Homepage banner image" \
//	  -F "alt=Company logo on blue background" \
//	  -F "post_id=123" \
//	  -F "order=1"
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
//   - focal_point: {"x", "y"} in 0..1, or null to clear it
//
// # Server-Owned Fields
//
// media_path, file_size, mime_type, width, height, duration,
// original_filename and variants describe the stored file and are set on
// upload. They are
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
//
//	curl -X PUT /api/v1/media/123 \
//	  -H "Content-Type: application/json" \
//	  -d '{"name": "Updated Hero Image", "alt": "New description"}'
type UpdateMediaRequest struct {
	Name        string `json:"name" binding:"omitempty,min=2,max=255"`
	Description string `json:"description" binding:"omitempty,min=5,max=500"`
	Alt         string `json:"alt" binding:"omitempty,min=2,max=255"`

	// FocalPoint is {"x": 0..1, "y": 0..1} to set it, null to clear it, or
	// absent to keep it (see focalPointUpdate).
	FocalPoint json.RawMessage `json:"focal_point"`

	MediaPath        json.RawMessage `json:"media_path"`
	FileSize         json.RawMessage `json:"file_size"`
	MimeType         json.RawMessage `json:"mime_type"`
	Width            json.RawMessage `json:"width"`
	Height           json.RawMessage `json:"height"`
	Duration         json.RawMessage `json:"duration"`
	OriginalFilename json.RawMessage `json:"original_filename"`
	Variants         json.RawMessage `json:"variants"`
}

// FocalPoint is a point of interest in an image, as fractions of its width
// and height from the top-left corner (0..1).
type FocalPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

var errInvalidFocalPoint = errors.New(`focal_point must be {"x": 0..1, "y": 0..1} or null`)

// focalPointUpdate interprets the focal_point field: set reports whether the
// request changes it, and point is the new value (nil clears it).
func (req UpdateMediaRequest) focalPointUpdate() (set bool, point *FocalPoint, err error) {
	if len(req.FocalPoint) == 0 {
		return false, nil, nil
	}
	if string(req.FocalPoint) == "null" {
		return true, nil, nil
	}
	var raw struct {
		X *float64 `json:"x"`
		Y *float64 `json:"y"`
	}
	dec := json.NewDecoder(bytes.NewReader(req.FocalPoint))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&raw); err != nil || raw.X == nil || raw.Y == nil {
		return false, nil, errInvalidFocalPoint
	}
	if !validFocalCoordinate(*raw.X) || !validFocalCoordinate(*raw.Y) {
		return false, nil, errInvalidFocalPoint
	}
	return true, &FocalPoint{X: *raw.X, Y: *raw.Y}, nil
}

func validFocalCoordinate(v float64) bool {
	return !math.IsNaN(v) && v >= 0 && v <= 1
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
		{"variants", req.Variants},
	}

	var set []string
	for _, f := range fields {
		if len(f.raw) > 0 && string(f.raw) != "null" {
			set = append(set, f.name)
		}
	}
	return set
}
