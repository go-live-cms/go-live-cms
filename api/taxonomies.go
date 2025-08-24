package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/sqlc-dev/pqtype"
)

type CreateTaxonomyTypeRequest struct {
	Name         string `json:"name" binding:"required,min=2,max=100"`
	Label        string `json:"label" binding:"required,min=2,max=100"`
	Description  string `json:"description"`
	Hierarchical bool   `json:"hierarchical"`
	Public       bool   `json:"public"`
	ShowUI       bool   `json:"show_ui"`
	ShowInMenu   bool   `json:"show_in_menu"`
}

type TaxonomyTypeResponse struct {
	ID           int64  `json:"id"`
	Name         string `json:"name"`
	Label        string `json:"label"`
	Description  string `json:"description"`
	Hierarchical bool   `json:"hierarchical"`
	Public       bool   `json:"public"`
	ShowUI       bool   `json:"show_ui"`
	ShowInMenu   bool   `json:"show_in_menu"`
	CreatedAt    string `json:"created_at"`
}

type CreateTaxonomyTermRequest struct {
	Name           string                 `json:"name" binding:"required,min=2,max=100"`
	Slug           string                 `json:"slug"`
	Description    string                 `json:"description"`
	ParentID       *int64                 `json:"parent_id,omitempty"`
	TaxonomyTypeID int64                  `json:"taxonomy_type_id" binding:"required"`
	SortOrder      *int32                 `json:"sort_order,omitempty"`
	Meta           map[string]interface{} `json:"meta,omitempty"`
}

type UpdateTaxonomyTermRequest struct {
	Name        string                 `json:"name" binding:"omitempty,min=2,max=100"`
	Slug        string                 `json:"slug"`
	Description string                 `json:"description"`
	ParentID    *int64                 `json:"parent_id"`
	SortOrder   *int32                 `json:"sort_order"`
	Meta        map[string]interface{} `json:"meta"`
}

type TaxonomyTermResponse struct {
	ID               int64                  `json:"id"`
	Name             string                 `json:"name"`
	Slug             string                 `json:"slug"`
	Description      string                 `json:"description"`
	ParentID         *int64                 `json:"parent_id,omitempty"`
	TaxonomyTypeID   int64                  `json:"taxonomy_type_id"`
	TaxonomyTypeName string                 `json:"taxonomy_type_name,omitempty"`
	SortOrder        *int32                 `json:"sort_order,omitempty"`
	Meta             map[string]interface{} `json:"meta,omitempty"`
	PostCount        *int64                 `json:"post_count,omitempty"`
	CreatedAt        string                 `json:"created_at"`
}

func toTaxonomyTypeResponse(taxonomyType db.TaxonomyType) TaxonomyTypeResponse {
	return TaxonomyTypeResponse{
		ID:           taxonomyType.ID,
		Name:         taxonomyType.Name,
		Label:        taxonomyType.Label,
		Description:  taxonomyType.Description.String,
		Hierarchical: taxonomyType.Hierarchical,
		Public:       taxonomyType.Public,
		ShowUI:       taxonomyType.ShowUi,
		ShowInMenu:   taxonomyType.ShowInMenu,
		CreatedAt:    taxonomyType.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}
}

func toTaxonomyTermResponse(term db.TaxonomyTerm) TaxonomyTermResponse {
	response := TaxonomyTermResponse{
		ID:             term.ID,
		Name:           term.Name,
		Slug:           term.Slug,
		Description:    term.Description.String,
		TaxonomyTypeID: term.TaxonomyTypeID,
		CreatedAt:      term.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}

	if term.ParentID.Valid {
		response.ParentID = &term.ParentID.Int64
	}

	if term.SortOrder.Valid {
		response.SortOrder = &term.SortOrder.Int32
	}

	if term.Meta.Valid {
		var meta map[string]interface{}
		if err := json.Unmarshal(term.Meta.RawMessage, &meta); err == nil {
			response.Meta = meta
		}
	}

	return response
}

func toTaxonomyTermWithTypeResponse(row db.ListTaxonomyTermsByTypeRow) TaxonomyTermResponse {
	response := TaxonomyTermResponse{
		ID:               row.ID,
		Name:             row.Name,
		Slug:             row.Slug,
		Description:      row.Description.String,
		TaxonomyTypeID:   row.TaxonomyTypeID,
		TaxonomyTypeName: row.TaxonomyTypeName,
		CreatedAt:        row.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}

	if row.ParentID.Valid {
		response.ParentID = &row.ParentID.Int64
	}

	if row.SortOrder.Valid {
		response.SortOrder = &row.SortOrder.Int32
	}

	if row.Meta.Valid {
		var meta map[string]interface{}
		if err := json.Unmarshal(row.Meta.RawMessage, &meta); err == nil {
			response.Meta = meta
		}
	}

	return response
}

func toTaxonomyTermWithCountResponse(row db.GetTaxonomyTermsWithPostCountRow) TaxonomyTermResponse {
	response := TaxonomyTermResponse{
		ID:               row.ID,
		Name:             row.Name,
		Slug:             row.Slug,
		Description:      row.Description.String,
		TaxonomyTypeID:   row.TaxonomyTypeID,
		TaxonomyTypeName: row.TaxonomyTypeName,
		PostCount:        &row.PostCount,
		CreatedAt:        row.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}

	if row.ParentID.Valid {
		response.ParentID = &row.ParentID.Int64
	}

	if row.SortOrder.Valid {
		response.SortOrder = &row.SortOrder.Int32
	}

	if row.Meta.Valid {
		var meta map[string]interface{}
		if err := json.Unmarshal(row.Meta.RawMessage, &meta); err == nil {
			response.Meta = meta
		}
	}

	return response
}

func generateSlug(name string) string {
	slug := strings.ToLower(name)
	slug = strings.ReplaceAll(slug, " ", "-")
	slug = strings.ReplaceAll(slug, "_", "-")
	return slug
}

func isValidTaxonomySortOption(sort string) bool {
	validSorts := []string{
		"name_asc", "name_desc",
		"id_asc", "id_desc",
		"order_asc", "order_desc",
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

func (server *Server) createTaxonomyType(c *gin.Context) {
	var req CreateTaxonomyTypeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	_, err := server.store.GetTaxonomyType(c.Request.Context(), req.Name)
	if err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "taxonomy type name already exists"})
		return
	}
	if err != sql.ErrNoRows {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check taxonomy type name"})
		return
	}

	arg := db.CreateTaxonomyTypeParams{
		Name:         req.Name,
		Label:        req.Label,
		Description:  sql.NullString{String: req.Description, Valid: req.Description != ""},
		Hierarchical: req.Hierarchical,
		Public:       req.Public,
		ShowUi:       req.ShowUI,
		ShowInMenu:   req.ShowInMenu,
	}

	taxonomyType, err := server.store.CreateTaxonomyType(c.Request.Context(), arg)
	if err != nil {
		if isUniqueViolation(err) {
			c.JSON(http.StatusConflict, gin.H{"error": "taxonomy type name already exists"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create taxonomy type"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"taxonomy_type": toTaxonomyTypeResponse(taxonomyType),
	})
}

func (server *Server) getTaxonomyTypes(c *gin.Context) {
	taxonomyTypes, err := server.store.ListTaxonomyTypes(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list taxonomy types"})
		return
	}

	typeResponses := make([]TaxonomyTypeResponse, len(taxonomyTypes))
	for i, taxonomyType := range taxonomyTypes {
		typeResponses[i] = toTaxonomyTypeResponse(taxonomyType)
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomy_types": typeResponses,
		"meta": gin.H{
			"count": len(typeResponses),
		},
	})
}

func (server *Server) getTaxonomyType(c *gin.Context) {
	name := c.Param("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "taxonomy type name is required"})
		return
	}

	taxonomyType, err := server.store.GetTaxonomyType(c.Request.Context(), name)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy type not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy type"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomy_type": toTaxonomyTypeResponse(taxonomyType),
	})
}

func (server *Server) createTaxonomyTerm(c *gin.Context) {
	var req CreateTaxonomyTermRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	slug := req.Slug
	if slug == "" {
		slug = generateSlug(req.Name)
	}

	_, err := server.store.GetTaxonomyTypeByID(c.Request.Context(), req.TaxonomyTypeID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusBadRequest, gin.H{"error": "taxonomy type not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to validate taxonomy type"})
		return
	}

	if req.ParentID != nil {
		_, err := server.store.GetTaxonomyTerm(c.Request.Context(), *req.ParentID)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusBadRequest, gin.H{"error": "parent taxonomy term not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to validate parent taxonomy term"})
			return
		}
	}

	var metaJSON pqtype.NullRawMessage
	if req.Meta != nil {
		metaBytes, err := json.Marshal(req.Meta)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid meta data"})
			return
		}
		metaJSON = pqtype.NullRawMessage{RawMessage: metaBytes, Valid: true}
	}

	arg := db.CreateTaxonomyTermParams{
		Name:           req.Name,
		Slug:           slug,
		Description:    sql.NullString{String: req.Description, Valid: req.Description != ""},
		ParentID:       sql.NullInt64{Int64: 0, Valid: req.ParentID != nil},
		TaxonomyTypeID: req.TaxonomyTypeID,
		SortOrder:      sql.NullInt32{Int32: 0, Valid: req.SortOrder != nil},
		Meta:           metaJSON,
	}

	if req.ParentID != nil {
		arg.ParentID.Int64 = *req.ParentID
	}
	if req.SortOrder != nil {
		arg.SortOrder.Int32 = *req.SortOrder
	}

	taxonomyTerm, err := server.store.CreateTaxonomyTerm(c.Request.Context(), arg)
	if err != nil {
		if isUniqueViolation(err) {
			c.JSON(http.StatusConflict, gin.H{"error": "taxonomy term slug already exists"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create taxonomy term"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"taxonomy_term": toTaxonomyTermResponse(taxonomyTerm),
	})
}

func (server *Server) getTaxonomyTermByID(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid taxonomy term ID"})
		return
	}

	taxonomyTerm, err := server.store.GetTaxonomyTerm(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy term not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy term"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomy_term": toTaxonomyTermResponse(taxonomyTerm),
	})
}

func (server *Server) getTaxonomyTermBySlug(c *gin.Context) {
	slug := c.Param("slug")
	if slug == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "taxonomy term slug is required"})
		return
	}

	taxonomyTerm, err := server.store.GetTaxonomyTermBySlug(c.Request.Context(), slug)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy term not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy term"})
		return
	}

	response := TaxonomyTermResponse{
		ID:               taxonomyTerm.ID,
		Name:             taxonomyTerm.Name,
		Slug:             taxonomyTerm.Slug,
		Description:      taxonomyTerm.Description.String,
		TaxonomyTypeID:   taxonomyTerm.TaxonomyTypeID,
		TaxonomyTypeName: taxonomyTerm.TaxonomyTypeName,
		CreatedAt:        taxonomyTerm.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}

	if taxonomyTerm.ParentID.Valid {
		response.ParentID = &taxonomyTerm.ParentID.Int64
	}

	if taxonomyTerm.SortOrder.Valid {
		response.SortOrder = &taxonomyTerm.SortOrder.Int32
	}

	if taxonomyTerm.Meta.Valid {
		var meta map[string]interface{}
		if err := json.Unmarshal(taxonomyTerm.Meta.RawMessage, &meta); err == nil {
			response.Meta = meta
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomy_term": response,
	})
}

func (server *Server) getTaxonomyTermsByType(c *gin.Context) {
	typeName := c.Param("type")
	if typeName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "taxonomy type name is required"})
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

	_, err = server.store.GetTaxonomyType(c.Request.Context(), typeName)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy type not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy type"})
		return
	}

	taxonomyTerms, err := server.store.ListTaxonomyTermsByType(c.Request.Context(), db.ListTaxonomyTermsByTypeParams{
		Name:        typeName,
		SortBy:      sortBy,
		OffsetCount: int32(offset),
		LimitCount:  int32(limit),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list taxonomy terms"})
		return
	}

	termResponses := make([]TaxonomyTermResponse, len(taxonomyTerms))
	for i, term := range taxonomyTerms {
		termResponses[i] = toTaxonomyTermWithTypeResponse(term)
	}

	totalCount, err := server.store.CountTaxonomyTerms(c.Request.Context(), typeName)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count taxonomy terms"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomy_terms": termResponses,
		"meta": gin.H{
			"taxonomy_type": typeName,
			"limit":         limit,
			"offset":        offset,
			"count":         len(termResponses),
			"total":         totalCount,
			"sort":          sortBy,
		},
	})
}

func (server *Server) getPopularTaxonomyTerms(c *gin.Context) {
	typeName := c.Query("type")
	if typeName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "taxonomy type name is required"})
		return
	}

	limitStr := c.DefaultQuery("limit", "10")

	limit, err := strconv.ParseInt(limitStr, 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 50 {
		limit = 50
	}

	taxonomyTerms, err := server.store.GetPopularTaxonomyTerms(c.Request.Context(), db.GetPopularTaxonomyTermsParams{
		Name:  typeName,
		Limit: int32(limit),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get popular taxonomy terms"})
		return
	}

	termResponses := make([]TaxonomyTermResponse, len(taxonomyTerms))
	for i, term := range taxonomyTerms {
		response := TaxonomyTermResponse{
			ID:               term.ID,
			Name:             term.Name,
			Slug:             term.Slug,
			Description:      term.Description.String,
			TaxonomyTypeID:   term.TaxonomyTypeID,
			TaxonomyTypeName: term.TaxonomyTypeName,
			PostCount:        &term.PostCount,
			CreatedAt:        term.CreatedAt.Format("2006-01-02T15:04:05Z"),
		}

		if term.ParentID.Valid {
			response.ParentID = &term.ParentID.Int64
		}

		if term.SortOrder.Valid {
			response.SortOrder = &term.SortOrder.Int32
		}

		if term.Meta.Valid {
			var meta map[string]interface{}
			if err := json.Unmarshal(term.Meta.RawMessage, &meta); err == nil {
				response.Meta = meta
			}
		}

		termResponses[i] = response
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomy_terms": termResponses,
		"meta": gin.H{
			"taxonomy_type": typeName,
			"limit":         limit,
			"count":         len(termResponses),
		},
	})
}

func (server *Server) searchTaxonomyTerms(c *gin.Context) {
	typeName := c.Query("type")
	if typeName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "taxonomy type name is required"})
		return
	}

	query := c.Query("q")
	if query == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "search query is required"})
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

	taxonomyTerms, err := server.store.SearchTaxonomyTerms(c.Request.Context(), db.SearchTaxonomyTermsParams{
		Name:        typeName,
		Column2:     sql.NullString{String: query, Valid: true},
		OffsetCount: int32(offset),
		LimitCount:  int32(limit),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to search taxonomy terms"})
		return
	}

	termResponses := make([]TaxonomyTermResponse, len(taxonomyTerms))
	for i, term := range taxonomyTerms {
		response := TaxonomyTermResponse{
			ID:               term.ID,
			Name:             term.Name,
			Slug:             term.Slug,
			Description:      term.Description.String,
			TaxonomyTypeID:   term.TaxonomyTypeID,
			TaxonomyTypeName: term.TaxonomyTypeName,
			CreatedAt:        term.CreatedAt.Format("2006-01-02T15:04:05Z"),
		}

		if term.ParentID.Valid {
			response.ParentID = &term.ParentID.Int64
		}

		if term.SortOrder.Valid {
			response.SortOrder = &term.SortOrder.Int32
		}

		if term.Meta.Valid {
			var meta map[string]interface{}
			if err := json.Unmarshal(term.Meta.RawMessage, &meta); err == nil {
				response.Meta = meta
			}
		}

		termResponses[i] = response
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomy_terms": termResponses,
		"meta": gin.H{
			"taxonomy_type": typeName,
			"query":         query,
			"limit":         limit,
			"offset":        offset,
			"count":         len(termResponses),
		},
	})
}

func (server *Server) updateTaxonomyTerm(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid taxonomy term ID"})
		return
	}

	var req UpdateTaxonomyTermRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	existingTerm, err := server.store.GetTaxonomyTerm(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy term not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy term"})
		return
	}

	updateParams := db.UpdateTaxonomyTermParams{
		ID:          id,
		Name:        existingTerm.Name,
		Slug:        existingTerm.Slug,
		Description: existingTerm.Description,
		ParentID:    existingTerm.ParentID,
		SortOrder:   existingTerm.SortOrder,
		Meta:        existingTerm.Meta,
	}

	if req.Name != "" {
		updateParams.Name = req.Name
		if req.Slug == "" {
			updateParams.Slug = generateSlug(req.Name)
		}
	}

	if req.Slug != "" {
		updateParams.Slug = req.Slug
	}

	if req.Description != "" {
		updateParams.Description = sql.NullString{String: req.Description, Valid: true}
	}

	if req.ParentID != nil {
		updateParams.ParentID = sql.NullInt64{Int64: *req.ParentID, Valid: true}
	}

	if req.SortOrder != nil {
		updateParams.SortOrder = sql.NullInt32{Int32: *req.SortOrder, Valid: true}
	}

	if req.Meta != nil {
		metaBytes, err := json.Marshal(req.Meta)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid meta data"})
			return
		}
		updateParams.Meta = pqtype.NullRawMessage{RawMessage: metaBytes, Valid: true}
	}

	updatedTerm, err := server.store.UpdateTaxonomyTerm(c.Request.Context(), updateParams)
	if err != nil {
		if isUniqueViolation(err) {
			c.JSON(http.StatusConflict, gin.H{"error": "taxonomy term slug already exists"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update taxonomy term"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomy_term": toTaxonomyTermResponse(updatedTerm),
	})
}

func (server *Server) deleteTaxonomyTerm(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid taxonomy term ID"})
		return
	}

	_, err = server.store.GetTaxonomyTerm(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy term not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy term"})
		return
	}

	postCount, err := server.store.CountPostsByTaxonomyTerm(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check taxonomy term usage"})
		return
	}

	forceDelete := c.Query("force") == "true"
	if postCount > 0 && !forceDelete {
		c.JSON(http.StatusConflict, gin.H{
			"error":      "taxonomy term is being used by posts",
			"post_count": postCount,
			"message":    "Use ?force=true to delete taxonomy term and remove all associations",
		})
		return
	}

	err = server.store.DeleteTaxonomyTermTx(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete taxonomy term"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "taxonomy term deleted successfully",
	})
}

func (server *Server) getTaxonomyTermPosts(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid taxonomy term ID"})
		return
	}

	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")
	sortBy := c.DefaultQuery("sort", "date_desc")
	status := c.DefaultQuery("status", "")

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

	taxonomyTerm, err := server.store.GetTaxonomyTerm(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy term not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy term"})
		return
	}

	posts, err := server.store.GetPostsByTaxonomyTerm(c.Request.Context(), db.GetPostsByTaxonomyTermParams{
		TaxonomyTermID: id,
		Column2:        status,
		SortBy:         sortBy,
		OffsetCount:    int32(offset),
		LimitCount:     int32(limit),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy term posts"})
		return
	}

	postResponses := make([]PostResponse, len(posts))
	for i, post := range posts {
		postResponses[i] = toPostResponse(post)
	}

	c.JSON(http.StatusOK, gin.H{
		"taxonomy_term": toTaxonomyTermResponse(taxonomyTerm),
		"posts":         postResponses,
		"meta": gin.H{
			"taxonomy_term_id": id,
			"limit":            limit,
			"offset":           offset,
			"count":            len(postResponses),
			"sort":             sortBy,
			"status":           status,
		},
	})
}

func (server *Server) getPostTaxonomyTerms(c *gin.Context) {
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

	taxonomyTerms, err := server.store.GetPostTaxonomyTerms(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post taxonomy terms"})
		return
	}

	termResponses := make([]TaxonomyTermResponse, len(taxonomyTerms))
	for i, term := range taxonomyTerms {
		response := TaxonomyTermResponse{
			ID:               term.ID,
			Name:             term.Name,
			Slug:             term.Slug,
			Description:      term.Description.String,
			TaxonomyTypeID:   term.TaxonomyTypeID,
			TaxonomyTypeName: term.TaxonomyTypeName,
			CreatedAt:        term.CreatedAt.Format("2006-01-02T15:04:05Z"),
		}

		if term.ParentID.Valid {
			response.ParentID = &term.ParentID.Int64
		}

		if term.SortOrder.Valid {
			response.SortOrder = &term.SortOrder.Int32
		}

		if term.Meta.Valid {
			var meta map[string]interface{}
			if err := json.Unmarshal(term.Meta.RawMessage, &meta); err == nil {
				response.Meta = meta
			}
		}

		termResponses[i] = response
	}

	c.JSON(http.StatusOK, gin.H{
		"post":           toPostResponse(post),
		"taxonomy_terms": termResponses,
		"meta": gin.H{
			"post_id": id,
			"count":   len(termResponses),
		},
	})
}
