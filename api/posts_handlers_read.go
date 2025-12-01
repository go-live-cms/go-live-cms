// Package api — Posts read operation handlers
//
// Handles all GET operations for posts: listing, individual retrieval,
// filtering by type/user, with optional meta hydration.
//
// Query Parameters
//   - limit/offset: pagination (max 100)
//   - sort: date_asc|desc, title_asc|desc, menu_order_asc|desc, id_asc|desc
//   - type, status, user_id: filtering
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
	sortBy := c.DefaultQuery("sort", "date_desc")
	postType := c.Query("type")
	status := c.Query("status")
	userIDStr := c.Query("user_id")
	withMeta := c.DefaultQuery("with_meta", "false")
	metaLevel := c.DefaultQuery("meta_level", "basic")

	if !isValidPostSortOption(sortBy) {
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

	var total int64
	if postType != "" {
		total, err = server.store.CountPostsByTypeFiltered(c.Request.Context(), db.CountPostsByTypeFilteredParams{
			PostType:   postType,
			PostStatus: status,
		})
	} else {
		total, err = server.store.CountFilteredPosts(c.Request.Context(), db.CountFilteredPostsParams{
			PostType:   postType,
			PostStatus: status,
			UserID:     userID,
		})
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count filtered posts"})
		return
	}

	if withMeta == "true" {
		switch metaLevel {
		case "full", "all":
			posts, err := server.store.ListPostsWithAllMeta(c.Request.Context(), db.ListPostsWithAllMetaParams{
				PostType:    postType,
				PostStatus:  status,
				UserID:      userID,
				SortBy:      sortBy,
				OffsetCount: int32(offset),
				LimitCount:  int32(limit),
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
					"sort":       sortBy,
					"type":       postType,
					"status":     status,
					"user_id":    userID,
					"with_meta":  true,
					"meta_level": metaLevel,
				},
			})

		default:
			posts, err := server.store.ListPostsWithMeta(c.Request.Context(), db.ListPostsWithMetaParams{
				PostType:    postType,
				PostStatus:  status,
				UserID:      userID,
				SortBy:      sortBy,
				OffsetCount: int32(offset),
				LimitCount:  int32(limit),
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
					"sort":       sortBy,
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
			PostType:    postType,
			PostStatus:  status,
			UserID:      userID,
			SortBy:      sortBy,
			OffsetCount: int32(offset),
			LimitCount:  int32(limit),
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
				"sort":      sortBy,
				"type":      postType,
				"status":    status,
				"user_id":   userID,
				"with_meta": false,
			},
		})
	}
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
		"post": toPostResponse(post),
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
	sortBy := c.DefaultQuery("sort", "date_desc")
	status := c.DefaultQuery("status", "")
	withMeta := c.DefaultQuery("with_meta", "false")
	metaLevel := c.DefaultQuery("meta_level", "basic")

	if !isValidPostSortOption(sortBy) {
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
			posts, err := server.store.ListPostsByTypeWithAllMeta(c.Request.Context(), db.ListPostsByTypeWithAllMetaParams{
				PostType:    postType,
				PostStatus:  status,
				UserID:      int64(0),
				SortBy:      sortBy,
				OffsetCount: int32(offset),
				LimitCount:  int32(limit),
			})
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list posts by type with all meta"})
				return
			}

			postResponses := make([]PostWithAllMetaResponse, len(posts))
			for i, post := range posts {
				postResponses[i] = toPostWithAllMetaResponseFromTypeQuery(post)
			}

			totalCount, err := server.store.CountPostsByTypeFiltered(c.Request.Context(), db.CountPostsByTypeFilteredParams{
				PostType:   postType,
				PostStatus: status,
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
					"sort":       sortBy,
					"status":     status,
					"with_meta":  true,
					"meta_level": metaLevel,
				},
			})

		default:
			posts, err := server.store.ListPostsByTypeWithMeta(c.Request.Context(), db.ListPostsByTypeWithMetaParams{
				PostType:    postType,
				PostStatus:  status,
				UserID:      int64(0),
				SortBy:      sortBy,
				OffsetCount: int32(offset),
				LimitCount:  int32(limit),
			})
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list posts by type with meta"})
				return
			}

			postResponses := make([]PostWithMetaResponse, len(posts))
			for i, post := range posts {
				postResponses[i] = toPostWithMetaResponseFromTypeQuery(post)
			}

			totalCount, err := server.store.CountPostsByType(c.Request.Context(), postType)
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
					"sort":      sortBy,
					"status":    status,
					"with_meta": true,
				},
			})
		}
	} else {
		posts, err := server.store.ListPostsByType(c.Request.Context(), db.ListPostsByTypeParams{
			PostType:    postType,
			PostStatus:  status,
			UserID:      int64(0),
			SortBy:      sortBy,
			OffsetCount: int32(offset),
			LimitCount:  int32(limit),
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list posts by type"})
			return
		}

		postResponses := make([]PostResponse, len(posts))
		for i, post := range posts {
			postResponses[i] = toPostResponse(post)
		}

		totalCount, err := server.store.CountPostsByType(c.Request.Context(), postType)
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
				"sort":      sortBy,
				"status":    status,
				"with_meta": false,
			},
		})
	}
}
