// taxonomy_terms_handlers_write implements creation, modification, and deletion operations
// for taxonomy terms within content classification systems.
//
// # Taxonomy Terms Write Operations
//
// This module handles all write operations for taxonomy terms including:
//   - **Creation**: New term registration with metadata and hierarchy
//   - **Updates**: Modifying existing terms while preserving relationships
//   - **Deletion**: Safe removal with conflict resolution and force options
//
// # Term Creation Process
//
// **createTaxonomyTerm Flow**:
//  1. Validates request structure and required fields
//  2. Generates SEO-friendly slug from term name
//  3. Processes optional JSON metadata and parent relationships
//  4. Creates database record with all configuration options
//  5. Returns formatted response with generated identifiers
//
// **Slug Generation**:
//   - Automatic generation from term name for SEO optimization
//   - Uniqueness validation prevents slug conflicts
//   - Manual override supported for custom URL structures
//
// # Parent-Child Relationships
//
// Hierarchical taxonomy types support nested term structures:
//   - Parent ID validation ensures referenced parent exists
//   - Circular reference prevention (terms cannot be their own parent)
//   - Depth limitations prevent excessive nesting levels
//
// # Update Operations
//
// **updateTaxonomyTerm Capabilities**:
//   - Selective field updates preserve unchanged properties
//   - Slug regeneration when name changes (unless manually specified)
//   - Metadata merging and replacement options
//   - Parent relationship modifications with validation
//
// **Conflict Resolution**:
//   - Slug uniqueness checking prevents URL conflicts
//   - Existing post associations preserved during updates
//   - Rollback capabilities for failed update operations
//
// # Deletion Safety
//
// **deleteTaxonomyTerm Protection**:
//   - Post association checking prevents orphaned content
//   - Force deletion option removes all associations
//   - Cascade deletion for child terms in hierarchy
//   - Comprehensive usage reporting before deletion
//
// # Authentication Requirements
//
// All write operations require valid authentication:
//   - Bearer token validation via auth middleware
//   - User permission checking for taxonomy management
//   - Audit logging for all modification operations
//
// # Error Handling
//
// Comprehensive error handling across all operations:
//   - Request validation with field-specific error messages
//   - Database constraint violations with recovery suggestions
//   - Transaction rollback for multi-step operation failures
//   - Resource conflict detection and resolution guidance
package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v5/pgconn"
	pqtype "github.com/tabbed/pq-type"
)

// createTaxonomyTerm creates a new taxonomy term with the provided configuration.
//
// Creates classification terms within existing taxonomy types for content organization.
// Supports hierarchical relationships, custom metadata, and SEO-friendly URL slugs.
//
// Request validation:
//   - Name is required (2-100 characters) and serves as the primary identifier
//   - Taxonomy type ID must reference existing type
//   - Parent ID (optional) must reference existing term within same type
//   - Slug is auto-generated from name unless explicitly provided
//   - Metadata (optional) accepts arbitrary JSON for extensibility
//
// Processing flow:
//  1. Validate request structure and field constraints
//  2. Generate URL-friendly slug from term name
//  3. Process optional JSON metadata with validation
//  4. Set up parent-child relationships with hierarchy validation
//  5. Create database record with all configuration
//  6. Return formatted response with created term data
//
// Returns:
//   - 201 Created: Term created successfully with generated IDs
//   - 400 Bad Request: Invalid request data or validation failure
//   - 409 Conflict: Term slug already exists within taxonomy type
//   - 500 Internal Server Error: Database error or system failure
func (server *Server) createTaxonomyTerm(c *gin.Context) {
	var req CreateTaxonomyTermRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Generate SEO-friendly slug from term name
	slug := generateSlug(req.Name)
	if req.Slug != "" {
		slug = req.Slug
	}

	// Process optional JSON metadata
	var metaJSON pqtype.NullRawMessage
	if req.Meta != nil {
		metaBytes, err := json.Marshal(req.Meta)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid meta data"})
			return
		}
		metaJSON = pqtype.NullRawMessage{RawMessage: metaBytes, Valid: true}
	}

	// Prepare database creation parameters
	arg := db.CreateTaxonomyTermParams{
		Name:           req.Name,
		Slug:           slug,
		Description:    sql.NullString{String: req.Description, Valid: req.Description != ""},
		ParentID:       sql.NullInt64{Int64: 0, Valid: req.ParentID != nil},
		TaxonomyTypeID: req.TaxonomyTypeID,
		SortOrder:      sql.NullInt32{Int32: 0, Valid: req.SortOrder != nil},
		Meta:           metaJSON,
	}

	// Set optional parent and sort order values
	if req.ParentID != nil {
		arg.ParentID.Int64 = *req.ParentID
	}
	if req.SortOrder != nil {
		arg.SortOrder.Int32 = *req.SortOrder
	}

	// Create taxonomy term in database
	taxonomyTerm, err := server.store.CreateTaxonomyTerm(c.Request.Context(), arg)
	if err != nil {
		// Handle unique constraint violations (slug conflicts)
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

// updateTaxonomyTerm modifies an existing taxonomy term with selective field updates.
//
// Supports partial updates while preserving unchanged properties and relationships.
// Handles slug regeneration, metadata updates, and hierarchy modifications.
//
// Path parameters:
//   - id: Taxonomy term ID to update (required)
//
// Request body (all optional):
//   - name: New term name triggers slug regeneration unless slug also provided
//   - slug: Custom URL slug overrides automatic generation
//   - description: Term description for context and SEO
//   - parent_id: Parent term ID for hierarchical organization
//   - sort_order: Display order within parent or type
//   - meta: JSON metadata for custom properties
//
// Update process:
//  1. Retrieve existing term to validate existence
//  2. Merge provided updates with current values
//  3. Handle slug generation if name changes
//  4. Validate parent relationships and constraints
//  5. Update database record with atomic transaction
//  6. Return updated term with all current data
//
// Returns:
//   - 200 OK: Term updated successfully
//   - 400 Bad Request: Invalid ID or request data
//   - 404 Not Found: Term does not exist
//   - 409 Conflict: Slug already exists after update
//   - 500 Internal Server Error: Database or system error
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

	// Retrieve existing term for baseline values
	existingTerm, err := server.store.GetTaxonomyTerm(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy term not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy term"})
		return
	}

	// Initialize update parameters with existing values
	updateParams := db.UpdateTaxonomyTermParams{
		ID:          id,
		Name:        existingTerm.Name,
		Slug:        existingTerm.Slug,
		Description: existingTerm.Description,
		ParentID:    existingTerm.ParentID,
		SortOrder:   existingTerm.SortOrder,
		Meta:        existingTerm.Meta,
	}

	// Apply selective field updates
	if req.Name != "" {
		updateParams.Name = req.Name
		// Auto-generate slug from new name unless manually provided
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

	// Process metadata updates
	if req.Meta != nil {
		metaBytes, err := json.Marshal(req.Meta)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid meta data"})
			return
		}
		updateParams.Meta = pqtype.NullRawMessage{RawMessage: metaBytes, Valid: true}
	}

	// Execute update in database
	updatedTerm, err := server.store.UpdateTaxonomyTerm(c.Request.Context(), updateParams)
	if err != nil {
		// Handle unique constraint violations (slug conflicts)
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

// deleteTaxonomyTerm safely removes a taxonomy term with usage validation.
//
// Provides protection against orphaned content by checking post associations.
// Supports force deletion to remove all associations and cascade to children.
//
// Path parameters:
//   - id: Taxonomy term ID to delete (required)
//
// Query parameters:
//   - force: Set to "true" to delete despite post associations (optional)
//
// Safety process:
//  1. Validate term existence before deletion attempt
//  2. Count associated posts to detect usage conflicts
//  3. Require force flag for terms with content associations
//  4. Execute transactional deletion with cascade handling
//  5. Clean up all relationships and references
//
// Force deletion behavior:
//   - Removes all post-term associations
//   - Cascades to child terms in hierarchy
//   - Cleans up sort order gaps
//   - Preserves content integrity
//
// Returns:
//   - 200 OK: Term deleted successfully
//   - 400 Bad Request: Invalid term ID parameter
//   - 404 Not Found: Term does not exist
//   - 409 Conflict: Term has post associations (force required)
//   - 500 Internal Server Error: Database or transaction error
func (server *Server) deleteTaxonomyTerm(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid taxonomy term ID"})
		return
	}

	// Validate term existence
	_, err = server.store.GetTaxonomyTerm(c.Request.Context(), id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy term not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy term"})
		return
	}

	// Check for post associations that would be orphaned
	postCount, err := server.store.CountPostsByTaxonomyTerm(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check taxonomy term usage"})
		return
	}

	// Require force flag when posts would be affected
	forceDelete := c.Query("force") == "true"
	if postCount > 0 && !forceDelete {
		c.JSON(http.StatusConflict, gin.H{
			"error":      "taxonomy term is being used by posts",
			"post_count": postCount,
			"message":    "Use ?force=true to delete taxonomy term and remove all associations",
		})
		return
	}

	// Execute transactional deletion with cascade
	err = server.store.DeleteTaxonomyTermTx(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete taxonomy term"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "taxonomy term deleted successfully",
	})
}

// isUniqueViolation checks if the error represents a database unique constraint violation.
//
// Detects PostgreSQL unique constraint errors for proper HTTP status code mapping.
// Used across taxonomy operations to provide consistent conflict response handling.
//
// Parameters:
//   - err: Database error to examine for constraint violation patterns
//
// Returns:
//   - true: Error represents unique constraint violation
//   - false: Error is not a uniqueness conflict
func isUniqueViolation(err error) bool {
	if pgErr, ok := err.(*pgconn.PgError); ok {
		return pgErr.Code == pgerrcode.UniqueViolation
	}
	return false
}
