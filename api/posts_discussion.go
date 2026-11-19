package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The post's Discussion choice (#522, design 12.3): default, open, closed or off.
//
// It applies at once, outside the publish snapshot: posts.discussion isn't in
// golive_post_settings(), isn't versioned, and doesn't make a published post show
// "changes not published" (closing a thread that turned nasty has to work now, not on
// the next Update). Restoring a version leaves it alone.
//
// Who: editors and admins (requireContentEditor), never while the post is in the trash.
// Contributors have no access to Discussion in v1 (decision 3, #527): the editor's
// Discussion section isn't theirs, so neither route is.

// UpdatePostDiscussionRequest is PUT /posts/:id/discussion's body.
type UpdatePostDiscussionRequest struct {
	Discussion string `json:"discussion" binding:"required,oneof=default open closed off"`
}

// PostDiscussionResponse is the post's choice and what it means now: the state with the
// clock applied (the admin's "Open · closes on Dec 3") and when an open state closes.
// first_published_at is the rule's input (12.4), so the admin's section can apply the
// shared rule itself (web/src/lib/discussion.ts) and say what Default means.
type PostDiscussionResponse struct {
	PostID           int64      `json:"post_id"`
	Discussion       string     `json:"discussion"`
	State            string     `json:"state"`
	ClosesAt         *time.Time `json:"closes_at"`
	FirstPublishedAt *time.Time `json:"first_published_at"`
}

// discussionPostID reads :id, answering 400 itself when it isn't one.
func discussionPostID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return 0, false
	}
	return id, true
}

// loadDiscussionPost reads the post, answering 404 or 500 itself.
func (server *Server) loadDiscussionPost(c *gin.Context, id int64) (db.Post, bool) {
	post, err := server.store.GetPost(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return db.Post{}, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return db.Post{}, false
	}
	return post, true
}

// writePostDiscussion answers the post's choice and what it means now.
func (server *Server) writePostDiscussion(c *gin.Context, post db.Post) {
	setting, err := server.postDiscussionSetting(c.Request.Context(), post)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the discussion settings"})
		return
	}
	response := PostDiscussionResponse{
		PostID:     post.ID,
		Discussion: post.Discussion,
		State:      discussionState(setting, time.Now()),
		ClosesAt:   setting.ClosesAt,
	}
	if post.FirstPublishedAt.Valid {
		first := post.FirstPublishedAt.Time
		response.FirstPublishedAt = &first
	}
	c.JSON(http.StatusOK, response)
}

// getPostDiscussion handles GET /posts/:id/discussion: the editor's Discussion section
// reads it when it opens (#527). A trashed post answers too (the section is read-only).
func (server *Server) getPostDiscussion(c *gin.Context) {
	id, ok := discussionPostID(c)
	if !ok {
		return
	}
	post, ok := server.loadDiscussionPost(c, id)
	if !ok {
		return
	}
	server.writePostDiscussion(c, post)
}

// updatePostDiscussion handles PUT /posts/:id/discussion. Activity
// post_discussion_changed {from, to} when the choice changes. A published post's change
// purges the public cache (publicCachePostDetailRoutes), so the thread (#523) follows.
func (server *Server) updatePostDiscussion(c *gin.Context) {
	id, ok := discussionPostID(c)
	if !ok {
		return
	}
	var req UpdatePostDiscussionRequest
	if !bindJSON(c, &req) {
		return
	}
	post, ok := server.loadDiscussionPost(c, id)
	if !ok {
		return
	}
	// Editors and admins only reach here; this refuses the trash (409, #327).
	if !server.checkLoadedPost(c, post, canEditPostDetails) {
		return
	}

	previous := post.Discussion
	if req.Discussion != previous {
		var err error
		post, err = server.store.UpdatePostDiscussion(c.Request.Context(), db.UpdatePostDiscussionParams{ID: id, Discussion: req.Discussion})
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update the discussion"})
			return
		}
		server.recordRequestActivity(c, activityEvent{
			Verb:       db.ActivityPostDiscussionChanged,
			ObjectType: db.ActivityObjectPost,
			ObjectID:   post.ID,
			Payload:    map[string]any{"from": previous, "to": post.Discussion},
		})
	}
	server.writePostDiscussion(c, post)
}
