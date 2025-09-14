// taxonomy_types_handlers implements CRUD operations for taxonomy type management.
//
// # Taxonomy Types Overview
//
// Taxonomy types define classification systems used throughout the content management system.
// Examples include "category", "tag", "location", "author", etc. Each type configures:
//   - Display behavior (labels, UI visibility)
//   - Structural behavior (hierarchical vs flat)
//   - Access control (public vs private)
//
// # Handler Responsibilities
//
// **Creation (createTaxonomyType)**:
//   - Validates request data and checks for unique name constraints
//   - Creates taxonomy type with configuration options
//   - Returns 409 Conflict for duplicate names, 201 Created on success
//
// **Listing (getTaxonomyTypes)**:
//   - Returns all available taxonomy types with metadata
//   - Public endpoint for discovering available classification systems
//   - Includes count metadata for client pagination support
//
// **Individual Access (getTaxonomyType)**:
//   - Retrieves specific taxonomy type by name identifier
//   - Returns full configuration details for client applications
//   - Returns 404 Not Found for non-existent types
//
// # Uniqueness Constraints
//
// Taxonomy type names must be unique across the system:
//   - Pre-creation validation queries check for existing names
//   - Database-level unique constraints provide final enforcement
//   - Duplicate names return 409 Conflict with descriptive error messages
//
// # Configuration Options
//
// Each taxonomy type supports extensive configuration:
//   - hierarchical: Enables parent-child relationships between terms
//   - public: Controls visibility in public API endpoints
//   - show_ui: Determines admin interface display
//   - show_in_menu: Controls navigation menu inclusion
//
// # Error Handling
//
// Comprehensive error handling for various failure scenarios:
//   - Validation errors: 400 Bad Request with field-specific messages
//   - Duplicate names: 409 Conflict with clear resolution guidance
//   - Database errors: 500 Internal Server Error for system issues
//   - Missing resources: 404 Not Found for non-existent types
package api

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// createTaxonomyType creates a new taxonomy type with the provided configuration.
//
// Validates uniqueness and creates classification system definitions.
// Taxonomy types serve as templates for organizing content through terms.
//
// Request validation:
//   - Name and label are required (2-100 characters)
//   - Name must be unique across all taxonomy types
//   - Description is optional for additional context
//   - Boolean flags control behavior and visibility
//
// Flow:
//  1. Validate request structure and field constraints
//  2. Check for existing taxonomy type with same name
//  3. Create database record with provided configuration
//  4. Return formatted response with created type data
//
// Returns:
//   - 201 Created: Taxonomy type created successfully
//   - 400 Bad Request: Invalid request data or validation failure
//   - 409 Conflict: Taxonomy type name already exists
//   - 500 Internal Server Error: Database or system error
func (server *Server) createTaxonomyType(c *gin.Context) {
	var req CreateTaxonomyTypeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Check for existing taxonomy type with same name
	_, err := server.store.GetTaxonomyType(c.Request.Context(), req.Name)
	if err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "taxonomy type name already exists"})
		return
	}
	if err != sql.ErrNoRows {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check taxonomy type name"})
		return
	}

	// Prepare database creation parameters
	arg := db.CreateTaxonomyTypeParams{
		Name:         req.Name,
		Label:        req.Label,
		Description:  sql.NullString{String: req.Description, Valid: req.Description != ""},
		Hierarchical: req.Hierarchical,
		Public:       req.Public,
		ShowUi:       req.ShowUI,
		ShowInMenu:   req.ShowInMenu,
	}

	// Create taxonomy type in database
	taxonomyType, err := server.store.CreateTaxonomyType(c.Request.Context(), arg)
	if err != nil {
		// Check for database-level unique constraint violation
		if containsString(err.Error(), "duplicate key value") || containsString(err.Error(), "unique constraint") {
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

// getTaxonomyTypes retrieves all available taxonomy types with metadata.
//
// Public endpoint for discovering classification systems available in the CMS.
// Returns comprehensive list of taxonomy types with their configurations.
//
// Response includes:
//   - Array of all taxonomy types with full configuration
//   - Metadata object with total count for client information
//   - Formatted timestamps and boolean configuration flags
//
// Use cases:
//   - Admin interface taxonomy type selection
//   - Client application feature discovery
//   - API documentation and schema generation
//
// Returns:
//   - 200 OK: Successfully retrieved taxonomy types list
//   - 500 Internal Server Error: Database query failure
func (server *Server) getTaxonomyTypes(c *gin.Context) {
	// Query all taxonomy types from database
	taxonomyTypes, err := server.store.ListTaxonomyTypes(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list taxonomy types"})
		return
	}

	// Convert database records to API response format
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

// getTaxonomyType retrieves a specific taxonomy type by name identifier.
//
// Returns detailed configuration for individual taxonomy type.
// Used for client applications needing specific type information.
//
// Path parameters:
//   - name: Taxonomy type name identifier (required)
//
// Response includes:
//   - Full taxonomy type configuration and metadata
//   - Hierarchical and visibility settings
//   - Creation timestamp and administrative flags
//
// Returns:
//   - 200 OK: Successfully retrieved taxonomy type
//   - 400 Bad Request: Missing or invalid name parameter
//   - 404 Not Found: Taxonomy type does not exist
//   - 500 Internal Server Error: Database query failure
func (server *Server) getTaxonomyType(c *gin.Context) {
	name := c.Param("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "taxonomy type name is required"})
		return
	}

	// Query taxonomy type by name
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
