// Package api — Review requests (#323, 000044)
//
// Anyone who may edit a post (canRequestReview = canEditPost) asks the editors and
// admins to review it, optionally naming one of them. Contributors above all: they
// can't publish (#135), so this is how their work reaches an editor.
//
//   - POST /posts/:id/review-request {reviewer_id?, message?} → 201 {review_request}.
//     One open request per post (000044's unique index): a second one while it is open
//     answers 409 code review_already_requested with the open request, and emails
//     nobody. To name another reviewer, withdraw it (dismiss) and ask again.
//   - GET /posts/:id/review-request → {review_request | null}: the open request, or
//     the latest one if changes were requested and nothing was published since (the
//     editor's notice). Reviewers and the post's owner only (canSeeReviewRequests).
//   - GET /posts/reviewers → who may be named (editors and admins, public fields).
//   - POST /review-requests/:id/dismiss: a reviewer, or the requester (withdrawn).
//   - POST /review-requests/:id/request-changes {note}: a reviewer; the note is
//     required, plain text (comments, #192, aren't built). The requester is emailed.
//   - Publishing resolves the open request by any path (Publish/Update, bulk, the
//     scheduler, a status set through PUT): 000044's trigger, which also records the
//     review_resolved event.
//
// Who is emailed when a request is made: the named reviewer; with none, every
// editor and admin except the requester (at most reviewRecipientLimit, the most
// recently active first; the request also shows in their Home's Needs attention). Each recipient gets their own message (never a shared To/Cc),
// sent after the response (runInBackground), so the answer is the same whoever
// gets one and however long mail takes: the API never says who was emailed. Links
// point at PUBLIC_BASE_URL. Logs carry ids and counts only (no addresses, names,
// titles or notes).
package api

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
)

// Codes the admin shows (web lib/reviewRequests.ts mirrors them).
const (
	codeReviewAlreadyRequested = "review_already_requested"
	codeReviewNotOpen          = "review_not_open"
	codeInvalidReviewer        = "invalid_reviewer"
)

// reviewRecipientLimit caps the emails one request sends (every editor and admin,
// when no reviewer is named).
const reviewRecipientLimit = 100

// The notes' limits in characters, once trimmed (000044's CHECKs).
const (
	reviewMessageMax = 1000
	reviewNoteMax    = 2000
)

// reviewersListLimit caps GET /posts/reviewers.
const reviewersListLimit = 200

// The emails' link is #321's: PUBLIC_BASE_URL + adminEditPath, and they're sent the
// same way (notifyAccessReviewers): the lookups under one mailSendTimeout, each
// email under its own (sendMail), so a slow relay delays later emails but never
// drops them.

// displayName is how emails name a member.
func displayName(fullName, username string) string {
	if name := strings.TrimSpace(fullName); name != "" {
		return name
	}
	return username
}

// ReviewPerson is a member a review request names: public fields only.
type ReviewPerson struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	FullName string  `json:"full_name"`
	Avatar   *string `json:"avatar"`
}

func reviewPerson(id sql.NullInt64, username, fullName, avatar sql.NullString) *ReviewPerson {
	if !id.Valid || !username.Valid {
		return nil // nobody, or a member removed since
	}
	p := &ReviewPerson{ID: id.Int64, Username: username.String, FullName: fullName.String}
	if avatar.Valid && avatar.String != "" {
		a := avatar.String
		p.Avatar = &a
	}
	return p
}

// ReviewRequestResponse is a review request as the editor shows it.
type ReviewRequestResponse struct {
	ID     int64  `json:"id"`
	PostID int64  `json:"post_id"`
	Status string `json:"status"`
	// Message: the requester's note; ResolutionNote: the reviewer's, with
	// changes_requested.
	Message        string        `json:"message"`
	ResolutionNote string        `json:"resolution_note"`
	CreatedAt      time.Time     `json:"created_at"`
	ResolvedAt     *time.Time    `json:"resolved_at"`
	RequestedBy    *ReviewPerson `json:"requested_by"`
	// Reviewer: who was asked; null = any editor or admin.
	Reviewer   *ReviewPerson `json:"reviewer"`
	ResolvedBy *ReviewPerson `json:"resolved_by"`
}

func toReviewRequestResponse(row db.GetCurrentReviewRequestRow) ReviewRequestResponse {
	return ReviewRequestResponse{
		ID:             row.ID,
		PostID:         row.PostID,
		Status:         row.Status,
		Message:        row.Message,
		ResolutionNote: row.ResolutionNote,
		CreatedAt:      row.CreatedAt,
		ResolvedAt:     nullTimePtr(row.ResolvedAt),
		RequestedBy:    reviewPerson(row.RequestedBy, row.RequesterUsername, row.RequesterFullName, row.RequesterAvatarUrl),
		Reviewer:       reviewPerson(row.ReviewerID, row.ReviewerUsername, row.ReviewerFullName, row.ReviewerAvatarUrl),
		ResolvedBy:     reviewPerson(row.ResolvedBy, row.ResolverUsername, row.ResolverFullName, row.ResolverAvatarUrl),
	}
}

// reviewRequestFromRow is a just-written request without the joined names (only
// ids), for when re-reading it failed.
func reviewRequestFromRow(rr db.ReviewRequest) ReviewRequestResponse {
	idOnly := func(id sql.NullInt64) *ReviewPerson {
		if !id.Valid {
			return nil
		}
		return &ReviewPerson{ID: id.Int64}
	}
	return ReviewRequestResponse{
		ID:             rr.ID,
		PostID:         rr.PostID,
		Status:         rr.Status,
		Message:        rr.Message,
		ResolutionNote: rr.ResolutionNote,
		CreatedAt:      rr.CreatedAt,
		ResolvedAt:     nullTimePtr(rr.ResolvedAt),
		RequestedBy:    idOnly(rr.RequestedBy),
		Reviewer:       idOnly(rr.ReviewerID),
		ResolvedBy:     idOnly(rr.ResolvedBy),
	}
}

// ReviewRequestSummary is the posts list's indicator on a row with an open request.
type ReviewRequestSummary struct {
	ID          int64         `json:"id"`
	CreatedAt   time.Time     `json:"created_at"`
	RequestedBy *ReviewPerson `json:"requested_by"`
	Reviewer    *ReviewPerson `json:"reviewer"`
}

// ReviewRequestAttention is one item of Home's Needs attention ("Kenji asked for a
// review").
type ReviewRequestAttention struct {
	ID          int64         `json:"id"`
	PostID      int64         `json:"post_id"`
	Title       string        `json:"title"`
	PostType    string        `json:"post_type"`
	CreatedAt   time.Time     `json:"created_at"`
	RequestedBy *ReviewPerson `json:"requested_by"`
	// Assigned: the request names the caller (else it names nobody, or someone who
	// can no longer review).
	Assigned bool `json:"assigned"`
}

func toReviewRequestAttention(rows []db.ListReviewRequestsForReviewerRow) *AttentionList[ReviewRequestAttention] {
	list := AttentionList[ReviewRequestAttention]{Posts: make([]ReviewRequestAttention, len(rows))}
	for i, row := range rows {
		list.Total = row.Total
		list.Posts[i] = ReviewRequestAttention{
			ID:          row.ID,
			PostID:      row.PostID,
			Title:       row.Title,
			PostType:    row.PostType,
			CreatedAt:   row.CreatedAt,
			RequestedBy: reviewPerson(row.RequestedBy, row.RequesterUsername, row.RequesterFullName, sql.NullString{}),
			Assigned:    row.AssignedToViewer,
		}
	}
	return &list
}

// attachReviewRequests sets the list rows' review_request (an open request), on
// the rows the caller may see requests for (canSeeReviewRequests). A failed lookup
// leaves the indicator out rather than failing the list.
func (server *Server) attachReviewRequests(ctx context.Context, log *slog.Logger, caller db.User, posts []PostWithMetaResponse) {
	ids := make([]int64, 0, len(posts))
	for _, p := range posts {
		if canSeeReviewRequests(caller, db.Post{ID: p.ID, UserID: p.UserID}) {
			ids = append(ids, p.ID)
		}
	}
	if len(ids) == 0 {
		return
	}
	rows, err := server.store.ListOpenReviewRequestsForPosts(ctx, ids)
	if err != nil {
		log.Warn("listing review requests failed", "error", err)
		return
	}
	byPost := make(map[int64]*ReviewRequestSummary, len(rows))
	for _, row := range rows {
		byPost[row.PostID] = &ReviewRequestSummary{
			ID:          row.ID,
			CreatedAt:   row.CreatedAt,
			RequestedBy: reviewPerson(row.RequestedBy, row.RequesterUsername, row.RequesterFullName, sql.NullString{}),
			Reviewer:    reviewPerson(row.ReviewerID, row.ReviewerUsername, row.ReviewerFullName, sql.NullString{}),
		}
	}
	for i := range posts {
		posts[i].ReviewRequest = byPost[posts[i].ID]
	}
}

// attachCallerReviewRequests is attachReviewRequests for the authenticated caller.
func (server *Server) attachCallerReviewRequests(c *gin.Context, posts []PostWithMetaResponse) {
	caller, ok := c.Get(authorizationUserKey)
	user, isUser := caller.(db.User)
	if !ok || !isUser {
		return
	}
	server.attachReviewRequests(c.Request.Context(), server.requestLog(c), user, posts)
}

// sendReviewRequestEmails emails a new request's reviewers: the named one, or
// every editor and admin but the requester. Runs after the response; errors are
// only logged.
func (server *Server) sendReviewRequestEmails(logger *slog.Logger, request db.ReviewRequest, requester db.User, postTitle string) {
	ctx, cancel := context.WithTimeout(context.Background(), mailSendTimeout)
	defer cancel()

	recipients, err := server.store.ListReviewRecipients(ctx, db.ListReviewRecipientsParams{
		Roles:       reviewerRoles,
		RequesterID: requester.ID,
		ReviewerID:  request.ReviewerID.Int64, // 0 = none named
		LimitCount:  reviewRecipientLimit,
	})
	if err != nil {
		logger.Error("review request: recipient lookup failed", "review_request_id", request.ID, "error", err)
		return
	}
	site := server.siteTitle(ctx)
	sent, failed := 0, 0
	for _, to := range recipients {
		msg, err := mailer.RenderReviewRequested(to.Email, mailer.ReviewRequested{
			SiteTitle:     site,
			RequesterName: displayName(requester.FullName, requester.Username),
			PostTitle:     postTitle,
			Note:          request.Message,
			Link:          server.publicURL + fmt.Sprintf(adminEditPath, request.PostID),
			Assigned:      request.ReviewerID.Valid,
		})
		if err == nil {
			err = server.sendMail(context.Background(), msg)
		}
		if err != nil {
			failed++
			logger.Error("review request email failed", "review_request_id", request.ID, "user_id", to.ID, "error", err)
			continue
		}
		sent++
	}
	logger.Info("review request emails sent", "review_request_id", request.ID, "post_id", request.PostID, "sent", sent, "failed", failed)
}

// sendChangesRequestedEmail tells the requester a reviewer asked for changes. Not
// when they're gone or asked for changes on their own request.
func (server *Server) sendChangesRequestedEmail(logger *slog.Logger, request db.ReviewRequest, reviewer db.User, postTitle string) {
	if !request.RequestedBy.Valid || request.RequestedBy.Int64 == reviewer.ID {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), mailSendTimeout)
	defer cancel()

	requester, err := server.store.GetUser(ctx, request.RequestedBy.Int64)
	if err != nil {
		// Removed since (sql.ErrNoRows): nobody to tell.
		if err != sql.ErrNoRows {
			logger.Error("changes requested: requester lookup failed", "review_request_id", request.ID, "error", err)
		}
		return
	}
	msg, err := mailer.RenderReviewChangesRequested(requester.Email, mailer.ReviewChangesRequested{
		SiteTitle:    server.siteTitle(ctx),
		ReviewerName: displayName(reviewer.FullName, reviewer.Username),
		PostTitle:    postTitle,
		Note:         request.ResolutionNote,
		Link:         server.publicURL + fmt.Sprintf(adminEditPath, request.PostID),
	})
	if err == nil {
		err = server.sendMail(context.Background(), msg)
	}
	if err != nil {
		logger.Error("changes requested email failed", "review_request_id", request.ID, "user_id", requester.ID, "error", err)
		return
	}
	logger.Info("changes requested email sent", "review_request_id", request.ID, "user_id", requester.ID)
}
