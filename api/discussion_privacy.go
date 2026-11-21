package api

// A commenter's export and erasure (#529, C9; docs/design/reader-comments.md 13, 9.2,
// 9.3). The last phase of reader comments (#499).
//
// # By an admin (13.1)
//
//   - GET /api/v1/discussion/commenters/:id/export: the commenter's file (CommenterExport),
//     downloaded from the commenter's page. Activity commenter_exported {comment_count}.
//   - DELETE /api/v1/discussion/commenters/:id: erasure (db.EraseCommenterTx, one
//     transaction): tombstones where someone else's approved reply answers a comment,
//     every other comment deleted, the outbox rows that named them, the keys, links and
//     tokens, and the commenter. Activity commenter_erased {comment_count}, never the
//     address.
//
// Both are requireSiteAdmin: editors see a commenter's address in full (decision 6) and
// may block them, but exporting and erasing are an admin's (4.3, 15.1).
//
// # By the reader (13.2)
//
// "Your comments" (/comments/your-data, through the web's /gl-comments/data* endpoints):
//
//   - POST /public/discussion/data-request {email}: 202, the same answer whatever the
//     address (unknown, known, blocked, in its cooldown). Everything that reads the address
//     runs after the response (runInBackground), as the comment form's confirmation does:
//     a commenter with that address gets one mail at most every 10 minutes holding a link,
//     /comments/your-data#token=…, valid an hour (commenter_data_tokens, 000069, hash only).
//     An address with no commenter gets nothing.
//   - POST /public/discussion/data {token}: the same file as the admin's. Reading doesn't
//     spend the link.
//   - POST /public/discussion/data/delete {token, comment_id?}: one comment (Delete), or
//     with no comment_id the erasure (Delete everything), which ends the link with the rest.
//   - POST /public/discussion/data/unsubscribe {token}: Stop all mail, every subscription.
//
// They work while comments are off for the site: what readers wrote stays theirs to see
// and delete. Self-service leaves no activity entry (7.4). Every bad link is 400
// invalid_token.
//
// # What never leaves
//
// The file holds no hash, key, token or network data (13.1), and no moderation record (a
// block, a spam mark, a hold's reason: the site's notes, on the commenter's page). Logs
// carry commenter and comment ids and counts, never an address, a name, a text or a token.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
)

const (
	// readerCommentDataPath is "Your comments" (11.6, #525), every reader mail's "Manage
	// your comments" and the data link's page.
	readerCommentDataPath = "/comments/your-data"
	// commenterDataTokenTTL: a "Your comments" link works for an hour (13.2).
	commenterDataTokenTTL = time.Hour
	// commenterDataMailCooldown: at most one "Your comments" mail per address this often;
	// later requests answer the same and mail nothing.
	commenterDataMailCooldown = 10 * time.Minute
)

// CommenterExportPerson is what the file says about the commenter: the address, the names
// they used, and when they were first seen, proved the address and were last seen.
type CommenterExportPerson struct {
	Email      string     `json:"email"`
	Name       string     `json:"name"`
	NamesUsed  []string   `json:"names_used"`
	CreatedAt  time.Time  `json:"created_at"`
	VerifiedAt *time.Time `json:"verified_at"`
	LastSeenAt time.Time  `json:"last_seen_at"`
}

// CommenterExportComment is one comment in the file, in whatever status it is.
// PostURL is the post's path on the site; CommentURL its anchor, for an approved one.
type CommenterExportComment struct {
	ID            int64      `json:"id"`
	PostID        int64      `json:"post_id"`
	PostTitle     string     `json:"post_title"`
	PostURL       string     `json:"post_url"`
	CommentURL    *string    `json:"comment_url"`
	ParentID      *int64     `json:"parent_id"`
	Status        string     `json:"status"`
	Name          string     `json:"name"`
	Body          string     `json:"body"`
	NotifyReplies bool       `json:"notify_replies"`
	CreatedAt     time.Time  `json:"created_at"`
	ApprovedAt    *time.Time `json:"approved_at"`
	EditedAt      *time.Time `json:"edited_at"`
}

// CommenterExportSubscription is a comment whose replies are mailed to the commenter (8.2).
type CommenterExportSubscription struct {
	CommentID int64  `json:"comment_id"`
	PostTitle string `json:"post_title"`
	PostURL   string `json:"post_url"`
}

// CommenterExport is the commenter's file (13.1), the admin's Export and the reader's
// Download my data alike: the person, every comment of the address in every status, and
// the subscriptions. #525's page reads commenter.email and comments[].{id, post_title,
// post_url, status, created_at, body}.
type CommenterExport struct {
	ExportedAt    time.Time                     `json:"exported_at"`
	Site          CommenterExportSite           `json:"site"`
	Commenter     CommenterExportPerson         `json:"commenter"`
	Comments      []CommenterExportComment      `json:"comments"`
	Subscriptions []CommenterExportSubscription `json:"subscriptions"`
}

// CommenterExportSite says where the file is from: the paths are on this site.
type CommenterExportSite struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

// commenterExport builds the commenter's file from the database.
func (server *Server) commenterExport(c *gin.Context, commenter db.Commenter) (CommenterExport, error) {
	ctx := c.Request.Context()
	settings, err := server.store.GetSettings(ctx)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return CommenterExport{}, err
	}
	rows, err := server.store.ListCommenterExportComments(ctx, sql.NullInt64{Int64: commenter.ID, Valid: true})
	if err != nil {
		return CommenterExport{}, err
	}
	out := CommenterExport{
		ExportedAt: time.Now().UTC(),
		Site:       CommenterExportSite{Title: settings.SiteTitle.String, URL: server.publicURL},
		Commenter: CommenterExportPerson{
			Email:      commenter.Email,
			Name:       commenter.DisplayName,
			NamesUsed:  []string{},
			CreatedAt:  commenter.CreatedAt,
			VerifiedAt: nullTimePtr(commenter.VerifiedAt),
			LastSeenAt: commenter.LastSeenAt,
		},
		Comments:      make([]CommenterExportComment, 0, len(rows)),
		Subscriptions: []CommenterExportSubscription{},
	}
	names := map[string]bool{}
	if commenter.DisplayName != "" {
		names[commenter.DisplayName] = true
	}
	for _, row := range rows {
		path := readerCommentPostPath(settings, row.PostType, row.Slug, row.PostID, row.CategorySlug)
		comment := CommenterExportComment{
			ID: row.ID, PostID: row.PostID, PostTitle: row.PostTitle, PostURL: path,
			ParentID: nullInt64Ptr(row.ParentID), Status: row.Status, Name: row.DisplayName,
			Body: row.Body, NotifyReplies: row.NotifyReplies, CreatedAt: row.CreatedAt,
			ApprovedAt: nullTimePtr(row.ApprovedAt), EditedAt: nullTimePtr(row.EditedAt),
		}
		if row.Status == db.ReaderCommentApproved {
			url := readerCommentURL(path, row.ID)
			comment.CommentURL = &url
		}
		out.Comments = append(out.Comments, comment)
		if row.DisplayName != "" {
			names[row.DisplayName] = true
		}
		if row.NotifyReplies && row.Status != db.ReaderCommentUnconfirmed {
			out.Subscriptions = append(out.Subscriptions, CommenterExportSubscription{CommentID: row.ID, PostTitle: row.PostTitle, PostURL: path})
		}
	}
	for name := range names {
		out.Commenter.NamesUsed = append(out.Commenter.NamesUsed, name)
	}
	slices.Sort(out.Commenter.NamesUsed)
	return out, nil
}

// --- the admin (13.1) ---------------------------------------------------------------

// exportDiscussionCommenter handles GET /discussion/commenters/:id/export (admins): the
// commenter's file as a download. 404 commenter_not_found once erased or pruned.
func (server *Server) exportDiscussionCommenter(c *gin.Context) {
	id, ok := discussionCommenterID(c)
	if !ok {
		return
	}
	logger := server.requestLog(c)
	commenter, err := server.store.GetCommenter(c.Request.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "commenter not found", "code": "commenter_not_found"})
		return
	}
	if err != nil {
		logger.Warn("discussion_commenter_export_failed", "commenter_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to export the commenter"})
		return
	}
	export, err := server.commenterExport(c, commenter)
	if err != nil {
		logger.Warn("discussion_commenter_export_failed", "commenter_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to export the commenter"})
		return
	}
	server.recordRequestActivity(c, activityEvent{
		Verb: db.ActivityCommenterExported, ObjectType: db.ActivityObjectCommenter, ObjectID: id,
		Payload: map[string]any{"comment_count": len(export.Comments)},
	})
	logger.Info("discussion_commenter_exported", "commenter_id", id, "comment_count", len(export.Comments))
	c.Header("Cache-Control", "no-store")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="commenter-%d.json"`, id))
	c.JSON(http.StatusOK, export)
}

// eraseDiscussionCommenter handles DELETE /discussion/commenters/:id (admins): 13.1's
// Erase, after the page asked. 200 {comment_count, tombstoned}; 404 commenter_not_found.
func (server *Server) eraseDiscussionCommenter(c *gin.Context) {
	id, ok := discussionCommenterID(c)
	if !ok {
		return
	}
	result, ok := server.eraseCommenter(c, id)
	if !ok {
		return
	}
	server.recordRequestActivity(c, activityEvent{
		Verb: db.ActivityCommenterErased, ObjectType: db.ActivityObjectCommenter, ObjectID: id,
		Payload: map[string]any{"comment_count": result.Comments},
	})
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"comment_count": result.Comments, "tombstoned": result.Tombstoned})
}

// eraseCommenter runs the erasure and purges what readers could see, after the commit
// (discussion_purge.go). It answers 404 or 500 itself and reports false then.
func (server *Server) eraseCommenter(c *gin.Context, id int64) (db.EraseCommenterTxResult, bool) {
	ctx := c.Request.Context()
	logger := server.requestLog(c)
	result, err := server.store.EraseCommenterTx(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "commenter not found", "code": "commenter_not_found"})
		return result, false
	}
	if err != nil {
		logger.Error("commenter erasure failed", "commenter_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to erase the commenter"})
		return result, false
	}
	logger.Info("commenter_erased", "commenter_id", id, "comment_count", result.Comments,
		"tombstoned", result.Tombstoned, "mail_rows_deleted", result.MailRowsDeleted)
	server.purgeErasure(c, logger, result)
	return result, true
}

// purgeErasure purges once when the erasure changed a public thread.
func (server *Server) purgeErasure(c *gin.Context, logger *slog.Logger, result db.EraseCommenterTxResult) {
	if !result.Shown {
		return
	}
	var postID int64 // several posts: one global purge
	if len(result.PostIDs) == 1 {
		postID = result.PostIDs[0]
	}
	server.purgeDiscussion(c.Request.Context(), logger, postID, discussionEventRemoved)
}

// --- the reader (13.2) --------------------------------------------------------------

// commenterDataRequest is POST /public/discussion/data-request's body.
type commenterDataRequest struct {
	Email string `json:"email" binding:"required,email,max=254"`
}

// commenterDataTokenRequest is POST /public/discussion/data and /data/unsubscribe's body.
type commenterDataTokenRequest struct {
	Token string `json:"token" binding:"required,max=100"`
}

// commenterDataDeleteRequest is POST /public/discussion/data/delete's body: one comment,
// or (no comment_id) everything.
type commenterDataDeleteRequest struct {
	Token     string `json:"token" binding:"required,max=100"`
	CommentID *int64 `json:"comment_id" binding:"omitempty,min=1"`
}

// requestCommenterData handles POST /public/discussion/data-request {email}: always 202
// {"outcome": "link_sent"} once the address is well formed. The lookup, the cooldown, the
// token and the mail run after the response, so neither the answer nor its timing tells
// whether comments were written with the address.
func (server *Server) requestCommenterData(c *gin.Context) {
	var req commenterDataRequest
	if !bindJSON(c, &req) {
		return
	}
	email := strings.TrimSpace(req.Email)
	if foldsOutsideASCII(email) {
		// The comment form refuses these (discussion_write.go), so no commenter has one.
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusBadRequest, gin.H{"error": "email must be a valid email address", "fields": gin.H{"email": "must be a valid email address"}})
		return
	}
	emailLower := normEmail(email)
	// Per client and address, never the address alone (#190).
	if !server.rateLimits.commentAddress.allow(c, clientKey(c.ClientIP())+"|"+emailLower) {
		return
	}
	logger := server.requestLog(c)
	server.runInBackground(requestIDFromContext(c), c.FullPath(), func() {
		server.processCommenterDataRequest(logger, email, emailLower)
	})
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusAccepted, gin.H{"outcome": "link_sent"})
}

// processCommenterDataRequest mails a "Your comments" link to an address comments were
// written with, after the response. Errors are only logged. Logs carry ids only.
func (server *Server) processCommenterDataRequest(logger *slog.Logger, email, emailLower string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*mailSendTimeout)
	defer cancel()
	commenter, err := server.store.GetCommenterByEmailLower(ctx, emailLower)
	if errors.Is(err, sql.ErrNoRows) {
		logger.Info("commenter data request: no comments with the address")
		return
	}
	if err != nil {
		logger.Error("commenter data request: lookup failed", "error", err)
		return
	}
	if !server.rateLimits.commentDataMail.allowSilently(ctx, emailLower) {
		logger.Info("commenter data request skipped: a link was mailed to the address less than 10 minutes ago", "commenter_id", commenter.ID)
		return
	}
	token, hash, err := newAccountToken()
	if err != nil {
		logger.Error("commenter data request: token generation failed", "commenter_id", commenter.ID, "error", err)
		return
	}
	if _, err := server.store.CreateCommenterDataToken(ctx, db.CreateCommenterDataTokenParams{
		TokenHash: hash, CommenterID: commenter.ID, ExpiresAt: time.Now().Add(commenterDataTokenTTL),
	}); err != nil {
		logger.Error("commenter data request: storing the link failed", "commenter_id", commenter.ID, "error", err)
		return
	}
	// To the address as this request typed it, as the confirmation is (discussion_write.go).
	msg, err := mailer.RenderReaderCommentData(email, mailer.ReaderCommentData{
		SiteTitle: server.siteTitle(ctx),
		Link:      server.accountLink(readerCommentDataPath, token),
		ExpiresIn: commenterDataTokenTTL,
	})
	if err == nil {
		err = server.sendMail(ctx, msg)
	}
	if err != nil {
		// error_type only: an SMTP rejection quotes the address.
		logger.Error("commenter data email failed", "commenter_id", commenter.ID, "error_type", fmt.Sprintf("%T", err))
		return
	}
	logger.Info("commenter data email sent", "commenter_id", commenter.ID)
}

// commenterByDataToken reads the commenter a "Your comments" link belongs to; every bad
// link answers 400 invalid_token (written here; false then).
func (server *Server) commenterByDataToken(c *gin.Context, token string) (db.Commenter, bool) {
	hash, ok := parseAccountToken(token)
	if !ok {
		respondInvalidAccountToken(c)
		return db.Commenter{}, false
	}
	commenter, err := server.store.GetCommenterByDataToken(c.Request.Context(), hash)
	if errors.Is(err, sql.ErrNoRows) {
		respondInvalidAccountToken(c)
		return db.Commenter{}, false
	}
	if err != nil {
		server.requestLog(c).Error("commenter data: link lookup failed", "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to read your comments")
		return db.Commenter{}, false
	}
	return commenter, true
}

// readCommenterData handles POST /public/discussion/data {token}: the commenter's file
// (the page's list and Download my data). The link stays good for its hour.
func (server *Server) readCommenterData(c *gin.Context) {
	var req commenterDataTokenRequest
	if !bindJSON(c, &req) {
		return
	}
	commenter, ok := server.commenterByDataToken(c, req.Token)
	if !ok {
		return
	}
	export, err := server.commenterExport(c, commenter)
	if err != nil {
		server.requestLog(c).Error("commenter data: export failed", "commenter_id", commenter.ID, "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to read your comments")
		return
	}
	server.requestLog(c).Info("commenter_data_read", "commenter_id", commenter.ID, "comment_count", len(export.Comments))
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, export)
}

// deleteCommenterData handles POST /public/discussion/data/delete {token, comment_id?}:
// with comment_id one of the reader's comments (a tombstone when approved replies answer
// it), 404 comment_not_found when it isn't theirs; without, the erasure. 204 either way.
func (server *Server) deleteCommenterData(c *gin.Context) {
	var req commenterDataDeleteRequest
	if !bindJSON(c, &req) {
		return
	}
	commenter, ok := server.commenterByDataToken(c, req.Token)
	if !ok {
		return
	}
	if req.CommentID == nil {
		if _, ok := server.eraseCommenter(c, commenter.ID); ok {
			c.Header("Cache-Control", "no-store")
			c.Status(http.StatusNoContent)
		}
		return
	}
	ctx := c.Request.Context()
	logger := server.requestLog(c)
	commentID := *req.CommentID
	result, err := server.store.DeleteCommenterReaderCommentTx(ctx, commenter.ID, commentID)
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, db.ErrReaderCommentNotTheCommenters) {
		respondDiscussionError(c, http.StatusNotFound, "comment_not_found", "comment not found")
		return
	}
	if err != nil {
		logger.Error("commenter data: deleting a comment failed", "commenter_id", commenter.ID, "comment_id", commentID, "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to delete the comment")
		return
	}
	logger.Info("commenter_comment_deleted", "commenter_id", commenter.ID, "comment_id", commentID,
		"post_id", result.Comment.PostID, "status", result.Status, "tombstoned", result.Tombstoned)
	if result.Tombstoned || result.Status == db.ReaderCommentApproved {
		server.purgeDiscussion(ctx, logger, result.Comment.PostID, discussionEventRemoved)
	}
	c.Header("Cache-Control", "no-store")
	c.Status(http.StatusNoContent)
}

// unsubscribeCommenterData handles POST /public/discussion/data/unsubscribe {token}: Stop
// all mail, every reply subscription of the commenter (8.2). 204.
func (server *Server) unsubscribeCommenterData(c *gin.Context) {
	var req commenterDataTokenRequest
	if !bindJSON(c, &req) {
		return
	}
	commenter, ok := server.commenterByDataToken(c, req.Token)
	if !ok {
		return
	}
	changed, err := server.store.UnsubscribeCommenter(c.Request.Context(), sql.NullInt64{Int64: commenter.ID, Valid: true})
	if err != nil {
		server.requestLog(c).Error("commenter data: unsubscribing failed", "commenter_id", commenter.ID, "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to stop the emails")
		return
	}
	server.requestLog(c).Info("reader_comment_unsubscribed", "commenter_id", commenter.ID, "all", true, "changed", changed, "from", "your_data")
	c.Header("Cache-Control", "no-store")
	c.Status(http.StatusNoContent)
}
