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
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/sqlc-dev/pqtype"
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
	if !bindJSON(c, &req) {
		return
	}

	// Validate that the taxonomy type exists
	taxonomyType, err := server.store.GetTaxonomyTypeByID(c.Request.Context(), req.TaxonomyTypeID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusBadRequest, gin.H{"error": "taxonomy type not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to validate taxonomy type"})
		return
	}

	// Validate parent term if provided (0 means "no parent", as on update)
	if req.ParentID != nil && *req.ParentID == 0 {
		req.ParentID = nil
	}
	if req.ParentID != nil {
		if !server.checkTermParent(c, taxonomyType, *req.ParentID, 0) {
			return
		}
	}

	// Generate SEO-friendly slug from term name, or normalize the given one
	slug := generateSlug(req.Name)
	if req.Slug != "" {
		slug = generateSlug(req.Slug)
	}
	if slug == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "slug can't be empty"})
		return
	}
	if !server.checkCategorySlug(c, taxonomyType, slug) {
		return
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
			c.JSON(http.StatusConflict, slugTakenResponse)
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
	if !bindJSON(c, &req) {
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
		updateParams.Slug = generateSlug(req.Slug)
	}
	if updateParams.Slug == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "slug can't be empty"})
		return
	}

	// A present but empty description clears it
	if req.Description != nil {
		updateParams.Description = sql.NullString{String: *req.Description, Valid: true}
	}

	parentChanges := req.ParentID != nil && *req.ParentID != 0 &&
		(!existingTerm.ParentID.Valid || existingTerm.ParentID.Int64 != *req.ParentID)
	slugChanges := updateParams.Slug != existingTerm.Slug
	// The type decides the parent rules, the category rules and the redirect (#331).
	var taxonomyType db.TaxonomyType
	if parentChanges || slugChanges {
		taxonomyType, err = server.store.GetTaxonomyTypeByID(c.Request.Context(), existingTerm.TaxonomyTypeID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to validate taxonomy type"})
			return
		}
	}

	// parent_id 0 moves the term to the top level
	if req.ParentID != nil && *req.ParentID == 0 {
		updateParams.ParentID = sql.NullInt64{}
	} else if parentChanges {
		if !server.checkTermParent(c, taxonomyType, *req.ParentID, id) {
			return
		}
		updateParams.ParentID = sql.NullInt64{Int64: *req.ParentID, Valid: true}
	}
	if slugChanges && !server.checkCategorySlug(c, taxonomyType, updateParams.Slug) {
		return
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

	// Execute update in database. A new slug of a term with a public archive also
	// redirects its old URL (#331), in the same transaction.
	var updatedTerm db.TaxonomyTerm
	if slugChanges && taxonomyType.Public {
		updatedTerm, err = server.store.UpdateTaxonomyTermTx(c.Request.Context(), db.UpdateTaxonomyTermTxParams{
			UpdateTaxonomyTermParams: updateParams,
			Redirect: &db.AddRedirectParams{
				FromPath:   termSitePath(taxonomyType.Name, existingTerm.Slug),
				ToPath:     termSitePath(taxonomyType.Name, updateParams.Slug),
				StatusCode: http.StatusMovedPermanently,
				Source:     db.RedirectSourceTerm,
				CreatedBy:  getAuthPayload(c).UserID,
			},
		})
	} else {
		updatedTerm, err = server.store.UpdateTaxonomyTerm(c.Request.Context(), updateParams)
	}
	if err != nil {
		// Handle unique constraint violations (slug conflicts)
		if isUniqueViolation(err) {
			c.JSON(http.StatusConflict, slugTakenResponse)
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

	// Execute transactional deletion with cascade. A category's posts move to the
	// default category; the default itself can't go (#331).
	err = server.store.DeleteTaxonomyTermTx(c.Request.Context(), id)
	if errors.Is(err, db.ErrDefaultTerm) {
		c.JSON(http.StatusConflict, defaultTermResponse)
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete taxonomy term"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "taxonomy term deleted successfully",
	})
}

// addPostTaxonomyTerm handles PUT /posts/:id/taxonomy-terms/:term_id: assigns
// one term to a post. It's idempotent and leaves the post's other terms alone,
// so editors changing different terms at the same time don't overwrite each
// other (PUT /posts/:id with taxonomy_ids replaces the whole set). A category
// replaces the post's category: a post has one (#331); replaced_term_ids says
// which it replaced.
func (server *Server) addPostTaxonomyTerm(c *gin.Context) {
	postID, termID, ok := server.postTermParams(c)
	if !ok {
		return
	}
	if _, err := server.store.GetTaxonomyTerm(c.Request.Context(), termID); err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy term not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy term"})
		return
	}

	result, err := server.store.SetPostTermTx(c.Request.Context(), db.SetPostTermTxParams{PostID: postID, TermID: termID})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to assign taxonomy term"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "taxonomy term assigned", "replaced_term_ids": result.ReplacedTermIDs})
}

// removePostTaxonomyTerm handles DELETE /posts/:id/taxonomy-terms/:term_id.
// Idempotent: removing a term the post doesn't have succeeds. A post of type "post"
// left without a category gets the default one back (#331): default_term_id is set
// when it did.
func (server *Server) removePostTaxonomyTerm(c *gin.Context) {
	postID, termID, ok := server.postTermParams(c)
	if !ok {
		return
	}
	defaultID, err := server.store.RemovePostTermTx(c.Request.Context(), db.SetPostTermTxParams{PostID: postID, TermID: termID})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to remove taxonomy term"})
		return
	}
	var restored *int64
	if defaultID != 0 {
		restored = &defaultID
	}
	c.JSON(http.StatusOK, gin.H{"message": "taxonomy term removed", "default_term_id": restored})
}

// postTermParams parses :id and :term_id and checks that the post exists,
// writing the error response when not.
func (server *Server) postTermParams(c *gin.Context) (postID, termID int64, ok bool) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return 0, 0, false
	}
	termID, err = strconv.ParseInt(c.Param("term_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid taxonomy term ID"})
		return 0, 0, false
	}
	if _, err := server.store.GetPost(c.Request.Context(), postID); err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return 0, 0, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return 0, 0, false
	}
	return postID, termID, true
}

// slugTakenResponse is the 409 body for a duplicate slug. Slugs are unique
// across all taxonomy types; the admin keys its field error off the code.
var slugTakenResponse = gin.H{"error": "taxonomy term slug already exists", "code": "slug_taken"}

// maxTermDepth bounds the ancestor walk in checkTermParent, so a hierarchy
// that is already broken can't keep a request looping.
const maxTermDepth = 100

// checkTermParent validates parentID as the parent of a term of the given type
// and writes the error response when it isn't valid. termID is the term being
// updated (0 on create): a term can't sit under itself or its own descendants.
func (server *Server) checkTermParent(c *gin.Context, taxonomyType db.TaxonomyType, parentID, termID int64) bool {
	if !taxonomyType.Hierarchical {
		c.JSON(http.StatusBadRequest, gin.H{"error": "terms of this taxonomy type can't have a parent"})
		return false
	}
	if parentID == termID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "a term can't be its own parent"})
		return false
	}

	parent, err := server.store.GetTaxonomyTerm(c.Request.Context(), parentID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusBadRequest, gin.H{"error": "parent term not found"})
			return false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to validate parent term"})
		return false
	}
	if parent.TaxonomyTypeID != taxonomyType.ID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "parent term must belong to the same taxonomy type"})
		return false
	}
	// Categories nest one level (#331): under a top-level category only, and a
	// category with children stays top level.
	if taxonomyType.Name == db.CategoryTaxonomy {
		if parent.ParentID.Valid {
			c.JSON(http.StatusBadRequest, gin.H{"error": "categories nest one level: the parent must be a top-level category", "code": "nesting_too_deep"})
			return false
		}
		if termID != 0 {
			children, err := server.store.CountTermChildren(c.Request.Context(), sql.NullInt64{Int64: termID, Valid: true})
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to validate parent term"})
				return false
			}
			if children > 0 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "categories nest one level: a category with subcategories can't have a parent", "code": "nesting_too_deep"})
				return false
			}
		}
	}
	if termID == 0 {
		return true
	}

	// Walk up from the new parent: meeting the term itself means a cycle.
	for depth := 0; parent.ParentID.Valid; depth++ {
		if parent.ParentID.Int64 == termID {
			c.JSON(http.StatusBadRequest, gin.H{"error": "a term can't be moved under one of its own children"})
			return false
		}
		if depth >= maxTermDepth {
			c.JSON(http.StatusBadRequest, gin.H{"error": "the term hierarchy is too deep"})
			return false
		}
		parent, err = server.store.GetTaxonomyTerm(c.Request.Context(), parent.ParentID.Int64)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to validate parent term"})
			return false
		}
	}
	return true
}

// defaultTermResponse is the 409 for deleting or merging away a taxonomy's default
// term (#331: the category type's Uncategorized).
var defaultTermResponse = gin.H{"error": "the default category can't be deleted", "code": "default_term"}

// reservedCategorySlugs are first path segments the public site already uses: a
// category with one of these slugs would never be reached by /:category/:slug (#331).
// Post type and taxonomy names are checked against the database.
var reservedCategorySlugs = map[string]bool{
	"gl-admin": true, "api": true, "uploads": true, "themes": true, "_astro": true,
	"author": true, "search": true, "page": true, "feeds": true, "rss.xml": true,
	"sitemap.xml": true, "robots.txt": true, "login": true, "register": true,
	"forgot-password": true, "reset-password": true, "accept-invite": true,
	"confirm-email": true, "verify-email": true, "taxonomies": true, "users": true,
	"about": true, "test-theme": true, "404": true, "500": true,
}

// checkCategorySlug refuses (400 slug_reserved) a category slug that is another
// public route's first segment. Other taxonomies' slugs are only the second segment
// of /{taxonomy}/{slug}, so anything goes there.
func (server *Server) checkCategorySlug(c *gin.Context, taxonomyType db.TaxonomyType, slug string) bool {
	if taxonomyType.Name != db.CategoryTaxonomy {
		return true
	}
	reserved := reservedCategorySlugs[slug]
	if !reserved {
		taken, err := server.store.IsPostTypeOrTaxonomyName(c.Request.Context(), slug)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to validate slug"})
			return false
		}
		reserved = taken
	}
	if reserved {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":  "this slug is used by another part of the site: category URLs would never reach their posts",
			"code":   "slug_reserved",
			"fields": gin.H{"slug": "is used by another part of the site"},
		})
		return false
	}
	return true
}

// MergeTaxonomyTermsRequest is POST /taxonomy/terms/:id/merge: the terms merged into
// :id, the one kept.
type MergeTaxonomyTermsRequest struct {
	SourceIDs []int64 `json:"source_ids" binding:"required,min=1,max=100,dive,gt=0"`
}

// mergeTaxonomyTerms handles POST /taxonomy/terms/:id/merge (#331; editors and
// admins): every post with a source term gets :id instead (the published sets too,
// so the site follows at once), the sources are deleted, and each source's archive
// URL redirects to the kept term's. Flat taxonomies only (tags): a category tree's
// children and the one-category rule make a category merge a different operation.
func (server *Server) mergeTaxonomyTerms(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid taxonomy term ID"})
		return
	}
	var req MergeTaxonomyTermsRequest
	if !bindJSON(c, &req) {
		return
	}
	ctx := c.Request.Context()
	target, err := server.store.GetTaxonomyTerm(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy term not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy term"})
		return
	}
	taxonomyType, err := server.store.GetTaxonomyTypeByID(ctx, target.TaxonomyTypeID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy type"})
		return
	}
	if taxonomyType.Hierarchical {
		c.JSON(http.StatusBadRequest, gin.H{"error": "only terms of a flat taxonomy, such as tags, can be merged", "code": "merge_not_supported"})
		return
	}

	var sources []db.TaxonomyTerm
	seen := map[int64]bool{}
	for _, sourceID := range req.SourceIDs {
		if sourceID == id {
			c.JSON(http.StatusBadRequest, gin.H{"error": "a term can't be merged into itself", "code": "merge_into_itself"})
			return
		}
		if seen[sourceID] {
			continue
		}
		seen[sourceID] = true
		source, err := server.store.GetTaxonomyTerm(ctx, sourceID)
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy term not found", "term_id": sourceID})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get taxonomy term"})
			return
		}
		if source.TaxonomyTypeID != target.TaxonomyTypeID {
			c.JSON(http.StatusBadRequest, gin.H{"error": "terms of different taxonomies can't be merged", "code": "merge_type_mismatch"})
			return
		}
		sources = append(sources, source)
	}

	caller := getAuthPayload(c).UserID
	arg := db.MergeTaxonomyTermsTxParams{TargetID: target.ID}
	for _, source := range sources {
		arg.SourceIDs = append(arg.SourceIDs, source.ID)
		if taxonomyType.Public {
			arg.Redirects = append(arg.Redirects, &db.AddRedirectParams{
				FromPath:   termSitePath(taxonomyType.Name, source.Slug),
				ToPath:     termSitePath(taxonomyType.Name, target.Slug),
				StatusCode: http.StatusMovedPermanently,
				Source:     db.RedirectSourceMerge,
				CreatedBy:  caller,
			})
		}
	}
	result, err := server.store.MergeTaxonomyTermsTx(ctx, arg)
	switch {
	case errors.Is(err, db.ErrDefaultTerm):
		c.JSON(http.StatusConflict, gin.H{"error": "the default term can't be merged away", "code": "default_term"})
		return
	case errors.Is(err, db.ErrMergeSource):
		c.JSON(http.StatusBadRequest, gin.H{"error": "terms of different taxonomies can't be merged", "code": "merge_type_mismatch"})
		return
	case errors.Is(err, sql.ErrNoRows):
		c.JSON(http.StatusNotFound, gin.H{"error": "taxonomy term not found"})
		return
	case err != nil:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to merge taxonomy terms"})
		return
	}

	server.recordRequestActivity(c, activityEvent{
		Verb:       db.ActivityTermsMerged,
		ObjectType: db.ActivityObjectTerm,
		ObjectID:   target.ID,
		Payload:    map[string]any{"source_ids": result.MergedIDs, "moved_posts": result.MovedPosts, "taxonomy": taxonomyType.Name},
	})
	redirects := make([]RedirectResponse, len(result.Redirects))
	author := server.redirectAuthor(c, caller)
	for i, r := range result.Redirects {
		redirects[i] = toRedirectResponse(r, author)
	}
	mergedIDs := result.MergedIDs
	if mergedIDs == nil {
		mergedIDs = []int64{}
	}
	c.JSON(http.StatusOK, gin.H{
		"taxonomy_term": toTaxonomyTermResponse(result.Target),
		"merged_ids":    mergedIDs,
		"moved_posts":   result.MovedPosts,
		"redirects":     redirects,
	})
}
