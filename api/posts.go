package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
	"github.com/google/uuid"
)

// Simple in-memory ticket store (replace with Redis in production)
type WSTicket struct {
	UserID    int64
	PostID    int64
	ExpiresAt time.Time
}

var (
	wsTicketStore = make(map[string]WSTicket)
	wsTicketMutex = sync.RWMutex{}
)

type CreatePostRequest struct {
	Title       string  `json:"title" binding:"required,min=3,max=255"`
	Content     string  `json:"content" binding:"required,min=10"`
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

type UpdatePostRequest struct {
	Title       string  `json:"title" binding:"omitempty,min=3,max=255"`
	Content     string  `json:"content" binding:"omitempty,min=10"`
	Description string  `json:"description" binding:"omitempty,min=10,max=500"`
	Url         string  `json:"url" binding:"omitempty,url"`
	PostType    string  `json:"post_type" binding:"omitempty"`
	PostStatus  string  `json:"post_status" binding:"omitempty,oneof=draft published archived"`
	PostParent  *int64  `json:"post_parent" binding:"omitempty"`
	MenuOrder   int32   `json:"menu_order" binding:"omitempty"`
	MediaIDs    []int64 `json:"media_ids" binding:"omitempty"`
	TaxonomyIDs []int64 `json:"taxonomy_ids" binding:"omitempty"`
}

type PostResponse struct {
	ID          int64     `json:"id"`
	Title       string    `json:"title"`
	Content     string    `json:"content"`
	Description string    `json:"description"`
	UserID      int64     `json:"user_id"`
	Username    string    `json:"username"`
	Url         string    `json:"url"`
	PostType    string    `json:"post_type"`
	PostStatus  string    `json:"post_status"`
	PostParent  *int64    `json:"post_parent"`
	MenuOrder   int32     `json:"menu_order"`
	CreatedAt   time.Time `json:"created_at"`
	ChangedAt   time.Time `json:"changed_at"`
}

func toPostResponse(post db.Post) PostResponse {
	var postParent *int64
	if post.PostParent.Valid {
		postParent = &post.PostParent.Int64
	}

	return PostResponse{
		ID:          post.ID,
		Title:       post.Title,
		Content:     post.Content,
		Description: post.Description,
		UserID:      post.UserID,
		Username:    post.Username,
		Url:         post.Url,
		PostType:    post.PostType,
		PostStatus:  post.PostStatus,
		PostParent:  postParent,
		MenuOrder:   post.MenuOrder,
		CreatedAt:   post.CreatedAt,
		ChangedAt:   post.ChangedAt,
	}
}

type PostWithMetaResponse struct {
	ID          int64                  `json:"id"`
	Title       string                 `json:"title"`
	Content     string                 `json:"content"`
	Description string                 `json:"description"`
	UserID      int64                  `json:"user_id"`
	Username    string                 `json:"username"`
	Url         string                 `json:"url"`
	PostType    string                 `json:"post_type"`
	PostStatus  string                 `json:"post_status"`
	PostParent  *int64                 `json:"post_parent"`
	MenuOrder   int32                  `json:"menu_order"`
	CreatedAt   time.Time              `json:"created_at"`
	ChangedAt   time.Time              `json:"changed_at"`
	Meta        map[string]interface{} `json:"meta,omitempty"`
}
type PostWithAllMetaResponse struct {
	ID           int64                  `json:"id"`
	Title        string                 `json:"title"`
	Content      string                 `json:"content"`
	Description  string                 `json:"description"`
	UserID       int64                  `json:"user_id"`
	Username     string                 `json:"username"`
	Url          string                 `json:"url"`
	PostType     string                 `json:"post_type"`
	PostStatus   string                 `json:"post_status"`
	PostParent   *int64                 `json:"post_parent"`
	MenuOrder    int32                  `json:"menu_order"`
	CreatedAt    time.Time              `json:"created_at"`
	ChangedAt    time.Time              `json:"changed_at"`
	PostMeta     map[string]interface{} `json:"post_meta,omitempty"`
	AuthorMeta   map[string]interface{} `json:"author_meta,omitempty"`
	PostTypeMeta map[string]interface{} `json:"post_type_meta,omitempty"`
}

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

	return PostWithAllMetaResponse{
		ID:           post.ID,
		Title:        post.Title,
		Content:      post.Content,
		Description:  post.Description,
		UserID:       post.UserID,
		Username:     post.Username,
		Url:          post.Url,
		PostType:     post.PostType,
		PostStatus:   post.PostStatus,
		PostParent:   postParent,
		MenuOrder:    post.MenuOrder,
		CreatedAt:    post.CreatedAt,
		ChangedAt:    post.ChangedAt,
		PostMeta:     postMetaMap,
		AuthorMeta:   authorMetaMap,
		PostTypeMeta: postTypeMetaMap,
	}
}

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

	return PostWithMetaResponse{
		ID:          post.ID,
		Title:       post.Title,
		Content:     post.Content,
		Description: post.Description,
		UserID:      post.UserID,
		Username:    post.Username,
		Url:         post.Url,
		PostType:    post.PostType,
		PostStatus:  post.PostStatus,
		PostParent:  postParent,
		MenuOrder:   post.MenuOrder,
		CreatedAt:   post.CreatedAt,
		ChangedAt:   post.ChangedAt,
		Meta:        metaMap,
	}
}
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

	return PostWithMetaResponse{
		ID:          post.ID,
		Title:       post.Title,
		Content:     post.Content,
		Description: post.Description,
		UserID:      post.UserID,
		Username:    post.Username,
		Url:         post.Url,
		PostType:    post.PostType,
		PostStatus:  post.PostStatus,
		PostParent:  postParent,
		MenuOrder:   post.MenuOrder,
		CreatedAt:   post.CreatedAt,
		ChangedAt:   post.ChangedAt,
		Meta:        metaMap,
	}
}

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
			postResponses[i] = toPostResponse(post)
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

func isValidPostSortOption(sort string) bool {
	validSorts := []string{
		"date_asc", "date_desc",
		"title_asc", "title_desc",
		"menu_order_asc", "menu_order_desc",
		"id_asc", "id_desc",
	}

	if sort == "" {
		return true
	}

	for _, valid := range validSorts {
		if sort == valid {
			return true
		}
	}
	return false
}

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

func (server *Server) createPost(c *gin.Context) {
	var req CreatePostRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if len(req.AuthorIDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "at least one author is required"})
		return
	}

	primaryAuthor, err := server.store.GetUser(c.Request.Context(), req.AuthorIDs[0])
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusBadRequest, gin.H{"error": "primary author not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get primary author"})
		return
	}

	createParams := db.CreatePostsParams{
		Title:       req.Title,
		Content:     req.Content,
		Description: req.Description,
		UserID:      primaryAuthor.ID,
		Username:    primaryAuthor.Username,
		Url:         req.Url,
		PostType:    req.PostType,
		PostStatus:  req.PostStatus,
		MenuOrder:   req.MenuOrder,
	}

	if req.PostParent != nil {
		createParams.PostParent = sql.NullInt64{
			Int64: *req.PostParent,
			Valid: true,
		}
	} else {
		createParams.PostParent = sql.NullInt64{Valid: false}
	}

	if createParams.PostType == "" {
		createParams.PostType = "post"
	}
	if createParams.PostStatus == "" {
		createParams.PostStatus = "draft"
	}

	if len(req.MediaIDs) > 0 && len(req.TaxonomyIDs) > 0 {

		result, err := server.store.CreatePostTx(c.Request.Context(), db.CreatePostTxParams{
			CreatePostsParams: createParams,
			AuthorIDs:         req.AuthorIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create post"})
			return
		}

		c.JSON(http.StatusCreated, gin.H{
			"post": toPostResponse(result.Post),
		})
	} else if len(req.MediaIDs) > 0 {

		result, err := server.store.CreatePostWithMediaTx(c.Request.Context(), db.CreatePostWithMediaTxParams{
			CreatePostsParams: createParams,
			AuthorIDs:         req.AuthorIDs,
			MediaIDs:          req.MediaIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create post with media"})
			return
		}

		c.JSON(http.StatusCreated, gin.H{
			"post": toPostResponse(result.Post),
		})
	} else if len(req.TaxonomyIDs) > 0 {

		result, err := server.store.CreatePostWithTaxonomyTermsTx(c.Request.Context(), db.CreatePostWithTaxonomyTermsTxParams{
			CreatePostsParams: createParams,
			AuthorIDs:         req.AuthorIDs,
			TaxonomyTermIDs:   req.TaxonomyIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create post with taxonomies"})
			return
		}

		c.JSON(http.StatusCreated, gin.H{
			"post": toPostResponse(result.Post),
		})
	} else {

		result, err := server.store.CreatePostTx(c.Request.Context(), db.CreatePostTxParams{
			CreatePostsParams: createParams,
			AuthorIDs:         req.AuthorIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create post"})
			return
		}

		c.JSON(http.StatusCreated, gin.H{
			"post": toPostResponse(result.Post),
		})
	}
}

func (server *Server) updatePost(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	var req UpdatePostRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	existingPost, err := server.store.GetPost(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	updateParams := db.UpdatePostParams{
		ID:          id,
		Title:       existingPost.Title,
		Content:     existingPost.Content,
		Description: existingPost.Description,
		UserID:      existingPost.UserID,
		Username:    existingPost.Username,
		Url:         existingPost.Url,
		PostType:    existingPost.PostType,
		PostStatus:  existingPost.PostStatus,
		PostParent:  existingPost.PostParent,
		MenuOrder:   existingPost.MenuOrder,
	}

	if req.Title != "" {
		updateParams.Title = req.Title
	}
	if req.Content != "" {
		updateParams.Content = req.Content
	}
	if req.Description != "" {
		updateParams.Description = req.Description
	}
	if req.Url != "" {
		updateParams.Url = req.Url
	}
	if req.PostType != "" {
		updateParams.PostType = req.PostType
	}
	if req.PostStatus != "" {
		updateParams.PostStatus = req.PostStatus
	}
	if req.PostParent != nil {
		updateParams.PostParent = sql.NullInt64{
			Int64: *req.PostParent,
			Valid: true,
		}
	}
	if req.MenuOrder != 0 {
		updateParams.MenuOrder = req.MenuOrder
	}

	updatedPost, err := server.store.UpdatePost(c.Request.Context(), updateParams)
	if err != nil {
		if containsString(err.Error(), "duplicate key value") || containsString(err.Error(), "unique constraint") {
			c.JSON(http.StatusConflict, gin.H{"error": "URL already exists"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update post"})
		return
	}

	if req.MediaIDs != nil {
		err = server.store.UpdatePostMediaTx(c.Request.Context(), db.UpdatePostMediaTxParams{
			PostID:   id,
			MediaIDs: req.MediaIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update post media"})
			return
		}
	}

	if req.TaxonomyIDs != nil {
		err = server.store.UpdatePostTaxonomyTermsTx(c.Request.Context(), db.UpdatePostTaxonomyTermsTxParams{
			PostID:          id,
			TaxonomyTermIDs: req.TaxonomyIDs,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update post taxonomies"})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"post": toPostResponse(updatedPost),
	})
}

func (server *Server) deletePost(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	_, err = server.store.GetPost(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	err = server.store.DeletePostTx(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete post"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "post deleted successfully",
	})
}

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
		postResponses[i] = PostResponse{
			ID:          post.ID,
			Title:       post.Title,
			Content:     post.Content,
			Description: post.Description,
			UserID:      post.UserID,
			Username:    post.Username,
			Url:         post.Url,
			CreatedAt:   post.CreatedAt,
			ChangedAt:   post.ChangedAt,
		}
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

	return PostWithAllMetaResponse{
		ID:           post.ID,
		Title:        post.Title,
		Content:      post.Content,
		Description:  post.Description,
		UserID:       post.UserID,
		Username:     post.Username,
		Url:          post.Url,
		PostType:     post.PostType,
		PostStatus:   post.PostStatus,
		PostParent:   postParent,
		MenuOrder:    post.MenuOrder,
		CreatedAt:    post.CreatedAt,
		ChangedAt:    post.ChangedAt,
		PostMeta:     postMetaMap,
		AuthorMeta:   authorMetaMap,
		PostTypeMeta: postTypeMetaMap,
	}
}

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

type CreatePostMetaRequest struct {
	MetaKey   string `json:"meta_key" binding:"required,min=1,max=255"`
	MetaValue string `json:"meta_value" binding:"required"`
}

type PostMetaResponse struct {
	ID        int64     `json:"id"`
	PostID    int64     `json:"post_id"`
	MetaKey   string    `json:"meta_key"`
	MetaValue string    `json:"meta_value"`
	CreatedAt time.Time `json:"created_at"`
}

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

func (server *Server) getPostMeta(c *gin.Context) {
	idParam := c.Param("id")
	postID, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	_, err = server.store.GetPost(c.Request.Context(), postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify post"})
		return
	}

	metaList, err := server.store.GetPostMeta(c.Request.Context(), postID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post meta"})
		return
	}

	metaResponses := make([]PostMetaResponse, len(metaList))
	for i, meta := range metaList {
		metaResponses[i] = toPostMetaResponse(meta)
	}

	c.JSON(http.StatusOK, gin.H{
		"meta": metaResponses,
	})
}

func (server *Server) createOrUpdatePostMeta(c *gin.Context) {
	idParam := c.Param("id")
	postID, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	var req CreatePostMetaRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	_, err = server.store.GetPost(c.Request.Context(), postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify post"})
		return
	}

	meta, err := server.store.UpsertPostMeta(c.Request.Context(), db.UpsertPostMetaParams{
		PostID:  postID,
		MetaKey: req.MetaKey,
		MetaValue: sql.NullString{
			String: req.MetaValue,
			Valid:  true,
		},
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save post meta"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"meta": toPostMetaResponse(meta),
	})
}

func (server *Server) deletePostMetaByKey(c *gin.Context) {
	idParam := c.Param("id")
	postID, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	metaKey := c.Param("key")
	if metaKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "meta key is required"})
		return
	}

	_, err = server.store.GetPost(c.Request.Context(), postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify post"})
		return
	}

	_, err = server.store.GetPostMetaByKey(c.Request.Context(), db.GetPostMetaByKeyParams{
		PostID:  postID,
		MetaKey: metaKey,
	})
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "meta not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify meta"})
		return
	}

	err = server.store.DeletePostMeta(c.Request.Context(), db.DeletePostMetaParams{
		PostID:  postID,
		MetaKey: metaKey,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete post meta"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "post meta deleted successfully",
	})
}

type SetFeaturedImageRequest struct {
	MediaID   int64  `json:"media_id" binding:"required"`
	MediaPath string `json:"media_path"`
}

func (server *Server) setFeaturedImage(c *gin.Context) {
	postIDStr := c.Param("id")
	postID, err := strconv.ParseInt(postIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	var req SetFeaturedImageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	_, err = server.store.GetPost(c.Request.Context(), postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	media, err := server.store.GetMedia(c.Request.Context(), req.MediaID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "media not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get media"})
		return
	}

	err = server.store.ExecTx(c.Request.Context(), func(q *db.Queries) error {

		err := q.DeletePostMediaByOrder(c.Request.Context(), db.DeletePostMediaByOrderParams{
			PostID: postID,
			Order:  0,
		})
		if err != nil && err != sql.ErrNoRows {
			return fmt.Errorf("failed to remove existing featured image: %w", err)
		}

		_, err = q.CreatePostMedia(c.Request.Context(), db.CreatePostMediaParams{
			PostID:  postID,
			MediaID: req.MediaID,
			Order:   0,
		})
		if err != nil {
			return fmt.Errorf("failed to create media association: %w", err)
		}

		_, err = q.UpsertPostMeta(c.Request.Context(), db.UpsertPostMetaParams{
			PostID:    postID,
			MetaKey:   "_thumbnail_id",
			MetaValue: sql.NullString{String: strconv.FormatInt(req.MediaID, 10), Valid: true},
		})
		if err != nil {
			return fmt.Errorf("failed to store thumbnail ID meta: %w", err)
		}

		mediaPath := req.MediaPath
		if mediaPath == "" {
			mediaPath = media.MediaPath
		}
		_, err = q.UpsertPostMeta(c.Request.Context(), db.UpsertPostMetaParams{
			PostID:    postID,
			MetaKey:   "_thumbnail_url",
			MetaValue: sql.NullString{String: mediaPath, Valid: true},
		})
		if err != nil {
			return fmt.Errorf("failed to store thumbnail URL meta: %w", err)
		}

		return nil
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "featured image set successfully",
		"media":   toMediaResponse(media),
	})
}

func (server *Server) getFeaturedImageQuick(c *gin.Context) {
	postIDStr := c.Param("id")
	postID, err := strconv.ParseInt(postIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	thumbnailMeta, err := server.store.GetPostMetaByKey(c.Request.Context(), db.GetPostMetaByKeyParams{
		PostID:  postID,
		MetaKey: "_thumbnail_url",
	})
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusOK, gin.H{"featured_image": nil})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get featured image"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"featured_image": gin.H{
			"url": thumbnailMeta.MetaValue.String,
		},
	})
}

func (server *Server) getFeaturedImageFull(c *gin.Context) {
	postIDStr := c.Param("id")
	postID, err := strconv.ParseInt(postIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	featuredImage, err := server.store.GetFeaturedImage(c.Request.Context(), postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusOK, gin.H{"featured_image": nil})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get featured image"})
		return
	}

	response := gin.H{
		"id":                featuredImage.MediaID,
		"name":              featuredImage.Name,
		"description":       featuredImage.Description,
		"alt":               featuredImage.Alt,
		"media_path":        featuredImage.MediaPath,
		"file_size":         featuredImage.FileSize,
		"mime_type":         featuredImage.MimeType,
		"original_filename": featuredImage.OriginalFilename,
		"created_at":        featuredImage.CreatedAt,
		"changed_at":        featuredImage.ChangedAt,
	}

	if featuredImage.Width != 0 {
		response["width"] = featuredImage.Width
	}
	if featuredImage.Height != 0 {
		response["height"] = featuredImage.Height
	}

	c.JSON(http.StatusOK, gin.H{"featured_image": response})
}

func (server *Server) removeFeaturedImage(c *gin.Context) {
	postIDStr := c.Param("id")
	postID, err := strconv.ParseInt(postIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	_, err = server.store.GetPost(c.Request.Context(), postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	err = server.store.ExecTx(c.Request.Context(), func(q *db.Queries) error {

		err := q.DeletePostMediaByOrder(c.Request.Context(), db.DeletePostMediaByOrderParams{
			PostID: postID,
			Order:  0,
		})
		if err != nil && err != sql.ErrNoRows {
			return fmt.Errorf("failed to remove featured image association: %w", err)
		}

		err = q.DeletePostMeta(c.Request.Context(), db.DeletePostMetaParams{
			PostID:  postID,
			MetaKey: "_thumbnail_id",
		})
		if err != nil && err != sql.ErrNoRows {

		}

		err = q.DeletePostMeta(c.Request.Context(), db.DeletePostMetaParams{
			PostID:  postID,
			MetaKey: "_thumbnail_url",
		})
		if err != nil && err != sql.ErrNoRows {

		}

		return nil
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "featured image removed successfully",
	})
}

type PostMediaRequest struct {
	MediaID int64 `json:"media_id" binding:"required"`
	Order   int32 `json:"order"`
}

func (server *Server) createPostMedia(c *gin.Context) {
	postIDStr := c.Param("id")
	postID, err := strconv.ParseInt(postIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	var req PostMediaRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	postMedia, err := server.store.CreatePostMedia(c.Request.Context(), db.CreatePostMediaParams{
		PostID:  postID,
		MediaID: req.MediaID,
		Order:   req.Order,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create post media association"})
		return
	}

	c.JSON(http.StatusCreated, postMedia)
}

func (server *Server) deletePostMedia(c *gin.Context) {
	postIDStr := c.Param("id")
	mediaIDStr := c.Param("media_id")

	postID, err := strconv.ParseInt(postIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	mediaID, err := strconv.ParseInt(mediaIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid media ID"})
		return
	}

	err = server.store.DeletePostMedia(c.Request.Context(), db.DeletePostMediaParams{
		PostID:  postID,
		MediaID: mediaID,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete post media association"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "post media association deleted"})
}

func (server *Server) getPostMedia(c *gin.Context) {
	postIDStr := c.Param("id")
	postID, err := strconv.ParseInt(postIDStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	featured := c.Query("featured") == "true"

	if featured {

		featuredImage, err := server.store.GetFeaturedImage(c.Request.Context(), postID)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusOK, gin.H{"data": nil})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get featured image"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": featuredImage})
	} else {

		postMedia, err := server.store.GetPostMedia(c.Request.Context(), postID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post media"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": postMedia})
	}
}

type CreateWSTicketRequest struct {
	PostID int64 `json:"post_id" binding:"required"`
}

type CreateWSTicketResponse struct {
	Ticket    string    `json:"ticket"`
	ExpiresAt time.Time `json:"expires_at"`
}

func (server *Server) createWSTicket(c *gin.Context) {
	var req CreateWSTicketRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Get the authenticated user from the middleware
	authPayload := c.MustGet(authorizationPayloadKey).(*token.Payload)

	// Verify the post exists and the user has access to it
	post, err := server.store.GetPost(c.Request.Context(), req.PostID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	// Check if the user is an author of this post (basic access control)
	// You can expand this logic based on your requirements
	if post.UserID != authPayload.UserID {
		c.JSON(http.StatusForbidden, gin.H{"error": "access denied to this post"})
		return
	}

	// Create a short-lived WebSocket ticket (2 minutes) - using UUID instead of PASETO
	ticket := uuid.New().String()
	ticketDuration := 2 * time.Minute
	expiresAt := time.Now().Add(ticketDuration)

	// Store ticket in memory store (replace with Redis in production)
	wsTicketMutex.Lock()
	wsTicketStore[ticket] = WSTicket{
		UserID:    authPayload.UserID,
		PostID:    req.PostID,
		ExpiresAt: expiresAt,
	}
	wsTicketMutex.Unlock()

	response := CreateWSTicketResponse{
		Ticket:    ticket,
		ExpiresAt: expiresAt,
	}

	c.JSON(http.StatusOK, response)
}

type VerifyWSTicketRequest struct {
	Ticket string `json:"ticket" binding:"required"`
	Room   string `json:"room" binding:"required"`
}

type VerifyWSTicketResponse struct {
	UserID int64 `json:"user_id"`
	PostID int64 `json:"post_id"`
}

func (server *Server) verifyWSTicket(c *gin.Context) {
	var req VerifyWSTicketRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Get and consume ticket atomically
	wsTicketMutex.Lock()
	ticket, exists := wsTicketStore[req.Ticket]
	if exists {
		delete(wsTicketStore, req.Ticket) // One-time use
	}
	wsTicketMutex.Unlock()

	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired ticket"})
		return
	}

	// Check expiration
	if time.Now().After(ticket.ExpiresAt) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "ticket expired"})
		return
	}

	// Verify room matches post
	expectedRoom := fmt.Sprintf("post-%d", ticket.PostID)
	if req.Room != expectedRoom {
		c.JSON(http.StatusForbidden, gin.H{"error": "ticket not valid for this room"})
		return
	}

	response := VerifyWSTicketResponse{
		UserID: ticket.UserID,
		PostID: ticket.PostID,
	}

	c.JSON(http.StatusOK, response)
}
