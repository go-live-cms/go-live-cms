package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
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
