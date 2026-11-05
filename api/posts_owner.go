// Package api — Post ownership (#353)
//
// The owner (posts.user_id) is what permissions read (#135: a contributor edits only
// their own posts); the byline (#319) only credits. An admin may give a post to
// another member:
//
//   - GET /posts/:id/owner: who owns it (canReadPost), for the settings panel's
//     Owner field.
//   - POST /posts/:id/transfer {"user_id", "replace_in_byline"?}: admins only (the
//     issue's default; editors can't). The new owner must be an active member: an
//     existing user (removal is a hard delete, #333) with a content role. The byline
//     stays as it is unless replace_in_byline, which puts the new owner in the old
//     owner's place in the working byline; on a published post that waits for Update
//     like any setting (golive_post_settings, #358). A post in the trash can't be
//     transferred (nobody edits one, #327).
//
// TransferPostOwnerTx runs the same reassignment as a member's removal
// (db.reassignPostOwner, RemoveUserTx). After the commit the API asks the collab
// server to re-check the document's open connections (recheckCollabDoc, the #313
// re-check), so a contributor who lost the post drops to read-only at once, and the
// transfer is recorded in the activity log (#324, "transferred").
package api

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// TransferPostRequest is the body of POST /posts/:id/transfer.
type TransferPostRequest struct {
	UserID int64 `json:"user_id" binding:"required,min=1"`
	// ReplaceInByline also replaces the old owner in the byline ("also replace me
	// in the byline"). Off, the byline is untouched.
	ReplaceInByline bool `json:"replace_in_byline"`
}

func toPostOwnerResponse(id int64, username, fullName, avatarURL string) PostAuthorResponse {
	return PostAuthorResponse{ID: id, Username: username, FullName: fullName, Avatar: avatarResponse(avatarURL)}
}

// getPostOwner handles GET /posts/:id/owner.
func (server *Server) getPostOwner(c *gin.Context) {
	id, ok := parsePostIDParam(c)
	if !ok {
		return
	}
	post, err := server.store.GetPost(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}
	if !server.checkLoadedPost(c, post, canReadPost) {
		return
	}
	owner, err := server.store.GetUser(c.Request.Context(), post.UserID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "owner not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the owner"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"owner": toPostOwnerResponse(owner.ID, owner.Username, owner.FullName, owner.AvatarUrl)})
}

// transferPost handles POST /posts/:id/transfer (requireSiteAdmin).
//
// Returns:
//   - 200 OK: {"post", "owner", "previous_owner_id", "authors", "byline_changed"}
//   - 400 Bad Request: invalid id or body; {"code": "invalid_owner"} the new owner
//     doesn't exist or isn't an active member (no content role)
//   - 403 Forbidden: not an admin
//   - 404 Not Found: no such post
//   - 409 Conflict: {"code": "already_owner"} they own it already;
//     {"code": "post_trashed"} the post is in the trash
func (server *Server) transferPost(c *gin.Context) {
	id, ok := parsePostIDParam(c)
	if !ok {
		return
	}
	var req TransferPostRequest
	if !bindJSON(c, &req) {
		return
	}

	result, err := server.store.TransferPostOwnerTx(c.Request.Context(), db.TransferPostOwnerTxParams{
		PostID:          id,
		ToID:            req.UserID,
		OwnerRoles:      contentRoles,
		ReplaceInByline: req.ReplaceInByline,
	})
	if err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows):
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		case errors.Is(err, db.ErrNewOwnerNotFound), errors.Is(err, db.ErrNewOwnerInactive):
			c.JSON(http.StatusBadRequest, gin.H{
				"error":  "choose an active member to own the post",
				"code":   "invalid_owner",
				"fields": gin.H{"user_id": "not an active member"},
			})
		case errors.Is(err, db.ErrAlreadyOwner):
			c.JSON(http.StatusConflict, gin.H{"error": "they already own this post", "code": "already_owner"})
		case errors.Is(err, db.ErrPostTrashed):
			c.JSON(http.StatusConflict, gin.H{"error": "the post is in the trash", "code": "post_trashed"})
		default:
			server.requestLog(c).Warn("post_transfer_failed", "post_id", id, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to transfer the post"})
		}
		return
	}

	// The old owner may be a contributor editing it now: their connections drop to
	// read-only at once instead of at the next periodic re-check (and a contributor
	// who receives it gets write access on theirs).
	server.recheckCollabDoc(requestIDFromContext(c), id)
	server.recordPostActivity(c, db.ActivityTransferred, id, map[string]any{
		"post_type":         result.Post.PostType,
		"previous_owner_id": result.PreviousOwnerID,
		"owner_id":          result.Owner.ID,
		"byline_changed":    result.BylineChanged,
	})
	c.JSON(http.StatusOK, gin.H{
		"post":              toPostResponse(result.Post),
		"owner":             toPostOwnerResponse(result.Owner.ID, result.Owner.Username, result.Owner.FullName, result.Owner.AvatarUrl),
		"previous_owner_id": result.PreviousOwnerID,
		"authors":           toPostBylineResponse(result.Authors),
		"byline_changed":    result.BylineChanged,
	})
}
