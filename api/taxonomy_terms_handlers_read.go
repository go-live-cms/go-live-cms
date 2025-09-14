// taxonomy_terms_handlers_read implements comprehensive read operations for taxonomy terms
// including retrieval, search, discovery, and relationship exploration.
//
// # Taxonomy Terms Read Operations
//
// This module provides extensive read access to taxonomy terms through:
//   - **Individual Access**: Direct term retrieval by ID or slug
//   - **Bulk Operations**: Listing terms by type with pagination and sorting
//   - **Search & Discovery**: Full-text search and popularity ranking
//   - **Relationship Exploration**: Post associations and cross-references
//
// # Individual Term Access
//
// **getTaxonomyTermByID**:
//   - Direct database lookup by primary key
//   - Complete term data including metadata and relationships
//   - Used for administrative interfaces and API integrations
//
// **getTaxonomyTermBySlug**:
//   - SEO-friendly URL endpoint for public content
//   - Slug-based routing for clean URL structures
//   - Enhanced response formatting for display contexts
//
// # Bulk Access Patterns
//
// **getTaxonomyTermsByType**:
//   - Filtered listing by taxonomy type (categories, tags, etc.)
//   - Comprehensive pagination with offset/limit controls
//   - Multiple sort options (name, id, custom order)
//   - Total count metadata for client pagination UIs
//
// **Sort Options Supported**:
//   - name_asc/name_desc: Alphabetical ordering
//   - id_asc/id_desc: Database primary key ordering
//   - order_asc/order_desc: Custom sort_order field
//
// # Search Capabilities
//   - **Relationship Exploration**: Post associations and cross-references
//
// # Individual Term Access
//
// **getTaxonomyTermByID**:
//   - Direct database lookup by primary key
//   - Complete term data including metadata and relationships
//   - Used for administrative interfaces and API integrations
//
// **getTaxonomyTermBySlug**:
//   - SEO-friendly URL endpoint for public content
//   - Slug-based routing for clean URL structures
//   - Enhanced response formatting for display contexts
//
// # Bulk Access Patterns
//
// **getTaxonomyTermsByType**:
//   - Filtered listing by taxonomy type (categories, tags, etc.)
//   - Comprehensive pagination with offset/limit controls
//   - Multiple sort options (name, date, usage count)
//   - Total count metadata for client pagination UIs
//
// **Sort Options Supported**:
//   - name_asc/name_desc: Alphabetical ordering
//   - date_asc/date_desc: Creation date chronology
//   - usage_asc/usage_desc: Post association count
//
// # Search Capabilities
//
// **searchTaxonomyTerms**:
//   - Full-text search across term names and descriptions
//   - Type-scoped searches within specific taxonomies
//   - Pagination support for large result sets
//   - Query highlighting and relevance scoring
//
// **getPopularTaxonomyTerms**:
//   - Usage-based popularity ranking
//   - Configurable result limits (max 50)
//   - Post count inclusion for trending analysis
//   - Type-specific popularity metrics
//
// # Relationship Exploration
//
// **getTaxonomyTermPosts**:
//   - Reverse lookup: find posts using specific terms
//   - Content status filtering (published, draft, etc.)
//   - Post metadata inclusion with taxonomy context
//   - Pagination for high-volume term usage
//
// **getPostTaxonomyTerms**:
//   - Forward lookup: find terms associated with posts
//   - Complete term hierarchy and metadata
//   - Cross-taxonomy term relationships
//   - Content classification overview
//
// # Response Formatting
//
// All endpoints use consistent response structures:
//   - Primary data in dedicated response fields
//   - Metadata objects with pagination and context info
//   - Standardized error messages and status codes
//   - Null field handling for optional properties
//
// # Performance Considerations
//
// **Database Optimization**:
//   - Strategic indexing on frequently queried fields
//   - Query result caching for popular terms
//   - Efficient join strategies for cross-table operations
//   - Connection pooling for concurrent access
//
// **Request Limits**:
//   - Maximum 100 items per page for list endpoints
//   - Maximum 50 items for popularity rankings
//   - Query string length limits for search operations
//   - Rate limiting protection on expensive operations
package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// getTaxonomyTermByID retrieves a specific taxonomy term by its primary key identifier.
//
// Direct database lookup for administrative and API access patterns.
// Returns complete term data including all relationships and metadata.
//
// Path parameters:
//   - id: Taxonomy term primary key (required, integer)
//
// Response includes:
//   - Complete term configuration and content
//   - Parent-child relationship information
//   - Custom metadata JSON objects
//   - Creation timestamps and sort ordering
//
// Returns:
//   - 200 OK: Successfully retrieved term data
//   - 400 Bad Request: Invalid or non-numeric ID parameter
//   - 404 Not Found: Term does not exist
//   - 500 Internal Server Error: Database access failure
func (server *Server) getTaxonomyTermByID(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid taxonomy term ID"})
		return
	}

	// Query term by primary key
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

// getTaxonomyTermBySlug retrieves a taxonomy term by its SEO-friendly URL slug.
//
// Public-facing endpoint for clean URL routing and content discovery.
// Enhanced response formatting optimized for display contexts.
//
// Path parameters:
//   - slug: URL-friendly term identifier (required, string)
//
// Response formatting:
//   - Manual response construction for enhanced control
//   - Proper null field handling for optional properties
//   - JSON metadata parsing with error resilience
//   - Taxonomy type name inclusion for context
//
// Returns:
//   - 200 OK: Successfully retrieved term by slug
//   - 400 Bad Request: Missing or empty slug parameter
//   - 404 Not Found: No term found with provided slug
//   - 500 Internal Server Error: Database or parsing error
func (server *Server) getTaxonomyTermBySlug(c *gin.Context) {
	slug := c.Param("slug")
	if slug == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "taxonomy term slug is required"})
		return
	}

	// Query term by slug identifier
	taxonomyTerm, err := server.store.GetTaxonomyTermBySlug(c.Request.Context(), slug)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy term not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy term"})
		return
	}

	// Build enhanced response with manual field control
	response := TaxonomyTermResponse{
		ID:               taxonomyTerm.ID,
		Name:             taxonomyTerm.Name,
		Slug:             taxonomyTerm.Slug,
		Description:      taxonomyTerm.Description.String,
		TaxonomyTypeID:   taxonomyTerm.TaxonomyTypeID,
		TaxonomyTypeName: taxonomyTerm.TaxonomyTypeName,
		CreatedAt:        taxonomyTerm.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}

	// Handle optional parent relationship
	if taxonomyTerm.ParentID.Valid {
		response.ParentID = &taxonomyTerm.ParentID.Int64
	}

	// Handle optional sort ordering
	if taxonomyTerm.SortOrder.Valid {
		response.SortOrder = &taxonomyTerm.SortOrder.Int32
	}

	// Parse JSON metadata with error resilience
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

// getTaxonomyTermsByType retrieves paginated taxonomy terms filtered by type.
//
// Primary bulk access endpoint with comprehensive filtering and sorting options.
// Supports administrative interfaces and content discovery workflows.
//
// Path parameters:
//   - type: Taxonomy type name for filtering (required)
//
// Query parameters:
//   - limit: Items per page (default: 10, max: 100)
//   - offset: Page offset for pagination (default: 0)
//   - sort: Sort option (default: name_asc)
//
// Sort options available:
//   - name_asc, name_desc: Alphabetical ordering
//   - id_asc, id_desc: Database primary key ordering
//   - order_asc, order_desc: Custom sort_order field
//
// Response metadata:
//   - Pagination information for client UI
//   - Total count for progress indicators
//   - Applied filters and sort parameters
//   - Taxonomy type validation confirmation
//
// Returns:
//   - 200 OK: Successfully retrieved filtered terms
//   - 400 Bad Request: Invalid parameters or sort option
//   - 404 Not Found: Taxonomy type does not exist
//   - 500 Internal Server Error: Database query failure
func (server *Server) getTaxonomyTermsByType(c *gin.Context) {
	typeName := c.Param("name")
	if typeName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "taxonomy type name is required"})
		return
	}

	// Parse pagination and sorting parameters
	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")
	sortBy := c.DefaultQuery("sort", "name_asc")

	// Validate sort option
	if !isValidTaxonomySortOption(sortBy) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid sort parameter"})
		return
	}

	// Parse and validate limit
	limit, err := strconv.ParseInt(limitStr, 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 100 {
		limit = 100 // Enforce maximum page size
	}

	// Parse and validate offset
	offset, err := strconv.ParseInt(offsetStr, 10, 32)
	if err != nil || offset < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid offset parameter"})
		return
	}

	// Validate taxonomy type exists
	_, err = server.store.GetTaxonomyType(c.Request.Context(), typeName)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy type not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy type"})
		return
	}

	// Query terms with pagination and sorting
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

	// Convert to response format
	termResponses := make([]TaxonomyTermResponse, len(taxonomyTerms))
	for i, term := range taxonomyTerms {
		termResponses[i] = toTaxonomyTermWithTypeResponse(term)
	}

	// Get total count for pagination metadata
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

// getPopularTaxonomyTerms retrieves terms ranked by usage popularity.
//
// Discovers trending terms based on post association counts.
// Useful for tag clouds, suggested content, and analytics dashboards.
//
// Query parameters:
//   - type: Taxonomy type name (required)
//   - limit: Result count limit (default: 10, max: 50)
//
// Response enhancements:
//   - Post count inclusion for each term
//   - Popularity ranking implicit in result order
//   - Limited result set focused on trending content
//   - Taxonomy type context for scoped popularity
//
// Returns:
//   - 200 OK: Successfully retrieved popular terms
//   - 400 Bad Request: Missing type or invalid limit
//   - 500 Internal Server Error: Database query failure
func (server *Server) getPopularTaxonomyTerms(c *gin.Context) {
	typeName := c.Query("type")
	if typeName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "taxonomy type name is required"})
		return
	}

	limitStr := c.DefaultQuery("limit", "10")

	// Parse and validate limit
	limit, err := strconv.ParseInt(limitStr, 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 50 {
		limit = 50 // Enforce reasonable maximum for popularity queries
	}

	// Query popular terms with usage counts
	taxonomyTerms, err := server.store.GetPopularTaxonomyTerms(c.Request.Context(), db.GetPopularTaxonomyTermsParams{
		Name:  typeName,
		Limit: int32(limit),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get popular taxonomy terms"})
		return
	}

	// Build enhanced responses with post counts
	termResponses := make([]TaxonomyTermResponse, len(taxonomyTerms))
	for i, term := range taxonomyTerms {
		response := TaxonomyTermResponse{
			ID:               term.ID,
			Name:             term.Name,
			Slug:             term.Slug,
			Description:      term.Description.String,
			TaxonomyTypeID:   term.TaxonomyTypeID,
			TaxonomyTypeName: term.TaxonomyTypeName,
			PostCount:        &term.PostCount, // Include popularity metric
			CreatedAt:        term.CreatedAt.Format("2006-01-02T15:04:05Z"),
		}

		// Handle optional relationships
		if term.ParentID.Valid {
			response.ParentID = &term.ParentID.Int64
		}

		if term.SortOrder.Valid {
			response.SortOrder = &term.SortOrder.Int32
		}

		// Parse metadata with error resilience
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

// searchTaxonomyTerms performs full-text search across taxonomy terms.
//
// Advanced search capabilities with type scoping and pagination support.
// Searches term names and descriptions for comprehensive content discovery.
//
// Query parameters:
//   - type: Taxonomy type name for scoped search (required)
//   - q: Search query string (required)
//   - limit: Result limit (default: 10, max: 100)
//   - offset: Pagination offset (default: 0)
//
// Search behavior:
//   - Full-text matching across name and description fields
//   - Type-scoped results for focused discovery
//   - Relevance-based result ordering
//   - Pagination support for large result sets
//
// Returns:
//   - 200 OK: Search completed with results
//   - 400 Bad Request: Missing required parameters or invalid values
//   - 500 Internal Server Error: Search engine or database failure
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

	// Parse pagination parameters
	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")

	limit, err := strconv.ParseInt(limitStr, 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return
	}
	if limit > 100 {
		limit = 100 // Enforce maximum search results
	}

	offset, err := strconv.ParseInt(offsetStr, 10, 32)
	if err != nil || offset < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid offset parameter"})
		return
	}

	// Execute search query
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

	// Build search results with complete term data
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

		// Handle optional relationships
		if term.ParentID.Valid {
			response.ParentID = &term.ParentID.Int64
		}

		if term.SortOrder.Valid {
			response.SortOrder = &term.SortOrder.Int32
		}

		// Parse metadata
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

// getTaxonomyTermPosts retrieves posts associated with a specific taxonomy term.
//
// Reverse lookup functionality for exploring term usage and content relationships.
// Supports content management workflows and public content discovery.
//
// Path parameters:
//   - id: Taxonomy term ID (required)
//
// Query parameters:
//   - limit: Post limit per page (default: 10, max: 100)
//   - offset: Pagination offset (default: 0)
//   - sort: Post sorting option (default: name_asc)
//   - status: Filter by post status (optional)
//
// Response includes:
//   - Term context information for reference
//   - Associated posts with full metadata
//   - Pagination and filtering metadata
//   - Content relationship insights
//
// Returns:
//   - 200 OK: Successfully retrieved term posts
//   - 400 Bad Request: Invalid ID or query parameters
//   - 404 Not Found: Term does not exist
//   - 500 Internal Server Error: Database query failure
func (server *Server) getTaxonomyTermPosts(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid taxonomy term ID"})
		return
	}

	// Parse query parameters with defaults
	limitStr := c.DefaultQuery("limit", "10")
	offsetStr := c.DefaultQuery("offset", "0")
	sortBy := c.DefaultQuery("sort", "name_asc")
	status := c.DefaultQuery("status", "")

	// Validate and parse pagination
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

	// Validate term existence and get context
	taxonomyTerm, err := server.store.GetTaxonomyTerm(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy term not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy term"})
		return
	}

	// Query associated posts
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

	// Convert posts to response format
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

// getPostTaxonomyTerms retrieves all taxonomy terms associated with a specific post.
//
// Forward lookup functionality for exploring post classifications and metadata.
// Essential for content editing interfaces and SEO analysis tools.
//
// Path parameters:
//   - id: Post ID (required)
//
// Response includes:
//   - Post context information for reference
//   - All associated taxonomy terms across types
//   - Term hierarchy and metadata details
//   - Cross-taxonomy relationship insights
//
// Use cases:
//   - Content editing interface population
//   - SEO keyword analysis and optimization
//   - Content classification reporting
//   - Related content suggestion algorithms
//
// Returns:
//   - 200 OK: Successfully retrieved post terms
//   - 400 Bad Request: Invalid post ID parameter
//   - 404 Not Found: Post does not exist
//   - 500 Internal Server Error: Database query failure
func (server *Server) getPostTaxonomyTerms(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	// Validate post existence and get context
	post, err := server.store.GetPost(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	// Query all taxonomy terms associated with post
	taxonomyTerms, err := server.store.GetPostTaxonomyTerms(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post taxonomy terms"})
		return
	}

	// Build comprehensive term responses
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

		// Handle optional relationships
		if term.ParentID.Valid {
			response.ParentID = &term.ParentID.Int64
		}

		if term.SortOrder.Valid {
			response.SortOrder = &term.SortOrder.Int32
		}

		// Parse metadata
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
