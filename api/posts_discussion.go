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
// the next Update). Restoring a version leaves it alone. Who may change it: anyone who
// may edit the post's details (canEditPostDetails), never while it is in the trash.

// UpdatePostDiscussionRequest is PUT /posts/:id/discussion's body.
type UpdatePostDiscussionRequest struct {
	Discussion string `json:"discussion" binding:"required,oneof=default open closed off"`
}

// PostDiscussionResponse is the post's choice and what it means now: the state with the
// clock applied (the admin's "Open · closes on Dec 3") and when an open state closes.
type PostDiscussionResponse struct {
	PostID     int64      `json:"post_id"`
	Discussion string     `json:"discussion"`
	State      string     `json:"state"`
	ClosesAt   *time.Time `json:"closes_at"`
}

// updatePostDiscussion handles PUT /posts/:id/discussion. Activity
// post_discussion_changed {from, to} when the choice changes. A published post's change
// purges the public cache (publicCachePostDetailRoutes), so the thread (#523) follows.
func (server *Server) updatePostDiscussion(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	var req UpdatePostDiscussionRequest
	if !bindJSON(c, &req) {
		return
	}

	post, loaded, ok := server.authorizeLoadPost(c, id, canEditPostDetails)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	if !loaded {
		// A moderator: the owner rule passed, not the trash (#327).
		post, err = server.store.GetPost(ctx, id)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
			return
		}
		if !server.checkLoadedPost(c, post, canEditPostDetails) {
			return
		}
	}

	previous := post.Discussion
	if req.Discussion != previous {
		post, err = server.store.UpdatePostDiscussion(ctx, db.UpdatePostDiscussionParams{ID: id, Discussion: req.Discussion})
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

	setting, err := server.postDiscussionSetting(ctx, post)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the discussion settings"})
		return
	}
	c.JSON(http.StatusOK, PostDiscussionResponse{
		PostID:     post.ID,
		Discussion: post.Discussion,
		State:      discussionState(setting, time.Now()),
		ClosesAt:   setting.ClosesAt,
	})
}
