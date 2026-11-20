package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Discussion in the admin (#526, C6; docs/design/reader-comments.md 3.4, 4.3, 4.4, 9.3,
// 15). The moderation queue, a comment's thread (the drawer), status changes one by one
// and in bulk, members' own comments and replies, and commenters' pages with Block.
//
// Who: editors and admins (requireContentEditor on the whole group, 4.3). Contributors get
// 403 on every route (decision 3): approving a comment puts reader text on the site
// without an editor, which contributors can't do with their own text either. Export and
// erasure (13.1) are #529's, admin-only.
//
// Privacy (7.1, decision 6): a commenter's address is answered in full to these callers
// and never logged; log lines carry comment, post and commenter ids, the action and
// outcomes. Activity (15.2) records ids and counts only.
//
// Every write purges the public cache through purgeDiscussion after its commit, by what
// readers can now see (discussion_purge.go), and then calls readerCommentModerated: the
// hook #528's moderation and reply notifications attach to.

// registerDiscussionRoutes registers /api/v1/discussion (9.3).
func (server *Server) registerDiscussionRoutes(v1 *gin.RouterGroup) {
	d := v1.Group("/discussion", server.requireAuth(), requireContentEditor(server))
	d.GET("/comments", server.listDiscussionComments)
	d.GET("/counts", server.getDiscussionCounts)
	d.GET("/comments/:id/thread", server.getDiscussionThread)
	d.PUT("/comments/:id/status", server.setDiscussionCommentStatus)
	d.POST("/comments/bulk", server.bulkDiscussionComments)
	d.DELETE("/comments/:id", server.deleteDiscussionComment)
	d.PUT("/comments/:id", server.updateDiscussionComment)
	d.POST("/posts/:id/comments", server.createDiscussionComment)
	d.GET("/commenters", server.findDiscussionCommenter)
	d.GET("/commenters/:id", server.getDiscussionCommenter)
	d.PUT("/commenters/:id/block", server.blockDiscussionCommenter)
}

const (
	discussionPageDefault = 25
	discussionPageMax     = 100
	// A thread in the drawer, and a commenter's page: every comment up to this many.
	discussionThreadMax   = 500
	discussionSearchMax   = 200
	maxBulkReaderComments = 100
	// ReaderCommentActionDelete is the bulk route's Delete permanently (spam or trash).
	readerCommentActionDelete = "delete"
)

// readerCommentChange is one committed change, for readerCommentModerated (#528): From
// is "" for a new member comment, To "" for a deleted one.
type readerCommentChange struct {
	CommentID int64
	PostID    int64
	ParentID  int64
	From      string
	To        string
	ActorID   int64
}

// notifyReaderCommentChanges hands committed changes to #528's hook (nil until then).
func (server *Server) notifyReaderCommentChanges(ctx context.Context, changes []readerCommentChange) {
	if server.readerCommentModerated == nil || len(changes) == 0 {
		return
	}
	server.readerCommentModerated(context.WithoutCancel(ctx), changes)
}

// ModerationCommenter is a reader's commenter as the queue shows it: the address in full
// (decision 6), "New commenter" when nothing of theirs is approved yet, and blocked.
type ModerationCommenter struct {
	ID      int64  `json:"id"`
	Email   string `json:"email"`
	New     bool   `json:"new"`
	Blocked bool   `json:"blocked"`
}

// ModerationPost is the post a comment is on: the working title (the admin's), its
// status ("Post not published", 4.4) and its public path.
type ModerationPost struct {
	ID       int64  `json:"id"`
	Title    string `json:"title"`
	PostType string `json:"post_type"`
	Status   string `json:"status"`
	URL      string `json:"url"`
}

// ModerationComment is one comment in the queue, a thread or a commenter's page.
type ModerationComment struct {
	ID       int64  `json:"id"`
	ParentID *int64 `json:"parent_id"`
	RootID   *int64 `json:"root_id"`
	Status   string `json:"status"`
	// TrashedFrom: what Restore puts back ("Was approved").
	TrashedFrom *string `json:"trashed_from"`
	// HeldReason: why the rules held it, or its spam route (4.2, 16.1, 16.2).
	HeldReason *string `json:"held_reason"`
	HeldDetail *string `json:"held_detail"`
	// Name: a member's current name, else the name it was posted with ("" on a tombstone).
	Name string `json:"name"`
	// Badge: "author" (on the post's published byline) or "staff" for a member's comment,
	// null otherwise, and null once the member is removed (3.4).
	Badge  *string `json:"badge"`
	Avatar *string `json:"avatar"`
	// AuthorUserID: the member who wrote it (their own comment offers Edit, 6.4).
	AuthorUserID *int64               `json:"author_user_id"`
	Commenter    *ModerationCommenter `json:"commenter"`
	Body         string               `json:"body"`
	// ReplyingTo: the name of the comment it answers, "" for a top-level one.
	ReplyingTo    string         `json:"replying_to"`
	NotifyReplies bool           `json:"notify_replies"`
	Edited        bool           `json:"edited"`
	Removed       bool           `json:"removed"`
	CreatedAt     time.Time      `json:"created_at"`
	ApprovedAt    *time.Time     `json:"approved_at"`
	ModeratedAt   *time.Time     `json:"moderated_at"`
	ModeratedBy   string         `json:"moderated_by"`
	Post          ModerationPost `json:"post"`
}

func toModerationComment(row db.ListModerationCommentsRow, structure string) ModerationComment {
	comment := ModerationComment{
		ID:            row.ID,
		ParentID:      nullInt64Ptr(row.ParentID),
		RootID:        nullInt64Ptr(row.RootID),
		Status:        row.Status,
		TrashedFrom:   nullStringPtr(row.TrashedFrom),
		HeldReason:    nullStringPtr(row.HeldReason),
		HeldDetail:    nullStringPtr(row.HeldDetail),
		Name:          row.DisplayName,
		AuthorUserID:  nullInt64Ptr(row.AuthorUserID),
		Body:          row.Body,
		ReplyingTo:    row.ParentName,
		NotifyReplies: row.NotifyReplies,
		Edited:        row.EditedAt.Valid,
		Removed:       row.RemovedAt.Valid,
		CreatedAt:     row.CreatedAt,
		ApprovedAt:    nullTimePtr(row.ApprovedAt),
		ModeratedAt:   nullTimePtr(row.ModeratedAt),
		ModeratedBy:   row.ModeratedByName,
		Post: ModerationPost{
			ID:       row.PostID,
			Title:    row.PostTitle,
			PostType: row.PostType,
			Status:   row.PostStatus,
			URL:      postHref(row.PostType, row.PostSlug, row.PostID, structure, row.PostCategorySlug),
		},
	}
	if row.ByMember {
		// 3.4: a member's comment shows their current name and avatar with a badge.
		if row.MemberName != "" {
			comment.Name = row.MemberName
		}
		comment.Avatar = avatarResponse(row.MemberAvatar)
		badge := readerCommentBadgeStaff
		if row.MemberIsAuthor {
			badge = readerCommentBadgeAuthor
		}
		comment.Badge = &badge
	}
	if row.CommenterID.Valid {
		comment.Commenter = &ModerationCommenter{
			ID:      row.CommenterID.Int64,
			Email:   row.CommenterEmail,
			New:     row.NewCommenter,
			Blocked: row.CommenterBlocked,
		}
	}
	return comment
}

// discussionCounts is the queue's tabs (GET /discussion/counts).
type discussionCounts struct {
	Pending  int64 `json:"pending"`
	Approved int64 `json:"approved"`
	Spam     int64 `json:"spam"`
	Trash    int64 `json:"trash"`
}

func (counts *discussionCounts) of(status string) int64 {
	switch status {
	case db.ReaderCommentPending:
		return counts.Pending
	case db.ReaderCommentApproved:
		return counts.Approved
	case db.ReaderCommentSpam:
		return counts.Spam
	case db.ReaderCommentTrash:
		return counts.Trash
	}
	return 0
}

// discussionFilters are the queue's filters: post, commenter, text search (4.4).
type discussionFilters struct {
	PostID      sql.NullInt64
	CommenterID sql.NullInt64
	Pattern     string
}

// likePattern is an ILIKE pattern matching text anywhere, its wildcards escaped.
func likePattern(text string) string {
	if text == "" {
		return ""
	}
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(text)
	return "%" + escaped + "%"
}

// readDiscussionFilters reads ?post_id=&commenter_id=&q= (400 written when invalid).
func readDiscussionFilters(c *gin.Context) (discussionFilters, bool) {
	var f discussionFilters
	postID, postSet, ok := positiveQueryInt(c, "post_id")
	if !ok {
		return f, false
	}
	commenterID, commenterSet, ok := positiveQueryInt(c, "commenter_id")
	if !ok {
		return f, false
	}
	q := strings.TrimSpace(c.Query("q"))
	if utf8.RuneCountInString(q) > discussionSearchMax {
		c.JSON(http.StatusBadRequest, gin.H{"error": "q is too long", "fields": gin.H{"q": "at most 200 characters"}})
		return f, false
	}
	f.PostID = sql.NullInt64{Int64: postID, Valid: postSet}
	f.CommenterID = sql.NullInt64{Int64: commenterID, Valid: commenterSet}
	f.Pattern = likePattern(q)
	return f, true
}

func (server *Server) countDiscussion(ctx context.Context, f discussionFilters) (discussionCounts, error) {
	rows, err := server.store.CountModerationComments(ctx, db.CountModerationCommentsParams{
		PostID: f.PostID, CommenterID: f.CommenterID, Pattern: f.Pattern,
	})
	var counts discussionCounts
	if err != nil {
		return counts, err
	}
	for _, row := range rows {
		switch row.Status {
		case db.ReaderCommentPending:
			counts.Pending = row.Count
		case db.ReaderCommentApproved:
			counts.Approved = row.Count
		case db.ReaderCommentSpam:
			counts.Spam = row.Count
		case db.ReaderCommentTrash:
			counts.Trash = row.Count
		}
	}
	return counts, nil
}

// urlStructure is the site's post URL structure, for the public links (the default when
// the settings can't be read: a link is a convenience, never a reason to fail), and whether
// comments are on for the site: nil when the settings couldn't be read, so a failed read is
// never answered as "comments are off".
func (server *Server) urlStructure(ctx context.Context) (string, *bool) {
	settings, err := server.store.GetSettings(ctx)
	if err != nil {
		return "", nil
	}
	enabled := settings.CommentsEnabled
	return settings.PostUrlStructure, &enabled
}

// listDiscussionComments handles GET /discussion/comments?status=&post_id=&commenter_id=
// &q=&page=&limit=: one page of the queue (4.4), newest first, with the tab counts
// (which follow the filters) and whether comments are on for the site (the queue's
// "Comments are off for this site" state; null when the settings couldn't be read).
func (server *Server) listDiscussionComments(c *gin.Context) {
	status := c.DefaultQuery("status", db.ReaderCommentPending)
	switch status {
	case db.ReaderCommentPending, db.ReaderCommentApproved, db.ReaderCommentSpam, db.ReaderCommentTrash:
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "status must be pending, approved, spam or trash", "fields": gin.H{"status": "must be pending, approved, spam or trash"}})
		return
	}
	filters, ok := readDiscussionFilters(c)
	if !ok {
		return
	}
	page, pageSet, ok := positiveQueryInt(c, "page")
	if !ok {
		return
	}
	if !pageSet {
		page = 1
	}
	limit, ok := queryLimit(c, discussionPageDefault, discussionPageMax)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	counts, err := server.countDiscussion(ctx, filters)
	if err != nil {
		server.requestLog(c).Warn("discussion_counts_failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load the comments"})
		return
	}
	offset := (page - 1) * int64(limit)
	if offset > 1<<30 {
		offset = 1 << 30
	}
	rows, err := server.store.ListModerationComments(ctx, db.ListModerationCommentsParams{
		Status:      sql.NullString{String: status, Valid: true},
		PostID:      filters.PostID,
		CommenterID: filters.CommenterID,
		Pattern:     filters.Pattern,
		LimitCount:  limit,
		OffsetCount: int32(offset),
	})
	if err != nil {
		server.requestLog(c).Warn("discussion_list_failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load the comments"})
		return
	}
	structure, enabled := server.urlStructure(ctx)
	comments := make([]ModerationComment, len(rows))
	for i, row := range rows {
		comments[i] = toModerationComment(row, structure)
	}
	total := counts.of(status)
	c.JSON(http.StatusOK, gin.H{
		"comments":         comments,
		"counts":           counts,
		"comments_enabled": enabled,
		"pagination": gin.H{
			"page":        page,
			"per_page":    limit,
			"total":       total,
			"total_pages": (total + int64(limit) - 1) / int64(limit),
		},
	})
}

// getDiscussionCounts handles GET /discussion/counts?post_id=&commenter_id=&q=: the tab
// counts; the sidebar's pending count and the editor's "12 comments · 2 waiting" read it.
func (server *Server) getDiscussionCounts(c *gin.Context) {
	filters, ok := readDiscussionFilters(c)
	if !ok {
		return
	}
	counts, err := server.countDiscussion(c.Request.Context(), filters)
	if err != nil {
		server.requestLog(c).Warn("discussion_counts_failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to count the comments"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"counts": counts})
}

// discussionCommentID reads :id (400 written otherwise).
func discussionCommentID(c *gin.Context) (int64, bool) {
	return parseIDParamNamed(c, "id", "comment ID")
}

// loadModerationComment reads one comment as the queue shows it (404, 500 written).
func (server *Server) loadModerationComment(c *gin.Context, id int64, structure string) (ModerationComment, bool) {
	rows, err := server.store.ListModerationComments(c.Request.Context(), db.ListModerationCommentsParams{
		ID: sql.NullInt64{Int64: id, Valid: true}, LimitCount: 1,
	})
	if err != nil {
		server.requestLog(c).Warn("discussion_comment_failed", "comment_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load the comment"})
		return ModerationComment{}, false
	}
	if len(rows) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "comment not found", "code": "comment_not_found"})
		return ModerationComment{}, false
	}
	return toModerationComment(rows[0], structure), true
}

// CommenterSummary is a commenter as the drawer and their page show them (4.4, 13.1).
type CommenterSummary struct {
	ID          int64      `json:"id"`
	Email       string     `json:"email"`
	Name        string     `json:"name"`
	NamesUsed   []string   `json:"names_used"`
	VerifiedAt  *time.Time `json:"verified_at"`
	BlockedAt   *time.Time `json:"blocked_at"`
	BlockedBy   string     `json:"blocked_by"`
	LastSpamAt  *time.Time `json:"last_spam_at"`
	CreatedAt   time.Time  `json:"created_at"`
	Approved    int64      `json:"approved"`
	Pending     int64      `json:"pending"`
	Spam        int64      `json:"spam"`
	Trash       int64      `json:"trash"`
	NotifyCount int64      `json:"notify_count"`
	// NetworkNeighbours: "3 other commenters from this network" (7.2), never the network.
	NetworkNeighbours int64 `json:"network_neighbours"`
}

func toCommenterSummary(row db.GetCommenterModerationRow) CommenterSummary {
	return CommenterSummary{
		ID: row.ID, Email: row.Email, Name: row.DisplayName, NamesUsed: row.NamesUsed,
		VerifiedAt: nullTimePtr(row.VerifiedAt), BlockedAt: nullTimePtr(row.BlockedAt), BlockedBy: row.BlockedByName,
		LastSpamAt: nullTimePtr(row.LastSpamAt), CreatedAt: row.CreatedAt,
		Approved: row.ApprovedCount, Pending: row.PendingCount, Spam: row.SpamCount, Trash: row.TrashCount,
		NotifyCount: row.NotifyCount, NetworkNeighbours: row.NetworkNeighbours,
	}
}

// getDiscussionThread handles GET /discussion/comments/:id/thread: the drawer (4.4).
// The comment's whole thread (its root and every reply, every status but unconfirmed,
// tombstones included), oldest first; the post's discussion state; and the commenter's
// summary when a reader wrote it.
func (server *Server) getDiscussionThread(c *gin.Context) {
	id, ok := discussionCommentID(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	structure, _ := server.urlStructure(ctx)
	comment, ok := server.loadModerationComment(c, id, structure)
	if !ok {
		return
	}
	root := comment.ID
	if comment.RootID != nil {
		root = *comment.RootID
	}
	rows, err := server.store.ListModerationComments(ctx, db.ListModerationCommentsParams{
		RootID: sql.NullInt64{Int64: root, Valid: true}, OldestFirst: true, LimitCount: discussionThreadMax,
	})
	if err != nil {
		server.requestLog(c).Warn("discussion_thread_failed", "comment_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load the thread"})
		return
	}
	thread := make([]ModerationComment, len(rows))
	for i, row := range rows {
		thread[i] = toModerationComment(row, structure)
	}
	rsp := gin.H{"comment": comment, "thread": thread, "commenter": nil, "discussion": nil}
	if comment.Commenter != nil {
		summary, err := server.store.GetCommenterModeration(ctx, comment.Commenter.ID)
		if err == nil {
			rsp["commenter"] = toCommenterSummary(summary)
		} else if !errors.Is(err, sql.ErrNoRows) {
			server.requestLog(c).Warn("discussion_commenter_failed", "commenter_id", comment.Commenter.ID, "error", err)
		}
	}
	// "Comments open · closes Dec 3": fails soft, the drawer says nothing then.
	if post, err := server.store.GetPost(ctx, comment.Post.ID); err == nil {
		if setting, err := server.postDiscussionSetting(ctx, post); err == nil {
			rsp["discussion"] = gin.H{"state": discussionState(setting, time.Now()), "closes_at": setting.ClosesAt}
		}
	}
	c.JSON(http.StatusOK, rsp)
}

// readerCommentActionVerbs is each action's activity verb (15.2).
var readerCommentActionVerbs = map[string]string{
	db.ReaderCommentActionApprove:   db.ActivityReaderCommentApproved,
	db.ReaderCommentActionUnapprove: db.ActivityReaderCommentUnapproved,
	db.ReaderCommentActionSpam:      db.ActivityReaderCommentSpammed,
	db.ReaderCommentActionNotSpam:   db.ActivityReaderCommentNotSpam,
	db.ReaderCommentActionTrash:     db.ActivityReaderCommentTrashed,
	db.ReaderCommentActionRestore:   db.ActivityReaderCommentRestored,
	readerCommentActionDelete:       db.ActivityReaderCommentDeleted,
}

// SetReaderCommentStatusRequest is PUT /discussion/comments/:id/status's body.
type SetReaderCommentStatusRequest struct {
	Action string `json:"action" binding:"required,oneof=approve unapprove spam not_spam trash restore"`
}

// readerCommentOutcome is one comment's committed action, for the answer, the purge,
// the activity and #528's hook.
type readerCommentOutcome struct {
	Comment    db.ReaderComment
	From       string
	Tombstoned bool
	Deleted    bool
}

// event is what readers can now see of it (discussion_purge.go).
func (o readerCommentOutcome) event() discussionEvent {
	if o.Deleted {
		if o.Tombstoned {
			// A hidden comment with approved replies was a placeholder; its tombstone
			// renders the same, but purge anyway: a delete is never worth a stale thread.
			return discussionEventRemoved
		}
		// Only spam and trash are deleted, and without approved replies nothing showed.
		return discussionEventUnseen
	}
	return discussionStatusEvent(o.From, o.Comment.Status)
}

// moderateOne runs one action on one comment and answers the failure it hit (nil = done).
func (server *Server) moderateOne(ctx context.Context, caller db.User, id int64, action string) (readerCommentOutcome, *postActionError) {
	if action == readerCommentActionDelete {
		// 6.4: Delete permanently is for spam and trash only (checked under the row lock).
		result, err := server.store.DeleteModeratedReaderCommentTx(ctx, id)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			return readerCommentOutcome{}, &postActionError{http.StatusNotFound, "comment_not_found", "comment not found"}
		case errors.Is(err, db.ErrReaderCommentStatusChanged):
			return readerCommentOutcome{}, &postActionError{http.StatusConflict, "comment_status_changed", "only comments in spam or the trash can be deleted permanently"}
		case err != nil:
			return readerCommentOutcome{}, &postActionError{http.StatusInternalServerError, "", "failed to delete the comment"}
		}
		return readerCommentOutcome{Comment: result.Comment, From: result.Status, Deleted: true, Tombstoned: result.Tombstoned}, nil
	}
	result, err := server.store.ModerateReaderCommentTx(ctx, db.ModerateReaderCommentTxParams{ID: id, Action: action, ModeratorID: caller.ID})
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return readerCommentOutcome{}, &postActionError{http.StatusNotFound, "comment_not_found", "comment not found"}
	case errors.Is(err, db.ErrReaderCommentStatusChanged):
		return readerCommentOutcome{}, &postActionError{http.StatusConflict, "comment_status_changed", "the comment isn't where this action applies any more"}
	case err != nil:
		return readerCommentOutcome{}, &postActionError{http.StatusInternalServerError, "", "failed to moderate the comment"}
	}
	return readerCommentOutcome{Comment: result.After, From: result.Before.Status}, nil
}

// recordReaderCommentActivity records one comment's verb, with its post.
func (server *Server) recordReaderCommentActivity(c *gin.Context, verb string, comment db.ReaderComment, extra map[string]any) {
	payload := map[string]any{"post_id": comment.PostID}
	for k, v := range extra {
		payload[k] = v
	}
	server.recordRequestActivity(c, activityEvent{Verb: verb, ObjectType: db.ActivityObjectReaderComment, ObjectID: comment.ID, Payload: payload})
}

func (o readerCommentOutcome) change(actorID int64) readerCommentChange {
	to := o.Comment.Status
	if o.Deleted {
		to = ""
	}
	return readerCommentChange{CommentID: o.Comment.ID, PostID: o.Comment.PostID, ParentID: o.Comment.ParentID.Int64, From: o.From, To: to, ActorID: actorID}
}

// setDiscussionCommentStatus handles PUT /discussion/comments/:id/status {action}:
// approve (pending), unapprove (approved), spam (pending or approved; the commenter is
// then held for 90 days, 4.2), not_spam (spam, back to pending), trash and restore. 409
// comment_status_changed when the comment isn't where the action applies (someone
// moderated it meanwhile). Answers the comment as the queue shows it.
func (server *Server) setDiscussionCommentStatus(c *gin.Context) {
	id, ok := discussionCommentID(c)
	if !ok {
		return
	}
	var req SetReaderCommentStatusRequest
	if !bindJSON(c, &req) {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	outcome, failure := server.moderateOne(ctx, caller, id, req.Action)
	if failure != nil {
		if failure.Status == http.StatusInternalServerError {
			server.requestLog(c).Warn("discussion_moderate_failed", "comment_id", id, "action", req.Action)
		}
		failure.write(c)
		return
	}
	server.purgeDiscussion(ctx, server.requestLog(c), outcome.Comment.PostID, outcome.event())
	server.recordReaderCommentActivity(c, readerCommentActionVerbs[req.Action], outcome.Comment, nil)
	server.notifyReaderCommentChanges(ctx, []readerCommentChange{outcome.change(caller.ID)})
	server.requestLog(c).Info("discussion_moderated", "comment_id", id, "post_id", outcome.Comment.PostID, "action", req.Action, "from", outcome.From, "to", outcome.Comment.Status)
	structure, _ := server.urlStructure(ctx)
	comment, ok := server.loadModerationComment(c, id, structure)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"comment": comment})
}

// deleteDiscussionComment handles DELETE /discussion/comments/:id: Delete permanently,
// from spam or trash only (409 otherwise). A comment with approved replies becomes a
// tombstone (6.4). 204.
func (server *Server) deleteDiscussionComment(c *gin.Context) {
	id, ok := discussionCommentID(c)
	if !ok {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	outcome, failure := server.moderateOne(ctx, caller, id, readerCommentActionDelete)
	if failure != nil {
		failure.write(c)
		return
	}
	server.purgeDiscussion(ctx, server.requestLog(c), outcome.Comment.PostID, outcome.event())
	server.recordReaderCommentActivity(c, db.ActivityReaderCommentDeleted, outcome.Comment, map[string]any{"status": outcome.From})
	server.notifyReaderCommentChanges(ctx, []readerCommentChange{outcome.change(caller.ID)})
	server.requestLog(c).Info("discussion_deleted", "comment_id", id, "post_id", outcome.Comment.PostID, "tombstoned", outcome.Tombstoned)
	c.Status(http.StatusNoContent)
}

// BulkReaderCommentsRequest is POST /discussion/comments/bulk's body.
type BulkReaderCommentsRequest struct {
	Action string  `json:"action" binding:"required,oneof=approve unapprove spam not_spam trash restore delete"`
	IDs    []int64 `json:"ids" binding:"required,min=1,max=100,dive,min=1"`
}

// BulkReaderCommentResult is one comment's outcome, as POST /posts/bulk answers.
type BulkReaderCommentResult struct {
	ID            int64  `json:"id"`
	OK            bool   `json:"ok"`
	CommentStatus string `json:"comment_status,omitempty"`
	Status        int    `json:"status,omitempty"`
	Code          string `json:"code,omitempty"`
	Error         string `json:"error,omitempty"`
}

// bulkDiscussionComments handles POST /discussion/comments/bulk {action, ids}: the
// queue's bulk Approve, Unapprove, Spam, Not spam, Trash, Restore and Delete permanently
// (4.4). Each comment is moderated on its own, as its single route would (its own
// transaction and checks); one comment's failure never stops the others. 200 with a
// result per id (duplicates once, in the order given) and the totals, as POST
// /posts/bulk answers. One purge for the request, one activity event
// (reader_comments_bulk_moderated, with the action and the count that applied).
func (server *Server) bulkDiscussionComments(c *gin.Context) {
	var req BulkReaderCommentsRequest
	if !bindJSON(c, &req) {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	ids := make([]int64, 0, len(req.IDs))
	seen := make(map[int64]bool, len(req.IDs))
	for _, id := range req.IDs {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}

	results := make([]BulkReaderCommentResult, 0, len(ids))
	changes := make([]readerCommentChange, 0, len(ids))
	purge := false
	var postID int64
	samePost := true
	for _, id := range ids {
		outcome, failure := server.moderateOne(ctx, caller, id, req.Action)
		if failure != nil {
			results = append(results, BulkReaderCommentResult{ID: id, Status: failure.Status, Code: failure.Code, Error: failure.Message})
			continue
		}
		result := BulkReaderCommentResult{ID: id, OK: true}
		if !outcome.Deleted {
			result.CommentStatus = outcome.Comment.Status
		}
		results = append(results, result)
		changes = append(changes, outcome.change(caller.ID))
		if discussionEventPurges[outcome.event()] {
			purge = true
		}
		if postID == 0 {
			postID = outcome.Comment.PostID
		} else if postID != outcome.Comment.PostID {
			samePost = false
		}
	}
	succeeded := len(changes)
	if succeeded > 0 {
		purgePost := postID
		if !samePost {
			purgePost = 0
		}
		if purge {
			server.purgeDiscussion(ctx, server.requestLog(c), purgePost, discussionEventBulkModerated)
		}
		payload := map[string]any{"action": req.Action, "count": succeeded}
		if samePost {
			payload["post_id"] = postID
		}
		server.recordRequestActivity(c, activityEvent{Verb: db.ActivityReaderCommentsBulkModerated, ObjectType: db.ActivityObjectReaderComment, ObjectID: 0, Payload: payload})
		server.notifyReaderCommentChanges(ctx, changes)
	}
	server.requestLog(c).Info("discussion_bulk_moderated", "action", req.Action, "requested", len(ids), "succeeded", succeeded)
	c.JSON(http.StatusOK, gin.H{
		"action":    req.Action,
		"results":   results,
		"succeeded": succeeded,
		"failed":    len(results) - succeeded,
	})
}

// MemberReaderCommentRequest is a member's comment or reply (POST
// /discussion/posts/:id/comments) or an edit of their own (PUT /discussion/comments/:id).
type MemberReaderCommentRequest struct {
	Body     string `json:"body"`
	ParentID int64  `json:"parent_id" binding:"omitempty,min=1"`
}

// memberCommentName is a member's name as a comment keeps it (3.4: a removed member's
// comment keeps the name it was posted with): their full name, else the username, cut to
// the column's 60 characters.
func memberCommentName(user db.User) string {
	name := strings.TrimSpace(user.FullName)
	if name == "" {
		name = user.Username
	}
	if utf8.RuneCountInString(name) > readerCommentNameMax {
		name = string([]rune(name)[:readerCommentNameMax])
	}
	return name
}

// createDiscussionComment handles POST /discussion/posts/:id/comments {body, parent_id?}:
// a member's comment, or reply, posted as them and approved at once (3.4). A reply to a
// pending comment approves it first, in the same transaction ("Approve and reply", 4.4);
// one to a comment that is in spam or the trash, removed, gone or on another post is 404
// parent_not_found. 409 comments_off while comments are off for the site; 409
// post_trashed on a post in the trash. 201 {comment, parent_approved}.
func (server *Server) createDiscussionComment(c *gin.Context) {
	postID, ok := discussionPostID(c)
	if !ok {
		return
	}
	var req MemberReaderCommentRequest
	if !bindJSON(c, &req) {
		return
	}
	body, code := normalizeReaderCommentBody(req.Body)
	if code != "" {
		respondReaderCommentField(c, "body", code)
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	settings, err := server.store.GetSettings(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the settings"})
		return
	}
	if !settings.CommentsEnabled {
		respondDiscussionError(c, http.StatusConflict, "comments_off", "comments are off for this site")
		return
	}
	post, ok := server.loadDiscussionPost(c, postID)
	if !ok {
		return
	}
	if post.PostStatus == postStatusTrash {
		respondDiscussionError(c, http.StatusConflict, "post_trashed", "the post is in the trash")
		return
	}
	result, err := server.store.CreateMemberReaderCommentTx(ctx, db.CreateMemberReaderCommentTxParams{
		PostID:      postID,
		ParentID:    sql.NullInt64{Int64: req.ParentID, Valid: req.ParentID > 0},
		AuthorID:    caller.ID,
		DisplayName: memberCommentName(caller),
		Body:        body,
	})
	if errors.Is(err, db.ErrReaderCommentParentGone) {
		respondDiscussionError(c, http.StatusNotFound, "parent_not_found", "the comment you're replying to isn't available any more")
		return
	}
	if err != nil {
		server.requestLog(c).Warn("discussion_member_comment_failed", "post_id", postID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to post the comment"})
		return
	}
	log := server.requestLog(c)
	server.purgeDiscussion(ctx, log, postID, discussionEventPublished)
	changes := []readerCommentChange{}
	if result.ParentApproved && result.Parent != nil {
		server.recordReaderCommentActivity(c, db.ActivityReaderCommentApproved, *result.Parent, nil)
		changes = append(changes, readerCommentChange{CommentID: result.Parent.ID, PostID: postID, ParentID: result.Parent.ParentID.Int64, From: db.ReaderCommentPending, To: db.ReaderCommentApproved, ActorID: caller.ID})
	}
	server.recordReaderCommentActivity(c, db.ActivityReaderCommentPosted, result.Comment, map[string]any{"parent_id": req.ParentID})
	changes = append(changes, readerCommentChange{CommentID: result.Comment.ID, PostID: postID, ParentID: req.ParentID, To: db.ReaderCommentApproved, ActorID: caller.ID})
	server.notifyReaderCommentChanges(ctx, changes)
	log.Info("discussion_member_comment", "comment_id", result.Comment.ID, "post_id", postID, "parent_approved", result.ParentApproved)
	comment, ok := server.loadModerationComment(c, result.Comment.ID, settings.PostUrlStructure)
	if !ok {
		return
	}
	c.JSON(http.StatusCreated, gin.H{"comment": comment, "parent_approved": result.ParentApproved})
}

// updateDiscussionComment handles PUT /discussion/comments/:id {body}: a member edits
// their own comment (6.4; moderators never edit a reader's text, decision 9). 403
// not_your_comment for anyone else's. The comment then shows "Edited".
func (server *Server) updateDiscussionComment(c *gin.Context) {
	id, ok := discussionCommentID(c)
	if !ok {
		return
	}
	var req MemberReaderCommentRequest
	if !bindJSON(c, &req) {
		return
	}
	body, code := normalizeReaderCommentBody(req.Body)
	if code != "" {
		respondReaderCommentField(c, "body", code)
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	updated, err := server.store.UpdateMemberReaderComment(ctx, db.UpdateMemberReaderCommentParams{
		ID: id, AuthorUserID: sql.NullInt64{Int64: caller.ID, Valid: true}, Body: body,
	})
	if errors.Is(err, sql.ErrNoRows) {
		current, getErr := server.store.GetReaderComment(ctx, id)
		if getErr == nil && current.Status != db.ReaderCommentUnconfirmed && !current.RemovedAt.Valid {
			respondDiscussionError(c, http.StatusForbidden, "not_your_comment", "only the member who wrote a comment can edit it")
			return
		}
		c.JSON(http.StatusNotFound, gin.H{"error": "comment not found", "code": "comment_not_found"})
		return
	}
	if err != nil {
		server.requestLog(c).Warn("discussion_edit_failed", "comment_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save the comment"})
		return
	}
	if updated.Status == db.ReaderCommentApproved {
		server.purgeDiscussion(ctx, server.requestLog(c), updated.PostID, discussionEventEdited)
	}
	server.recordReaderCommentActivity(c, db.ActivityReaderCommentEdited, updated, map[string]any{"parent_id": updated.ParentID.Int64})
	structure, _ := server.urlStructure(ctx)
	comment, ok := server.loadModerationComment(c, id, structure)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"comment": comment})
}

// findDiscussionCommenter handles GET /discussion/commenters?email=: Find a commenter by
// the whole address (16.1; never a prefix, so the queue can't be fished for addresses).
// 200 {id} or 404.
func (server *Server) findDiscussionCommenter(c *gin.Context) {
	email := strings.ToLower(strings.TrimSpace(c.Query("email")))
	if email == "" || len(email) > 254 || !strings.Contains(email, "@") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email must be a whole address", "fields": gin.H{"email": "enter the whole address"}})
		return
	}
	id, err := server.store.GetCommenterIDByEmail(c.Request.Context(), email)
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "no commenter uses this address", "code": "commenter_not_found"})
		return
	}
	if err != nil {
		server.requestLog(c).Warn("discussion_find_commenter_failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to look the address up"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": id})
}

func discussionCommenterID(c *gin.Context) (int64, bool) {
	return parseIDParamNamed(c, "id", "commenter ID")
}

// getDiscussionCommenter handles GET /discussion/commenters/:id: a commenter's page
// (16.1): the summary and every comment of theirs (but unconfirmed ones), newest first.
// 404 commenter_not_found once erased or pruned ("This commenter isn't here anymore").
func (server *Server) getDiscussionCommenter(c *gin.Context) {
	id, ok := discussionCommenterID(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	summary, err := server.store.GetCommenterModeration(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "commenter not found", "code": "commenter_not_found"})
		return
	}
	if err != nil {
		server.requestLog(c).Warn("discussion_commenter_failed", "commenter_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load the commenter"})
		return
	}
	rows, err := server.store.ListModerationComments(ctx, db.ListModerationCommentsParams{
		CommenterID: sql.NullInt64{Int64: id, Valid: true}, LimitCount: discussionThreadMax,
	})
	if err != nil {
		server.requestLog(c).Warn("discussion_commenter_failed", "commenter_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load the commenter"})
		return
	}
	structure, _ := server.urlStructure(ctx)
	comments := make([]ModerationComment, len(rows))
	for i, row := range rows {
		comments[i] = toModerationComment(row, structure)
	}
	c.JSON(http.StatusOK, gin.H{"commenter": toCommenterSummary(summary), "comments": comments})
}

// BlockCommenterRequest is PUT /discussion/commenters/:id/block's body.
type BlockCommenterRequest struct {
	Blocked *bool `json:"blocked" binding:"required"`
}

// blockDiscussionCommenter handles PUT /discussion/commenters/:id/block {blocked}: 5.5.
// A blocked commenter's later comments go to spam silently; it applies at once and is
// undoable. Nothing public changes (no purge). Activity commenter_blocked or
// commenter_unblocked with their comment count. Answers the summary.
func (server *Server) blockDiscussionCommenter(c *gin.Context) {
	id, ok := discussionCommenterID(c)
	if !ok {
		return
	}
	var req BlockCommenterRequest
	if !bindJSON(c, &req) {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	_, err := server.store.SetCommenterBlocked(ctx, db.SetCommenterBlockedParams{
		ID: id, Blocked: *req.Blocked, BlockedBy: sql.NullInt64{Int64: caller.ID, Valid: true},
	})
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "commenter not found", "code": "commenter_not_found"})
		return
	}
	if err != nil {
		server.requestLog(c).Warn("discussion_block_failed", "commenter_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save the block"})
		return
	}
	summary, err := server.store.GetCommenterModeration(ctx, id)
	if err != nil {
		server.requestLog(c).Warn("discussion_commenter_failed", "commenter_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load the commenter"})
		return
	}
	verb := db.ActivityCommenterUnblocked
	if *req.Blocked {
		verb = db.ActivityCommenterBlocked
	}
	count := summary.ApprovedCount + summary.PendingCount + summary.SpamCount + summary.TrashCount
	server.recordRequestActivity(c, activityEvent{Verb: verb, ObjectType: db.ActivityObjectCommenter, ObjectID: id, Payload: map[string]any{"comment_count": count}})
	server.requestLog(c).Info("discussion_commenter_blocked", "commenter_id", id, "blocked", *req.Blocked)
	c.JSON(http.StatusOK, gin.H{"commenter": toCommenterSummary(summary)})
}

// PendingCommentsAttention is Home's "4 comments await moderation" (4.4, 16.1): how many,
// on how many posts, and when the oldest arrived.
type PendingCommentsAttention struct {
	Count     int64      `json:"count"`
	PostCount int64      `json:"post_count"`
	OldestAt  *time.Time `json:"oldest_at"`
}

func (server *Server) pendingCommentsAttention(ctx context.Context) (*PendingCommentsAttention, error) {
	row, err := server.store.GetPendingReaderCommentsSummary(ctx)
	if err != nil {
		return nil, err
	}
	rsp := &PendingCommentsAttention{Count: row.Count, PostCount: row.PostCount}
	if row.Count > 0 {
		oldest := row.OldestAt
		rsp.OldestAt = &oldest
	}
	return rsp, nil
}
