// Package api — Byline authors (#319)
//
// A post's byline is who it credits: one or more users in order, shown on the
// post, in the lists (avatars) and on the author pages (#350). It is separate from
// the owner (posts.user_id), which is the only thing permissions read (#135):
// being credited gives no access to a post, and editing the byline never changes
// the owner. A new post's byline is its author_ids (the caller for a contributor),
// a duplicate's is the caller (#354).
//
//   - GET /posts/:id/authors: the working byline (canReadPost).
//   - PUT /posts/:id/authors {"author_ids": [..], "base_author_ids": [..]}: replaces
//     it, in that order (1-20 distinct existing users; canEditPostDetails:
//     moderators on any post, a contributor on their own unpublished post, and they
//     may credit others). base_author_ids, the byline the client edited, turns a
//     save that would overwrite someone else's change into a 409 byline_changed.
//   - GET /posts/author-candidates?q=: who can be credited (content roles), for the
//     Authors field's picker. Any content role: GET /users is admin-only.
//
// The byline is a post setting (#358): golive_post_settings() snapshots it as
// author_ids, so on a published post an edit reaches the site on Update, versions
// record it and restore-settings brings it back (users removed since are skipped).
// The public site reads the published byline only (post_published_authors): the
// /public lists' authors, "Written by" (/public/posts/:id/authors) and who has an
// author page.
//
// Removing a member (#333, RemoveUserTx) can't keep their credit (the account is
// deleted): on the posts they owned the recipient takes their place, elsewhere the
// credit is dropped, and a byline left empty credits the post's owner. The working
// and published bylines change alike, at once.
package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// maxPostAuthors caps a byline, like POST /posts' author_ids.
const maxPostAuthors = 20

// authorCandidatesLimit caps the picker's matches.
const authorCandidatesLimit = 20

// SetPostAuthorsRequest is the body of PUT /posts/:id/authors: the whole byline,
// in credit order.
type SetPostAuthorsRequest struct {
	AuthorIDs []int64 `json:"author_ids" binding:"required,min=1,max=20,dive,min=1"`
	// BaseAuthorIDs is the byline the client edited (optional). When it isn't the
	// current one, someone else saved theirs meanwhile: 409 byline_changed with the
	// current authors, and nothing written.
	BaseAuthorIDs []int64 `json:"base_author_ids" binding:"omitempty,max=20"`
}

// canEditPostByline reports whether the user may change the post's byline. It is
// a post detail like the title (the issue's rule), so canEditPostDetails decides.
func canEditPostByline(user db.User, post db.Post) bool {
	return canEditPostDetails(user, post)
}

// distinctIDs reports whether ids has no repeats.
func distinctIDs(ids []int64) bool {
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func parsePostIDParam(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return 0, false
	}
	return id, true
}

func toPostBylineResponse(rows []db.ListPostBylineAuthorsRow) []PostAuthorResponse {
	authors := make([]PostAuthorResponse, len(rows))
	for i, row := range rows {
		authors[i] = PostAuthorResponse{ID: row.ID, Username: row.Username, FullName: row.FullName, Avatar: avatarResponse(row.AvatarUrl)}
	}
	return authors
}

// getPostAuthors handles GET /posts/:id/authors.
func (server *Server) getPostAuthors(c *gin.Context) {
	id, ok := parsePostIDParam(c)
	if !ok {
		return
	}
	post, err := server.store.GetPost(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}
	if !server.checkLoadedPost(c, post, canReadPost) {
		return
	}
	rows, err := server.store.ListPostBylineAuthors(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list post authors"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"authors": toPostBylineResponse(rows)})
}

// setPostAuthors handles PUT /posts/:id/authors.
func (server *Server) setPostAuthors(c *gin.Context) {
	id, ok := parsePostIDParam(c)
	if !ok {
		return
	}
	var req SetPostAuthorsRequest
	if !bindJSON(c, &req) {
		return
	}
	if !distinctIDs(req.AuthorIDs) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "author_ids must not repeat", "fields": gin.H{"author_ids": "must not repeat"}})
		return
	}
	if !server.authorizePost(c, id, canEditPostByline) {
		return
	}

	result, err := server.store.SetPostAuthorsTx(c.Request.Context(), db.SetPostAuthorsTxParams{
		PostID: id, AuthorIDs: req.AuthorIDs, BaseAuthorIDs: req.BaseAuthorIDs,
	})
	if err != nil {
		switch {
		case errors.Is(err, db.ErrBylineChanged):
			c.JSON(http.StatusConflict, gin.H{
				"error":   "someone else changed the authors",
				"code":    "byline_changed",
				"authors": toPostBylineResponse(result.Current),
			})
		case errors.Is(err, sql.ErrNoRows):
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		case errors.Is(err, db.ErrUnknownAuthor):
			c.JSON(http.StatusBadRequest, gin.H{"error": "every author must be an existing user", "fields": gin.H{"author_ids": "unknown user"}})
		default:
			server.requestLog(c).Warn("setting post authors failed", "post_id", id, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update post authors"})
		}
		return
	}
	// A settings save like the others (#324): throttled "updated".
	server.recordPostUpdated(c, id)
	c.JSON(http.StatusOK, gin.H{"post": toPostResponse(result.Post), "authors": toPostBylineResponse(result.Authors)})
}

// listAuthorCandidates handles GET /posts/author-candidates?q=: up to 20 members
// with a content role whose name or username contains q (all of them, by name,
// without q).
func (server *Server) listAuthorCandidates(c *gin.Context) {
	q := c.Query("q")
	if len(q) > 100 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "q must be at most 100 characters"})
		return
	}
	rows, err := server.store.ListAuthorCandidates(c.Request.Context(), db.ListAuthorCandidatesParams{
		Roles:      contentRoles,
		Pattern:    memberSearchPattern(q),
		LimitCount: authorCandidatesLimit,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list authors"})
		return
	}
	authors := make([]PostAuthorResponse, len(rows))
	for i, row := range rows {
		authors[i] = PostAuthorResponse{ID: row.ID, Username: row.Username, FullName: row.FullName, Avatar: avatarResponse(row.AvatarUrl)}
	}
	c.JSON(http.StatusOK, gin.H{"authors": authors})
}
