// Package api — Posts utility functions
//
// Shared utility functions for post operations: sort validation,
// string operations, and common helpers.
//
// Functions
//   - isValidPostSortOption: Validates sort parameter values
//   - containsString: Case-sensitive substring check
//   - indexOf: String index search helper
package api

import "strings"

// isValidPostSortOption validates sort query parameter values
func isValidPostSortOption(sort string) bool {
	validSorts := []string{
		"date_asc", "date_desc",
		"title_asc", "title_desc",
		"menu_order_asc", "menu_order_desc",
		"id_asc", "id_desc",
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

// containsString performs case-sensitive substring search
func containsString(s, substring string) bool {
	return strings.Contains(s, substring)
}

// indexOf returns the index of first occurrence of substring in s, or -1 if not found
func indexOf(s, sub string) int {
	return strings.Index(s, sub)
}
