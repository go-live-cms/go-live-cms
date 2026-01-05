// Package api — Posts request binding structs
//
// Defines JSON binding structs for post creation, updates, meta operations,
// and featured image management.
//
// Validation Rules
//   - Title: 3-255 chars, required for create
//   - Content: min 10 chars, required for create
//   - Description: 10-500 chars, required for create
//   - URL: valid URL format, required for create
//   - AuthorIDs: min 1 author required for create
//   - PostStatus: draft|published|archived enum
package api

// CreatePostRequest defines the JSON structure for POST /posts
type CreatePostRequest struct {
	Title       string  `json:"title" binding:"required,min=3,max=255"`
	Description string  `json:"description" binding:"required,min=10,max=500"`
	Url         string  `json:"url" binding:"required,url"`
	PostType    string  `json:"post_type" binding:"omitempty"`
	PostStatus  string  `json:"post_status" binding:"omitempty,oneof=draft published archived"`
	PostParent  *int64  `json:"post_parent" binding:"omitempty"`
	MenuOrder   int32   `json:"menu_order" binding:"omitempty"`
	AuthorIDs   []int64 `json:"author_ids" binding:"required,min=1"`
	MediaIDs    []int64 `json:"media_ids" binding:"omitempty"`
	TaxonomyIDs []int64 `json:"taxonomy_ids" binding:"omitempty"`
}

// UpdatePostRequest defines the JSON structure for PUT /posts/:id
type UpdatePostRequest struct {
	Title       string  `json:"title" binding:"omitempty,min=3,max=255"`
	Description string  `json:"description" binding:"omitempty,min=10,max=500"`
	Url         string  `json:"url" binding:"omitempty,url"`
	PostType    string  `json:"post_type" binding:"omitempty"`
	PostStatus  string  `json:"post_status" binding:"omitempty,oneof=draft published archived"`
	PostParent  *int64  `json:"post_parent" binding:"omitempty"`
	MenuOrder   int32   `json:"menu_order" binding:"omitempty"`
	MediaIDs    []int64 `json:"media_ids" binding:"omitempty"`
	TaxonomyIDs []int64 `json:"taxonomy_ids" binding:"omitempty"`
}

// CreatePostMetaRequest defines the JSON structure for POST /posts/:id/meta
type CreatePostMetaRequest struct {
	MetaKey   string `json:"meta_key" binding:"required,min=1,max=255"`
	MetaValue string `json:"meta_value" binding:"required"`
}

// SetFeaturedImageRequest defines the JSON structure for POST /posts/:id/featured-image
type SetFeaturedImageRequest struct {
	MediaID   int64  `json:"media_id" binding:"required"`
	MediaPath string `json:"media_path"`
}

// PostMediaRequest defines the JSON structure for POST /posts/:id/media
type PostMediaRequest struct {
	MediaID int64 `json:"media_id" binding:"required"`
	Order   int32 `json:"order"`
}
