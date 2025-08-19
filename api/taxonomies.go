package api

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

type CreateTaxonomyRequest struct {
	Name        string `json:"name" binding:"required,min=2,max=100"`
	Description string `json:"description" binding:"required,min=5,max=500"`
}

type UpdateTaxonomyRequest struct {
	Name        string `json:"name" binding:"omitempty,min=2,max=100"`
	Description string `json:"description" binding:"omitempty,min=5,max=500"`
}

type TaxonomyResponse struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	PostCount   *int64 `json:"post_count,omitempty"`
}

type PopularTaxonomyResponse struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	PostCount   int64  `json:"post_count"`
}

func toTaxonomyResponse(taxonomy db.Taxonomy) TaxonomyResponse {
	return TaxonomyResponse{
		ID:          taxonomy.ID,
		Name:        taxonomy.Name,
		Description: taxonomy.Description,
	}
}

func toTaxonomyWithCountResponse(row db.ListTaxonomiesWithPostCountRow) TaxonomyResponse {
	return TaxonomyResponse{
		ID:          row.ID,
		Name:        row.Name,
		Description: row.Description,
		PostCount:   &row.PostCount,
	}
}

func toPopularTaxonomyResponse(row db.GetPopularTaxonomiesRow) PopularTaxonomyResponse {
	return PopularTaxonomyResponse{
		ID:          row.ID,
		Name:        row.Name,
		Description: row.Description,
		PostCount:   row.PostCount,
	}
}

func isValidTaxonomySortOption(sort string) bool {
	validSorts := []string{
		"name_asc", "name_desc",
		"id_asc", "id_desc",
		"posts_asc", "posts_desc",
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

func (server *Server) createTaxonomy(c *gin.Context) {
	var req CreateTaxonomyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	_, err := server.store.GetTaxonomyByName(c.Request.Context(), req.Name)
	if err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "taxonomy name already exists"})
		return
	}
	if err != sql.ErrNoRows {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check taxonomy name"})
		return
	}

	arg := db.CreateTaxonomyParams{
		Name:        req.Name,
		Description: req.Description,
	}

	taxonomy, err := server.store.CreateTaxonomy(c.Request.Context(), arg)
	if err != nil {
		if isUniqueViolation(err) {
			c.JSON(http.StatusConflict, gin.H{"error": "taxonomy name already exists"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create taxonomy"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"taxonomy": toTaxonomyResponse(taxonomy),
	})
}

func (server *Server) getTaxonomyByID(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid taxonomy ID"})
		return
	}

	taxonomy, err := server.store.GetTaxonomy(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomy": toTaxonomyResponse(taxonomy),
	})
}

func (server *Server) getTaxonomyByName(c *gin.Context) {
	name := c.Param("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "taxonomy name is required"})
		return
	}

	taxonomy, err := server.store.GetTaxonomyByName(c.Request.Context(), name)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomy": toTaxonomyResponse(taxonomy),
	})
}

func (server *Server) getTaxonomies(c *gin.Context) {
	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")
	withCounts := c.DefaultQuery("with_counts", "false")
	sortBy := c.DefaultQuery("sort", "name_asc")

	if !isValidTaxonomySortOption(sortBy) {
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

	if withCounts == "true" {
		taxonomies, err := server.store.ListTaxonomiesWithPostCount(c.Request.Context(), db.ListTaxonomiesWithPostCountParams{
			LimitCount:  int32(limit),
			OffsetCount: int32(offset),
			SortBy:      sortBy,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list taxonomies"})
			return
		}

		taxonomyResponses := make([]TaxonomyResponse, len(taxonomies))
		for i, taxonomy := range taxonomies {
			taxonomyResponses[i] = toTaxonomyWithCountResponse(taxonomy)
		}

		totalCount, err := server.store.CountTotalTaxonomies(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count total taxonomies"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"taxonomies": taxonomyResponses,
			"meta": gin.H{
				"limit":       limit,
				"offset":      offset,
				"count":       len(taxonomyResponses),
				"with_counts": true,
				"total":       totalCount,
				"sort":        sortBy,
			},
		})
	} else {
		taxonomies, err := server.store.ListTaxonomies(c.Request.Context(), db.ListTaxonomiesParams{
			LimitCount:  int32(limit),
			OffsetCount: int32(offset),
			SortBy:      sortBy,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list taxonomies"})
			return
		}

		taxonomyResponses := make([]TaxonomyResponse, len(taxonomies))
		for i, taxonomy := range taxonomies {
			taxonomyResponses[i] = toTaxonomyResponse(taxonomy)
		}

		total, err := server.store.CountTotalTaxonomies(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count total taxonomies"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"taxonomies": taxonomyResponses,
			"meta": gin.H{
				"limit":       limit,
				"offset":      offset,
				"count":       len(taxonomyResponses),
				"with_counts": false,
				"total":       total,
				"sort":        sortBy,
			},
		})
	}
}

func (server *Server) getPopularTaxonomies(c *gin.Context) {
	limitStr := c.DefaultQuery("limit", "10")

	limit, err := strconv.ParseInt(limitStr, 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 50 {
		limit = 50
	}

	taxonomies, err := server.store.GetPopularTaxonomies(c.Request.Context(), int32(limit))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get popular taxonomies"})
		return
	}

	taxonomyResponses := make([]PopularTaxonomyResponse, len(taxonomies))
	for i, taxonomy := range taxonomies {
		taxonomyResponses[i] = toPopularTaxonomyResponse(taxonomy)
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomies": taxonomyResponses,
		"meta": gin.H{
			"limit": limit,
			"count": len(taxonomyResponses),
		},
	})
}

func (server *Server) searchTaxonomies(c *gin.Context) {
	query := c.Query("q")
	if query == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "search query is required"})
		return
	}

	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")
	sortBy := c.DefaultQuery("sort", "name_asc")

	if !isValidTaxonomySortOption(sortBy) {
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

	taxonomies, err := server.store.SearchTaxonomiesByName(c.Request.Context(), db.SearchTaxonomiesByNameParams{
		Column1:     sql.NullString{String: query, Valid: true},
		LimitCount:  int32(limit),
		OffsetCount: int32(offset),
		SortBy:      sortBy,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to search taxonomies"})
		return
	}

	taxonomyResponses := make([]TaxonomyResponse, len(taxonomies))
	for i, taxonomy := range taxonomies {
		taxonomyResponses[i] = toTaxonomyResponse(taxonomy)
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomies": taxonomyResponses,
		"meta": gin.H{
			"query":  query,
			"limit":  limit,
			"offset": offset,
			"count":  len(taxonomyResponses),
			"sort":   sortBy,
		},
	})
}

func (server *Server) updateTaxonomy(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid taxonomy ID"})
		return
	}

	var req UpdateTaxonomyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	existingTaxonomy, err := server.store.GetTaxonomy(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy"})
		return
	}

	if req.Name != "" && req.Name != existingTaxonomy.Name {
		_, err := server.store.GetTaxonomyByName(c.Request.Context(), req.Name)
		if err == nil {
			c.JSON(http.StatusConflict, gin.H{"error": "taxonomy name already exists"})
			return
		}
		if err != sql.ErrNoRows {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check taxonomy name"})
			return
		}
	}

	updateParams := db.UpdateTaxonomyParams{
		ID:          id,
		Name:        existingTaxonomy.Name,
		Description: existingTaxonomy.Description,
	}

	if req.Name != "" {
		updateParams.Name = req.Name
	}
	if req.Description != "" {
		updateParams.Description = req.Description
	}

	updatedTaxonomy, err := server.store.UpdateTaxonomy(c.Request.Context(), updateParams)
	if err != nil {
		if isUniqueViolation(err) {
			c.JSON(http.StatusConflict, gin.H{"error": "taxonomy name already exists"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update taxonomy"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomy": toTaxonomyResponse(updatedTaxonomy),
	})
}

func (server *Server) deleteTaxonomy(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid taxonomy ID"})
		return
	}

	_, err = server.store.GetTaxonomy(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy"})
		return
	}

	postCount, err := server.store.GetTaxonomyPostCount(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check taxonomy usage"})
		return
	}

	forceDelete := c.Query("force") == "true"
	if postCount > 0 && !forceDelete {
		c.JSON(http.StatusConflict, gin.H{
			"error":      "taxonomy is being used by posts",
			"post_count": postCount,
			"message":    "Use ?force=true to delete taxonomy and remove all associations",
		})
		return
	}

	if forceDelete && postCount > 0 {
		err = server.store.DeleteTaxonomyPosts(c.Request.Context(), id)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to remove taxonomy associations"})
			return
		}
	}

	err = server.store.DeleteTaxonomy(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete taxonomy"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "taxonomy deleted successfully",
	})
}

func (server *Server) getTaxonomyPosts(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid taxonomy ID"})
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

	taxonomy, err := server.store.GetTaxonomy(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy"})
		return
	}

	posts, err := server.store.GetTaxonomyPosts(c.Request.Context(), db.GetTaxonomyPostsParams{
		TaxonomyID: id,
		Limit:      int32(limit),
		Offset:     int32(offset),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy posts"})
		return
	}

	postResponses := make([]PostResponse, len(posts))
	for i, post := range posts {
		postResponses[i] = toPostResponse(post)
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomy": toTaxonomyResponse(taxonomy),
		"posts":    postResponses,
		"meta": gin.H{
			"taxonomy_id": id,
			"limit":       limit,
			"offset":      offset,
			"count":       len(postResponses),
		},
	})
}

func (server *Server) getPostTaxonomies(c *gin.Context) {
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

	taxonomies, err := server.store.GetPostTaxonomies(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post taxonomies"})
		return
	}

	taxonomyResponses := make([]TaxonomyResponse, len(taxonomies))
	for i, taxonomy := range taxonomies {
		taxonomyResponses[i] = toTaxonomyResponse(taxonomy)
	}

	c.JSON(http.StatusOK, gin.H{
		"post":       toPostResponse(post),
		"taxonomies": taxonomyResponses,
		"meta": gin.H{
			"post_id": id,
			"count":   len(taxonomyResponses),
		},
	})
}
