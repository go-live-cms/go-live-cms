// Package api — Posts request binding structs
//
// Defines JSON binding structs for post creation, updates, meta operations,
// and featured image management.
//
// Validation Rules
//   - Title: 3-255 chars, required for create
//   - Description: 10-500 chars, required for create
//   - URL: absolute http(s) URL up to 2048 chars, required for create
//   - PostType: a post type name, max 50, no slashes (existing types may
//     predate the identifier pattern createPostType enforces)
//   - Slug: optional, up to 255; normalized (normalizePostSlug) and made
//     unique (-2, -3, ...) rather than rejected, so no `slug` format tag
//   - PostStatus: draft|published|archived enum
//   - AuthorIDs: 1-20 ids, required for create
//   - MediaIDs/TaxonomyIDs: up to 500 ids
//   - Meta: key 1-255 chars of [A-Za-z0-9._:-], value up to 64 KiB
//
// Unknown fields are rejected (bindJSON), except "content": the admin post
// form still sends its HTML editor content, which the API never stored (the
// body lives in the block document), so it is accepted and ignored.
package api

import "encoding/json"

// CreatePostRequest defines the JSON structure for POST /posts
type CreatePostRequest struct {
	Title       string  `json:"title" binding:"required,min=3,max=255"`
	Description string  `json:"description" binding:"required,min=10,max=500"`
	Url         string  `json:"url" binding:"required,max=2048,http_url"`
	Slug        string  `json:"slug" binding:"omitempty,max=255"`
	PostType    string  `json:"post_type" binding:"omitempty,max=50,excludesall=/\\"`
	PostStatus  string  `json:"post_status" binding:"omitempty,oneof=draft published archived"`
	PostParent  *int64  `json:"post_parent" binding:"omitempty"`
	MenuOrder   int32   `json:"menu_order" binding:"omitempty"`
	AuthorIDs   []int64 `json:"author_ids" binding:"required,min=1,max=20"`
	MediaIDs    []int64 `json:"media_ids" binding:"omitempty,max=500"`
	TaxonomyIDs []int64 `json:"taxonomy_ids" binding:"omitempty,max=500"`

	// BlockDoc is the initial body (optional). Under COLLAB_BACKEND=hocuspocus
	// PUT /posts/:id/blocks is refused, so the admin sends a new post's body
	// here and the collab server seeds the live doc from it (#206, #283). It
	// gets the same checks as PUT /blocks (prepareForStore).
	BlockDoc *BlockDocV1 `json:"block_doc"`

	// Content is accepted for the admin form's sake and ignored (see above).
	Content json.RawMessage `json:"content"`
}

// UpdatePostRequest defines the JSON structure for PUT /posts/:id
type UpdatePostRequest struct {
	Title       string  `json:"title" binding:"omitempty,min=3,max=255"`
	Description string  `json:"description" binding:"omitempty,min=10,max=500"`
	Url         string  `json:"url" binding:"omitempty,max=2048,http_url"`
	Slug        string  `json:"slug" binding:"omitempty,max=255"`
	PostType    string  `json:"post_type" binding:"omitempty,max=50,excludesall=/\\"`
	PostStatus  string  `json:"post_status" binding:"omitempty,oneof=draft published archived"`
	PostParent  *int64  `json:"post_parent" binding:"omitempty"`
	MenuOrder   int32   `json:"menu_order" binding:"omitempty"`
	MediaIDs    []int64 `json:"media_ids" binding:"omitempty,max=500"`
	TaxonomyIDs []int64 `json:"taxonomy_ids" binding:"omitempty,max=500"`

	// Content is accepted for the admin form's sake and ignored (see above).
	Content json.RawMessage `json:"content"`
}

// CreatePostMetaRequest defines the JSON structure for POST /posts/:id/meta
type CreatePostMetaRequest struct {
	MetaKey   string `json:"meta_key" binding:"required,min=1,max=255,setting_key"`
	MetaValue string `json:"meta_value" binding:"required,max_bytes=65536"`
}

// SetFeaturedImageRequest defines the JSON structure for POST /posts/:id/featured-image
//
// MediaPath is accepted because the admin sends the media row's own path, but
// it is ignored: the stored thumbnail URL always comes from the media row, so
// a client can't point a post's featured image at an arbitrary URL.
type SetFeaturedImageRequest struct {
	MediaID   int64  `json:"media_id" binding:"required"`
	MediaPath string `json:"media_path" binding:"max=2048"`
}

// PostMediaRequest defines the JSON structure for POST /posts/:id/media
type PostMediaRequest struct {
	MediaID int64 `json:"media_id" binding:"required"`
	Order   int32 `json:"order" binding:"min=0"`
}
