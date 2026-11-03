// Package api — Posts read operation handlers
//
// Handles all GET operations for posts: listing, individual retrieval,
// filtering by type/user, with optional meta hydration.
//
// Query Parameters
//   - limit/offset: pagination (max 100)
//   - sort: created_at|changed_at|title|id|menu_order (legacy date_desc etc. still work)
//   - order: asc|desc (default depends on the column; see resolvePostSort)
//   - type, user_id: filtering; status: one status or a comma list (draft,published)
//   - with_meta: true|false, meta_level: basic|all|full
package api

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// getPosts handles GET /posts with optional filtering and meta hydration
func (server *Server) getPosts(c *gin.Context) {
	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")
	sorting, sortErr := resolvePostSort(c.Query("sort"), c.Query("order"))
	postType := c.Query("type")
	status := c.Query("status")
	userIDStr := c.Query("user_id")
	withMeta := c.DefaultQuery("with_meta", "false")
	metaLevel := c.DefaultQuery("meta_level", "basic")

	if sortErr != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": sortErr.Error()})
		return
	}
	unpublishedChanges, err := parseUnpublishedChangesFilter(c.Query("unpublished_changes"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
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

	// Count with the same filters as the list, user_id included.
	total, err := server.store.CountFilteredPosts(c.Request.Context(), db.CountFilteredPostsParams{
		PostType:           postType,
		PostStatus:         status,
		UserID:             userID,
		UnpublishedChanges: unpublishedChanges,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count filtered posts"})
		return
	}

	if withMeta == "true" {
		switch metaLevel {
		case "full", "all":
			posts, err := server.store.ListPostsWithAllMeta(c.Request.Context(), db.ListPostsWithAllMetaParams{
				PostType:           postType,
				PostStatus:         status,
				UserID:             userID,
				UnpublishedChanges: unpublishedChanges,
				SortColumn:         sorting.Column,
				SortDirection:      sorting.Direction,
				OffsetCount:        int32(offset),
				LimitCount:         int32(limit),
			})
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list posts with all meta"})
				return
			}

			postResponses := make([]PostWithAllMetaResponse, len(posts))
			for i, post := range posts {
				postResponses[i] = toPostWithAllMetaResponse(post)
			}

			c.JSON(http.StatusOK, gin.H{
				"posts": postResponses,
				"meta": gin.H{
					"total":      total,
					"limit":      limit,
					"offset":     offset,
					"count":      len(postResponses),
					"sort":       sorting.Column,
					"order":      sorting.Direction,
					"type":       postType,
					"status":     status,
					"user_id":    userID,
					"with_meta":  true,
					"meta_level": metaLevel,
				},
			})

		default:
			posts, err := server.store.ListPostsWithMeta(c.Request.Context(), db.ListPostsWithMetaParams{
				PostType:           postType,
				PostStatus:         status,
				UserID:             userID,
				UnpublishedChanges: unpublishedChanges,
				// The admin list: has_unpublished_changes (#326).
				WithUnpublishedChanges: true,
				SortColumn:             sorting.Column,
				SortDirection:          sorting.Direction,
				OffsetCount:            int32(offset),
				LimitCount:             int32(limit),
			})
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list posts with meta"})
				return
			}

			postResponses := make([]PostWithMetaResponse, len(posts))
			for i, post := range posts {
				postResponses[i] = toPostWithMetaResponse(post)
			}

			c.JSON(http.StatusOK, gin.H{
				"posts": postResponses,
				"meta": gin.H{
					"total":      total,
					"limit":      limit,
					"offset":     offset,
					"count":      len(postResponses),
					"sort":       sorting.Column,
					"order":      sorting.Direction,
					"type":       postType,
					"status":     status,
					"user_id":    userID,
					"with_meta":  true,
					"meta_level": metaLevel,
				},
			})
		}
	} else {
		posts, err := server.store.ListPosts(c.Request.Context(), db.ListPostsParams{
			PostType:           postType,
			PostStatus:         status,
			UserID:             userID,
			UnpublishedChanges: unpublishedChanges,
			SortColumn:         sorting.Column,
			SortDirection:      sorting.Direction,
			OffsetCount:        int32(offset),
			LimitCount:         int32(limit),
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list posts"})
			return
		}

		postResponses := make([]PostResponse, len(posts))
		for i, post := range posts {
			postResponses[i] = toPostResponseFromListRow(post)
		}

		c.JSON(http.StatusOK, gin.H{
			"posts": postResponses,
			"meta": gin.H{
				"total":     total,
				"limit":     limit,
				"offset":    offset,
				"count":     len(postResponses),
				"sort":      sorting.Column,
				"order":     sorting.Direction,
				"type":      postType,
				"status":    status,
				"user_id":   userID,
				"with_meta": false,
			},
		})
	}
}

// getPostCounts handles GET /posts/counts: how many posts have each status,
// for the admin list's tabs (#340). Takes the list's type and user_id filters.
// Public like GET /posts, whose meta.total already gives the same numbers.
func (server *Server) getPostCounts(c *gin.Context) {
	var userID int64
	if s := c.Query("user_id"); s != "" {
		uid, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id parameter"})
			return
		}
		userID = uid
	}

	rows, err := server.store.CountPostsByStatus(c.Request.Context(), db.CountPostsByStatusParams{
		PostType: c.Query("type"),
		UserID:   userID,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count posts"})
		return
	}

	counts := make(map[string]int64, len(rows))
	var total, unpublishedChanges int64
	for _, row := range rows {
		counts[row.PostStatus] = row.Total
		total += row.Total
		unpublishedChanges += row.UnpublishedChanges
	}
	// unpublished_changes: the "Changes not published" tab (#326), published posts
	// whose working copy differs from the site's. They're in counts.published too.
	c.JSON(http.StatusOK, gin.H{"counts": counts, "total": total, "unpublished_changes": unpublishedChanges})
}

// postDetailResponse is GET /posts/:id and /posts/slug/:slug's post: the row, its
// published blocks' media, and whether it has changes not published (#326). A
// failed flag lookup leaves the flag out rather than failing the read.
func (server *Server) postDetailResponse(c *gin.Context, post db.Post) PostResponse {
	resp := toPostResponse(post)
	server.attachBlockMedia(c.Request.Context(), resp.PublishedBlocks)
	if post.PostStatus == "published" {
		changed, err := server.store.GetPostHasUnpublishedChanges(c.Request.Context(), post.ID)
		if err != nil {
			server.requestLog(c).Warn("failed to read unpublished changes", "post_id", post.ID, "error", err)
		}
		resp.HasUnpublishedChanges = changed
	}
	return resp
}

// getPostByID handles GET /posts/:id
func (server *Server) getPostByID(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	post, err := server.store.GetPost(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"post": server.postDetailResponse(c, post),
	})
}

// getPostBySlug handles GET /posts/slug/:slug
func (server *Server) getPostBySlug(c *gin.Context) {
	slug := c.Param("slug")
	if slug == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "slug is required"})
		return
	}

	post, err := server.store.GetPostBySlug(c.Request.Context(), slug)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"post": server.postDetailResponse(c, post),
	})
}

// getPostsByUser handles GET /posts/user/:id
func (server *Server) getPostsByUser(c *gin.Context) {
	userIDParam := c.Param("id")
	userID, err := strconv.ParseInt(userIDParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user ID"})
		return
	}

	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")

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

	posts, err := server.store.GetPostsByUserWithMedia(c.Request.Context(), db.GetPostsByUserWithMediaParams{
		UserID: userID,
		Limit:  int32(limit),
		Offset: int32(offset),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get user posts"})
		return
	}

	postResponses := make([]PostResponse, len(posts))
	for i, post := range posts {
		postResponses[i] = toPostResponseFromUserMediaRow(post)
	}

	c.JSON(http.StatusOK, gin.H{
		"posts": postResponses,
		"meta": gin.H{
			"user_id": userID,
			"limit":   limit,
			"offset":  offset,
			"count":   len(postResponses),
		},
	})
}

// getPostsByType handles GET /posts/type/:type with optional meta hydration
func (server *Server) getPostsByType(c *gin.Context) {
	postType := c.Param("type")

	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")
	sorting, sortErr := resolvePostSort(c.Query("sort"), c.Query("order"))
	status := c.DefaultQuery("status", "")
	withMeta := c.DefaultQuery("with_meta", "false")
	metaLevel := c.DefaultQuery("meta_level", "basic")

	if sortErr != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": sortErr.Error()})
		return
	}
	unpublishedChanges, err := parseUnpublishedChangesFilter(c.Query("unpublished_changes"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
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

	_, err = server.store.GetPostType(c.Request.Context(), postType)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post type not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify post type"})
		return
	}

	if withMeta == "true" {
		switch metaLevel {
		case "full", "all":
			posts, err := server.store.ListPostsWithAllMeta(c.Request.Context(), db.ListPostsWithAllMetaParams{
				PostType:           postType,
				PostStatus:         status,
				UserID:             int64(0),
				UnpublishedChanges: unpublishedChanges,
				SortColumn:         sorting.Column,
				SortDirection:      sorting.Direction,
				OffsetCount:        int32(offset),
				LimitCount:         int32(limit),
			})
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list posts by type with all meta"})
				return
			}

			postResponses := make([]PostWithAllMetaResponse, len(posts))
			for i, post := range posts {
				postResponses[i] = toPostWithAllMetaResponse(post)
			}

			totalCount, err := server.store.CountPostsByTypeFiltered(c.Request.Context(), db.CountPostsByTypeFilteredParams{
				PostType:           postType,
				PostStatus:         status,
				UnpublishedChanges: unpublishedChanges,
			})
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count posts by type"})
				return
			}

			c.JSON(http.StatusOK, gin.H{
				"posts": postResponses,
				"meta": gin.H{
					"post_type":  postType,
					"limit":      limit,
					"offset":     offset,
					"count":      len(postResponses),
					"total":      totalCount,
					"sort":       sorting.Column,
					"order":      sorting.Direction,
					"status":     status,
					"with_meta":  true,
					"meta_level": metaLevel,
				},
			})

		default:
			posts, err := server.store.ListPostsWithMeta(c.Request.Context(), db.ListPostsWithMetaParams{
				PostType:               postType,
				PostStatus:             status,
				UserID:                 int64(0),
				UnpublishedChanges:     unpublishedChanges,
				WithUnpublishedChanges: true,
				SortColumn:             sorting.Column,
				SortDirection:          sorting.Direction,
				OffsetCount:            int32(offset),
				LimitCount:             int32(limit),
			})
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list posts by type with meta"})
				return
			}

			postResponses := make([]PostWithMetaResponse, len(posts))
			for i, post := range posts {
				postResponses[i] = toPostWithMetaResponse(post)
			}

			totalCount, err := server.store.CountPostsByTypeFiltered(c.Request.Context(), db.CountPostsByTypeFilteredParams{
				PostType:           postType,
				PostStatus:         status,
				UnpublishedChanges: unpublishedChanges,
			})
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count posts by type"})
				return
			}

			c.JSON(http.StatusOK, gin.H{
				"posts": postResponses,
				"meta": gin.H{
					"post_type": postType,
					"limit":     limit,
					"offset":    offset,
					"count":     len(postResponses),
					"total":     totalCount,
					"sort":      sorting.Column,
					"order":     sorting.Direction,
					"status":    status,
					"with_meta": true,
				},
			})
		}
	} else {
		posts, err := server.store.ListPosts(c.Request.Context(), db.ListPostsParams{
			PostType:           postType,
			PostStatus:         status,
			UserID:             int64(0),
			UnpublishedChanges: unpublishedChanges,
			SortColumn:         sorting.Column,
			SortDirection:      sorting.Direction,
			OffsetCount:        int32(offset),
			LimitCount:         int32(limit),
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list posts by type"})
			return
		}

		postResponses := make([]PostResponse, len(posts))
		for i, post := range posts {
			postResponses[i] = toPostResponseFromListRow(post)
		}

		totalCount, err := server.store.CountPostsByTypeFiltered(c.Request.Context(), db.CountPostsByTypeFilteredParams{
			PostType:           postType,
			PostStatus:         status,
			UnpublishedChanges: unpublishedChanges,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count posts by type"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"posts": postResponses,
			"meta": gin.H{
				"post_type": postType,
				"limit":     limit,
				"offset":    offset,
				"count":     len(postResponses),
				"total":     totalCount,
				"sort":      sorting.Column,
				"order":     sorting.Direction,
				"status":    status,
				"with_meta": false,
			},
		})
	}
}
