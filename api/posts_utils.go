// Package api — Posts utility functions
//
// Shared utility functions for post operations: sort resolution,
// string operations, and common helpers.
//
// Functions
//   - normalizePostSlug: Turns a title or requested slug into a URL segment
//   - resolvePostSort: Validates and normalizes the sort/order query parameters
//   - containsString: Case-sensitive substring check
//   - parseUnpublishedChangesFilter: The list's "Changes not published" filter
package api

import (
	"errors"
	"strconv"
	"strings"
	"unicode"

	"github.com/gin-gonic/gin"
)

// maxPostListTerms caps the terms filter (a category and a tag today).
const maxPostListTerms = 10

// postListFilters are the posts list's Author / Category / Tag filters (#327).
// They combine with each other, the status tabs, search and sort.
type postListFilters struct {
	// AuthorID: credited in the post's byline (user_posts), not just the owner.
	// 0 = anyone.
	AuthorID int64
	// TermIDs: the post is linked to every one of them (its working terms).
	TermIDs []int64
}

// parsePostListFilters reads author_id (a user id) and terms (a comma list of
// term ids) from the query.
func parsePostListFilters(c *gin.Context) (postListFilters, error) {
	var filters postListFilters
	if s := strings.TrimSpace(c.Query("author_id")); s != "" {
		id, err := strconv.ParseInt(s, 10, 64)
		if err != nil || id <= 0 {
			return filters, errors.New("invalid author_id parameter")
		}
		filters.AuthorID = id
	}
	if s := strings.TrimSpace(c.Query("terms")); s != "" {
		parts := strings.Split(s, ",")
		if len(parts) > maxPostListTerms {
			return filters, errors.New("too many terms (at most 10)")
		}
		for _, part := range parts {
			id, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
			if err != nil || id <= 0 {
				return filters, errors.New("invalid terms parameter")
			}
			filters.TermIDs = append(filters.TermIDs, id)
		}
	}
	return filters, nil
}

// parseUnpublishedChangesFilter reads the lists' unpublished_changes parameter
// (#326): true keeps only published posts whose working copy differs from what
// the site shows. Absent or false: no filter.
func parseUnpublishedChangesFilter(value string) (bool, error) {
	if value == "" {
		return false, nil
	}
	only, err := strconv.ParseBool(value)
	if err != nil {
		return false, errors.New("invalid unpublished_changes parameter")
	}
	return only, nil
}

// postSlugFallback is used when a title or requested slug has no usable characters.
const postSlugFallback = "post"

// normalizePostSlug turns a title or user-supplied slug into a URL path segment:
// generateSlug's lowercase/hyphen rules, then anything that is not a letter,
// digit or hyphen is dropped (so "/", "?", "#" can't break the post URL) and
// leading/trailing hyphens are trimmed. Unicode letters are kept. An all-digit
// result gets a "post-" prefix.
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
	// The public route reads an all-digit segment as a post id, so /post/2026
	// could never reach a post whose slug is "2026".
	if strings.IndexFunc(s, func(r rune) bool { return !unicode.IsDigit(r) }) == -1 {
		return postSlugFallback + "-" + s
	}
	return s
}

// postSort is a validated post list ordering. Column and Direction are always
// one of the whitelisted values the list queries switch on.
type postSort struct {
	Column    string
	Direction string
}

const (
	sortAsc  = "asc"
	sortDesc = "desc"
)

// postSortDefaultDirection lists the sortable columns and the direction used
// when the request has no order parameter: newest first for dates and ids,
// alphabetical/ascending for title and menu order.
var postSortDefaultDirection = map[string]string{
	"created_at": sortDesc,
	"changed_at": sortDesc,
	"title":      sortAsc,
	"id":         sortDesc,
	"menu_order": sortAsc,
}

// legacyPostSortColumn maps the column part of the pre-#89 combined values
// (date_desc, title_asc, ...) to a sort column.
var legacyPostSortColumn = map[string]string{
	"date":       "created_at",
	"title":      "title",
	"menu_order": "menu_order",
	"id":         "id",
}

var (
	errInvalidPostSort  = errors.New("invalid sort parameter")
	errInvalidPostOrder = errors.New("invalid order parameter")
)

// resolvePostSort validates the sort and order query parameters (#89).
//
// sort is a column (created_at, changed_at, title, id, menu_order) and order
// is asc or desc. The old combined values (date_desc, title_asc, ...) still
// work; their suffix is the direction unless order is also given, which wins.
// An empty sort means created_at, and an empty order means the column's
// default direction (see postSortDefaultDirection).
func resolvePostSort(sort, order string) (postSort, error) {
	if order != "" && order != sortAsc && order != sortDesc {
		return postSort{}, errInvalidPostOrder
	}

	column, direction := sort, ""
	if column == "" {
		column = "created_at"
	}
	if _, ok := postSortDefaultDirection[column]; !ok {
		legacy, ok := parseLegacyPostSort(column)
		if !ok {
			return postSort{}, errInvalidPostSort
		}
		column, direction = legacy.Column, legacy.Direction
	}

	if order != "" {
		direction = order
	}
	if direction == "" {
		direction = postSortDefaultDirection[column]
	}
	return postSort{Column: column, Direction: direction}, nil
}

// parseLegacyPostSort splits a combined value such as "menu_order_desc".
func parseLegacyPostSort(value string) (postSort, bool) {
	cut := strings.LastIndexByte(value, '_')
	if cut <= 0 {
		return postSort{}, false
	}
	column, ok := legacyPostSortColumn[value[:cut]]
	direction := value[cut+1:]
	if !ok || (direction != sortAsc && direction != sortDesc) {
		return postSort{}, false
	}
	return postSort{Column: column, Direction: direction}, true
}

// containsString performs case-sensitive substring search
func containsString(s, substring string) bool {
	return strings.Contains(s, substring)
}
