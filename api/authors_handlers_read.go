// authors_handlers_read serves the public author pages (#350), under /public.
//
// An author is a user credited (user_posts) on at least one published post of a
// public, active post type (db/query/authors.sql). Anyone else, including a
// user whose posts are all drafts, gets exactly the same 404 as an unknown
// username, so these routes can't tell whether an account exists.
//
// Responses use AuthorProfileResponse only (authors_presenters.go).
package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

const (
	authorPostsDefaultLimit = 10
	authorPostsMaxLimit     = 100
	publicAuthorsMaxLimit   = 1000
)

// errAuthorNotFound is the one body every "no page" case answers.
var errAuthorNotFound = gin.H{"error": "author not found"}

// parseLimitOffset reads ?limit= (default def, capped at max) and ?offset=.
func parseLimitOffset(c *gin.Context, def, max int64) (int64, int64, bool) {
	limit, err := strconv.ParseInt(c.DefaultQuery("limit", strconv.FormatInt(def, 10)), 10, 32)
	if err != nil || limit <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid limit parameter"})
		return 0, 0, false
	}
	if limit > max {
		limit = max
	}
	offset, err := strconv.ParseInt(c.DefaultQuery("offset", "0"), 10, 32)
	if err != nil || offset < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid offset parameter"})
		return 0, 0, false
	}
	return limit, offset, true
}

// loadPublicAuthor answers 404 (same body for unknown and uncredited users)
// or 500 itself and returns false; otherwise the author row.
func (server *Server) loadPublicAuthor(c *gin.Context) (db.GetPublicAuthorRow, bool) {
	author, err := server.store.GetPublicAuthor(c.Request.Context(), c.Param("username"))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, errAuthorNotFound)
			return author, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get author"})
		return author, false
	}
	if author.PostCount < 1 {
		c.JSON(http.StatusNotFound, errAuthorNotFound)
		return author, false
	}
	return author, true
}

// getPublicAuthor handles GET /public/authors/:username:
// {"author": AuthorProfileResponse, "post_count": n}.
func (server *Server) getPublicAuthor(c *gin.Context) {
	author, ok := server.loadPublicAuthor(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"author":     authorProfileFromRow(author),
		"post_count": author.PostCount,
	})
}

// listPublicAuthorPosts handles GET /public/authors/:username/posts?limit=&offset=:
// the published posts the author is credited on, newest first, in the shape of
// GET /posts?with_meta=true (rows carry meta and authors), plus the author, so
// the author page needs this one call.
func (server *Server) listPublicAuthorPosts(c *gin.Context) {
	limit, offset, ok := parseLimitOffset(c, authorPostsDefaultLimit, authorPostsMaxLimit)
	if !ok {
		return
	}
	author, ok := server.loadPublicAuthor(c)
	if !ok {
		return
	}

	rows, err := server.store.ListPublishedPostsByAuthor(c.Request.Context(), db.ListPublishedPostsByAuthorParams{
		UserID:      author.ID,
		LimitCount:  int32(limit),
		OffsetCount: int32(offset),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list author posts"})
		return
	}

	posts := make([]PostWithMetaResponse, len(rows))
	for i, row := range rows {
		// Same columns as ListPostsWithMeta, so the row converts directly.
		posts[i] = toPostWithMetaResponse(db.ListPostsWithMetaRow(row))
	}
	c.JSON(http.StatusOK, gin.H{
		"author": authorProfileFromRow(author),
		"posts":  posts,
		"meta": gin.H{
			"total":  author.PostCount,
			"limit":  limit,
			"offset": offset,
			"count":  len(posts),
		},
	})
}

// listPublicPostAuthors handles GET /public/posts/:id/authors: the post's
// "Written by" cards in byline order. Empty for a post the public site doesn't
// serve (a draft, a private type), so it never shows who wrote one.
func (server *Server) listPublicPostAuthors(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	rows, err := server.store.ListPostAuthorProfiles(c.Request.Context(), postID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list post authors"})
		return
	}
	authors := make([]AuthorProfileResponse, len(rows))
	for i, row := range rows {
		authors[i] = authorProfileFromPostRow(row)
	}
	c.JSON(http.StatusOK, gin.H{"authors": authors})
}

// listPublicAuthors handles GET /public/authors?limit=&offset=: every author
// with a page and their newest post's time, for the sitemap.
func (server *Server) listPublicAuthors(c *gin.Context) {
	limit, offset, ok := parseLimitOffset(c, publicAuthorsMaxLimit, publicAuthorsMaxLimit)
	if !ok {
		return
	}
	rows, err := server.store.ListPublicAuthors(c.Request.Context(), db.ListPublicAuthorsParams{
		LimitCount:  int32(limit),
		OffsetCount: int32(offset),
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list authors"})
		return
	}
	authors := make([]PublicAuthorListEntry, len(rows))
	for i, row := range rows {
		authors[i] = PublicAuthorListEntry{Username: row.Username, LastModified: row.LastModified}
	}
	c.JSON(http.StatusOK, gin.H{"authors": authors})
}
