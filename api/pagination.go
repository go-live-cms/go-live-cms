package api

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
)

// Numbered pages for the public lists (#349). A public list reads ?page=, takes its
// page size from the posts_per_page setting, counts its rows with the same filters
// as the page query (one count(*) per request) and answers
// {"<items>": [...], "pagination": {page, per_page, total, total_pages}}. A page
// past the end is a 404, so the site can 404 it too; page 1 never is (an empty
// list is still a page). Term (#348), author (#350) and search (#145) lists reuse
// publicPageRequest, newPageInfo and outOfRange.

// defaultPostsPerPage is the settings column's default, for a missing row or NULL.
const defaultPostsPerPage int32 = 10

var errInvalidPage = errors.New("invalid page parameter")

type pageRequest struct {
	Page    int32
	PerPage int32
}

// offset of the page's first row. Only called once the page is known to be in
// range, so it fits the int32 the queries take.
func (p pageRequest) offset() int32 {
	return int32(int64(p.Page-1) * int64(p.PerPage))
}

type pageInfo struct {
	Page       int32 `json:"page"`
	PerPage    int32 `json:"per_page"`
	Total      int64 `json:"total"`
	TotalPages int64 `json:"total_pages"`
}

func newPageInfo(req pageRequest, total int64) pageInfo {
	perPage := int64(req.PerPage)
	return pageInfo{
		Page:       req.Page,
		PerPage:    req.PerPage,
		Total:      total,
		TotalPages: (total + perPage - 1) / perPage,
	}
}

// outOfRange reports a page past the last one.
func (p pageInfo) outOfRange() bool {
	return p.Page > 1 && int64(p.Page) > p.TotalPages
}

// parsePageQuery reads ?page=: 1 when absent, a 400 for anything but a positive integer.
func parsePageQuery(c *gin.Context) (int32, error) {
	value, ok := c.GetQuery("page")
	if !ok {
		return 1, nil
	}
	page, err := strconv.ParseInt(value, 10, 32)
	if err != nil || page < 1 {
		return 0, errInvalidPage
	}
	return int32(page), nil
}

// postsPerPage is the posts_per_page setting (1..100, enforced on write).
func (server *Server) postsPerPage(ctx context.Context) (int32, error) {
	settings, err := server.store.GetSettings(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return defaultPostsPerPage, nil
	}
	if err != nil {
		return 0, err
	}
	if !settings.PostsPerPage.Valid || settings.PostsPerPage.Int32 < 1 {
		return defaultPostsPerPage, nil
	}
	return settings.PostsPerPage.Int32, nil
}

// publicPageRequest is the page a public list asked for. On an error it has
// already answered (400 or 500) and returns false.
func (server *Server) publicPageRequest(c *gin.Context) (pageRequest, bool) {
	page, err := parsePageQuery(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return pageRequest{}, false
	}
	perPage, err := server.postsPerPage(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read settings"})
		return pageRequest{}, false
	}
	// A page whose first row is past what an int32 offset can address is past
	// any real list's end too.
	if int64(page-1)*int64(perPage) > math.MaxInt32 {
		c.JSON(http.StatusNotFound, gin.H{"error": "page out of range"})
		return pageRequest{}, false
	}
	return pageRequest{Page: page, PerPage: perPage}, true
}
