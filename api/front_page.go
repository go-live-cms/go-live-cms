// Package api — The front page (#336)
//
// settings.front_page_id (000045) names the page the public site renders at /;
// NULL = the latest posts, as before. PUT /settings sets it (admins only, like every
// setting): a published page, else 400 invalid_front_page; null clears it.
//
// The id stays when that page is later unpublished, archived or moved to the trash:
// GET /public/front-page then answers 404 and / shows the latest posts until it is
// published again (the admin warns before those actions). A permanent delete clears
// it (ON DELETE SET NULL). GET /settings returns the id as is, so the admin can say
// why / shows the latest posts.
package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
)

var errInvalidFrontPageID = errors.New("front_page_id must be a page id or null")

// frontPageUpdate interprets front_page_id: set reports whether the request
// changes it, and id is the new page (nil: the latest posts).
func (req UpdateSettingsRequest) frontPageUpdate() (set bool, id *int64, err error) {
	raw := bytes.TrimSpace(req.FrontPageID)
	if len(raw) == 0 {
		return false, nil, nil
	}
	if string(raw) == "null" {
		return true, nil, nil
	}
	var value int64
	if err := json.Unmarshal(raw, &value); err != nil || value <= 0 {
		return false, nil, errInvalidFrontPageID
	}
	return true, &value, nil
}

// checkFrontPage answers 400 (or 500) itself unless id is a published page.
func (server *Server) checkFrontPage(c *gin.Context, id int64) bool {
	post, err := server.store.GetPost(c.Request.Context(), id)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the front page"})
		return false
	}
	if err != nil || post.PostType != "page" || post.PostStatus != publishedStatus {
		msg := "the front page must be a published page"
		c.JSON(http.StatusBadRequest, gin.H{"error": msg, "code": "invalid_front_page", "fields": gin.H{"front_page_id": msg}})
		return false
	}
	return true
}

// getPublicFrontPage handles GET /public/front-page: the front page as the post
// route's /public/posts/:id shows it (published settings, template included), or
// 404 no_front_page when / shows the latest posts (none set, or it isn't a
// published page of an active, public type any more).
func (server *Server) getPublicFrontPage(c *gin.Context) {
	ctx := c.Request.Context()
	post, err := server.store.GetPublicFrontPage(ctx)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "no front page", "code": "no_front_page"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the front page"})
		return
	}
	view, err := server.publicPostView(ctx, post)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the front page"})
		return
	}
	c.JSON(http.StatusOK, view)
}
