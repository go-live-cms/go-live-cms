package api

import (
	"database/sql"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

const (
	activityPageDefault        = 20
	activityPageMax            = 50
	continueEditingDefault     = 6
	continueEditingMax         = 20
	needsAttentionListLimit    = 5
	activityQueryPositiveError = "must be a positive integer"
)

// positiveQueryInt reads an optional positive integer query parameter. ok is
// false after a 400 has been written.
func positiveQueryInt(c *gin.Context, name string) (value int64, set bool, ok bool) {
	raw, present := c.GetQuery(name)
	if !present || raw == "" {
		return 0, false, true
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": name + " " + activityQueryPositiveError, "fields": gin.H{name: activityQueryPositiveError}})
		return 0, false, false
	}
	return value, true, true
}

// queryLimit reads ?limit= (default def, at most max).
func queryLimit(c *gin.Context, def, max int64) (int32, bool) {
	limit, set, ok := positiveQueryInt(c, "limit")
	if !ok {
		return 0, false
	}
	if !set {
		limit = def
	}
	if limit > max {
		limit = max
	}
	return int32(limit), true
}

// listActivity handles GET /activity?limit=&before=&post_id=: the events the
// caller may see, newest first (who sees what: ListActivity in
// db/query/activity.sql; contributors their own posts' and published posts'
// events, editors every post and media event, admins everything). Paged by id:
// next_before is the value to pass as before for the next page, null at the end.
// post_id narrows it to one post's history.
//
// Auth: any content role.
func (server *Server) listActivity(c *gin.Context) {
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	limit, ok := queryLimit(c, activityPageDefault, activityPageMax)
	if !ok {
		return
	}
	before, beforeSet, ok := positiveQueryInt(c, "before")
	if !ok {
		return
	}
	postID, postSet, ok := positiveQueryInt(c, "post_id")
	if !ok {
		return
	}

	arg := db.ListActivityParams{
		BeforeID:    sql.NullInt64{Int64: before, Valid: beforeSet},
		IsAdmin:     isSiteAdmin(caller),
		IsModerator: canModeratePosts(caller),
		ViewerID:    caller.ID,
		// One more than asked, to know whether there is a next page.
		RowLimit: limit + 1,
	}
	if postSet {
		arg.ObjectType = sql.NullString{String: db.ActivityObjectPost, Valid: true}
		arg.ObjectID = sql.NullInt64{Int64: postID, Valid: true}
	}
	rows, err := server.store.ListActivity(c.Request.Context(), arg)
	if err != nil {
		server.requestLog(c).Warn("listing activity failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list activity"})
		return
	}

	var next *int64
	if len(rows) > int(limit) {
		rows = rows[:limit]
		last := rows[len(rows)-1].ID
		next = &last
	}
	events := make([]ActivityResponse, len(rows))
	for i, row := range rows {
		events[i] = toActivityResponse(row)
	}
	c.JSON(http.StatusOK, gin.H{"activity": events, "next_before": next})
}

// listContinueEditing handles GET /home/continue-editing?limit=: Home's
// "Continue where you left off", the posts the caller last worked on
// (ListContinueEditing), that they may still read (canReadPost).
//
// Auth: any content role.
func (server *Server) listContinueEditing(c *gin.Context) {
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	limit, ok := queryLimit(c, continueEditingDefault, continueEditingMax)
	if !ok {
		return
	}
	rows, err := server.store.ListContinueEditing(c.Request.Context(), db.ListContinueEditingParams{
		UserID:   caller.ID,
		ViewerID: postsViewerID(caller),
		RowLimit: limit,
	})
	if err != nil {
		server.requestLog(c).Warn("listing recently edited posts failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list recently edited posts"})
		return
	}
	posts := make([]ContinueEditingPost, len(rows))
	for i, row := range rows {
		posts[i] = toContinueEditingPost(row)
	}
	c.JSON(http.StatusOK, gin.H{"posts": posts})
}

// getNeedsAttention handles GET /home/needs-attention: Home's to-do list, built
// from other features.
//
//   - failed_schedules (#147): scheduled posts whose last attempt failed; a
//     contributor's own, everyone's for editors.
//   - unpublished_changes (#326) and missing_alt (#325): editors and admins only,
//     the people who can act on them (publish; edit anyone's media). null for
//     other roles.
//   - review_requests (#323): open review requests for the caller to review:
//     naming them, naming nobody, or naming someone who can no longer review;
//     never their own. Editors and admins only (null for contributors, who
//     can't review; their requests' outcome shows in the editor).
//
// Auth: any content role.
func (server *Server) getNeedsAttention(c *gin.Context) {
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()

	failed, err := server.store.ListFailedScheduledPosts(ctx, db.ListFailedScheduledPostsParams{
		ViewerID: postsViewerID(caller),
		RowLimit: needsAttentionListLimit,
	})
	if err != nil {
		server.requestLog(c).Warn("listing failed scheduled posts failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load what needs attention"})
		return
	}
	rsp := NeedsAttentionResponse{
		FailedSchedules: toFailedSchedules(failed),
	}

	if canModeratePosts(caller) {
		changed, err := server.store.ListPostsWithUnpublishedChanges(ctx, needsAttentionListLimit)
		if err != nil {
			server.requestLog(c).Warn("listing posts with unpublished changes failed", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load what needs attention"})
			return
		}
		rsp.UnpublishedChanges = toUnpublishedChanges(changed)

		missing, err := server.store.CountMissingAltMedia(ctx)
		if err != nil {
			server.requestLog(c).Warn("counting media without alt text failed", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load what needs attention"})
			return
		}
		rsp.MissingAlt = &MissingAltSummary{MediaCount: missing.MediaCount, PublishedPostCount: missing.PublishedPostCount}

		reviews, err := server.store.ListReviewRequestsForReviewer(ctx, db.ListReviewRequestsForReviewerParams{
			ViewerID:      caller.ID,
			ReviewerRoles: reviewerRoles,
			RowLimit:      needsAttentionListLimit,
		})
		if err != nil {
			server.requestLog(c).Warn("listing review requests failed", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load what needs attention"})
			return
		}
		rsp.ReviewRequests = toReviewRequestAttention(reviews)
	}

	c.JSON(http.StatusOK, rsp)
}
