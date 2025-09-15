// taxonomy_presenters handles response formatting and data transformation for taxonomy endpoints.
//
// # Response Transformation Strategy
//
// Transforms internal database models into client-facing JSON responses:
//   - Maps database field names to consistent API JSON field names
//   - Handles nullable database fields with appropriate Go pointer/option patterns
//   - Marshals complex data types (pqtype.NullRawMessage) to standard JSON
//   - Excludes internal database metadata not relevant to API consumers
//
// # Nullable Field Handling
//
// Database nullable fields are handled consistently:
//   - sql.NullString → string (empty string if null)
//   - sql.NullInt64 → *int64 (nil if null, pointer to value if present)
//   - sql.NullInt32 → *int32 (nil if null, pointer to value if present)
//   - pqtype.NullRawMessage → map[string]interface{} (nil if null, unmarshaled JSON if present)
//
// # JSON Field Naming & Consistency
//
// All response structures follow snake_case naming convention:
//   - taxonomy_type_id for foreign key references
//   - taxonomy_type_name for joined display names
//   - post_count for aggregated statistics
//   - created_at for timestamps (formatted as RFC3339 strings)
//
// # Response Enrichment
//
// Some presenters enrich responses with additional context:
//   - TaxonomyTermResponse includes type name when available from joins
//   - Terms with post count include usage statistics
//   - Hierarchical information preserved through parent_id references
//
// # Database Row Type Support
//
// Supports conversion from multiple sqlc-generated row types:
//   - db.TaxonomyType → TaxonomyTypeResponse
//   - db.TaxonomyTerm → TaxonomyTermResponse
//   - db.ListTaxonomyTermsByTypeRow → TaxonomyTermResponse (with type name)
//   - db.GetTaxonomyTermsWithPostCountRow → TaxonomyTermResponse (with post count)
//   - Various query-specific row types with appropriate field mappings
package api

import (
	"encoding/json"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// TaxonomyTypeResponse represents a taxonomy type for API consumption.
// Includes configuration and display options for taxonomy classification systems.
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

// TaxonomyTermResponse represents a taxonomy term for API consumption.
// Includes hierarchical relationships, metadata, and optional enrichment data.
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

// toTaxonomyTypeResponse converts database taxonomy type record to API response format.
// Handles nullable description field and formats timestamp for API consistency.
func toTaxonomyTypeResponse(taxonomyType db.TaxonomyType) TaxonomyTypeResponse {
	return TaxonomyTypeResponse{
		ID:           taxonomyType.ID,
		Name:         taxonomyType.Name,
		Label:        taxonomyType.Label,
		Description:  taxonomyType.Description.String, // Handle sql.NullString
		Hierarchical: taxonomyType.Hierarchical,
		Public:       taxonomyType.Public,
		ShowUI:       taxonomyType.ShowUi,
		ShowInMenu:   taxonomyType.ShowInMenu,
		CreatedAt:    taxonomyType.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}
}

// toTaxonomyTermResponse converts database taxonomy term record to API response format.
// Handles all nullable fields and marshals JSON metadata to map structure.
func toTaxonomyTermResponse(term db.TaxonomyTerm) TaxonomyTermResponse {
	response := TaxonomyTermResponse{
		ID:             term.ID,
		Name:           term.Name,
		Slug:           term.Slug,
		Description:    term.Description.String, // Handle sql.NullString
		TaxonomyTypeID: term.TaxonomyTypeID,
		CreatedAt:      term.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}

	// Handle nullable parent_id
	if term.ParentID.Valid {
		response.ParentID = &term.ParentID.Int64
	}

	// Handle nullable sort_order
	if term.SortOrder.Valid {
		response.SortOrder = &term.SortOrder.Int32
	}

	// Handle nullable JSON metadata
	if term.Meta.Valid {
		var meta map[string]interface{}
		if err := json.Unmarshal(term.Meta.RawMessage, &meta); err == nil {
			response.Meta = meta
		}
	}

	return response
}

// toTaxonomyTermWithTypeResponse converts joined query result to API response format.
// Includes taxonomy type name from database join for enriched responses.
func toTaxonomyTermWithTypeResponse(row db.ListTaxonomyTermsByTypeRow) TaxonomyTermResponse {
	response := TaxonomyTermResponse{
		ID:               row.ID,
		Name:             row.Name,
		Slug:             row.Slug,
		Description:      row.Description.String,
		TaxonomyTypeID:   row.TaxonomyTypeID,
		TaxonomyTypeName: row.TaxonomyTypeName, // Enriched with type name
		CreatedAt:        row.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}

	// Handle nullable parent_id
	if row.ParentID.Valid {
		response.ParentID = &row.ParentID.Int64
	}

	// Handle nullable sort_order
	if row.SortOrder.Valid {
		response.SortOrder = &row.SortOrder.Int32
	}

	// Handle nullable JSON metadata
	if row.Meta.Valid {
		var meta map[string]interface{}
		if err := json.Unmarshal(row.Meta.RawMessage, &meta); err == nil {
			response.Meta = meta
		}
	}

	return response
}

// toTaxonomyTermWithCountResponse converts query result with post count to API response.
// Includes usage statistics for popularity and analytics features.
func toTaxonomyTermWithCountResponse(row db.GetTaxonomyTermsWithPostCountRow) TaxonomyTermResponse {
	response := TaxonomyTermResponse{
		ID:               row.ID,
		Name:             row.Name,
		Slug:             row.Slug,
		Description:      row.Description.String,
		TaxonomyTypeID:   row.TaxonomyTypeID,
		TaxonomyTypeName: row.TaxonomyTypeName,
		PostCount:        &row.PostCount, // Include usage statistics
		CreatedAt:        row.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}

	// Handle nullable parent_id
	if row.ParentID.Valid {
		response.ParentID = &row.ParentID.Int64
	}

	// Handle nullable sort_order
	if row.SortOrder.Valid {
		response.SortOrder = &row.SortOrder.Int32
	}

	// Handle nullable JSON metadata
	if row.Meta.Valid {
		var meta map[string]interface{}
		if err := json.Unmarshal(row.Meta.RawMessage, &meta); err == nil {
			response.Meta = meta
		}
	}

	return response
}
