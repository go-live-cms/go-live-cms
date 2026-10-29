// Package api — Older/newer and related posts for the public post page (#351)
//
// Routes (public group, for SSR):
//   - GET /public/posts/:id/adjacent: {previous, next}, the published posts of the
//     same type just before and after this one by publish date (null at either end)
//   - GET /public/posts/:id/related?limit=3&taxonomy=: up to limit published posts
//     of the same type sharing the most terms (categories first, then tags), newest
//     first. Without taxonomy the latest posts fill in when fewer share a term; with
//     one (e.g. taxonomy=category, the sidebar's "In <category>") only that
//     taxonomy's terms count and nothing fills in.
//
// Both 404 unless the post exists and is published, like /public/posts/:id/blocks.
// The rows carry meta and authors like a with_meta list row, so the theme renders
// them with the same list components.
package api

import (
	"database/sql"
	"net/http"
	"regexp"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

const (
	relatedPostsDefaultLimit = 3
	relatedPostsMaxLimit     = 12
)

// A taxonomy type name as the API creates them (lowercase identifier).
var relatedTaxonomyPattern = regexp.MustCompile(`^[a-z0-9_-]{1,64}$`)

// RelatedPostResponse is a with_meta list row plus how many terms it shares.
type RelatedPostResponse struct {
	PostWithMetaResponse
	SharedCategories int32 `json:"shared_categories"`
	SharedTags       int32 `json:"shared_tags"`
}

// publishedPostForRelated loads the post and answers 400/404/500 itself; ok is false
// when it did.
func (server *Server) publishedPostForRelated(c *gin.Context) (db.Post, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return db.Post{}, false
	}
	post, err := server.store.GetPost(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return db.Post{}, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return db.Post{}, false
	}
	// Drafts and archived posts have no public page, so nothing links from them.
	if post.PostStatus != "published" {
		c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		return db.Post{}, false
	}
	return post, true
}

// getAdjacentPosts handles GET /public/posts/:id/adjacent
func (server *Server) getAdjacentPosts(c *gin.Context) {
	post, ok := server.publishedPostForRelated(c)
	if !ok {
		return
	}
	rows, err := server.store.ListAdjacentPosts(c.Request.Context(), db.ListAdjacentPostsParams{
		PostType:  post.PostType,
		CreatedAt: post.CreatedAt,
		PostID:    post.ID,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get adjacent posts"})
		return
	}

	var previous, next *PostWithMetaResponse
	for _, row := range rows {
		resp := toAdjacentPostResponse(row)
		switch row.Direction {
		case "previous":
			previous = &resp
		case "next":
			next = &resp
		}
	}
	c.JSON(http.StatusOK, gin.H{"previous": previous, "next": next})
}

// getRelatedPosts handles GET /public/posts/:id/related
func (server *Server) getRelatedPosts(c *gin.Context) {
	limit := int64(relatedPostsDefaultLimit)
	if s := c.Query("limit"); s != "" {
		n, err := strconv.ParseInt(s, 10, 32)
		if err != nil || n <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
			return
		}
		limit = min(n, relatedPostsMaxLimit)
	}
	taxonomy := c.Query("taxonomy")
	if taxonomy != "" && !relatedTaxonomyPattern.MatchString(taxonomy) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid taxonomy parameter"})
		return
	}

	post, ok := server.publishedPostForRelated(c)
	if !ok {
		return
	}
	rows, err := server.store.ListRelatedPosts(c.Request.Context(), db.ListRelatedPostsParams{
		PostType:     post.PostType,
		PostID:       post.ID,
		LimitCount:   int32(limit),
		Taxonomy:     taxonomy,
		WithFallback: taxonomy == "",
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get related posts"})
		return
	}

	posts := make([]RelatedPostResponse, len(rows))
	for i, row := range rows {
		posts[i] = toRelatedPostResponse(row)
	}
	c.JSON(http.StatusOK, gin.H{"posts": posts})
}

// The two rows have the same post columns; ListAdjacentPostsRow adds direction and
// ListRelatedPostsRow the shared counts.
func toAdjacentPostResponse(row db.ListAdjacentPostsRow) PostWithMetaResponse {
	return toRelatedPostResponse(db.ListRelatedPostsRow{
		ID: row.ID, Title: row.Title, Description: row.Description, UserID: row.UserID,
		Username: row.Username, Url: row.Url, PostType: row.PostType, PostStatus: row.PostStatus,
		PostParent: row.PostParent, MenuOrder: row.MenuOrder, CreatedAt: row.CreatedAt,
		ChangedAt: row.ChangedAt, Slug: row.Slug, Meta: row.Meta, Authors: row.Authors,
	}).PostWithMetaResponse
}

func toRelatedPostResponse(row db.ListRelatedPostsRow) RelatedPostResponse {
	var postParent *int64
	if row.PostParent.Valid {
		postParent = &row.PostParent.Int64
	}
	metaMap := make(map[string]interface{})
	decodeJSONBestEffort(row.Meta, &metaMap)

	return RelatedPostResponse{
		PostWithMetaResponse: PostWithMetaResponse{
			ID:          row.ID,
			Title:       row.Title,
			Description: row.Description,
			UserID:      row.UserID,
			Username:    row.Username,
			Url:         row.Url,
			Slug:        row.Slug,
			PostType:    row.PostType,
			PostStatus:  row.PostStatus,
			PostParent:  postParent,
			MenuOrder:   row.MenuOrder,
			CreatedAt:   row.CreatedAt,
			ChangedAt:   row.ChangedAt,
			Meta:        metaMap,
			Authors:     decodePostAuthors(row.Authors),
		},
		SharedCategories: row.SharedCategories,
		SharedTags:       row.SharedTags,
	}
}
