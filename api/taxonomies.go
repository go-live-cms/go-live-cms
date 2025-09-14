// Package api — Taxonomies & Content Classification Module
//
// Complete taxonomy system for organizing and categorizing content through hierarchical
// classification structures. Manages taxonomy types (categories, tags, etc.) and their
// associated terms, with full CRUD operations and content association capabilities.
//
// # Purpose & Architecture
//
// This module enables flexible content organization through:
//   - **Taxonomy Types**: Define classification systems (e.g., "category", "tag", "location")
//   - **Taxonomy Terms**: Individual items within types (e.g., "News", "GoLang", "San Francisco")
//   - **Post Associations**: Link content to relevant terms for organization and discovery
//   - **Hierarchical Support**: Parent-child relationships within taxonomy terms
//   - **Metadata**: JSON metadata storage for extended term information
//
// # Authentication Model
//
// **Read Operations** (Public):
//   - Browse taxonomy types and their structures
//   - Search and filter taxonomy terms
//   - View popular terms and usage statistics
//   - Access term-to-content associations
//
// **Write Operations** (Protected via Bearer tokens):
//   - Create new taxonomy types and terms
//   - Modify existing taxonomies and relationships
//   - Delete terms with safety checks for content associations
//
// # Module Structure
//
// The taxonomy functionality is split across focused files:
//   - **taxonomy_routes.go**: Route registration and middleware setup
//   - **taxonomy_bindings.go**: Request structures with validation
//   - **taxonomy_presenters.go**: Response formatting and data conversion
//   - **taxonomy_utils.go**: Utility functions and validation helpers
//   - **taxonomy_types_handlers.go**: CRUD operations for taxonomy types
//   - **taxonomy_terms_handlers_read.go**: Term retrieval, search, and discovery
//   - **taxonomy_terms_handlers_write.go**: Term creation, updates, and deletion
//
// # API Endpoints
//
// **Taxonomy Types**:
//   - POST /taxonomy-types (auth required)
//   - GET /taxonomy-types
//   - GET /taxonomy-types/:name
//
// **Taxonomy Terms**:
//   - POST /taxonomy-terms (auth required)
//   - PUT /taxonomy-terms/:id (auth required)
//   - DELETE /taxonomy-terms/:id (auth required)
//   - GET /taxonomy-terms/:id
//   - GET /taxonomy-terms/slug/:slug
//   - GET /taxonomy-terms/type/:type
//   - GET /taxonomy-terms/popular
//   - GET /taxonomy-terms/search
//   - GET /taxonomy-terms/:id/posts
//
// **Legacy/Cross-reference**:
//   - GET /posts/:id/taxonomies (taxonomy terms for a post)
//
// # Usage Examples
//
// Creating a hierarchical category taxonomy:
//  1. POST /taxonomy-types with hierarchical: true
//  2. POST /taxonomy-terms for parent categories
//  3. POST /taxonomy-terms with parent_id for subcategories
//
// Content discovery patterns:
//   - Use /taxonomy-terms/popular for trending topics
//   - Use /taxonomy-terms/search for user-driven exploration
//   - Use /taxonomy-terms/:id/posts for term-specific content
package api
