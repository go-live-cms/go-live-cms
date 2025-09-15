// Package api provides read operations for media asset management.
// This file contains GET handlers for media resources with filtering, search, and pagination.
//
// # Overview
//
// Purpose: Handles all HTTP read operations (GET) for media assets.
// Includes single resource retrieval, paginated listing, search, and relationship queries.
//
// Auth: Most read operations are public, but may include user context for personalization.
// Pagination: Uses limit/offset with reasonable defaults and maximum limits.
//
// # Query Features
//
// Single resource: GET /media/:id with full media details.
// Paginated listing: GET /media with limit/offset, filters, sorting.
// Search: GET /media/search?q=term with text matching on names/descriptions.
// Popular media: GET /media/popular with usage-based ranking.
//
// # Filtering Options
//
// Type filters: image, video, audio, document via ?type= parameter.
// User filters: ?user_id= to show media by specific user.
// Search terms: ?search= for text matching across multiple fields.
// Sort options: date_desc, date_asc, name_asc, name_desc, size_asc, size_desc.
//
// # Relationship Queries
//
// User media: GET /users/:id/media for media owned by specific user.
// Post media: GET /posts/:id/media for media linked to specific post.
// Media posts: GET /media/:id/posts for posts using specific media.
//
// # Response Format
//
// Single resource: {media: {...}} with full details.
// Collections: {media: [...], meta: {limit, offset, count, total, filters}}.
// Search results: {media: [...], meta: {query, limit, offset, count, filters}}.
//
// # Cross-References
//
//   - media_presenters.go: Response formatting and data transformation
//   - media_utils.go: Sort validation, MIME type filtering
//   - Database queries: ListMedia, SearchMediaByName, GetPopularMedia
package api

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// getMediaByID handles GET /media/:id - single media resource retrieval.
// Path param: id (required) - media resource identifier.
// Returns 200 with {media: {...}} or 404 if not found.
// Auth: Public endpoint, no authentication required.
func (server *Server) getMediaByID(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid media ID"})
		return
	}

	media, err := server.store.GetMedia(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "media not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get media"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"media": toMediaResponse(media),
	})
}

// getMedia handles GET /media - paginated media listing with filters and search.
// Query params: limit (max 100), offset, type (image|video|audio|document),
// user_id, search, sort (date_desc|date_asc|name_asc|name_desc|size_asc|size_desc).
// Returns: {media: [], meta: {limit, offset, count, total, filters}}.
func (server *Server) getMedia(c *gin.Context) {
	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")
	withCounts := c.DefaultQuery("with_counts", "false")

	fileType := c.Query("type")
	userIDStr := c.Query("user_id")
	search := c.Query("search")
	sortBy := c.DefaultQuery("sort", "date_desc")

	if !isValidSortOption(sortBy) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid sort parameter"})
		return
	}

	limit, err := strconv.ParseInt(limitStr, 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 100 {
		limit = 100
	}

	offset, err := strconv.ParseInt(offsetStr, 10, 32)
	if err != nil || offset < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid offset parameter"})
		return
	}

	// Parse optional user_id filter - use 0 for no filter (matches SQL logic)
	var userID int64 = 0
	if userIDStr != "" {
		uid, err := strconv.ParseInt(userIDStr, 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id parameter"})
			return
		}
		userID = uid
	}

	mimeTypeFilter := getMimeTypeFilter(fileType)

	searchTerm := ""
	if search != "" {
		searchTerm = search
	}

	media, err := server.store.ListMedia(c.Request.Context(), db.ListMediaParams{
		Column1: mimeTypeFilter,
		Column2: userID,
		Column3: searchTerm,
		Column4: sortBy,
		Limit:   int32(limit),
		Offset:  int32(offset),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list media"})
		return
	}

	mediaResponses := make([]MediaResponse, len(media))
	for i, m := range media {
		mediaResponses[i] = toMediaFromListRow(m)
	}

	total, err := server.store.CountTotalMedia(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count total media"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"media": mediaResponses,
		"meta": gin.H{
			"limit":       limit,
			"offset":      offset,
			"count":       len(mediaResponses),
			"total":       total,
			"with_counts": withCounts == "true",
			"filters": gin.H{
				"type":    fileType,
				"user_id": userID,
				"search":  search,
				"sort":    sortBy,
			},
		},
	})
}

// getPopularMedia handles GET /media/popular - usage-based media ranking.
// Query params: limit (default 10, max 50) - number of results to return.
// Returns media ordered by usage frequency/popularity metrics.
// Auth: Public endpoint with optional user context for personalization.
func (server *Server) getPopularMedia(c *gin.Context) {
	limitStr := c.DefaultQuery("limit", "10")

	limit, err := strconv.ParseInt(limitStr, 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 50 {
		limit = 50
	}

	media, err := server.store.GetPopularMedia(c.Request.Context(), int32(limit))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get popular media"})
		return
	}

	mediaResponses := make([]PopularMediaResponse, len(media))
	for i, m := range media {
		mediaResponses[i] = toPopularMediaResponse(m)
	}

	c.JSON(http.StatusOK, gin.H{
		"media": mediaResponses,
		"meta": gin.H{
			"limit": limit,
			"count": len(mediaResponses),
		},
	})
}

// searchMedia handles GET /media/search - text-based media search.
// Query params: q (required), limit, offset, type, user_id, sort.
// Searches across media names, descriptions, and original filenames.
// Returns paginated results with search metadata.
func (server *Server) searchMedia(c *gin.Context) {
	query := c.Query("q")
	if query == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "search query is required"})
		return
	}

	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")

	fileType := c.Query("type")
	userIDStr := c.Query("user_id")
	sortBy := c.DefaultQuery("sort", "date_desc")

	if !isValidSortOption(sortBy) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid sort parameter"})
		return
	}

	limit, err := strconv.ParseInt(limitStr, 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 100 {
		limit = 100
	}

	offset, err := strconv.ParseInt(offsetStr, 10, 32)
	if err != nil || offset < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid offset parameter"})
		return
	}

	var userID int64 = 0
	if userIDStr != "" {
		uid, err := strconv.ParseInt(userIDStr, 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id parameter"})
			return
		}
		userID = uid
	}

	mimeTypeFilter := getMimeTypeFilter(fileType)

	media, err := server.store.SearchMediaByName(c.Request.Context(), db.SearchMediaByNameParams{
		Column1: sql.NullString{String: query, Valid: true},
		Column2: mimeTypeFilter,
		Column3: userID,
		Column4: sortBy,
		Limit:   int32(limit),
		Offset:  int32(offset),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to search media"})
		return
	}

	mediaResponses := make([]MediaResponse, len(media))
	for i, m := range media {
		mediaResponses[i] = toMediaFromSearchRow(m)
	}

	c.JSON(http.StatusOK, gin.H{
		"media": mediaResponses,
		"meta": gin.H{
			"query":  query,
			"limit":  limit,
			"offset": offset,
			"count":  len(mediaResponses),
			"filters": gin.H{
				"type":    fileType,
				"user_id": userID,
				"sort":    sortBy,
			},
		},
	})
}

// getMediaByUser handles GET /users/:id/media - user-specific media listing.
// Path param: id (required) - user identifier.
// Query params: limit, offset, type, search, sort - same as getMedia.
// Returns paginated media owned by the specified user.
func (server *Server) getMediaByUser(c *gin.Context) {
	userIDParam := c.Param("id")
	userID, err := strconv.ParseInt(userIDParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user ID"})
		return
	}

	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")

	fileType := c.Query("type")
	search := c.Query("search")
	sortBy := c.DefaultQuery("sort", "date_desc")

	if !isValidSortOption(sortBy) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid sort parameter"})
		return
	}

	limit, err := strconv.ParseInt(limitStr, 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 100 {
		limit = 100
	}

	offset, err := strconv.ParseInt(offsetStr, 10, 32)
	if err != nil || offset < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid offset parameter"})
		return
	}

	_, err = server.store.GetUser(c.Request.Context(), userID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user"})
		return
	}

	mimeTypeFilter := getMimeTypeFilter(fileType)

	searchTerm := ""
	if search != "" {
		searchTerm = search
	}

	media, err := server.store.GetMediaByUser(c.Request.Context(), db.GetMediaByUserParams{
		UserID:  userID,
		Column2: mimeTypeFilter,
		Column3: searchTerm,
		Column4: sortBy,
		Limit:   int32(limit),
		Offset:  int32(offset),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user media"})
		return
	}

	mediaResponses := make([]MediaResponse, len(media))
	for i, m := range media {
		mediaResponses[i] = toMediaFromUserRow(m)
	}

	c.JSON(http.StatusOK, gin.H{
		"media": mediaResponses,
		"meta": gin.H{
			"user_id": userID,
			"limit":   limit,
			"offset":  offset,
			"count":   len(mediaResponses),
			"filters": gin.H{
				"type":   fileType,
				"search": search,
				"sort":   sortBy,
			},
		},
	})
}

// getMediaByPost handles GET /posts/:id/media - post-linked media retrieval.
// Path param: id (required) - post identifier.
// Returns media assets linked to the specified post with order information.
// Includes both post details and associated media in response.
func (server *Server) getMediaByPost(c *gin.Context) {
	postIDParam := c.Param("id")
	postID, err := strconv.ParseInt(postIDParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	post, err := server.store.GetPost(c.Request.Context(), postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	media, err := server.store.GetMediaByPost(c.Request.Context(), postID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post media"})
		return
	}

	mediaResponses := make([]MediaResponse, len(media))
	for i, m := range media {
		mediaResponses[i] = toMediaResponse(m)
	}

	c.JSON(http.StatusOK, gin.H{
		"post":  toPostResponse(post),
		"media": mediaResponses,
		"meta": gin.H{
			"post_id": postID,
			"count":   len(mediaResponses),
		},
	})
}

// getMediaPosts handles GET /media/:id/posts - posts using specific media.
// Path param: id (required) - media identifier.
// Returns posts that reference the specified media asset.
// Includes media details and linked posts with order information.
func (server *Server) getMediaPosts(c *gin.Context) {
	mediaIDParam := c.Param("id")
	mediaID, err := strconv.ParseInt(mediaIDParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid media ID"})
		return
	}

	media, err := server.store.GetMedia(c.Request.Context(), mediaID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "media not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get media"})
		return
	}

	posts, err := server.store.GetPostsByMedia(c.Request.Context(), mediaID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get media posts"})
		return
	}

	postResponses := make([]PostWithMediaOrderResponse, len(posts))
	for i, post := range posts {
		postResponses[i] = toPostResponseFromMediaRow(post)
	}

	c.JSON(http.StatusOK, gin.H{
		"media": toMediaResponse(media),
		"posts": postResponses,
		"meta": gin.H{
			"media_id": mediaID,
			"count":    len(postResponses),
		},
	})
}
