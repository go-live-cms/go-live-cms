// Package api — Posts utility functions
//
// Shared utility functions for post operations: sort resolution,
// string operations, and common helpers.
//
// Functions
//   - resolvePostSort: Validates and normalizes the sort/order query parameters
//   - containsString: Case-sensitive substring check
package api

import (
	"errors"
	"strings"
)

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
