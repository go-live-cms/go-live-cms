package api

// Unsubscribing from reply mail (#528, docs/design/reader-comments.md 8.2, 9.2).
//
// Every reply mail carries a token, minted when the mail is built (discussion_mail.go;
// only its SHA-256 is kept, in reader_comment_unsubscribe_tokens, and it goes with its
// comment). It is the whole authority, and it can only turn mail off:
//
//   - POST /public/discussion/unsubscribe {token, all?}: the /comments/unsubscribe page's
//     buttons (through the web's /gl-comments/unsubscribe). "Stop these emails" turns off
//     the replies to that one comment; all: true ("Stop all mail from this site") every
//     subscription of the commenter.
//   - POST /public/discussion/unsubscribe/:token: RFC 8058's one-click, which mail
//     providers POST from their servers (through the web's /gl-comments/unsubscribe/:token)
//     with the form body List-Unsubscribe=One-Click. That comment's replies only. The token
//     is in the path, which #233 forbids elsewhere: RFC 8058 requires it, it can only stop
//     one comment's mail, and both servers log routes by pattern, never the path.
//
// Both are idempotent (a second click answers 204 again: a link stays good while its
// comment exists) and work while comments are off for the site. Every bad token is 400
// invalid_token. Logs: comment and commenter ids, counts.

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// readerCommentUnsubscribeRequest is POST /public/discussion/unsubscribe's body.
type readerCommentUnsubscribeRequest struct {
	Token string `json:"token" binding:"required,max=100"`
	All   bool   `json:"all"`
}

// rfc8058Body is the one-click POST's form field and value (RFC 8058 section 3.1).
const (
	rfc8058Field = "List-Unsubscribe"
	rfc8058Value = "One-Click"
)

// unsubscribeReaderComment handles the unsubscribe page's buttons.
func (server *Server) unsubscribeReaderComment(c *gin.Context) {
	var req readerCommentUnsubscribeRequest
	if !bindJSON(c, &req) {
		return
	}
	server.applyReaderCommentUnsubscribe(c, req.Token, req.All)
}

// unsubscribeReaderCommentOneClick handles RFC 8058's one-click POST.
func (server *Server) unsubscribeReaderCommentOneClick(c *gin.Context) {
	if c.PostForm(rfc8058Field) != rfc8058Value {
		respondDiscussionError(c, http.StatusBadRequest, "invalid_request", "expected List-Unsubscribe=One-Click")
		return
	}
	server.applyReaderCommentUnsubscribe(c, c.Param("token"), false)
}

func (server *Server) applyReaderCommentUnsubscribe(c *gin.Context, token string, all bool) {
	ctx := c.Request.Context()
	logger := server.requestLog(c)
	hash, ok := parseAccountToken(token)
	if !ok {
		respondInvalidAccountToken(c)
		return
	}
	comment, err := server.store.GetReaderCommentByUnsubscribeToken(ctx, hash)
	if errors.Is(err, sql.ErrNoRows) {
		respondInvalidAccountToken(c)
		return
	}
	if err != nil {
		logger.Error("reader comment unsubscribe: lookup failed", "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to unsubscribe")
		return
	}
	var changed int64
	if all && comment.CommenterID.Valid {
		changed, err = server.store.UnsubscribeCommenter(ctx, comment.CommenterID)
	} else {
		changed, err = server.store.UnsubscribeReaderComment(ctx, comment.ID)
	}
	if err != nil {
		logger.Error("reader comment unsubscribe failed", "comment_id", comment.ID, "error", err)
		respondDiscussionError(c, http.StatusInternalServerError, "", "failed to unsubscribe")
		return
	}
	logger.Info("reader_comment_unsubscribed", "comment_id", comment.ID, "commenter_id", comment.CommenterID.Int64, "all", all, "changed", changed)
	c.Status(http.StatusNoContent)
}

// UserNotifications is Profile's Notifications (8.3), the caller's own.
// CommentsToModerate applies to editors and admins (Moderates); a contributor's is kept
// but never used.
type UserNotifications struct {
	CommentsOnPosts    string `json:"comments_on_posts"`
	CommentsToModerate string `json:"comments_to_moderate"`
	Moderates          bool   `json:"moderates"`
}

// updateUserNotificationsRequest is PUT /users/me/notifications's body.
type updateUserNotificationsRequest struct {
	CommentsOnPosts    string `json:"comments_on_posts" binding:"required,oneof=each digest off"`
	CommentsToModerate string `json:"comments_to_moderate" binding:"required,oneof=hourly off"`
}

func userNotifications(role, onPosts, toModerate string) UserNotifications {
	return UserNotifications{
		CommentsOnPosts:    onPosts,
		CommentsToModerate: toModerate,
		Moderates:          role == RoleAdmin || role == RoleEditor,
	}
}

// getUserNotifications handles GET /users/me/notifications.
func (server *Server) getUserNotifications(c *gin.Context) {
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	prefs, err := server.store.GetUserNotifications(c.Request.Context(), caller.ID)
	if err != nil {
		server.requestLog(c).Error("notifications: reading failed", "user_id", caller.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the notification settings"})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, userNotifications(caller.Role, prefs.NotifyPostComments, prefs.NotifyCommentModeration))
}

// updateUserNotifications handles PUT /users/me/notifications. A change of "Comments on
// my posts" moves the member's waiting author mail with it (RetimeAuthorMail): due soon
// for each one, at the next digest for the digest; off drops it when it is due.
func (server *Server) updateUserNotifications(c *gin.Context) {
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	var req updateUserNotificationsRequest
	if !bindJSON(c, &req) {
		return
	}
	ctx := c.Request.Context()
	logger := server.requestLog(c)
	prefs, err := server.store.UpdateUserNotifications(ctx, db.UpdateUserNotificationsParams{
		ID: caller.ID, NotifyPostComments: req.CommentsOnPosts, NotifyCommentModeration: req.CommentsToModerate,
	})
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	if err != nil {
		logger.Error("notifications: saving failed", "user_id", caller.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save the notification settings"})
		return
	}
	if prefs.NotifyPostComments != notifyPostCommentsOff {
		if _, err := server.store.RetimeAuthorMail(ctx, db.RetimeAuthorMailParams{Preference: prefs.NotifyPostComments, UserID: caller.ID}); err != nil {
			// The preference is saved; the waiting mail keeps its time.
			logger.Error("notifications: moving the waiting mail failed", "user_id", caller.ID, "error", err)
		}
	}
	logger.Info("notifications_updated", "user_id", caller.ID, "comments_on_posts", prefs.NotifyPostComments, "comments_to_moderate", prefs.NotifyCommentModeration)
	c.JSON(http.StatusOK, userNotifications(caller.Role, prefs.NotifyPostComments, prefs.NotifyCommentModeration))
}
