// Package api — Taxonomies & Content Classification Module  // Package api — Taxonomies & Content Classification Module  package api

//

// Complete taxonomy system for organizing and categorizing content through hierarchical//

// classification structures. Manages taxonomy types (categories, tags, etc.) and their

// associated terms, with full CRUD operations and content association capabilities.// Complete taxonomy system for organizing and categorizing content through hierarchicalimport (

//

// # Purpose & Architecture// classification structures. Manages taxonomy types (categories, tags, etc.) and their 	"database/sql"

//

// This module enables flexible content organization through:// associated terms, with full CRUD operations and content association capabilities.	"encoding/json"

//   - **Taxonomy Types**: Define classification systems (e.g., "category", "tag", "location")

//   - **Taxonomy Terms**: Individual items within types (e.g., "News", "GoLang", "San Francisco")  //	"net/http"

//   - **Post Associations**: Link content to relevant terms for organization and discovery

//   - **Hierarchical Support**: Parent-child relationships within taxonomy terms// # Purpose & Architecture	"strconv"

//   - **Metadata**: JSON metadata storage for extended term information

////	"strings"

// # Authentication Model

//// This module enables flexible content organization through:

// **Read Operations** (Public):

//   - Browse taxonomy types and their structures//   - **Taxonomy Types**: Define classification systems (e.g., "category", "tag", "location")	"github.com/gin-gonic/gin"

//   - Search and filter taxonomy terms

//   - View popular terms and usage statistics//   - **Taxonomy Terms**: Individual items within types (e.g., "News", "GoLang", "San Francisco")  	db "github.com/go-live-cms/go-live-cms/db/sqlc"

//   - Access term-to-content associations

////   - **Post Associations**: Link content to relevant terms for organization and discovery	"github.com/sqlc-dev/pqtype"

// **Write Operations** (Protected via Bearer tokens):

//   - Create new taxonomy types and terms//   - **Hierarchical Support**: Parent-child relationships within taxonomy terms)

//   - Update existing term information and metadata

//   - Delete terms with optional force for terms in use//   - **Metadata**: JSON metadata storage for extended term information

//   - Modify hierarchical relationships

////type CreateTaxonomyTypeRequest struct {

// # Core Features

//// # Authentication Model	Name         string `json:"name" binding:"required,min=2,max=100"`

// **Taxonomy Types Management**:

//   - Create taxonomy types with labels and descriptions//	Label        string `json:"label" binding:"required,min=2,max=100"`

//   - Configure hierarchical vs flat structures

//   - Control public visibility and UI display options  // **Read Operations** (Public):	Description  string `json:"description"`

//   - Unique name enforcement with conflict detection

////   - Browse taxonomy types and their structures	Hierarchical bool   `json:"hierarchical"`

// **Taxonomy Terms Operations**:

//   - CRUD operations with validation and conflict handling//   - Search and filter taxonomy terms	Public       bool   `json:"public"`

//   - Automatic and manual slug generation for SEO-friendly URLs

//   - Parent-child relationships for hierarchical taxonomies//   - View popular terms and usage statistics	ShowUI       bool   `json:"show_ui"`

//   - Rich metadata support via JSON fields

//   - Bulk operations with transaction safety//   - Access term-to-content associations	ShowInMenu   bool   `json:"show_in_menu"`

//

// **Content Discovery**:  //}

//   - List terms by taxonomy type with pagination and sorting

//   - Search terms with query matching on names and descriptions// **Write Operations** (Protected via Bearer tokens):

//   - Popular terms ranking based on content association frequency

//   - Bidirectional content-term relationship browsing//   - Create new taxonomy types and termstype TaxonomyTypeResponse struct {

//

// **Advanced Features**://   - Update existing term information and metadata	ID           int64  `json:"id"`

//   - Force deletion with automatic association cleanup

//   - Multiple sorting options (name, ID, custom order)//   - Delete terms with optional force for terms in use	Name         string `json:"name"`

//   - Flexible metadata system for extensibility

//   - Usage statistics and popularity metrics//   - Modify hierarchical relationships	Label        string `json:"label"`

//

// # Route Organization//	Description  string `json:"description"`

//

// **Public Taxonomy Type Endpoints** (/api/v1/taxonomy/types):// # Core Features	Hierarchical bool   `json:"hierarchical"`

//   - GET / — List all available taxonomy types

//   - GET /:name — Get specific type details and configuration//	Public       bool   `json:"public"`

//

// **Protected Type Management** (/api/v1/taxonomy/types):  // **Taxonomy Types Management**:	ShowUI       bool   `json:"show_ui"`

//   - POST / — Create new taxonomy type (auth required)

////   - Create taxonomy types with labels and descriptions	ShowInMenu   bool   `json:"show_in_menu"`

// **Public Term Discovery** (/api/v1/taxonomy/terms):

//   - GET /popular — Most frequently used terms by type//   - Configure hierarchical vs flat structures	CreatedAt    string `json:"created_at"`

//   - GET /search — Search terms with query and filters

//   - GET /:id — Get specific term details//   - Control public visibility and UI display options  }

//   - GET /slug/:slug — Get term by SEO-friendly slug

//   - GET /:id/posts — List content associated with term//   - Unique name enforcement with conflict detection

//

// **Public Type-Specific Browsing** (/api/v1/taxonomy/types/:type)://type CreateTaxonomyTermRequest struct {

//   - GET /terms — List all terms within taxonomy type

//// **Taxonomy Terms Operations**:	Name           string                 `json:"name" binding:"required,min=2,max=100"`

// **Protected Term Management** (/api/v1/taxonomy/terms):

//   - POST / — Create new taxonomy term (auth required)  //   - CRUD operations with validation and conflict handling	Slug           string                 `json:"slug"`

//   - PUT /:id — Update existing term (auth required)

//   - DELETE /:id — Delete term, supports ?force=true (auth required)//   - Automatic and manual slug generation for SEO-friendly URLs	Description    string                 `json:"description"`

//

// **Cross-Module Integration** (/api/v1/posts)://   - Parent-child relationships for hierarchical taxonomies	ParentID       *int64                 `json:"parent_id,omitempty"`

//   - GET /:id/taxonomy-terms — List terms associated with post

////   - Rich metadata support via JSON fields	TaxonomyTypeID int64                  `json:"taxonomy_type_id" binding:"required"`

// # Sorting & Filtering Options

////   - Bulk operations with transaction safety	SortOrder      *int32                 `json:"sort_order,omitempty"`

// **Supported Sort Parameters**:

//   - `name_asc`, `name_desc` — Alphabetical sorting//	Meta           map[string]interface{} `json:"meta,omitempty"`

//   - `id_asc`, `id_desc` — Database ID ordering

//   - `order_asc`, `order_desc` — Custom sort order field// **Content Discovery**:  }

//

// **Query Parameters**://   - List terms by taxonomy type with pagination and sorting

//   - `limit` — Results per page (default: 10, max: 100 for lists, 50 for popular)

//   - `offset` — Pagination offset (default: 0)//   - Search terms with query matching on names and descriptionstype UpdateTaxonomyTermRequest struct {

//   - `sort` — Sorting method (default: name_asc)

//   - `type` — Filter by taxonomy type name//   - Popular terms ranking based on content association frequency	Name        string                 `json:"name" binding:"omitempty,min=2,max=100"`

//   - `q` — Search query for term names and descriptions

//   - `status` — Filter associated content by publication status//   - Bidirectional content-term relationship browsing	Slug        string                 `json:"slug"`

//   - `force` — Force deletion despite existing associations

////	Description string                 `json:"description"`

// # Cross-Module Dependencies

//// **Advanced Features**:	ParentID    *int64                 `json:"parent_id"`

// **Database Layer** (`db/sqlc`):

//   - TaxonomyType and TaxonomyTerm core entities//   - Force deletion with automatic association cleanup	SortOrder   *int32                 `json:"sort_order"`

//   - PostTaxonomyTerm association table for content linking

//   - Complex queries for search, popular terms, and statistics//   - Multiple sorting options (name, ID, custom order)	Meta        map[string]interface{} `json:"meta"`

//   - Transaction support for safe multi-table operations

////   - Flexible metadata system for extensibility}

// **Authentication System** (`auth.go`):

//   - Bearer token validation for protected operations//   - Usage statistics and popularity metrics

//   - User context for audit trails and permissions

//   - Middleware integration for selective route protection//type TaxonomyTermResponse struct {

//

// **Posts Module Integration** (`posts_*.go`):// # Route Organization	ID               int64                  `json:"id"`

//   - PostResponse structure for content listings

//   - toPostResponse presenter for consistent formatting//	Name             string                 `json:"name"`

//   - Cross-references in term-to-content associations

//// **Public Taxonomy Type Endpoints** (/api/v1/taxonomy/types):	Slug             string                 `json:"slug"`

// **Validation & Utilities** (`taxonomy_utils.go`):

//   - Slug generation and validation//   - GET / — List all available taxonomy types	Description      string                 `json:"description"`

//   - Sort parameter validation

//   - Database constraint violation detection//   - GET /:name — Get specific type details and configuration	ParentID         *int64                 `json:"parent_id,omitempty"`

//

// # HTTP Status Codes//	TaxonomyTypeID   int64                  `json:"taxonomy_type_id"`

//

// **Success Responses**:// **Protected Type Management** (/api/v1/taxonomy/types):  	TaxonomyTypeName string                 `json:"taxonomy_type_name,omitempty"`

//   - 200 OK — Successful retrieval, update, or deletion

//   - 201 Created — Successful creation of types or terms//   - POST / — Create new taxonomy type (auth required)	SortOrder        *int32                 `json:"sort_order,omitempty"`

//

// **Client Error Responses**:  //	Meta             map[string]interface{} `json:"meta,omitempty"`

//   - 400 Bad Request — Invalid parameters, malformed JSON, validation failures

//   - 401 Unauthorized — Missing or invalid Bearer token for protected operations// **Public Term Discovery** (/api/v1/taxonomy/terms):	PostCount        *int64                 `json:"post_count,omitempty"`

//   - 404 Not Found — Requested type, term, or post not found

//   - 409 Conflict — Unique constraint violations (duplicate names/slugs) or terms in use//   - GET /popular — Most frequently used terms by type	CreatedAt        string                 `json:"created_at"`

//

// **Server Error Responses**://   - GET /search — Search terms with query and filters}

//   - 500 Internal Server Error — Database errors, JSON processing failures, system issues

////   - GET /:id — Get specific term details

// # Implementation Files

////   - GET /slug/:slug — Get term by SEO-friendly slug  func toTaxonomyTypeResponse(taxonomyType db.TaxonomyType) TaxonomyTypeResponse {

//   - `taxonomy_routes.go` — Route registration with authentication middleware

//   - `taxonomy_bindings.go` — Request structures with validation tags  //   - GET /:id/posts — List content associated with term	return TaxonomyTypeResponse{

//   - `taxonomy_presenters.go` — Response formatting and database row conversion

//   - `taxonomy_utils.go` — Slug generation, validation, and helper functions//		ID:           taxonomyType.ID,

//   - `taxonomy_types_handlers.go` — Taxonomy type CRUD operations

//   - `taxonomy_terms_handlers_write.go` — Term creation, updates, and deletion// **Public Type-Specific Browsing** (/api/v1/taxonomy/types/:type):		Name:         taxonomyType.Name,

//   - `taxonomy_terms_handlers_read.go` — Term discovery, search, and listing

////   - GET /terms — List all terms within taxonomy type		Label:        taxonomyType.Label,

// # Usage Examples

////		Description:  taxonomyType.Description.String,

// **Create a hierarchical category system**:

//   1. POST /taxonomy/types — Create "category" type with hierarchical=true// **Protected Term Management** (/api/v1/taxonomy/terms):		Hierarchical: taxonomyType.Hierarchical,

//   2. POST /taxonomy/terms — Create "Technology" parent term

//   3. POST /taxonomy/terms — Create "Programming" with parent_id pointing to Technology//   - POST / — Create new taxonomy term (auth required)  		Public:       taxonomyType.Public,

//   4. Associate posts with terms via post creation/update endpoints

////   - PUT /:id — Update existing term (auth required)		ShowUI:       taxonomyType.ShowUi,

// **Implement tagging system**:

//   1. POST /taxonomy/types — Create "tag" type with hierarchical=false//   - DELETE /:id — Delete term, supports ?force=true (auth required)		ShowInMenu:   taxonomyType.ShowInMenu,

//   2. POST /taxonomy/terms — Create various tag terms (Go, API, Tutorial)

//   3. Use search and popular endpoints for tag discovery and trending//		CreatedAt:    taxonomyType.CreatedAt.Format("2006-01-02T15:04:05Z"),

package api

// **Cross-Module Integration** (/api/v1/posts):	}

//   - GET /:id/taxonomy-terms — List terms associated with post}

//

// # Sorting & Filtering Optionsfunc toTaxonomyTermResponse(term db.TaxonomyTerm) TaxonomyTermResponse {

//	response := TaxonomyTermResponse{

// **Supported Sort Parameters**:		ID:             term.ID,

//   - `name_asc`, `name_desc` — Alphabetical sorting		Name:           term.Name,

//   - `id_asc`, `id_desc` — Database ID ordering  		Slug:           term.Slug,

//   - `order_asc`, `order_desc` — Custom sort order field		Description:    term.Description.String,

//		TaxonomyTypeID: term.TaxonomyTypeID,

// **Query Parameters**:		CreatedAt:      term.CreatedAt.Format("2006-01-02T15:04:05Z"),

//   - `limit` — Results per page (default: 10, max: 100 for lists, 50 for popular)	}

//   - `offset` — Pagination offset (default: 0)

//   - `sort` — Sorting method (default: name_asc)	if term.ParentID.Valid {

//   - `type` — Filter by taxonomy type name		response.ParentID = &term.ParentID.Int64

//   - `q` — Search query for term names and descriptions	}

//   - `status` — Filter associated content by publication status

//   - `force` — Force deletion despite existing associations	if term.SortOrder.Valid {

//		response.SortOrder = &term.SortOrder.Int32

// # Cross-Module Dependencies  	}

//

// **Database Layer** (`db/sqlc`):	if term.Meta.Valid {

//   - TaxonomyType and TaxonomyTerm core entities		var meta map[string]interface{}

//   - PostTaxonomyTerm association table for content linking		if err := json.Unmarshal(term.Meta.RawMessage, &meta); err == nil {

//   - Complex queries for search, popular terms, and statistics			response.Meta = meta

//   - Transaction support for safe multi-table operations		}

//	}

// **Authentication System** (`auth.go`):

//   - Bearer token validation for protected operations	return response

//   - User context for audit trails and permissions}

//   - Middleware integration for selective route protection

//func toTaxonomyTermWithTypeResponse(row db.ListTaxonomyTermsByTypeRow) TaxonomyTermResponse {

// **Posts Module Integration** (`posts_*.go`):	response := TaxonomyTermResponse{

//   - PostResponse structure for content listings		ID:               row.ID,

//   - toPostResponse presenter for consistent formatting		Name:             row.Name,

//   - Cross-references in term-to-content associations		Slug:             row.Slug,

//		Description:      row.Description.String,

// **Validation & Utilities** (`taxonomy_utils.go`):		TaxonomyTypeID:   row.TaxonomyTypeID,

//   - Slug generation and validation		TaxonomyTypeName: row.TaxonomyTypeName,

//   - Sort parameter validation  		CreatedAt:        row.CreatedAt.Format("2006-01-02T15:04:05Z"),

//   - Database constraint violation detection	}

//

// # HTTP Status Codes	if row.ParentID.Valid {

//		response.ParentID = &row.ParentID.Int64

// **Success Responses**:	}

//   - 200 OK — Successful retrieval, update, or deletion

//   - 201 Created — Successful creation of types or terms	if row.SortOrder.Valid {

//		response.SortOrder = &row.SortOrder.Int32

// **Client Error Responses**:  	}

//   - 400 Bad Request — Invalid parameters, malformed JSON, validation failures

//   - 401 Unauthorized — Missing or invalid Bearer token for protected operations	if row.Meta.Valid {

//   - 404 Not Found — Requested type, term, or post not found		var meta map[string]interface{}

//   - 409 Conflict — Unique constraint violations (duplicate names/slugs) or terms in use		if err := json.Unmarshal(row.Meta.RawMessage, &meta); err == nil {

//			response.Meta = meta

// **Server Error Responses**:		}

//   - 500 Internal Server Error — Database errors, JSON processing failures, system issues	}

//

// # Implementation Files	return response

//}

//   - `taxonomy_routes.go` — Route registration with authentication middleware

//   - `taxonomy_bindings.go` — Request structures with validation tags  func toTaxonomyTermWithCountResponse(row db.GetTaxonomyTermsWithPostCountRow) TaxonomyTermResponse {

//   - `taxonomy_presenters.go` — Response formatting and database row conversion	response := TaxonomyTermResponse{

//   - `taxonomy_utils.go` — Slug generation, validation, and helper functions		ID:               row.ID,

//   - `taxonomy_types_handlers.go` — Taxonomy type CRUD operations		Name:             row.Name,

//   - `taxonomy_terms_handlers_write.go` — Term creation, updates, and deletion		Slug:             row.Slug,

//   - `taxonomy_terms_handlers_read.go` — Term discovery, search, and listing		Description:      row.Description.String,

//		TaxonomyTypeID:   row.TaxonomyTypeID,

// # Usage Examples		TaxonomyTypeName: row.TaxonomyTypeName,

//		PostCount:        &row.PostCount,

// **Create a hierarchical category system**:		CreatedAt:        row.CreatedAt.Format("2006-01-02T15:04:05Z"),

//   1. POST /taxonomy/types — Create "category" type with hierarchical=true	}

//   2. POST /taxonomy/terms — Create "Technology" parent term

//   3. POST /taxonomy/terms — Create "Programming" with parent_id pointing to Technology	if row.ParentID.Valid {

//   4. Associate posts with terms via post creation/update endpoints		response.ParentID = &row.ParentID.Int64

//	}

// **Implement tagging system**:

//   1. POST /taxonomy/types — Create "tag" type with hierarchical=false	if row.SortOrder.Valid {

//   2. POST /taxonomy/terms — Create various tag terms (Go, API, Tutorial)		response.SortOrder = &row.SortOrder.Int32

//   3. Use search and popular endpoints for tag discovery and trending	}
