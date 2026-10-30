package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Full-text search (#145): the public site's /search and the admin posts list's
// search box, both over the post_search index (search_utils.go).

// PublicSearchResult is one hit of the public search. TitleHTML and ExcerptHTML
// are escaped HTML whose only markup is <mark> around the matches.
type PublicSearchResult struct {
	ID          int64     `json:"id"`
	Title       string    `json:"title"`
	Slug        string    `json:"slug"`
	PostType    string    `json:"post_type"`
	CreatedAt   time.Time `json:"created_at"`
	ChangedAt   time.Time `json:"changed_at"`
	TitleHTML   string    `json:"title_html"`
	ExcerptHTML string    `json:"excerpt_html"`
}

// searchCounts are the matches per type chip (All / Posts / Pages).
type searchCounts struct {
	All  int64 `json:"all"`
	Post int64 `json:"post"`
	Page int64 `json:"page"`
}

// of is the count for one ?type= value.
func (c searchCounts) of(searchType string) int64 {
	switch searchType {
	case searchTypePost:
		return c.Post
	case searchTypePage:
		return c.Page
	}
	return c.All
}

// getPublicSearch handles GET /public/search?q=&type=&page=: published posts and
// pages matching q, best match first (title, then description and terms, then
// body; newer first on a tie), posts_per_page at a time like the other public
// lists (pagination.go). Answers the counts per type and the selected type's
// total; an empty q is an empty first page. Rate-limited with the /public group.
func (server *Server) getPublicSearch(c *gin.Context) {
	query := normalizeSearchQuery(c.Query("q"))
	searchType, ok := parseSearchType(c.Query("type"))
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "type must be all, post or page"})
		return
	}
	req, ok := server.publicPageRequest(c)
	if !ok {
		return
	}

	ctx := c.Request.Context()
	var counts searchCounts
	if query != "" {
		rows, err := server.store.CountPublicSearchResults(ctx, query)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to search"})
			return
		}
		for _, row := range rows {
			switch row.PostType {
			case searchTypePost:
				counts.Post = row.Total
			case searchTypePage:
				counts.Page = row.Total
			}
			counts.All += row.Total
		}
	}

	info := newPageInfo(req, counts.of(searchType))
	if info.outOfRange() {
		c.JSON(http.StatusNotFound, gin.H{"error": "page out of range"})
		return
	}

	results := []PublicSearchResult{}
	if info.Total > 0 {
		postType := ""
		if searchType != searchTypeAll {
			postType = searchType
		}
		rows, err := server.store.SearchPublicPosts(ctx, db.SearchPublicPostsParams{
			Query:       query,
			PostType:    postType,
			OffsetCount: req.offset(),
			LimitCount:  req.PerPage,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to search"})
			return
		}
		for _, row := range rows {
			results = append(results, PublicSearchResult{
				ID:          row.ID,
				Title:       row.Title,
				Slug:        row.Slug,
				PostType:    row.PostType,
				CreatedAt:   row.CreatedAt,
				ChangedAt:   row.ChangedAt,
				TitleHTML:   highlightHTML(row.TitleHighlight),
				ExcerptHTML: excerptHTML(row),
			})
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"query":      query,
		"type":       searchType,
		"results":    results,
		"counts":     counts,
		"pagination": info,
	})
}

// searchPosts handles GET /posts/search?q=: the admin posts list's search box.
// The list's filters (type, status, user_id) and paging (limit, offset) work as
// on GET /posts, and so do its permissions: any content role sees every post
// the list shows, drafts included. Rows are ranked like the public search and
// shaped like GET /posts?with_meta=true.
func (server *Server) searchPosts(c *gin.Context) {
	query := normalizeSearchQuery(c.Query("q"))
	limit, err := strconv.ParseInt(c.DefaultQuery("limit", "10"), 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 100 {
		limit = 100
	}
	offset, err := strconv.ParseInt(c.DefaultQuery("offset", "0"), 10, 32)
	if err != nil || offset < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid offset parameter"})
		return
	}
	var userID int64
	if s := c.Query("user_id"); s != "" {
		userID, err = strconv.ParseInt(s, 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id parameter"})
			return
		}
	}
	postType := c.Query("type")
	status := c.Query("status")

	posts := []PostWithMetaResponse{}
	var total int64
	if query != "" {
		ctx := c.Request.Context()
		total, err = server.store.CountSearchPosts(ctx, db.CountSearchPostsParams{
			Query:      query,
			PostType:   postType,
			PostStatus: status,
			UserID:     userID,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to search posts"})
			return
		}
		rows, err := server.store.SearchPostsWithMeta(ctx, db.SearchPostsWithMetaParams{
			Query:       query,
			PostType:    postType,
			PostStatus:  status,
			UserID:      userID,
			OffsetCount: int32(offset),
			LimitCount:  int32(limit),
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to search posts"})
			return
		}
		for _, row := range rows {
			// Same columns as ListPostsWithMeta (post_search.sql).
			posts = append(posts, toPostWithMetaResponse(db.ListPostsWithMetaRow(row)))
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"posts": posts,
		"meta": gin.H{
			"total":     total,
			"limit":     limit,
			"offset":    offset,
			"count":     len(posts),
			"q":         query,
			"type":      postType,
			"status":    status,
			"user_id":   userID,
			"with_meta": true,
		},
	})
}
