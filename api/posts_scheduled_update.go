// Package api — Scheduling a published post's update (#335): PUT and DELETE
// /posts/:id/scheduled-update
//
// A published post with changes not published (#326) can schedule its Update for a
// time. Scheduling **freezes the content**: the collab document is flushed (as for
// Update), then the working copy's body and settings are copied into the pending
// update (ScheduleUpdateTx). The live post stays as it is until the time; the working
// copy stays free to edit, and those later edits are not part of the update
// ("schedule again to include them": PUT again takes a new snapshot). At the time the
// scheduler (scheduled_publish.go, #147's) publishes exactly that snapshot as a new
// version credited to whoever scheduled it.
//
// One pending update per post. It ends (000035's trigger) when the post gets a new
// published version (an Update by hand supersedes it: applying the older snapshot
// later would roll the site back) or leaves "published" (unpublish, archive, trash).
// Restoring a version changes the working copy only (the editor, rule 9, and
// restore-settings), so the pending update is unaffected; schedule again to include
// the restored content. Same permission as publishing: admins and editors
// (requireContentEditor).
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

// Error codes the editor tells apart (lib/schedule.ts).
const (
	scheduledUpdateNoChanges    = "no_unpublished_changes"
	scheduledUpdateNotScheduled = "not_scheduled"
)

// ScheduledUpdateResponse is a published post's pending update (#335), without
// its snapshot.
type ScheduledUpdateResponse struct {
	// UpdateAt is when it goes live, in UTC.
	UpdateAt time.Time `json:"update_at"`
	// ScheduledAt is when it was scheduled: the moment its content was frozen.
	ScheduledAt time.Time `json:"scheduled_at"`
	// ScheduledBy is who scheduled it (the version's author); null if removed.
	ScheduledBy *int64 `json:"scheduled_by"`
	// Failure is the last failed attempt to apply it, with the next try.
	Failure *ScheduleFailureResponse `json:"failure,omitempty"`
}

func toScheduledUpdateResponse(row db.PostScheduledUpdateRow) *ScheduledUpdateResponse {
	resp := &ScheduledUpdateResponse{
		UpdateAt:    row.UpdateAt.UTC(),
		ScheduledAt: row.CreatedAt.UTC(),
	}
	if row.ScheduledBy.Valid {
		by := row.ScheduledBy.Int64
		resp.ScheduledBy = &by
	}
	if row.FailedAt.Valid {
		resp.Failure = &ScheduleFailureResponse{
			FailedAt:      row.FailedAt.Time.UTC(),
			Reason:        row.Error.String,
			Attempts:      row.Attempts,
			NextAttemptAt: nullTimePtr(row.NextAttemptAt),
		}
	}
	return resp
}

// scheduledUpdate reads a published post's pending update for GET /posts/:id, or
// nil. A failed read leaves it out rather than failing the read.
func (server *Server) scheduledUpdate(c *gin.Context, postID int64) *ScheduledUpdateResponse {
	row, err := server.store.GetPostScheduledUpdate(c.Request.Context(), postID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		server.requestLog(c).Warn("failed to read the scheduled update", "post_id", postID, "error", err)
		return nil
	}
	return toScheduledUpdateResponse(row)
}

// scheduleUpdate handles PUT /posts/:id/scheduled-update ("Schedule update…" and
// Reschedule): flush the collab document, then freeze the working copy with the
// time, replacing an update scheduled before. The time must be in the future.
func (server *Server) scheduleUpdate(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	var req SchedulePostRequest
	if !bindJSON(c, &req) {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	updateAt, ok := server.scheduleTime(c, req, "the time has passed: pick a later one, or update now")
	if !ok {
		return
	}

	// Refuse before flushing: only a live post has an update to schedule.
	status, err := server.store.GetPostStatus(c.Request.Context(), postID)
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}
	if status != postStatusPublished {
		respondUpdateNotSchedulable(c, status)
		return
	}

	// As publishPost: block_doc must hold every edit before it's frozen.
	if err := server.flushCollabDoc(c.Request.Context(), postID, requestIDFromContext(c)); err != nil {
		server.requestLog(c).Warn("collab flush before scheduling an update failed", "post_id", postID, "error", err)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "the collaboration server could not save the latest edits; nothing was scheduled, try again"})
		return
	}

	row, err := server.store.ScheduleUpdateTx(c.Request.Context(), db.ScheduleUpdateTxParams{
		PostID:      postID,
		UpdateAt:    updateAt,
		ScheduledBy: sql.NullInt64{Int64: caller.ID, Valid: true},
	})
	switch {
	case errors.Is(err, sql.ErrNoRows):
		c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		return
	case errors.Is(err, db.ErrPostNotPublished):
		// Unpublished between the read above and the transaction.
		respondUpdateNotSchedulable(c, "")
		return
	case errors.Is(err, db.ErrNoUnpublishedChanges):
		c.JSON(http.StatusConflict, gin.H{"error": "the post has no changes to publish: the live post already matches it", "code": scheduledUpdateNoChanges})
		return
	case err != nil:
		server.requestLog(c).Warn("scheduling an update failed", "post_id", postID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to schedule the update"})
		return
	}
	server.requestLog(c).Info("post update scheduled", "post_id", postID, "user_id", caller.ID, "update_at", updateAt.Format(time.RFC3339))
	server.recordPostActivity(c, db.ActivityUpdateScheduled, postID, map[string]any{"update_at": updateAt.Format(time.RFC3339)})
	c.JSON(http.StatusOK, gin.H{"scheduled_update": toScheduledUpdateResponse(row)})
}

// cancelScheduledUpdate handles DELETE /posts/:id/scheduled-update ("Cancel
// update"): the snapshot is dropped; the live post and the working copy stay as
// they are. An apply already in flight is fenced off (PublishScheduledUpdateTx).
func (server *Server) cancelScheduledUpdate(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	rows, err := server.store.CancelPostScheduledUpdate(c.Request.Context(), postID)
	if err != nil {
		server.requestLog(c).Warn("cancelling a scheduled update failed", "post_id", postID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to cancel the scheduled update"})
		return
	}
	if rows == 0 {
		if _, err := server.store.GetPost(c.Request.Context(), postID); errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		} else if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
			return
		}
		c.JSON(http.StatusConflict, gin.H{"error": "no update is scheduled for this post", "code": scheduledUpdateNotScheduled})
		return
	}
	server.requestLog(c).Info("scheduled update cancelled", "post_id", postID)
	server.recordPostActivity(c, db.ActivityUpdateUnscheduled, postID, nil)
	c.JSON(http.StatusOK, gin.H{"scheduled_update": nil})
}

// respondUpdateNotSchedulable is the 409 for a post that isn't published (status
// "" when it isn't known any more: it was unpublished meanwhile).
func respondUpdateNotSchedulable(c *gin.Context, status string) {
	message := "only a published post's update can be scheduled; this post isn't published any more"
	switch status {
	case "":
	case "draft", postStatusScheduled:
		message = "only a published post's update can be scheduled; a " + status + " post's publish is scheduled with PUT /posts/:id/schedule"
	default:
		message = "only a published post's update can be scheduled; this post is " + status
	}
	body := gin.H{"error": message}
	if status != "" {
		body["post_status"] = status
	}
	c.JSON(http.StatusConflict, body)
}
