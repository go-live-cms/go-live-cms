// post_comments implements block comments (#192; design:
// docs/design/block-map-yjs-schema.md, "#192: block comments").
//
// A thread is anchored to one block of the post's working copy by the block's
// data-block-id and holds plain-text comments. Threads are ordinary API rows
// (post_comment_threads, post_comments, 000048), never part of the Yjs document,
// block_doc or a version, so they survive reseeds and restores, and the editor
// works out which ones are orphans (their block isn't in its doc now). The API only
// checks a block id's format, not that the block is in the stored block_doc: a
// block typed a second ago isn't stored yet, and an orphan is shown, not lost.
//
// Who may do what is decided in auth_posts.go (canCommentOnPost and friends).
// Every write records an activity event (#324) and, after the response, asks the
// collab server to tell the post's open editors (POST
// /internal/documents/post-<id>/comments, best effort), which then refetch.
// Mention notifications (#320) belong in afterCommentWrite.
//
// The public site never sees comments: there's no /public route, and every route
// here takes a token and a content role.
//
// Routes (all: requireAuth + requireContentAuthor; the per-post rule in each
// handler). Every one answers the post's whole comment state (CommentsResponse).
//
//	GET    /posts/:id/comments                                 canReadPost
//	POST   /posts/:id/comments                                 {block_id, body} → 201: a new thread
//	POST   /posts/:id/comment-threads/:thread_id/replies       {body} → 201
//	POST   /posts/:id/comment-threads/:thread_id/resolve
//	POST   /posts/:id/comment-threads/:thread_id/unresolve
//	PUT    /posts/:id/comments/:comment_id                     {body}: the author's edit
//	DELETE /posts/:id/comments/:comment_id
package api

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// commentBodyMax is a comment's limit in characters (000048's CHECK says the same).
const commentBodyMax = 4000

// commentBlockIDPattern is 000048's block_id CHECK: what BlockIdExtension and the
// collab server's stamping produce (10+ characters), printable ASCII, at most the
// API's block id limit.
var commentBlockIDPattern = regexp.MustCompile(`^[!-~]{10,128}$`)

// Codes the admin reads (lib/comments.ts).
const (
	codeCommentDeleted = "comment_deleted"
	codeInvalidBlockID = "invalid_block_id"
)

// CreateCommentThreadRequest is POST /posts/:id/comments.
type CreateCommentThreadRequest struct {
	BlockID string `json:"block_id" binding:"required,max=128"`
	Body    string `json:"body" binding:"required,max=4000"`
}

// CommentBodyRequest is a reply's or an edit's body.
type CommentBodyRequest struct {
	Body string `json:"body" binding:"required,max=4000"`
}

// CommentResponse is one comment. A deleted one has an empty body and deleted
// true (its place in the thread stays).
type CommentResponse struct {
	ID        int64               `json:"id"`
	ThreadID  int64               `json:"thread_id"`
	Author    *PostAuthorResponse `json:"author"`
	Body      string              `json:"body"`
	CreatedAt time.Time           `json:"created_at"`
	EditedAt  *time.Time          `json:"edited_at"`
	Deleted   bool                `json:"deleted"`
	CanEdit   bool                `json:"can_edit"`
	CanDelete bool                `json:"can_delete"`
}

// CommentThreadResponse is one thread with its comments, oldest first.
type CommentThreadResponse struct {
	ID         int64               `json:"id"`
	PostID     int64               `json:"post_id"`
	BlockID    string              `json:"block_id"`
	CreatedBy  *PostAuthorResponse `json:"created_by"`
	CreatedAt  time.Time           `json:"created_at"`
	ResolvedAt *time.Time          `json:"resolved_at"`
	ResolvedBy *PostAuthorResponse `json:"resolved_by"`
	CanResolve bool                `json:"can_resolve"`
	Comments   []CommentResponse   `json:"comments"`
}

// CommentsResponse is a post's comment state, what every route answers.
type CommentsResponse struct {
	PostID int64 `json:"post_id"`
	// CanComment: the caller may start threads and reply.
	CanComment bool                    `json:"can_comment"`
	Threads    []CommentThreadResponse `json:"threads"`
	// ThreadID / CommentID: what a write created or changed (0 otherwise).
	ThreadID  int64 `json:"thread_id,omitempty"`
	CommentID int64 `json:"comment_id,omitempty"`
}

// commentUser builds a user from a LEFT JOIN's columns: nil for a member removed
// since (or no user).
func commentUser(id sql.NullInt64, username, fullName, avatar sql.NullString) *PostAuthorResponse {
	if !id.Valid || !username.Valid {
		return nil
	}
	return &PostAuthorResponse{ID: id.Int64, Username: username.String, FullName: fullName.String, Avatar: avatarResponse(avatar.String)}
}

// normalizeCommentBody trims the body and checks it: not blank, no NUL (Postgres
// text can't hold one), at most commentBodyMax characters.
func normalizeCommentBody(body string) (string, error) {
	body = strings.TrimSpace(body)
	switch {
	case body == "":
		return "", errors.New("body must not be empty")
	case strings.ContainsRune(body, 0):
		return "", errors.New("body must not contain NUL characters")
	case utf8.RuneCountInString(body) > commentBodyMax:
		return "", fmt.Errorf("body must be at most %d characters", commentBodyMax)
	}
	return body, nil
}

// respondCommentBodyError answers a body normalizeCommentBody refused, in
// bindJSON's error shape.
func respondCommentBodyError(c *gin.Context, err error) {
	c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "fields": gin.H{"body": strings.TrimPrefix(err.Error(), "body ")}})
}

// parseIDParamNamed parses a positive id route parameter (400 otherwise).
func parseIDParamNamed(c *gin.Context, name, label string) (int64, bool) {
	id, err := strconv.ParseInt(c.Param(name), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid " + label})
		return 0, false
	}
	return id, true
}

// commentsState builds the post's CommentsResponse for the caller.
func (server *Server) commentsState(c *gin.Context, caller db.User, post db.Post) (CommentsResponse, error) {
	ctx := c.Request.Context()
	canEdit, err := server.canEditWorkingCopy(ctx, caller, post)
	if err != nil {
		return CommentsResponse{}, err
	}
	threads, err := server.store.ListPostCommentThreads(ctx, post.ID)
	if err != nil {
		return CommentsResponse{}, err
	}
	comments, err := server.store.ListPostComments(ctx, post.ID)
	if err != nil {
		return CommentsResponse{}, err
	}

	byThread := make(map[int64][]CommentResponse, len(threads))
	for _, row := range comments {
		byThread[row.ThreadID] = append(byThread[row.ThreadID], CommentResponse{
			ID:        row.ID,
			ThreadID:  row.ThreadID,
			Author:    commentUser(row.AuthorID, row.AuthorUsername, row.AuthorFullName, row.AuthorAvatarUrl),
			Body:      row.Body,
			CreatedAt: row.CreatedAt,
			EditedAt:  nullTimePtr(row.EditedAt),
			Deleted:   row.DeletedAt.Valid,
			CanEdit:   !row.DeletedAt.Valid && canEditComment(caller, post, row.AuthorID),
			CanDelete: !row.DeletedAt.Valid && canDeleteComment(caller, post, row.AuthorID),
		})
	}

	rsp := CommentsResponse{PostID: post.ID, CanComment: canCommentOnPost(caller, post), Threads: make([]CommentThreadResponse, 0, len(threads))}
	for _, t := range threads {
		list := byThread[t.ID]
		if list == nil {
			list = []CommentResponse{}
		}
		rsp.Threads = append(rsp.Threads, CommentThreadResponse{
			ID:         t.ID,
			PostID:     t.PostID,
			BlockID:    t.BlockID,
			CreatedBy:  commentUser(t.CreatedBy, t.CreatorUsername, t.CreatorFullName, t.CreatorAvatarUrl),
			CreatedAt:  t.CreatedAt,
			ResolvedAt: nullTimePtr(t.ResolvedAt),
			ResolvedBy: commentUser(t.ResolvedBy, t.ResolverUsername, t.ResolverFullName, t.ResolverAvatarUrl),
			CanResolve: canResolveCommentThread(caller, post, t.CreatedBy, canEdit),
			Comments:   list,
		})
	}
	return rsp, nil
}

// respondComments writes the post's comment state with status.
func (server *Server) respondComments(c *gin.Context, status int, caller db.User, post db.Post, threadID, commentID int64) {
	rsp, err := server.commentsState(c, caller, post)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read comments"})
		return
	}
	rsp.ThreadID, rsp.CommentID = threadID, commentID
	c.Header("Cache-Control", "no-store")
	c.JSON(status, rsp)
}

// afterCommentWrite runs after every successful comment write: the activity event
// (#324) and the nudge to the post's open editors. Mention notifications (#320)
// hook in here, with the new or edited comment's body.
func (server *Server) afterCommentWrite(c *gin.Context, postID int64, verb string, payload map[string]any) {
	if verb != "" {
		server.recordPostActivity(c, verb, postID, payload)
	}
	server.notifyCollabComments(requestIDFromContext(c), postID)
}

// loadCommentThread reads :thread_id, which must be a thread of post (404).
func (server *Server) loadCommentThread(c *gin.Context, post db.Post) (db.PostCommentThread, bool) {
	threadID, ok := parseIDParamNamed(c, "thread_id", "thread ID")
	if !ok {
		return db.PostCommentThread{}, false
	}
	thread, err := server.store.GetPostCommentThread(c.Request.Context(), threadID)
	if err != nil || thread.PostID != post.ID {
		if err == nil || errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "thread not found"})
			return db.PostCommentThread{}, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get thread"})
		return db.PostCommentThread{}, false
	}
	return thread, true
}

// loadComment reads :comment_id, which must be a comment of post (404).
func (server *Server) loadComment(c *gin.Context, post db.Post) (db.GetPostCommentRow, bool) {
	commentID, ok := parseIDParamNamed(c, "comment_id", "comment ID")
	if !ok {
		return db.GetPostCommentRow{}, false
	}
	comment, err := server.store.GetPostComment(c.Request.Context(), commentID)
	if err != nil || comment.PostID != post.ID {
		if err == nil || errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "comment not found"})
			return db.GetPostCommentRow{}, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get comment"})
		return db.GetPostCommentRow{}, false
	}
	return comment, true
}

// refuseComment answers a refused comment rule: 409 post_trashed on a trashed
// post the caller may read (restore it first), else 403.
func refuseComment(c *gin.Context, caller db.User, post db.Post) {
	if isTrashed(post) && canReadPost(caller, post) {
		postTrashedError().write(c)
		return
	}
	c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
}

// listPostComments handles GET /posts/:id/comments (canReadPost).
func (server *Server) listPostComments(c *gin.Context) {
	caller, post, ok := server.loadPostForAccess(c, canReadPost)
	if !ok {
		return
	}
	server.respondComments(c, http.StatusOK, caller, post, 0, 0)
}

// createCommentThread handles POST /posts/:id/comments (canCommentOnPost): a new
// thread on block_id with its first comment.
//
// Returns 201 CommentsResponse (thread_id, comment_id); 400 bad body or block id;
// 403/404; 409 post_trashed.
func (server *Server) createCommentThread(c *gin.Context) {
	caller, post, ok := server.loadPostForAccess(c, canCommentOnPost)
	if !ok {
		return
	}
	var req CreateCommentThreadRequest
	if !bindJSON(c, &req) {
		return
	}
	if !commentBlockIDPattern.MatchString(req.BlockID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "block_id is not a block id", "code": codeInvalidBlockID, "fields": gin.H{"block_id": "is not a block id"}})
		return
	}
	body, err := normalizeCommentBody(req.Body)
	if err != nil {
		respondCommentBodyError(c, err)
		return
	}
	result, err := server.store.CreatePostCommentThreadTx(c.Request.Context(), db.CreatePostCommentThreadTxParams{
		PostID: post.ID, BlockID: req.BlockID, AuthorID: caller.ID, Body: body,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create thread"})
		return
	}
	server.afterCommentWrite(c, post.ID, db.ActivityCommented, map[string]any{
		"thread_id": result.Thread.ID, "comment_id": result.Comment.ID, "reply": false,
	})
	server.respondComments(c, http.StatusCreated, caller, post, result.Thread.ID, result.Comment.ID)
}

// replyToCommentThread handles POST /posts/:id/comment-threads/:thread_id/replies
// (canCommentOnPost). A resolved thread takes replies too; it stays resolved.
func (server *Server) replyToCommentThread(c *gin.Context) {
	caller, post, ok := server.loadPostForAccess(c, canCommentOnPost)
	if !ok {
		return
	}
	thread, ok := server.loadCommentThread(c, post)
	if !ok {
		return
	}
	var req CommentBodyRequest
	if !bindJSON(c, &req) {
		return
	}
	body, err := normalizeCommentBody(req.Body)
	if err != nil {
		respondCommentBodyError(c, err)
		return
	}
	comment, err := server.store.CreatePostComment(c.Request.Context(), db.CreatePostCommentParams{
		ThreadID: thread.ID, AuthorID: sql.NullInt64{Int64: caller.ID, Valid: true}, Body: body,
	})
	if err != nil {
		// The thread's last comment was deleted (and the thread with it) meanwhile.
		if isForeignKeyViolation(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "thread not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to add reply"})
		return
	}
	server.afterCommentWrite(c, post.ID, db.ActivityCommented, map[string]any{
		"thread_id": thread.ID, "comment_id": comment.ID, "reply": true,
	})
	server.respondComments(c, http.StatusCreated, caller, post, thread.ID, comment.ID)
}

// resolveCommentThread handles POST .../resolve and .../unresolve
// (canResolveCommentThread). Both are idempotent.
func (server *Server) resolveCommentThread(resolve bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		caller, post, ok := server.loadPostForAccess(c, canReadPost)
		if !ok {
			return
		}
		thread, ok := server.loadCommentThread(c, post)
		if !ok {
			return
		}
		ctx := c.Request.Context()
		canEdit, err := server.canEditWorkingCopy(ctx, caller, post)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check edit access"})
			return
		}
		if !canResolveCommentThread(caller, post, thread.CreatedBy, canEdit) {
			refuseComment(c, caller, post)
			return
		}
		wasResolved := thread.ResolvedAt.Valid
		verb := ""
		if resolve {
			_, err = server.store.ResolvePostCommentThread(ctx, db.ResolvePostCommentThreadParams{
				ID: thread.ID, ResolvedBy: sql.NullInt64{Int64: caller.ID, Valid: true},
			})
			if !wasResolved {
				verb = db.ActivityCommentResolved
			}
		} else {
			_, err = server.store.UnresolvePostCommentThread(ctx, thread.ID)
			if wasResolved {
				verb = db.ActivityCommentReopened
			}
		}
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "thread not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update thread"})
			return
		}
		if verb != "" {
			server.afterCommentWrite(c, post.ID, verb, map[string]any{"thread_id": thread.ID})
		}
		server.respondComments(c, http.StatusOK, caller, post, thread.ID, 0)
	}
}

// editComment handles PUT /posts/:id/comments/:comment_id (canEditComment: the
// author). 409 comment_deleted when it was deleted.
func (server *Server) editComment(c *gin.Context) {
	caller, post, ok := server.loadPostForAccess(c, canReadPost)
	if !ok {
		return
	}
	comment, ok := server.loadComment(c, post)
	if !ok {
		return
	}
	if !canEditComment(caller, post, comment.AuthorID) {
		refuseComment(c, caller, post)
		return
	}
	var req CommentBodyRequest
	if !bindJSON(c, &req) {
		return
	}
	body, err := normalizeCommentBody(req.Body)
	if err != nil {
		respondCommentBodyError(c, err)
		return
	}
	if _, err := server.store.UpdatePostCommentBody(c.Request.Context(), db.UpdatePostCommentBodyParams{ID: comment.ID, Body: body}); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusConflict, gin.H{"error": "the comment was deleted", "code": codeCommentDeleted})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to edit comment"})
		return
	}
	// No activity event for an edit (the comment was recorded when it was made).
	server.afterCommentWrite(c, post.ID, "", nil)
	server.respondComments(c, http.StatusOK, caller, post, comment.ThreadID, comment.ID)
}

// deleteComment handles DELETE /posts/:id/comments/:comment_id
// (canDeleteComment: the author or a moderator). Deleting a thread's last live
// comment deletes the thread. 409 comment_deleted when it was deleted already.
func (server *Server) deleteComment(c *gin.Context) {
	caller, post, ok := server.loadPostForAccess(c, canReadPost)
	if !ok {
		return
	}
	comment, ok := server.loadComment(c, post)
	if !ok {
		return
	}
	if !canDeleteComment(caller, post, comment.AuthorID) {
		refuseComment(c, caller, post)
		return
	}
	result, err := server.store.DeletePostCommentTx(c.Request.Context(), comment.ID, comment.ThreadID)
	if err != nil {
		switch {
		case errors.Is(err, db.ErrCommentDeleted), errors.Is(err, sql.ErrNoRows):
			c.JSON(http.StatusConflict, gin.H{"error": "the comment was deleted", "code": codeCommentDeleted})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete comment"})
		}
		return
	}
	payload := map[string]any{"thread_id": comment.ThreadID, "comment_id": comment.ID, "thread_deleted": result.ThreadDeleted}
	if comment.AuthorID.Valid {
		payload["author_id"] = comment.AuthorID.Int64
	}
	server.afterCommentWrite(c, post.ID, db.ActivityCommentDeleted, payload)
	threadID := comment.ThreadID
	if result.ThreadDeleted {
		threadID = 0
	}
	server.respondComments(c, http.StatusOK, caller, post, threadID, 0)
}
