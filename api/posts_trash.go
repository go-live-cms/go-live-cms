// Package api — Trash and bulk actions for the posts list (#327)
//
// DELETE /posts/:id moves a post to the trash (post_status 'trash', 000036);
// it used to delete the row. From the trash, POST /posts/:id/restore gives it
// back the status it had, and DELETE /posts/:id/permanent (admins and editors)
// is the old hard delete. POST /posts/bulk runs publish, trash, restore or
// permanent delete on up to 100 posts, checking each one against the caller's
// permissions (auth_posts.go) and reporting each outcome.
//
// A trashed post is hidden everywhere else because nothing else asks for that
// status: the public site reads post_status 'published' only, the scheduler
// claims 'scheduled' only, and the admin lists leave it out unless asked for
// status=trash. The collab server refuses its document (the access lookup
// answers 410) and the API asks it to re-check open connections right after a
// post is trashed, so they close with post-trashed.
package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Error codes the posts list shows (web lib/contentList.ts mirrors them).
const (
	codePostTrashed      = "post_trashed"
	codePostNotTrashed   = "not_in_trash"
	codePostNotFound     = "not_found"
	codePostForbidden    = "forbidden"
	codeCollabSaveFailed = "collab_unavailable"
	codePostActionFailed = "failed"
)

// maxBulkPosts caps one POST /posts/bulk: each publish flushes the collab
// document first (up to collabFlushTimeout), so a request stays bounded.
const maxBulkPosts = 100

// postActionError is why one post's action failed: the HTTP status the single
// route answers, and a code for the bulk report.
type postActionError struct {
	Status  int
	Code    string
	Message string
}

func (e *postActionError) write(c *gin.Context) {
	c.JSON(e.Status, gin.H{"error": e.Message, "code": e.Code})
}

var (
	errPostNotFound = &postActionError{http.StatusNotFound, codePostNotFound, "post not found"}
	errPostRefused  = &postActionError{http.StatusForbidden, codePostForbidden, "forbidden"}
)

func postActionFailed(message string) *postActionError {
	return &postActionError{http.StatusInternalServerError, codePostActionFailed, message}
}

// postTrashedError is the 409 every write to a trashed post gets: restore it first.
func postTrashedError() *postActionError {
	return &postActionError{http.StatusConflict, codePostTrashed, "the post is in the trash; restore it first"}
}

// loadPostFor reads the post for an action and checks that the caller may at
// least read it (canReadPost: a contributor gets 403, not "in the trash", for
// someone else's draft).
func (server *Server) loadPostFor(ctx context.Context, caller db.User, id int64) (db.Post, *postActionError) {
	post, err := server.store.GetPost(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return db.Post{}, errPostNotFound
		}
		return db.Post{}, postActionFailed("failed to get post")
	}
	if !canReadPost(caller, post) {
		return db.Post{}, errPostRefused
	}
	return post, nil
}

// trashPostByID moves one post to the trash for the caller.
func (server *Server) trashPostByID(c *gin.Context, caller db.User, id int64) (db.Post, *postActionError) {
	ctx := c.Request.Context()
	post, failure := server.loadPostFor(ctx, caller, id)
	if failure != nil {
		return db.Post{}, failure
	}
	if isTrashed(post) {
		return db.Post{}, &postActionError{http.StatusConflict, codePostTrashed, "the post is already in the trash"}
	}
	if !canTrashPost(caller, post) {
		return db.Post{}, errPostRefused
	}
	trashed, err := server.store.TrashPost(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// Trashed (or deleted) by someone else since the read.
			return db.Post{}, &postActionError{http.StatusConflict, codePostTrashed, "the post is already in the trash"}
		}
		return db.Post{}, postActionFailed("failed to move the post to the trash")
	}
	// Open editors of this post close now (the access lookup answers 410).
	server.recheckCollabDoc(requestIDFromContext(c), id)
	return trashed, nil
}

// restorePostByID takes one post out of the trash for the caller.
func (server *Server) restorePostByID(c *gin.Context, caller db.User, id int64) (db.Post, *postActionError) {
	ctx := c.Request.Context()
	post, failure := server.loadPostFor(ctx, caller, id)
	if failure != nil {
		return db.Post{}, failure
	}
	if !isTrashed(post) {
		return db.Post{}, &postActionError{http.StatusConflict, codePostNotTrashed, "the post is not in the trash"}
	}
	if !canRestorePost(caller, post) {
		return db.Post{}, errPostRefused
	}
	restored, err := server.store.RestorePostFromTrash(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return db.Post{}, &postActionError{http.StatusConflict, codePostNotTrashed, "the post is not in the trash"}
		}
		return db.Post{}, postActionFailed("failed to restore the post")
	}
	return restored, nil
}

// deletePostPermanentlyByID deletes one trashed post for good.
func (server *Server) deletePostPermanentlyByID(c *gin.Context, caller db.User, id int64) *postActionError {
	ctx := c.Request.Context()
	post, failure := server.loadPostFor(ctx, caller, id)
	if failure != nil {
		return failure
	}
	if !canDeletePostPermanently(caller, post) {
		return errPostRefused
	}
	if !isTrashed(post) {
		return &postActionError{http.StatusConflict, codePostNotTrashed, "only posts in the trash can be deleted permanently"}
	}
	if err := server.store.DeleteTrashedPostTx(ctx, id); err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows):
			return errPostNotFound
		case errors.Is(err, db.ErrPostNotTrashed):
			return &postActionError{http.StatusConflict, codePostNotTrashed, "only posts in the trash can be deleted permanently"}
		}
		return postActionFailed("failed to delete post")
	}
	return nil
}

// publishPostByID is the Publish button's path for one post: flush the collab
// document so block_doc holds every edit, then PublishPostTx (#206, #358).
// publishPost and the bulk publish both use it. The caller has the publish
// permission (requireContentEditor, or canModeratePosts in bulk).
func (server *Server) publishPostByID(c *gin.Context, postID, userID int64, label, message sql.NullString) (db.PublishPostTxResult, *postActionError) {
	// Edits reach block_doc only when the collab server stores (debounced).
	// Make it store now, or the snapshot below could miss the last seconds of
	// editing; if it can't, publish nothing (#206).
	if err := server.flushCollabDoc(c.Request.Context(), postID, requestIDFromContext(c)); err != nil {
		server.requestLog(c).Warn("collab flush before publish failed", "post_id", postID, "error", err)
		return db.PublishPostTxResult{}, &postActionError{http.StatusServiceUnavailable, codeCollabSaveFailed,
			"the collaboration server could not save the latest edits; nothing was published, try again"}
	}

	// One transaction: the version gets the working copy's blocks and settings
	// (title, excerpt, featured image, terms; #358), the post's published
	// snapshot points at it, and the content image links follow the published
	// body without moving the featured image's (#389).
	version, err := server.store.PublishPostTx(c, db.PublishPostTxParams{
		PostID:       postID,
		Label:        label,
		Message:      message,
		CreatedBy:    sql.NullInt64{Int64: userID, Valid: true},
		ContentMedia: publishedContentMedia,
	})
	if err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows):
			return db.PublishPostTxResult{}, errPostNotFound
		case errors.Is(err, db.ErrPostTrashed):
			return db.PublishPostTxResult{}, postTrashedError()
		}
		return db.PublishPostTxResult{}, postActionFailed("failed to publish post")
	}
	return version, nil
}

// postIDParam reads :id; false means a 400 was written.
func postIDParam(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return 0, false
	}
	return id, true
}

// deletePost handles DELETE /posts/:id: moves the post to the trash (#327).
// Same permission as the delete it replaced (canEditPostDetails). 409 when it
// is already there.
func (server *Server) deletePost(c *gin.Context) {
	id, ok := postIDParam(c)
	if !ok {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	post, failure := server.trashPostByID(c, caller, id)
	if failure != nil {
		failure.write(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "post moved to the trash", "post": toPostResponse(post)})
}

// restorePost handles POST /posts/:id/restore: out of the trash, with the
// status it had (a scheduled post whose time has passed comes back as a draft).
func (server *Server) restorePost(c *gin.Context) {
	id, ok := postIDParam(c)
	if !ok {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	post, failure := server.restorePostByID(c, caller, id)
	if failure != nil {
		failure.write(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"post": toPostResponse(post)})
}

// deletePostPermanently handles DELETE /posts/:id/permanent (admins and
// editors): the old hard delete, for a post in the trash only (409 otherwise).
func (server *Server) deletePostPermanently(c *gin.Context) {
	id, ok := postIDParam(c)
	if !ok {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	if failure := server.deletePostPermanentlyByID(c, caller, id); failure != nil {
		failure.write(c)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "post deleted permanently"})
}

// listCreditedAuthors handles GET /posts/authors?type=: the posts list's Author
// filter. Everyone credited on a post the caller may read (contributors: their
// own and published ones), as {id, username, full_name}; editors can't list
// users (GET /users is admins'), so the filter can't come from there.
func (server *Server) listCreditedAuthors(c *gin.Context) {
	viewerID, ok := server.callerViewerID(c)
	if !ok {
		return
	}
	rows, err := server.store.ListCreditedAuthors(c.Request.Context(), db.ListCreditedAuthorsParams{
		PostType: c.Query("type"),
		ViewerID: viewerID,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list authors"})
		return
	}
	authors := make([]PostAuthorResponse, 0, len(rows))
	for _, row := range rows {
		authors = append(authors, PostAuthorResponse{ID: row.ID, Username: row.Username, FullName: row.FullName})
	}
	c.JSON(http.StatusOK, gin.H{"authors": authors})
}

// Bulk actions (POST /posts/bulk).
const (
	bulkActionPublish = "publish"
	bulkActionTrash   = "trash"
	bulkActionRestore = "restore"
	bulkActionDelete  = "delete"
)

// BulkPostsRequest is POST /posts/bulk's body. The byline bulk action ("change
// byline author") waits for #319's byline writes.
type BulkPostsRequest struct {
	Action string  `json:"action" binding:"required,oneof=publish trash restore delete"`
	IDs    []int64 `json:"ids" binding:"required,min=1,max=100,dive,min=1"`
}

// BulkPostResult is one post's outcome. A failure has the status the single
// route would have answered, a code and a message.
type BulkPostResult struct {
	ID         int64  `json:"id"`
	OK         bool   `json:"ok"`
	PostStatus string `json:"post_status,omitempty"`
	Status     int    `json:"status,omitempty"`
	Code       string `json:"code,omitempty"`
	Error      string `json:"error,omitempty"`
}

// bulkPosts handles POST /posts/bulk {action, ids}. Every content role may
// call it; each post is checked on its own, exactly as its single route checks
// it (publish needs the editor role, trash canTrashPost, restore
// canRestorePost, delete canDeletePostPermanently on a trashed post). One
// post's failure never stops the others: the answer is 200 with a result per
// id (duplicates once, in the order given) and the totals.
func (server *Server) bulkPosts(c *gin.Context) {
	var req BulkPostsRequest
	if !bindJSON(c, &req) {
		return
	}
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}

	ids := make([]int64, 0, len(req.IDs))
	seen := make(map[int64]bool, len(req.IDs))
	for _, id := range req.IDs {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}

	results := make([]BulkPostResult, 0, len(ids))
	succeeded := 0
	for _, id := range ids {
		status, failure := server.bulkPostAction(c, caller, req.Action, id)
		if failure != nil {
			results = append(results, BulkPostResult{ID: id, Status: failure.Status, Code: failure.Code, Error: failure.Message})
			continue
		}
		succeeded++
		results = append(results, BulkPostResult{ID: id, OK: true, PostStatus: status})
	}
	c.JSON(http.StatusOK, gin.H{
		"action":    req.Action,
		"results":   results,
		"succeeded": succeeded,
		"failed":    len(results) - succeeded,
	})
}

// bulkPostAction runs one post's action and returns its status afterwards
// ("" once deleted).
func (server *Server) bulkPostAction(c *gin.Context, caller db.User, action string, id int64) (string, *postActionError) {
	switch action {
	case bulkActionPublish:
		// The route's requireContentEditor, per item: contributors can't publish.
		if !canModeratePosts(caller) {
			return "", &postActionError{http.StatusForbidden, codePostForbidden, "publishing requires the editor role"}
		}
		if _, failure := server.publishPostByID(c, id, caller.ID, sql.NullString{}, sql.NullString{}); failure != nil {
			return "", failure
		}
		return postStatusPublished, nil
	case bulkActionTrash:
		post, failure := server.trashPostByID(c, caller, id)
		if failure != nil {
			return "", failure
		}
		return post.PostStatus, nil
	case bulkActionRestore:
		post, failure := server.restorePostByID(c, caller, id)
		if failure != nil {
			return "", failure
		}
		return post.PostStatus, nil
	default: // bulkActionDelete (the binding allows nothing else)
		if failure := server.deletePostPermanentlyByID(c, caller, id); failure != nil {
			return "", failure
		}
		return "", nil
	}
}
