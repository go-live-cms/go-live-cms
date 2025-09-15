// taxonomy_bindings defines request and response structures for taxonomy and content classification endpoints.
//
// # Request Validation Strategy
//
// All request structures include comprehensive gin binding tags for automatic validation:
//   - `required` ensures mandatory fields are present and not empty
//   - `min` and `max` enforce string length constraints for names and descriptions
//   - Type-specific validation for hierarchical relationships and metadata
//
// # Validation Rules & Constraints
//
// **Taxonomy Type Names & Labels**:
//   - Names: 2-100 characters, used as unique identifiers and URL paths
//   - Labels: 2-100 characters, human-readable display names
//   - Descriptions: Optional, no length restrictions for flexibility
//
// **Taxonomy Term Names & Slugs**:
//   - Names: 2-100 characters, display names for terms
//   - Slugs: Optional on creation (auto-generated from name), used in SEO-friendly URLs
//   - Auto-generation: lowercase, spaces and underscores converted to hyphens
//
// **Hierarchical Relationships**:
//   - parent_id: Optional, creates hierarchical term structures
//   - Validation occurs at handler level to verify parent exists and belongs to same type
//   - sort_order: Optional custom ordering within hierarchy levels
//
// **Metadata Support**:
//   - meta: Optional JSON object for extensible term information
//   - Must be valid JSON object structure (validated at handler level)
//   - Supports arbitrary key-value pairs for custom implementations
//
// # Request Structure Patterns
//
// **Create Requests**: Include all required fields plus optional configuration
// **Update Requests**: All fields optional with omitempty tags for partial updates
// **Binding Tags**: Consistent validation rules across all request types
//
// # JSON Field Naming
//
// Follows API-wide snake_case convention for consistency:
//   - taxonomy_type_id for foreign key relationships
//   - parent_id for hierarchical references
//   - sort_order for custom ordering fields
package api

// CreateTaxonomyTypeRequest defines the structure for creating new taxonomy types.
// Used for defining classification systems like "category", "tag", "location", etc.
type CreateTaxonomyTypeRequest struct {
	Name         string `json:"name" binding:"required,min=2,max=100"`
	Label        string `json:"label" binding:"required,min=2,max=100"`
	Description  string `json:"description"`
	Hierarchical bool   `json:"hierarchical"`
	Public       bool   `json:"public"`
	ShowUI       bool   `json:"show_ui"`
	ShowInMenu   bool   `json:"show_in_menu"`
}

// CreateTaxonomyTermRequest defines the structure for creating new taxonomy terms.
// Used for individual classification items within taxonomy types.
type CreateTaxonomyTermRequest struct {
	Name           string                 `json:"name" binding:"required,min=2,max=100"`
	Slug           string                 `json:"slug"`
	Description    string                 `json:"description"`
	ParentID       *int64                 `json:"parent_id,omitempty"`
	TaxonomyTypeID int64                  `json:"taxonomy_type_id" binding:"required"`
	SortOrder      *int32                 `json:"sort_order,omitempty"`
	Meta           map[string]interface{} `json:"meta,omitempty"`
}

// UpdateTaxonomyTermRequest defines the structure for updating existing taxonomy terms.
// All fields are optional to support partial updates with omitempty tags.
type UpdateTaxonomyTermRequest struct {
	Name        string                 `json:"name" binding:"omitempty,min=2,max=100"`
	Slug        string                 `json:"slug"`
	Description string                 `json:"description"`
	ParentID    *int64                 `json:"parent_id"`
	SortOrder   *int32                 `json:"sort_order"`
	Meta        map[string]interface{} `json:"meta"`
}
