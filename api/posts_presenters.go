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
	"database/sql"
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
	Slug            string                 `json:"slug"`
	PostType        string                 `json:"post_type"`
	PostStatus      string                 `json:"post_status"`
	PostParent      *int64                 `json:"post_parent"`
	MenuOrder       int32                  `json:"menu_order"`
	CreatedAt       time.Time              `json:"created_at"`
	ChangedAt       time.Time              `json:"changed_at"`
	PublishedBlocks map[string]interface{} `json:"published_blocks,omitempty"`
	// HasUnpublishedChanges (#326): published, and the working copy (body or
	// settings) differs from what the site shows. Lists and GET /posts/:id set it;
	// omitted when false.
	HasUnpublishedChanges bool `json:"has_unpublished_changes,omitempty"`
	// SEO is the working SEO settings (#357), the admin's; the public site gets
	// the published ones (publicPostView.SEO), never these.
	SEO *PostSEOResponse `json:"seo,omitempty"`
	// PublishAt is when a scheduled post publishes (#147), in UTC; null unless
	// post_status is "scheduled".
	PublishAt *time.Time `json:"publish_at"`
	// ScheduleFailure is the last failed attempt to publish it on schedule,
	// while it is still scheduled (the editor's "Scheduled publish failed").
	ScheduleFailure *ScheduleFailureResponse `json:"schedule_failure,omitempty"`
}

// ScheduleFailureResponse says why a scheduled post isn't live yet (#147) and
// when the scheduler tries again.
type ScheduleFailureResponse struct {
	FailedAt time.Time `json:"failed_at"`
	// Reason is a code: scheduledPublishCollabFlushFailed or
	// scheduledPublishFailed (scheduled_publish.go).
	Reason   string `json:"reason"`
	Attempts int32  `json:"attempts"`
	// NextAttemptAt is the next try (it may already be in progress).
	NextAttemptAt *time.Time `json:"next_attempt_at"`
}

// PostWithMetaResponse includes post-specific meta data
type PostWithMetaResponse struct {
	ID              int64                  `json:"id"`
	Title           string                 `json:"title"`
	Description     string                 `json:"description"`
	UserID          int64                  `json:"user_id"`
	Username        string                 `json:"username"`
	Url             string                 `json:"url"`
	Slug            string                 `json:"slug"`
	PostType        string                 `json:"post_type"`
	PostStatus      string                 `json:"post_status"`
	PostParent      *int64                 `json:"post_parent"`
	MenuOrder       int32                  `json:"menu_order"`
	CreatedAt       time.Time              `json:"created_at"`
	ChangedAt       time.Time              `json:"changed_at"`
	PublishedBlocks map[string]interface{} `json:"published_blocks,omitempty"`
	// PublishAt as in PostResponse: the list's "Scheduled · Nov 3" pill (#147).
	PublishAt *time.Time             `json:"publish_at"`
	Meta      map[string]interface{} `json:"meta,omitempty"`
	// Every credited author (user_posts), in byline order (#340).
	Authors []PostAuthorResponse `json:"authors"`
	// HasUnpublishedChanges (#326): published, and the working copy (body or
	// settings) differs from what the site shows. Lists and GET /posts/:id set it;
	// omitted when false.
	HasUnpublishedChanges bool `json:"has_unpublished_changes,omitempty"`
}

// PostAuthorResponse is one byline entry: public fields only.
type PostAuthorResponse struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	FullName string `json:"full_name"`
}

// PostWithAllMetaResponse includes post, author, and post-type meta
type PostWithAllMetaResponse struct {
	ID              int64                  `json:"id"`
	Title           string                 `json:"title"`
	Description     string                 `json:"description"`
	UserID          int64                  `json:"user_id"`
	Username        string                 `json:"username"`
	Url             string                 `json:"url"`
	Slug            string                 `json:"slug"`
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
	// HasUnpublishedChanges (#326): published, and the working copy (body or
	// settings) differs from what the site shows. Lists and GET /posts/:id set it;
	// omitted when false.
	HasUnpublishedChanges bool `json:"has_unpublished_changes,omitempty"`
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
		decodeJSONBestEffort(post.PublishedBlockDoc.RawMessage, &publishedBlocks)
	}

	return PostResponse{
		ID:              post.ID,
		Title:           post.Title,
		Description:     post.Description,
		UserID:          post.UserID,
		Username:        post.Username,
		Url:             post.Url,
		Slug:            post.Slug,
		PostType:        post.PostType,
		PostStatus:      post.PostStatus,
		PostParent:      postParent,
		MenuOrder:       post.MenuOrder,
		CreatedAt:       post.CreatedAt,
		ChangedAt:       post.ChangedAt,
		PublishedBlocks: publishedBlocks,
		SEO:             toPostSEOResponse(post),
		PublishAt:       nullTimePtr(post.PublishAt),
		ScheduleFailure: scheduleFailure(post),
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
		decodeJSONBestEffort(post.PublishedBlockDoc.RawMessage, &publishedBlocks)
	}

	return PostResponse{
		ID:                    post.ID,
		Title:                 post.Title,
		Description:           post.Description,
		UserID:                post.UserID,
		Username:              post.Username,
		Url:                   post.Url,
		Slug:                  post.Slug,
		PostType:              post.PostType,
		PostStatus:            post.PostStatus,
		PostParent:            postParent,
		MenuOrder:             post.MenuOrder,
		CreatedAt:             post.CreatedAt,
		ChangedAt:             post.ChangedAt,
		PublishedBlocks:       publishedBlocks,
		HasUnpublishedChanges: post.HasUnpublishedChanges,
		PublishAt:             nullTimePtr(post.PublishAt),
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
			decodeJSONBestEffort(metaBytes, &metaMap)
		}
	}

	var publishedBlocks map[string]interface{}
	if post.PublishedBlockDoc.Valid {
		decodeJSONBestEffort(post.PublishedBlockDoc.RawMessage, &publishedBlocks)
	}

	return PostWithMetaResponse{
		ID:              post.ID,
		Title:           post.Title,
		Description:     post.Description,
		UserID:          post.UserID,
		Username:        post.Username,
		Url:             post.Url,
		Slug:            post.Slug,
		PostType:        post.PostType,
		PostStatus:      post.PostStatus,
		PostParent:      postParent,
		MenuOrder:       post.MenuOrder,
		CreatedAt:       post.CreatedAt,
		ChangedAt:       post.ChangedAt,
		PublishedBlocks: publishedBlocks,
		PublishAt:       nullTimePtr(post.PublishAt),
		Meta:            metaMap,
		Authors:         decodePostAuthors(post.Authors),

		HasUnpublishedChanges: post.HasUnpublishedChanges,
	}
}

// toPublicPostWithMetaResponse is toPostWithMetaResponse for the public site:
// the post's published title, excerpt and featured image (#358).
func toPublicPostWithMetaResponse(post db.ListPostsWithMetaRow) PostWithMetaResponse {
	resp := toPostWithMetaResponse(post)
	// The working copy is the admin's business.
	resp.HasUnpublishedChanges = false
	applyPublishedSettings(&resp, post.PublishedSettings)
	return resp
}

// nullTimePtr is a nullable timestamp for a response, in UTC.
func nullTimePtr(t sql.NullTime) *time.Time {
	if !t.Valid {
		return nil
	}
	utc := t.Time.UTC()
	return &utc
}

// scheduleFailure is a scheduled post's last failed publish attempt, or nil.
func scheduleFailure(post db.Post) *ScheduleFailureResponse {
	if post.PostStatus != postStatusScheduled || !post.PublishFailedAt.Valid {
		return nil
	}
	return &ScheduleFailureResponse{
		FailedAt:      post.PublishFailedAt.Time.UTC(),
		Reason:        post.PublishError.String,
		Attempts:      post.PublishAttempts,
		NextAttemptAt: nullTimePtr(post.PublishNextAttemptAt),
	}
}

// decodePostAuthors reads the authors column; [] when it's empty or invalid.
func decodePostAuthors(data []byte) []PostAuthorResponse {
	var authors []PostAuthorResponse
	decodeJSONBestEffort(data, &authors)
	if authors == nil {
		return []PostAuthorResponse{}
	}
	return authors
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
			decodeJSONBestEffort(metaBytes, &postMetaMap)
		}
	}

	authorMetaMap := make(map[string]interface{})
	if len(post.AuthorMeta) > 0 {
		decodeJSONBestEffort(post.AuthorMeta, &authorMetaMap)
	}

	postTypeMetaMap := make(map[string]interface{})
	if len(post.PostTypeMeta) > 0 {
		decodeJSONBestEffort(post.PostTypeMeta, &postTypeMetaMap)
	}

	var publishedBlocks map[string]interface{}
	if post.PublishedBlockDoc.Valid {
		decodeJSONBestEffort(post.PublishedBlockDoc.RawMessage, &publishedBlocks)
	}

	return PostWithAllMetaResponse{
		ID:              post.ID,
		Title:           post.Title,
		Description:     post.Description,
		UserID:          post.UserID,
		Username:        post.Username,
		Url:             post.Url,
		Slug:            post.Slug,
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

		HasUnpublishedChanges: post.HasUnpublishedChanges,
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

// decodeJSONBestEffort decodes stored JSON (published blocks, meta) for a
// response. A malformed value leaves v empty or partially filled instead of
// failing the whole response, so the error is deliberately ignored.
func decodeJSONBestEffort(data []byte, v any) {
	_ = json.Unmarshal(data, v)
}
