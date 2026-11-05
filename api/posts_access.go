// posts_access implements edit access requests and per-post grants (#321).
//
// A contributor watching someone else's published post (view-only, #135) asks
// for edit access from the editor's notice, with an optional message. The post's
// owner, the editors and the admins (canReviewPostAccess) see the request in
// Home's "Needs attention" and the editor, and get an email (#148 mailer); one of
// them grants or declines it. A grant (post_collaborators) can be revoked.
//
// What a grant allows is decided in auth_posts.go (canEditWorkingCopy): the
// working copy only, through a read-write collab connection, while the post is
// published. After a grant or a revoke the API asks the collab server to re-check
// the member's open connections at once (recheckCollabUser, #313/#333), so an
// open editor turns editable, or back to view-only, without a reload.
//
// Abuse limits: one open request per member and post (a unique index), a
// per-member+IP rate limit (RATE_LIMIT_ACCESS_REQUEST_PER_MINUTE), and after a
// decline the same member can't ask again for that post for
// accessRequestCooldown, so a declined request can't be turned into a stream of
// emails to the reviewers.
//
// Every request, grant, decline and revoke is in the activity log (access_*).
//
// Routes (all: requireAuth + requireContentAuthor; the per-post rule in each
// handler):
//
//	GET    /posts/collaborations                                the caller's granted post ids (the posts lists)
//	GET    /posts/:id/access                                    caller's state; reviewers also the open requests and grants
//	POST   /posts/:id/access-requests                           {message?} → 201
//	POST   /posts/:id/access-requests/:request_id/grant         reviewers
//	POST   /posts/:id/access-requests/:request_id/decline       reviewers
//	DELETE /posts/:id/collaborators/:user_id                    reviewers: revoke a grant
package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
)

const (
	// accessRequestCooldown is how long after a decline the same member may not
	// ask again for the same post.
	accessRequestCooldown = 24 * time.Hour

	// accessRequestMessageMax is the message's limit in characters (the
	// table's CHECK says the same).
	accessRequestMessageMax = 500

	// adminEditPath is where the admin edits a post (the email's link).
	adminEditPath = "/gl-admin/content/edit/%d"
)

// Codes the admin reads (lib/postAccess.ts).
const (
	codeAlreadyHasAccess  = "already_has_access"
	codeAccessRequestOpen = "request_open"
	codeRecentlyDeclined  = "recently_declined"
	codeAlreadyAnswered   = "already_answered"
	codeNotCollaborator   = "not_a_collaborator"
)

// RequestPostAccessRequest is POST /posts/:id/access-requests. The body may be
// omitted.
type RequestPostAccessRequest struct {
	Message string `json:"message" binding:"max=500"`
}

// AccessRequestResponse is one access request.
type AccessRequestResponse struct {
	ID         int64      `json:"id"`
	PostID     int64      `json:"post_id"`
	Status     string     `json:"status"`
	Message    string     `json:"message"`
	CreatedAt  time.Time  `json:"created_at"`
	ReviewedAt *time.Time `json:"reviewed_at"`
	// Requester is who asked (reviewers' lists).
	Requester *PostAuthorResponse `json:"requester,omitempty"`
	// RequestAgainAt is when a declined request's member may ask again.
	RequestAgainAt *time.Time `json:"request_again_at,omitempty"`
}

// PostCollaboratorResponse is a member granted edit access to the post.
type PostCollaboratorResponse struct {
	PostAuthorResponse
	GrantedAt time.Time `json:"granted_at"`
}

// PostAccessResponse is GET /posts/:id/access: what the caller may do with the
// post's working copy, and the request state behind the view-only notice.
type PostAccessResponse struct {
	// CanEdit: a read-write collab connection (canEditWorkingCopy).
	CanEdit bool `json:"can_edit"`
	// Collaborator: a grant is what allows it.
	Collaborator bool `json:"collaborator"`
	// CanRequest: the caller may ask for edit access now (no grant, no open
	// request, not within a decline's cooldown).
	CanRequest bool `json:"can_request"`
	// Request is the caller's latest request for this post, or null.
	Request *AccessRequestResponse `json:"request"`
	// CanReview: the caller answers requests and revokes grants. Pending and
	// Collaborators are set (possibly []) only then, else null.
	CanReview     bool                       `json:"can_review"`
	Pending       []AccessRequestResponse    `json:"pending"`
	Collaborators []PostCollaboratorResponse `json:"collaborators"`
}

func toAccessRequestResponse(r db.PostAccessRequest) AccessRequestResponse {
	rsp := AccessRequestResponse{
		ID:         r.ID,
		PostID:     r.PostID,
		Status:     r.Status,
		Message:    r.Message,
		CreatedAt:  r.CreatedAt,
		ReviewedAt: nullTimePtr(r.ReviewedAt),
	}
	if r.Status == db.AccessRequestDeclined && r.ReviewedAt.Valid {
		again := r.ReviewedAt.Time.Add(accessRequestCooldown)
		rsp.RequestAgainAt = &again
	}
	return rsp
}

// mayRequestAgain reports whether a member whose latest request is latest may ask
// again now.
func mayRequestAgain(latest *db.PostAccessRequest, now time.Time) bool {
	if latest == nil {
		return true
	}
	switch latest.Status {
	case db.AccessRequestPending:
		return false
	case db.AccessRequestDeclined:
		return !latest.ReviewedAt.Valid || !now.Before(latest.ReviewedAt.Time.Add(accessRequestCooldown))
	default:
		// Granted, and revoked since (the caller has no grant).
		return true
	}
}

// loadPostForAccess reads the post at :id and checks rule for the caller.
// ok=false means the response was written (400, 404, 403, 409 post_trashed).
func (server *Server) loadPostForAccess(c *gin.Context, rule func(db.User, db.Post) bool) (db.User, db.Post, bool) {
	id, ok := parsePostIDParam(c)
	if !ok {
		return db.User{}, db.Post{}, false
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return db.User{}, db.Post{}, false
	}
	post, err := server.store.GetPost(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return db.User{}, db.Post{}, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return db.User{}, db.Post{}, false
	}
	// Nothing here for a post the caller can't read (403, as authorizePost
	// answers the reads).
	if !canReadPost(caller, post) {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return db.User{}, db.Post{}, false
	}
	if !server.checkPost(c, caller, post, rule) {
		return db.User{}, db.Post{}, false
	}
	return caller, post, true
}

// getPostAccess handles GET /posts/:id/access (canReadPost).
//
// Returns:
//   - 200 OK: PostAccessResponse
//   - 403/404: see canReadPost
func (server *Server) getPostAccess(c *gin.Context) {
	caller, post, ok := server.loadPostForAccess(c, canReadPost)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	canEdit, collaborator, err := server.workingCopyAccess(ctx, caller, post)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check edit access"})
		return
	}
	rsp := PostAccessResponse{CanEdit: canEdit, Collaborator: collaborator}

	if canRequestPostAccess(caller, post) {
		latest, err := server.store.GetLatestPostAccessRequest(ctx, db.GetLatestPostAccessRequestParams{PostID: post.ID, RequesterID: caller.ID})
		var latestPtr *db.PostAccessRequest
		switch {
		case err == nil:
			latestPtr = &latest
			r := toAccessRequestResponse(latest)
			rsp.Request = &r
		case !errors.Is(err, sql.ErrNoRows):
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read access requests"})
			return
		}
		rsp.CanRequest = !collaborator && mayRequestAgain(latestPtr, time.Now())
	}

	if canReviewPostAccess(caller, post) {
		rsp.CanReview = true
		pending, err := server.store.ListPendingPostAccessRequests(ctx, post.ID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read access requests"})
			return
		}
		rsp.Pending = make([]AccessRequestResponse, len(pending))
		for i, row := range pending {
			rsp.Pending[i] = AccessRequestResponse{
				ID:        row.ID,
				PostID:    row.PostID,
				Status:    db.AccessRequestPending,
				Message:   row.Message,
				CreatedAt: row.CreatedAt,
				Requester: &PostAuthorResponse{ID: row.RequesterID, Username: row.RequesterUsername, FullName: row.RequesterFullName, Avatar: avatarResponse(row.RequesterAvatarUrl)},
			}
		}
		grants, err := server.store.ListPostCollaborators(ctx, post.ID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read edit access"})
			return
		}
		rsp.Collaborators = make([]PostCollaboratorResponse, len(grants))
		for i, row := range grants {
			rsp.Collaborators[i] = PostCollaboratorResponse{
				PostAuthorResponse: PostAuthorResponse{ID: row.ID, Username: row.Username, FullName: row.FullName, Avatar: avatarResponse(row.AvatarUrl)},
				GrantedAt:          row.GrantedAt,
			}
		}
	}

	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, rsp)
}

// listCollaborations handles GET /posts/collaborations: the ids of the posts the
// caller may edit through a grant now (canEditAsCollaborator), so the posts lists
// can show them as editable. Moderators edit everything without one: [].
//
// Returns:
//   - 200 OK: {"post_ids": [1, 2]}
func (server *Server) listCollaborations(c *gin.Context) {
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	ids := []int64{}
	if hasRole(caller, RoleContributor) {
		rows, err := server.store.ListCollaboratorPostIDs(c.Request.Context(), caller.ID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read edit access"})
			return
		}
		ids = append(ids, rows...)
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"post_ids": ids})
}

// requestPostAccess handles POST /posts/:id/access-requests: a contributor asks
// for edit access to someone else's published post (canRequestPostAccess).
//
// Request body (optional): {"message": "..."} (≤500 characters, trimmed)
//
// Returns:
//   - 201 Created: {"request": AccessRequestResponse}; the reviewers are emailed
//     after the response
//   - 403 Forbidden: may not read the post, or can't ask (not a contributor)
//   - 409 Conflict: code already_has_access (owner, moderator or granted),
//     request_open (with the open "request"), recently_declined (with
//     "request_again_at")
//   - 429 Too Many Requests: the per member+IP limit
func (server *Server) requestPostAccess(c *gin.Context) {
	caller, post, ok := server.loadPostForAccess(c, canReadPost)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	// Ownership, a moderator's role or a grant (canEditWorkingCopy).
	canEdit, _, err := server.workingCopyAccess(ctx, caller, post)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check edit access"})
		return
	}
	if canEdit {
		c.JSON(http.StatusConflict, gin.H{"error": "you can already edit this post", "code": codeAlreadyHasAccess})
		return
	}
	if !canRequestPostAccess(caller, post) {
		if isTrashed(post) {
			postTrashedError().write(c)
			return
		}
		c.JSON(http.StatusForbidden, gin.H{"error": "edit access can't be requested for this post"})
		return
	}
	var req RequestPostAccessRequest
	if !bindOptionalJSON(c, &req) {
		return
	}
	message := strings.TrimSpace(req.Message)

	// An open request or a recent decline is answered before the rate limit, so
	// repeated clicks don't use up the allowance for other posts. The INSERT
	// below checks both again (a race only costs a 409 from there).
	latest, err := server.store.GetLatestPostAccessRequest(ctx, db.GetLatestPostAccessRequestParams{PostID: post.ID, RequesterID: caller.ID})
	switch {
	case err == nil && latest.Status == db.AccessRequestPending:
		c.JSON(http.StatusConflict, gin.H{"error": "you already asked for edit access to this post", "code": codeAccessRequestOpen, "request": toAccessRequestResponse(latest)})
		return
	case err == nil && !mayRequestAgain(&latest, time.Now()):
		c.JSON(http.StatusConflict, gin.H{"error": "your last request for this post was declined recently", "code": codeRecentlyDeclined, "request_again_at": toAccessRequestResponse(latest).RequestAgainAt})
		return
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read access requests"})
		return
	}
	// Per member and client: a member can't flood the reviewers, and a stolen
	// token can't use up the owner's allowance from elsewhere.
	if !server.rateLimits.accessRequest.allow(c, strconv.FormatInt(caller.ID, 10)+"|"+clientKey(c.ClientIP())) {
		return
	}

	request, err := server.store.CreatePostAccessRequest(ctx, db.CreatePostAccessRequestParams{
		PostID:          post.ID,
		RequesterID:     caller.ID,
		Message:         message,
		CooldownSeconds: accessRequestCooldown.Seconds(),
	})
	if err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows):
			// Refused by the cooldown: the latest request is the decline.
			body := gin.H{"error": "your last request for this post was declined recently", "code": codeRecentlyDeclined}
			if latest, err := server.store.GetLatestPostAccessRequest(ctx, db.GetLatestPostAccessRequestParams{PostID: post.ID, RequesterID: caller.ID}); err == nil {
				body["request_again_at"] = toAccessRequestResponse(latest).RequestAgainAt
			}
			c.JSON(http.StatusConflict, body)
		case isUniqueViolation(err):
			body := gin.H{"error": "you already asked for edit access to this post", "code": codeAccessRequestOpen}
			if latest, err := server.store.GetLatestPostAccessRequest(ctx, db.GetLatestPostAccessRequestParams{PostID: post.ID, RequesterID: caller.ID}); err == nil {
				body["request"] = toAccessRequestResponse(latest)
			}
			c.JSON(http.StatusConflict, body)
		default:
			server.requestLog(c).Error("creating an access request failed", "post_id", post.ID, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to request edit access"})
		}
		return
	}

	server.recordPostActivity(c, db.ActivityAccessRequested, post.ID, map[string]any{"request_id": request.ID})
	logger := server.requestLog(c)
	requester := caller
	server.runInBackground(requestIDFromContext(c), c.FullPath(), func() {
		server.notifyAccessReviewers(logger, post, requester, request)
	})

	c.JSON(http.StatusCreated, gin.H{"request": toAccessRequestResponse(request)})
}

// grantPostAccess handles POST /posts/:id/access-requests/:request_id/grant.
func (server *Server) grantPostAccess(c *gin.Context) {
	server.reviewPostAccess(c, true)
}

// declinePostAccess handles POST /posts/:id/access-requests/:request_id/decline.
func (server *Server) declinePostAccess(c *gin.Context) {
	server.reviewPostAccess(c, false)
}

// reviewPostAccess answers an open request (canReviewPostAccess). A grant takes
// effect on the requester's open editor at once (recheckCollabUser).
//
// Returns:
//   - 200 OK: {"request": AccessRequestResponse}
//   - 403 Forbidden: not a reviewer of this post
//   - 404 Not Found: no such request on this post
//   - 409 Conflict: code already_answered (with its "status"), post_trashed
func (server *Server) reviewPostAccess(c *gin.Context, grant bool) {
	caller, post, ok := server.loadPostForAccess(c, canReviewPostAccess)
	if !ok {
		return
	}
	requestID, err := strconv.ParseInt(c.Param("request_id"), 10, 64)
	if err != nil || requestID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request ID"})
		return
	}
	ctx := c.Request.Context()
	existing, err := server.store.GetPostAccessRequest(ctx, requestID)
	if err != nil || existing.PostID != post.ID {
		if err == nil || errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "access request not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the access request"})
		return
	}
	if existing.Status != db.AccessRequestPending {
		c.JSON(http.StatusConflict, gin.H{"error": "this request was already answered", "code": codeAlreadyAnswered, "status": existing.Status})
		return
	}

	request, err := server.store.ReviewPostAccessRequestTx(ctx, db.ReviewPostAccessRequestTxParams{
		RequestID:  requestID,
		ReviewerID: caller.ID,
		Grant:      grant,
	})
	if err != nil {
		if errors.Is(err, db.ErrAccessRequestAnswered) {
			status := ""
			if current, err := server.store.GetPostAccessRequest(ctx, requestID); err == nil {
				status = current.Status
			}
			c.JSON(http.StatusConflict, gin.H{"error": "this request was already answered", "code": codeAlreadyAnswered, "status": status})
			return
		}
		server.requestLog(c).Error("answering an access request failed", "post_id", post.ID, "request_id", requestID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to answer the access request"})
		return
	}

	verb := db.ActivityAccessDeclined
	if grant {
		verb = db.ActivityAccessGranted
	}
	server.recordPostActivity(c, verb, post.ID, map[string]any{"user_id": request.RequesterID, "request_id": request.ID})
	if grant {
		// The requester's open editor upgrades now instead of at the next
		// periodic re-check (best effort; that re-check is the fallback).
		server.recheckCollabUser(requestIDFromContext(c), request.RequesterID)
	}
	c.JSON(http.StatusOK, gin.H{"request": toAccessRequestResponse(request)})
}

// revokePostAccess handles DELETE /posts/:id/collaborators/:user_id: a reviewer
// takes a grant back. The member's open editor drops to view-only at once.
//
// Returns:
//   - 204 No Content
//   - 403 Forbidden: not a reviewer of this post
//   - 404 Not Found: code not_a_collaborator
func (server *Server) revokePostAccess(c *gin.Context) {
	_, post, ok := server.loadPostForAccess(c, canReviewPostAccess)
	if !ok {
		return
	}
	userID, err := strconv.ParseInt(c.Param("user_id"), 10, 64)
	if err != nil || userID <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user ID"})
		return
	}
	removed, err := server.store.DeletePostCollaborator(c.Request.Context(), db.DeletePostCollaboratorParams{PostID: post.ID, UserID: userID})
	if err != nil {
		server.requestLog(c).Error("revoking edit access failed", "post_id", post.ID, "user_id", userID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to revoke edit access"})
		return
	}
	if removed == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "that member has no edit access to this post", "code": codeNotCollaborator})
		return
	}
	server.recordPostActivity(c, db.ActivityAccessRevoked, post.ID, map[string]any{"user_id": userID})
	server.recheckCollabUser(requestIDFromContext(c), userID)
	c.Status(http.StatusNoContent)
}

// notifyAccessReviewers emails a new request to everyone who may answer it
// (ListAccessRequestReviewers), after the response. Failures are only logged:
// the request stands and shows in Home's Needs attention anyway.
func (server *Server) notifyAccessReviewers(logger *slog.Logger, post db.Post, requester db.User, request db.PostAccessRequest) {
	// The lookups get one deadline; each email its own (sendMail), so a slow
	// relay delays the later reviewers' emails but never drops them.
	ctx, cancel := context.WithTimeout(context.Background(), mailSendTimeout)
	defer cancel()

	reviewers, err := server.store.ListAccessRequestReviewers(ctx, db.ListAccessRequestReviewersParams{RequesterID: requester.ID, PostID: post.ID})
	if err != nil {
		logger.Error("access request: listing reviewers failed", "post_id", post.ID, "request_id", request.ID, "error", err)
		return
	}
	siteTitle := server.siteTitle(ctx)
	name := strings.TrimSpace(requester.FullName)
	if name == "" {
		name = requester.Username
	}
	link := server.publicURL + fmt.Sprintf(adminEditPath, post.ID)
	sent := 0
	for _, reviewer := range reviewers {
		if reviewer.Email == "" {
			continue
		}
		msg, err := mailer.RenderAccessRequest(reviewer.Email, mailer.AccessRequest{
			SiteTitle: siteTitle,
			Requester: name,
			PostTitle: post.Title,
			Message:   request.Message,
			Link:      link,
		})
		if err == nil {
			err = server.sendMail(context.Background(), msg)
		}
		if err != nil {
			logger.Error("access request email failed", "post_id", post.ID, "request_id", request.ID, "user_id", reviewer.ID, "error", err)
			continue
		}
		sent++
	}
	logger.Info("access request emails sent", "post_id", post.ID, "request_id", request.ID, "count", sent)
}
