// Package api — Posts response presentation structs
//
// Transforms database models into consistent JSON response formats.
// Handles optional meta hydration with multiple levels of detail.
//
// Response Types
//   - PostResponse: Basic post data
//   - PostWithMetaResponse: Post + post-specific meta
//   - PostWithAllMetaResponse: Post + post/author/post-type meta
//   - PostMetaResponse: Individual meta key-value pairs
package api

import (
	"encoding/json"
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// PostResponse provides the standard post data structure for API responses
type PostResponse struct {
	ID              int64                  `json:"id"`
	Title           string                 `json:"title"`
	Description     string                 `json:"description"`
	UserID          int64                  `json:"user_id"`
	Username        string                 `json:"username"`
	Url             string                 `json:"url"`
	PostType        string                 `json:"post_type"`
	PostStatus      string                 `json:"post_status"`
	PostParent      *int64                 `json:"post_parent"`
	MenuOrder       int32                  `json:"menu_order"`
	CreatedAt       time.Time              `json:"created_at"`
	ChangedAt       time.Time              `json:"changed_at"`
	PublishedBlocks map[string]interface{} `json:"published_blocks,omitempty"`
}

// PostWithMetaResponse includes post-specific meta data
type PostWithMetaResponse struct {
	ID              int64                  `json:"id"`
	Title           string                 `json:"title"`
	Description     string                 `json:"description"`
	UserID          int64                  `json:"user_id"`
	Username        string                 `json:"username"`
	Url             string                 `json:"url"`
	PostType        string                 `json:"post_type"`
	PostStatus      string                 `json:"post_status"`
	PostParent      *int64                 `json:"post_parent"`
	MenuOrder       int32                  `json:"menu_order"`
	CreatedAt       time.Time              `json:"created_at"`
	ChangedAt       time.Time              `json:"changed_at"`
	PublishedBlocks map[string]interface{} `json:"published_blocks,omitempty"`
	Meta            map[string]interface{} `json:"meta,omitempty"`
}

// PostWithAllMetaResponse includes post, author, and post-type meta
type PostWithAllMetaResponse struct {
	ID              int64                  `json:"id"`
	Title           string                 `json:"title"`
	Description     string                 `json:"description"`
	UserID          int64                  `json:"user_id"`
	Username        string                 `json:"username"`
	Url             string                 `json:"url"`
	PostType        string                 `json:"post_type"`
	PostStatus      string                 `json:"post_status"`
	PostParent      *int64                 `json:"post_parent"`
	MenuOrder       int32                  `json:"menu_order"`
	CreatedAt       time.Time              `json:"created_at"`
	ChangedAt       time.Time              `json:"changed_at"`
	PublishedBlocks map[string]interface{} `json:"published_blocks,omitempty"`
	PostMeta        map[string]interface{} `json:"post_meta,omitempty"`
	AuthorMeta      map[string]interface{} `json:"author_meta,omitempty"`
	PostTypeMeta    map[string]interface{} `json:"post_type_meta,omitempty"`
}

// PostMetaResponse represents individual meta key-value pair responses
type PostMetaResponse struct {
	ID        int64     `json:"id"`
	PostID    int64     `json:"post_id"`
	MetaKey   string    `json:"meta_key"`
	MetaValue string    `json:"meta_value"`
	CreatedAt time.Time `json:"created_at"`
}

// toPostResponse converts a database Post model to API response format
func toPostResponse(post db.Post) PostResponse {
	var postParent *int64
	if post.PostParent.Valid {
		postParent = &post.PostParent.Int64
	}

	var publishedBlocks map[string]interface{}
	if post.PublishedBlockDoc.Valid {
		json.Unmarshal(post.PublishedBlockDoc.RawMessage, &publishedBlocks)
	}

	return PostResponse{
		ID:              post.ID,
		Title:           post.Title,
		Description:     post.Description,
		UserID:          post.UserID,
		Username:        post.Username,
		Url:             post.Url,
		PostType:        post.PostType,
		PostStatus:      post.PostStatus,
		PostParent:      postParent,
		MenuOrder:       post.MenuOrder,
		CreatedAt:       post.CreatedAt,
		ChangedAt:       post.ChangedAt,
		PublishedBlocks: publishedBlocks,
	}
}

// toPostResponseFromListRow converts a ListPostsRow to API response format
func toPostResponseFromListRow(post db.ListPostsRow) PostResponse {
	var postParent *int64
	if post.PostParent.Valid {
		postParent = &post.PostParent.Int64
	}

	var publishedBlocks map[string]interface{}
	if post.PublishedBlockDoc.Valid {
		json.Unmarshal(post.PublishedBlockDoc.RawMessage, &publishedBlocks)
	}

	return PostResponse{
		ID:              post.ID,
		Title:           post.Title,
		Description:     post.Description,
		UserID:          post.UserID,
		Username:        post.Username,
		Url:             post.Url,
		PostType:        post.PostType,
		PostStatus:      post.PostStatus,
		PostParent:      postParent,
		MenuOrder:       post.MenuOrder,
		CreatedAt:       post.CreatedAt,
		ChangedAt:       post.ChangedAt,
		PublishedBlocks: publishedBlocks,
	}
}

// toPostWithMetaResponse converts ListPostsWithMetaRow to API response with basic meta
func toPostWithMetaResponse(post db.ListPostsWithMetaRow) PostWithMetaResponse {
	var postParent *int64
	if post.PostParent.Valid {
		postParent = &post.PostParent.Int64
	}

	metaMap := make(map[string]interface{})
	if post.Meta != nil {
		if metaBytes, ok := post.Meta.([]byte); ok {
			json.Unmarshal(metaBytes, &metaMap)
		}
	}

	var publishedBlocks map[string]interface{}
	if post.PublishedBlockDoc.Valid {
		json.Unmarshal(post.PublishedBlockDoc.RawMessage, &publishedBlocks)
	}

	return PostWithMetaResponse{
		ID:              post.ID,
		Title:           post.Title,
		Description:     post.Description,
		UserID:          post.UserID,
		Username:        post.Username,
		Url:             post.Url,
		PostType:        post.PostType,
		PostStatus:      post.PostStatus,
		PostParent:      postParent,
		MenuOrder:       post.MenuOrder,
		CreatedAt:       post.CreatedAt,
		ChangedAt:       post.ChangedAt,
		PublishedBlocks: publishedBlocks,
		Meta:            metaMap,
	}
}

// toPostWithAllMetaResponse converts ListPostsWithAllMetaRow to API response with full meta
func toPostWithAllMetaResponse(post db.ListPostsWithAllMetaRow) PostWithAllMetaResponse {
	var postParent *int64
	if post.PostParent.Valid {
		postParent = &post.PostParent.Int64
	}

	postMetaMap := make(map[string]interface{})
	if post.PostMeta != nil {
		if metaBytes, ok := post.PostMeta.([]byte); ok {
			json.Unmarshal(metaBytes, &postMetaMap)
		}
	}

	authorMetaMap := make(map[string]interface{})
	if len(post.AuthorMeta) > 0 {
		json.Unmarshal(post.AuthorMeta, &authorMetaMap)
	}

	postTypeMetaMap := make(map[string]interface{})
	if len(post.PostTypeMeta) > 0 {
		json.Unmarshal(post.PostTypeMeta, &postTypeMetaMap)
	}

	var publishedBlocks map[string]interface{}
	if post.PublishedBlockDoc.Valid {
		json.Unmarshal(post.PublishedBlockDoc.RawMessage, &publishedBlocks)
	}

	return PostWithAllMetaResponse{
		ID:              post.ID,
		Title:           post.Title,
		Description:     post.Description,
		UserID:          post.UserID,
		Username:        post.Username,
		Url:             post.Url,
		PostType:        post.PostType,
		PostStatus:      post.PostStatus,
		PostParent:      postParent,
		MenuOrder:       post.MenuOrder,
		CreatedAt:       post.CreatedAt,
		ChangedAt:       post.ChangedAt,
		PublishedBlocks: publishedBlocks,
		PostMeta:        postMetaMap,
		AuthorMeta:      authorMetaMap,
		PostTypeMeta:    postTypeMetaMap,
	}
}

// toPostWithMetaResponseFromTypeQuery converts ListPostsByTypeWithMetaRow for typed queries
func toPostWithMetaResponseFromTypeQuery(post db.ListPostsByTypeWithMetaRow) PostWithMetaResponse {
	var postParent *int64
	if post.PostParent.Valid {
		postParent = &post.PostParent.Int64
	}

	metaMap := make(map[string]interface{})
	if post.Meta != nil {
		if metaBytes, ok := post.Meta.([]byte); ok {
			json.Unmarshal(metaBytes, &metaMap)
		}
	}

	var publishedBlocks map[string]interface{}
	if post.PublishedBlockDoc.Valid {
		json.Unmarshal(post.PublishedBlockDoc.RawMessage, &publishedBlocks)
	}

	return PostWithMetaResponse{
		ID:              post.ID,
		Title:           post.Title,
		Description:     post.Description,
		UserID:          post.UserID,
		Username:        post.Username,
		Url:             post.Url,
		PostType:        post.PostType,
		PostStatus:      post.PostStatus,
		PostParent:      postParent,
		MenuOrder:       post.MenuOrder,
		CreatedAt:       post.CreatedAt,
		ChangedAt:       post.ChangedAt,
		PublishedBlocks: publishedBlocks,
		Meta:            metaMap,
	}
}

// toPostWithAllMetaResponseFromTypeQuery converts ListPostsByTypeWithAllMetaRow for typed queries with full meta
func toPostWithAllMetaResponseFromTypeQuery(post db.ListPostsByTypeWithAllMetaRow) PostWithAllMetaResponse {
	var postParent *int64
	if post.PostParent.Valid {
		postParent = &post.PostParent.Int64
	}

	postMetaMap := make(map[string]interface{})
	if post.PostMeta != nil {
		if metaBytes, ok := post.PostMeta.([]byte); ok {
			json.Unmarshal(metaBytes, &postMetaMap)
		}
	}

	authorMetaMap := make(map[string]interface{})
	if len(post.AuthorMeta) > 0 {
		json.Unmarshal(post.AuthorMeta, &authorMetaMap)
	}

	postTypeMetaMap := make(map[string]interface{})
	if len(post.PostTypeMeta) > 0 {
		json.Unmarshal(post.PostTypeMeta, &postTypeMetaMap)
	}

	var publishedBlocks map[string]interface{}
	if post.PublishedBlockDoc.Valid {
		json.Unmarshal(post.PublishedBlockDoc.RawMessage, &publishedBlocks)
	}

	return PostWithAllMetaResponse{
		ID:              post.ID,
		Title:           post.Title,
		Description:     post.Description,
		UserID:          post.UserID,
		Username:        post.Username,
		Url:             post.Url,
		PostType:        post.PostType,
		PostStatus:      post.PostStatus,
		PostParent:      postParent,
		MenuOrder:       post.MenuOrder,
		CreatedAt:       post.CreatedAt,
		ChangedAt:       post.ChangedAt,
		PublishedBlocks: publishedBlocks,
		PostMeta:        postMetaMap,
		AuthorMeta:      authorMetaMap,
		PostTypeMeta:    postTypeMetaMap,
	}
}

// toPostMetaResponse converts a PostMetum model to API response format
func toPostMetaResponse(meta db.PostMetum) PostMetaResponse {
	metaValue := ""
	if meta.MetaValue.Valid {
		metaValue = meta.MetaValue.String
	}

	return PostMetaResponse{
		ID:        meta.ID,
		PostID:    meta.PostID,
		MetaKey:   meta.MetaKey,
		MetaValue: metaValue,
		CreatedAt: meta.CreatedAt,
	}
}
