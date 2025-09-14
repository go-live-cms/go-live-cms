// taxonomy_utils provides validation helpers and utility functions for taxonomy operations.
//
// # Slug Generation Strategy
//
// SEO-friendly URL slug creation with consistent transformation rules:
//   - Convert to lowercase for URL compatibility
//   - Replace spaces with hyphens for readability
//   - Replace underscores with hyphens for consistency
//   - Preserve other characters for international content support
//
// # Validation Helpers
//
// Centralized validation logic prevents code duplication across handlers:
//   - Sort parameter validation with predefined allowed values
//   - Database constraint violation detection for error handling
//   - Consistent validation rules across all taxonomy operations
//
// # Sorting Options Support
//
// Supported sort parameters for flexible content organization:
//   - name_asc, name_desc: Alphabetical sorting for browsing
//   - id_asc, id_desc: Database order for administrative views
//   - order_asc, order_desc: Custom sort_order field for manual arrangement
//
// # Error Detection Utilities
//
// Database constraint violation detection for proper HTTP status codes:
//   - Unique constraint violations → 409 Conflict responses
//   - Foreign key violations → 400 Bad Request responses
//   - Generic database errors → 500 Internal Server Error responses
//
// # Design Principles
//
// - Pure functions with no side effects for testability
// - Consistent naming conventions across all utilities
// - Minimal dependencies for maintainability
// - Clear separation of concerns for different validation types
package api

import "strings"

// generateSlug creates SEO-friendly URL slugs from taxonomy term names.
// Applies consistent transformation rules for URL compatibility and readability.
//
// Transformation rules:
//   - Convert to lowercase
//   - Replace spaces with hyphens
//   - Replace underscores with hyphens
//   - Preserve other characters (including international characters)
//
// Examples:
//   - "Technology News" → "technology-news"
//   - "Go_Programming" → "go-programming"
//   - "São Paulo" → "são-paulo" (preserves international characters)
func generateSlug(name string) string {
	slug := strings.ToLower(name)
	slug = strings.ReplaceAll(slug, " ", "-")
	slug = strings.ReplaceAll(slug, "_", "-")
	return slug
}

// isValidTaxonomySortOption validates sort query parameter values for taxonomy endpoints.
// Ensures only supported sorting methods are accepted to prevent database errors.
//
// Supported sort options:
//   - name_asc, name_desc: Alphabetical sorting
//   - id_asc, id_desc: Database ID ordering
//   - order_asc, order_desc: Custom sort_order field
//   - Empty string: Allowed (defaults to name_asc in handlers)
//
// Returns true for valid sort options, false for invalid options.
func isValidTaxonomySortOption(sort string) bool {
	validSorts := []string{
		"name_asc", "name_desc",
		"id_asc", "id_desc",
		"order_asc", "order_desc",
	}

	// Empty sort is valid (will default in handlers)
	if sort == "" {
		return true
	}

	// Check against allowed sort options
	for _, valid := range validSorts {
		if sort == valid {
			return true
		}
	}

	return false
}
