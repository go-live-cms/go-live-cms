package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// registerReviewRequestRoutes registers the review request routes (#323,
// review_requests.go). Every route takes a content role; the handlers decide per
// post and request. The per-post ones live under /posts in RegisterPostRoutes.
func (server *Server) registerReviewRequestRoutes(v1 *gin.RouterGroup) {
	reviews := v1.Group("/review-requests", server.requireAuth(), requireContentAuthor(server))
	{
		// A reviewer, or the requester withdrawing it.
		reviews.POST("/:id/dismiss", server.dismissReviewRequest)
		// Reviewers only (editors and admins), with a note.
		reviews.POST("/:id/request-changes", requireContentEditor(server), server.requestReviewChanges)
	}
}

// CreateReviewRequestRequest is POST /posts/:id/review-request's body (optional).
type CreateReviewRequestRequest struct {
	// ReviewerID names an editor or admin; absent or 0 = any of them.
	ReviewerID int64 `json:"reviewer_id" binding:"omitempty,min=1"`
	// Message is an optional note for the reviewer, plain text: at most
	// reviewMessageMax characters once trimmed (requestReview checks; the binding
	// only bounds the body).
	Message string `json:"message" binding:"max=4000"`
}

// RequestReviewChangesRequest is POST /review-requests/:id/request-changes's body.
type RequestReviewChangesRequest struct {
	// Note says what to change, plain text (comments, #192, aren't built): at most
	// reviewNoteMax characters once trimmed.
	Note string `json:"note" binding:"required,max=8000"`
}

// currentReviewRequest reads the post's current request for a response; nil
// when it has none.
func (server *Server) currentReviewRequest(c *gin.Context, postID int64) (*ReviewRequestResponse, error) {
	row, err := server.store.GetCurrentReviewRequest(c.Request.Context(), postID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rsp := toReviewRequestResponse(row)
	return &rsp, nil
}

// reviewRequestResponseFor is the response after a write: the request with its
// names, re-read; just the ids if that read fails (the write stands).
func (server *Server) reviewRequestResponseFor(c *gin.Context, rr db.ReviewRequest) ReviewRequestResponse {
	row, err := server.store.GetReviewRequestDetail(c.Request.Context(), rr.ID)
	if err != nil {
		server.requestLog(c).Warn("re-reading the review request failed", "review_request_id", rr.ID, "error", err)
		return reviewRequestFromRow(rr)
	}
	return toReviewRequestResponse(db.GetCurrentReviewRequestRow(row))
}

// getPostReviewRequest handles GET /posts/:id/review-request: the post's open
// request, or the latest one when changes were requested and nothing was published
// since; null otherwise. Reviewers and the post's owner (canSeeReviewRequests).
func (server *Server) getPostReviewRequest(c *gin.Context) {
	id, ok := postIDParam(c)
	if !ok {
		return
	}
	post, err := server.store.GetPost(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			errPostNotFound.write(c)
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	if !canReadPost(caller, post) {
		errPostRefused.write(c)
		return
	}
	if !canSeeReviewRequests(caller, post) {
		c.JSON(http.StatusOK, gin.H{"review_request": nil})
		return
	}
	current, err := server.currentReviewRequest(c, id)
	if err != nil {
		server.requestLog(c).Warn("reading the review request failed", "post_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the review request"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"review_request": current})
}

// listReviewers handles GET /posts/reviewers: who may be named as a reviewer
// (editors and admins), public fields only, for the Request review picker.
func (server *Server) listReviewers(c *gin.Context) {
	rows, err := server.store.ListReviewers(c.Request.Context(), db.ListReviewersParams{
		Roles:      reviewerRoles,
		LimitCount: reviewersListLimit,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list reviewers"})
		return
	}
	reviewers := make([]ReviewPerson, 0, len(rows))
	for _, row := range rows {
		p := ReviewPerson{ID: row.ID, Username: row.Username, FullName: row.FullName}
		if row.AvatarUrl != "" {
			a := row.AvatarUrl
			p.Avatar = &a
		}
		reviewers = append(reviewers, p)
	}
	c.JSON(http.StatusOK, gin.H{"reviewers": reviewers})
}

// requestReview handles POST /posts/:id/review-request {reviewer_id?, message?}:
// anyone who may edit the post (canRequestReview) asks for a review. The named
// reviewer must be an editor or admin other than the caller (400 invalid_reviewer
// otherwise, the same for an unknown id). A post with an open request answers 409
// review_already_requested with it, and nobody is emailed again. The emails go
// out after the response (review_requests.go).
func (server *Server) requestReview(c *gin.Context) {
	id, ok := postIDParam(c)
	if !ok {
		return
	}
	var req CreateReviewRequestRequest
	if !bindOptionalJSON(c, &req) {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	post, failure := server.loadPostFor(ctx, caller, id)
	if failure != nil {
		failure.write(c)
		return
	}
	if !server.checkPost(c, caller, post, canRequestReview) {
		return
	}

	message := strings.TrimSpace(req.Message)
	if utf8.RuneCountInString(message) > reviewMessageMax {
		c.JSON(http.StatusBadRequest, gin.H{"error": "message must be at most 1000 characters", "fields": gin.H{"message": "must be at most 1000 characters"}})
		return
	}

	reviewer := sql.NullInt64{}
	if req.ReviewerID != 0 {
		named, err := server.store.GetUser(ctx, req.ReviewerID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check the reviewer"})
			return
		}
		if err != nil || !canReview(named) || named.ID == caller.ID {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": "the reviewer must be another member who is an editor or admin",
				"code":  codeInvalidReviewer,
			})
			return
		}
		reviewer = sql.NullInt64{Int64: named.ID, Valid: true}
	}

	created, err := server.store.CreateReviewRequest(ctx, db.CreateReviewRequestParams{
		PostID:      id,
		RequestedBy: sql.NullInt64{Int64: caller.ID, Valid: true},
		ReviewerID:  reviewer,
		Message:     message,
	})
	if errors.Is(err, sql.ErrNoRows) {
		// One open request per post (000040). Answer with it, so the editor shows it.
		rsp := gin.H{"error": "a review was already requested for this post", "code": codeReviewAlreadyRequested}
		if current, err := server.currentReviewRequest(c, id); err == nil && current != nil {
			rsp["review_request"] = current
		}
		c.JSON(http.StatusConflict, rsp)
		return
	}
	if err != nil {
		server.requestLog(c).Warn("creating a review request failed", "post_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to request a review"})
		return
	}

	payload := map[string]any{"request_id": created.ID}
	if reviewer.Valid {
		payload["reviewer_id"] = reviewer.Int64
	}
	server.recordPostActivity(c, db.ActivityReviewRequested, id, payload)

	logger := server.requestLog(c)
	title := post.Title
	server.runInBackground(requestIDFromContext(c), c.FullPath(), func() {
		server.sendReviewRequestEmails(logger, created, caller, title)
	})
	c.JSON(http.StatusCreated, gin.H{"review_request": server.reviewRequestResponseFor(c, created)})
}

// loadReviewRequest reads :id's request and its post, and checks that the caller
// may read the post. false means a response was written.
func (server *Server) loadReviewRequest(c *gin.Context) (db.ReviewRequest, db.Post, db.User, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid review request ID"})
		return db.ReviewRequest{}, db.Post{}, db.User{}, false
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return db.ReviewRequest{}, db.Post{}, db.User{}, false
	}
	ctx := c.Request.Context()
	notFound := func() {
		c.JSON(http.StatusNotFound, gin.H{"error": "review request not found"})
	}
	rr, err := server.store.GetReviewRequest(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			notFound()
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the review request"})
		}
		return db.ReviewRequest{}, db.Post{}, db.User{}, false
	}
	post, err := server.store.GetPost(ctx, rr.PostID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			notFound()
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		}
		return db.ReviewRequest{}, db.Post{}, db.User{}, false
	}
	// Someone who doesn't see the post's requests gets the unknown id's answer.
	if !canReadPost(caller, post) || !canSeeReviewRequests(caller, post) {
		notFound()
		return db.ReviewRequest{}, db.Post{}, db.User{}, false
	}
	return rr, post, caller, true
}

// resolveReviewRequest writes a dismissal or changes requested; false means a
// response was written (409 review_not_open when it was resolved meanwhile).
func (server *Server) resolveReviewRequest(c *gin.Context, rr db.ReviewRequest, caller db.User, status, note string) (db.ReviewRequest, bool) {
	if rr.Status != db.ReviewStatusOpen {
		respondReviewNotOpen(c)
		return db.ReviewRequest{}, false
	}
	resolved, err := server.store.ResolveReviewRequest(c.Request.Context(), db.ResolveReviewRequestParams{
		ID:             rr.ID,
		Status:         status,
		ResolvedBy:     sql.NullInt64{Int64: caller.ID, Valid: true},
		ResolutionNote: note,
	})
	if errors.Is(err, sql.ErrNoRows) {
		respondReviewNotOpen(c)
		return db.ReviewRequest{}, false
	}
	if err != nil {
		server.requestLog(c).Warn("resolving a review request failed", "review_request_id", rr.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update the review request"})
		return db.ReviewRequest{}, false
	}
	return resolved, true
}

func respondReviewNotOpen(c *gin.Context) {
	c.JSON(http.StatusConflict, gin.H{"error": "this review request is no longer open", "code": codeReviewNotOpen})
}

// dismissReviewRequest handles POST /review-requests/:id/dismiss: a reviewer
// dismisses it, or its requester withdraws it. 409 review_not_open when it was
// resolved already.
func (server *Server) dismissReviewRequest(c *gin.Context) {
	rr, _, caller, ok := server.loadReviewRequest(c)
	if !ok {
		return
	}
	if !canDismissReviewRequest(caller, rr) {
		errPostRefused.write(c)
		return
	}
	resolved, ok := server.resolveReviewRequest(c, rr, caller, db.ReviewStatusDismissed, "")
	if !ok {
		return
	}
	withdrawn := rr.RequestedBy.Valid && rr.RequestedBy.Int64 == caller.ID
	server.recordPostActivity(c, db.ActivityReviewDismissed, rr.PostID, map[string]any{"request_id": rr.ID, "withdrawn": withdrawn})
	c.JSON(http.StatusOK, gin.H{"review_request": server.reviewRequestResponseFor(c, resolved)})
}

// requestReviewChanges handles POST /review-requests/:id/request-changes {note}:
// a reviewer (editors and admins) resolves the request asking for changes, and
// the requester is emailed the note (after the response). The note must not be
// blank.
func (server *Server) requestReviewChanges(c *gin.Context) {
	var req RequestReviewChangesRequest
	if !bindJSON(c, &req) {
		return
	}
	note := strings.TrimSpace(req.Note)
	if note == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "note is required", "fields": gin.H{"note": "is required"}})
		return
	}
	if utf8.RuneCountInString(note) > reviewNoteMax {
		c.JSON(http.StatusBadRequest, gin.H{"error": "note must be at most 2000 characters", "fields": gin.H{"note": "must be at most 2000 characters"}})
		return
	}
	rr, post, caller, ok := server.loadReviewRequest(c)
	if !ok {
		return
	}
	if !canReview(caller) {
		errPostRefused.write(c)
		return
	}
	resolved, ok := server.resolveReviewRequest(c, rr, caller, db.ReviewStatusChangesRequested, note)
	if !ok {
		return
	}
	server.recordPostActivity(c, db.ActivityReviewChangesRequested, rr.PostID, map[string]any{"request_id": rr.ID})

	logger := server.requestLog(c)
	title := post.Title
	server.runInBackground(requestIDFromContext(c), c.FullPath(), func() {
		server.sendChangesRequestedEmail(logger, resolved, caller, title)
	})
	c.JSON(http.StatusOK, gin.H{"review_request": server.reviewRequestResponseFor(c, resolved)})
}
