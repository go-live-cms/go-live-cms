// Package api — Posts utility functions
//
// Shared utility functions for post operations: sort validation,
// string operations, and common helpers.
//
// Functions
//   - isValidPostSortOption: Validates sort parameter values
//   - containsString: Case-sensitive substring check
package api

import (
	"strings"
	"unicode"
)

// postSlugFallback is used when a title or requested slug has no usable characters.
const postSlugFallback = "post"

// normalizePostSlug turns a title or user-supplied slug into a URL path segment:
// generateSlug's lowercase/hyphen rules, then anything that is not a letter,
// digit or hyphen is dropped (so "/", "?", "#" can't break the post URL) and
// leading/trailing hyphens are trimmed. Unicode letters are kept.
func normalizePostSlug(s string) string {
	s = generateSlug(s)
	s = strings.Map(func(r rune) rune {
		if r == '-' || unicode.IsLetter(r) || unicode.IsDigit(r) {
			return r
		}
		return -1
	}, s)
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	s = strings.Trim(s, "-")
	if s == "" {
		return postSlugFallback
	}
	return s
}

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
