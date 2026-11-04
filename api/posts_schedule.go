// Package api — Scheduling a post's publish (#147): PUT and DELETE /posts/:id/schedule
//
// Scheduling a draft sets post_status "scheduled" and publish_at (UTC); the
// scheduler (scheduled_publish.go) publishes it at that time through the
// Publish button's path. Same permission as publishing: admins and editors
// (requireContentEditor). A published post can't be scheduled here: its update
// is scheduled with PUT /posts/:id/scheduled-update (#335, posts_scheduled_update.go).
package api

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// scheduleThroughScheduleRoute is the 400 for post_status "scheduled" on
// POST/PUT /posts: a schedule needs a time.
const scheduleThroughScheduleRoute = "a post is scheduled with PUT /posts/:id/schedule, which takes the time"

// maxScheduleAhead bounds publish_at: further out is a typo, not a plan.
const maxScheduleAhead = 5 * 366 * 24 * time.Hour

// siteLocalLayout is SchedulePostRequest.Local's format: a wall-clock time in
// the site's time zone, to the minute, as the dialog's date and time fields give it.
const siteLocalLayout = "2006-01-02T15:04"

// SchedulePostRequest is PUT /posts/:id/schedule's body: exactly one of the two.
type SchedulePostRequest struct {
	// PublishAt is an instant in RFC 3339 with its offset, e.g. "2026-11-03T12:00:00Z".
	PublishAt *time.Time `json:"publish_at"`
	// Local is a wall-clock time in the site's time zone (#330), e.g.
	// "2026-11-03T09:00" for 09:00 São Paulo time. The admin's dialog sends
	// this, so the server's zone data decides the offset, DST included.
	Local string `json:"local" binding:"omitempty,max=32"`
}

var (
	errNonexistentLocalTime = errors.New("that time doesn't exist in the site's time zone (the clocks change then)")
	errInvalidLocalTime     = errors.New("local must be a date and time like 2026-11-03T09:00")
)

// siteLocalToUTC converts a wall-clock time in loc to the instant it names.
// A time the clocks skip (spring forward) is refused rather than shifted. A
// time that happens twice (fall back) is the first one, the earlier instant.
func siteLocalToUTC(local string, loc *time.Location) (time.Time, error) {
	t, err := time.ParseInLocation(siteLocalLayout, local, loc)
	if err != nil {
		return time.Time{}, errInvalidLocalTime
	}
	if t.In(loc).Format(siteLocalLayout) != local {
		return time.Time{}, errNonexistentLocalTime
	}
	// Go may pick either side of an ambiguous wall time. Look for the same wall
	// time up to two hours earlier (the largest DST shift in use; Lord Howe's
	// is 30 minutes) and take the earliest.
	earliest := t
	for _, back := range []time.Duration{2 * time.Hour, time.Hour, 30 * time.Minute} {
		if c := t.Add(-back); c.In(loc).Format(siteLocalLayout) == local {
			earliest = c
			break
		}
	}
	return earliest.UTC(), nil
}

// siteLocation is the site's time zone from settings (#330); UTC when unset.
func (server *Server) siteLocation(c *gin.Context) (*time.Location, error) {
	settings, err := server.store.GetSettings(c.Request.Context())
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return time.UTC, nil
		}
		return nil, err
	}
	if settings.SiteTimezone == "" {
		return time.UTC, nil
	}
	return time.LoadLocation(settings.SiteTimezone)
}

// scheduleTime reads the instant a schedule request names (publish_at, or local in
// the site's zone) and checks it is in the future and within maxScheduleAhead.
// Otherwise it answers 400 (pastMessage for a time that has passed) or 500 and
// returns false. Shared by a draft's schedule (#147) and an update's (#335).
func (server *Server) scheduleTime(c *gin.Context, req SchedulePostRequest, pastMessage string) (time.Time, bool) {
	var at time.Time
	switch {
	case req.PublishAt != nil && req.Local != "":
		c.JSON(http.StatusBadRequest, gin.H{"error": "send publish_at or local, not both"})
		return time.Time{}, false
	case req.PublishAt != nil:
		at = req.PublishAt.UTC()
	case req.Local != "":
		loc, err := server.siteLocation(c)
		if err != nil {
			server.requestLog(c).Warn("reading the site time zone failed", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the site's time zone"})
			return time.Time{}, false
		}
		at, err = siteLocalToUTC(req.Local, loc)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "fields": gin.H{"local": err.Error()}})
			return time.Time{}, false
		}
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "publish_at or local is required"})
		return time.Time{}, false
	}
	now := time.Now()
	if !at.After(now) {
		c.JSON(http.StatusBadRequest, gin.H{"error": pastMessage})
		return time.Time{}, false
	}
	if at.After(now.Add(maxScheduleAhead)) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "pick a time within the next five years"})
		return time.Time{}, false
	}
	return at, true
}

// schedulePost handles PUT /posts/:id/schedule: schedule a draft, or move a
// scheduled post to a new time (Reschedule). The time must be in the future.
func (server *Server) schedulePost(c *gin.Context) {
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
	publishAt, ok := server.scheduleTime(c, req, "the time has passed: pick a later one, or publish now")
	if !ok {
		return
	}

	post, err := server.store.SchedulePost(c.Request.Context(), db.SchedulePostParams{
		ID:          postID,
		PublishAt:   publishAt,
		ScheduledBy: sql.NullInt64{Int64: caller.ID, Valid: true},
	})
	if errors.Is(err, sql.ErrNoRows) {
		server.respondNotSchedulable(c, postID, "only a draft can be scheduled; this post is %s")
		return
	}
	if err != nil {
		server.requestLog(c).Warn("scheduling a post failed", "post_id", postID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to schedule the post"})
		return
	}
	server.requestLog(c).Info("post scheduled", "post_id", postID, "user_id", caller.ID, "publish_at", publishAt.Format(time.RFC3339))
	server.recordPostActivity(c, db.ActivityScheduled, postID, map[string]any{"publish_at": publishAt.Format(time.RFC3339)})
	c.JSON(http.StatusOK, gin.H{"post": toPostResponse(post)})
}

// cancelPostSchedule handles DELETE /posts/:id/schedule ("Cancel schedule"):
// the post goes back to draft. A publish already in flight for it is fenced
// off (PublishScheduledPostTx): it publishes nothing.
func (server *Server) cancelPostSchedule(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	post, err := server.store.CancelPostSchedule(c.Request.Context(), postID)
	if errors.Is(err, sql.ErrNoRows) {
		server.respondNotSchedulable(c, postID, "the post isn't scheduled; it is %s")
		return
	}
	if err != nil {
		server.requestLog(c).Warn("cancelling a schedule failed", "post_id", postID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to cancel the schedule"})
		return
	}
	server.requestLog(c).Info("post schedule cancelled", "post_id", postID)
	server.recordPostActivity(c, db.ActivityUnscheduled, postID, nil)
	c.JSON(http.StatusOK, gin.H{"post": toPostResponse(post)})
}

// respondNotSchedulable answers a schedule change that matched no row: 404 for
// a missing post, else 409 naming its status (format has one %s).
func (server *Server) respondNotSchedulable(c *gin.Context, postID int64, format string) {
	post, err := server.store.GetPost(c.Request.Context(), postID)
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}
	c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf(format, post.PostStatus), "post_status": post.PostStatus})
}
