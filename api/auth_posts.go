// auth_posts implements document-level (per-post) permissions (#135).
//
// Like auth_roles.go, this is the only place that decides who may do what to a
// post; handlers call these helpers and never compare roles or owner ids
// themselves.
//
// # Model: ownership
//
//   - Admins and editors (canModeratePosts) may do anything to any post.
//   - Contributors may create posts (always as drafts, owned by themselves)
//     and edit their own posts' working copy (the collab socket), at any
//     status but scheduled. The working copy only goes live when a moderator
//     publishes, and scheduling (#147) is that decision made in advance: the
//     scheduler publishes whatever the working copy holds then, so a
//     contributor's later edits would go live unreviewed. Their scheduled post
//     is read-only to them until a moderator cancels the schedule.
//   - What is live on the public site (title, slug, status, meta, featured
//     image, media links, the row itself) a contributor may change only while
//     their post is not published (canEditPostDetails). Otherwise a
//     contributor could change or remove published content without the
//     publish permission.
//   - Reading (#393): every /api/v1/posts* read serves the working copy, so
//     it needs a content role, and a contributor reads only their own posts
//     and published ones (canReadPost; the lists filter the same way with
//     postsViewerID). They may watch those live, read-only (collab tickets).
//     Anonymous readers get /public only: published snapshots.
//   - Publishing, scheduling, unpublishing and revisions are moderator-only
//     (requireContentEditor on those routes).
//   - Trash (#327): moving a post to the trash is the old delete, so the same
//     rule (canEditPostDetails). Restoring needs the right to give the post its
//     old status back: a contributor may restore their own post unless it was
//     published or scheduled (canRestorePost). Permanent delete is
//     moderator-only (canDeletePostPermanently). Nobody edits a trashed post:
//     canEditPost is false for it, the collab server refuses its document, and
//     the write routes answer 409 (postTrashedError).
//
// The owner is posts.user_id. Everything is read from the DB, never the token.
package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// postStatusPublished is the status publishPost sets and the public site reads.
const postStatusPublished = "published"

// postStatusScheduled is a draft waiting for its publish_at (#147). It isn't
// public: every public read requires postStatusPublished.
const postStatusScheduled = "scheduled"

// postStatusTrash is a post in the trash (#327): not public, not editable.
const postStatusTrash = db.PostStatusTrash

// isTrashed reports whether the post is in the trash.
func isTrashed(post db.Post) bool {
	return post.PostStatus == postStatusTrash
}

// requireContentAuthor gates routes any content role may reach: creating
// posts and media, and the per-post write routes, where the handler then
// decides with canEditPost / canEditPostDetails.
func requireContentAuthor(server *Server) gin.HandlerFunc {
	return requireRole(server, RoleAdmin, RoleEditor, RoleContributor)
}

// canModeratePosts reports whether the user may edit, publish and delete any
// post. Mirrors requireContentEditor.
func canModeratePosts(user db.User) bool {
	return hasRole(user, RoleAdmin, RoleEditor)
}

// canCreatePost reports whether the user may create a post with the given
// authors and status. Moderators may create anything; a contributor only a
// draft whose sole author is themselves (so they own it).
func canCreatePost(user db.User, authorIDs []int64, status string) bool {
	if canModeratePosts(user) {
		return true
	}
	if !hasRole(user, RoleContributor) {
		return false
	}
	ownDraft := status == "" || strings.EqualFold(status, "draft")
	return ownDraft && len(authorIDs) == 1 && authorIDs[0] == user.ID
}

// canEditPost reports whether the user may edit the post's working copy: a
// read-write collab connection. The working copy is not public, but a
// scheduled post's goes live at its time without another review, so its
// contributor owner may only watch it (#147). Nobody edits a post in the trash
// (#327): it has to be restored first.
func canEditPost(user db.User, post db.Post) bool {
	if isTrashed(post) {
		return false
	}
	if canModeratePosts(user) {
		return true
	}
	return hasRole(user, RoleContributor) && post.UserID == user.ID &&
		!strings.EqualFold(post.PostStatus, postStatusScheduled)
}

// canTrashPost reports whether the user may move the post to the trash: the
// rule DELETE always had (canEditPostDetails), so a contributor may trash their
// own post only while it isn't published or scheduled. A post already in the
// trash can't be trashed again.
func canTrashPost(user db.User, post db.Post) bool {
	if isTrashed(post) {
		return false
	}
	return canEditPostDetails(user, post)
}

// canRestorePost reports whether the user may take the post out of the trash.
// Restoring gives it back its old status, so a published or scheduled post needs
// the publish permission (a moderator); a contributor may restore their own post
// that was a draft or archived.
func canRestorePost(user db.User, post db.Post) bool {
	if canModeratePosts(user) {
		return true
	}
	if !hasRole(user, RoleContributor) || post.UserID != user.ID {
		return false
	}
	from := post.TrashedFromStatus.String
	return !strings.EqualFold(from, postStatusPublished) && !strings.EqualFold(from, postStatusScheduled)
}

// canDeletePostPermanently reports whether the user may delete the post for
// good (from the trash): admins and editors only.
func canDeletePostPermanently(user db.User, _ db.Post) bool {
	return canModeratePosts(user)
}

// canReadPost reports whether the user may read the post's working copy: the
// row, meta, featured image, media links and terms through /api/v1/posts*, the
// blocks, and a collab ticket (#206, read-only unless canEditPost). Moderators
// may read any post; a contributor their own posts at any status and any
// published post, never someone else's draft or archived post (#393). The post
// must still exist (authorizePost: 404).
func canReadPost(user db.User, post db.Post) bool {
	if canModeratePosts(user) {
		return true
	}
	if !hasRole(user, RoleContributor) {
		return false
	}
	return post.UserID == user.ID || strings.EqualFold(post.PostStatus, postStatusPublished)
}

// postsViewerID is canReadPost for the list queries' viewer_id: 0 for a
// moderator (every post), else the caller's id (their own posts plus
// published ones). Only call it behind requireContentAuthor.
func postsViewerID(user db.User) int64 {
	if canModeratePosts(user) {
		return 0
	}
	return user.ID
}

// callerViewerID is postsViewerID for the authenticated caller. ok=false means
// the response was already written (callerUser).
func (server *Server) callerViewerID(c *gin.Context) (int64, bool) {
	user, ok := server.callerUser(c)
	if !ok {
		return 0, false
	}
	return postsViewerID(user), true
}

// canEditPostDetails reports whether the user may change the post's live
// fields (title, slug, meta, featured image, media links) or delete it. An
// owner without moderation rights can do that only while it isn't published
// (or scheduled, which canEditPost already refuses).
func canEditPostDetails(user db.User, post db.Post) bool {
	// A trashed post changes only through restore (#327), moderators' too.
	if isTrashed(post) {
		return false
	}
	if canModeratePosts(user) {
		return true
	}
	return canEditPost(user, post) && !strings.EqualFold(post.PostStatus, postStatusPublished)
}

// authorizePost checks a per-post permission for the caller and writes the
// error response when it fails. Moderators pass without loading the post
// (the handler reports a missing post itself, as before #135); anyone else
// needs the post row, so a missing post is 404 and a refused one 403.
// Returns ok=false when the caller must just return.
func (server *Server) authorizePost(c *gin.Context, postID int64, allowed func(db.User, db.Post) bool) bool {
	_, _, ok := server.authorizeLoadPost(c, postID, allowed)
	return ok
}

// authorizeLoadPost is authorizePost that also hands back the post row when it
// had to load one (loaded=false for moderators), so the handler can reuse it.
func (server *Server) authorizeLoadPost(c *gin.Context, postID int64, allowed func(db.User, db.Post) bool) (post db.Post, loaded bool, ok bool) {
	user, ok := server.callerUser(c)
	if !ok {
		return db.Post{}, false, false
	}
	if canModeratePosts(user) {
		return db.Post{}, false, true
	}

	post, err := server.store.GetPost(c.Request.Context(), postID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return db.Post{}, false, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return db.Post{}, false, false
	}
	return post, true, server.checkPost(c, user, post, allowed)
}

// mayNestUnder reports whether the caller may file a post under parentID:
// createPost's parent rule (canEditPost on the parent), moderators without a
// lookup. A parent that no longer exists is not allowed. ok=false means the
// lookup failed and a 500 was written.
func (server *Server) mayNestUnder(c *gin.Context, caller db.User, parentID int64) (allowed bool, ok bool) {
	if canModeratePosts(caller) {
		return true, true
	}
	parent, err := server.store.GetPost(c.Request.Context(), parentID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, true
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get parent post"})
		return false, false
	}
	return canEditPost(caller, parent), true
}

// checkLoadedPost is checkPost for the authenticated caller (callerUser), for a
// handler that already loaded the post. false means the response was written.
func (server *Server) checkLoadedPost(c *gin.Context, post db.Post, allowed func(db.User, db.Post) bool) bool {
	caller, ok := server.callerUser(c)
	return ok && server.checkPost(c, caller, post, allowed)
}

// checkPost is authorizePost for a handler that already loaded the post. A
// rule refused because the post is in the trash (#327) answers 409
// post_trashed, to a caller who may read the post: restore it first.
func (server *Server) checkPost(c *gin.Context, user db.User, post db.Post, allowed func(db.User, db.Post) bool) bool {
	if !allowed(user, post) {
		if isTrashed(post) && canReadPost(user, post) {
			postTrashedError().write(c)
			return false
		}
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return false
	}
	return true
}

// authorizeWritePost is authorizePost(canEditPostDetails) for a write route
// that doesn't load the post itself (media links, SEO, restore-settings):
// moderators skip the owner rule, not the trash (#327), so their post is read
// too. A missing post passes, as authorizePost lets moderators through, and
// the handler reports it.
func (server *Server) authorizeWritePost(c *gin.Context, postID int64) bool {
	_, loaded, ok := server.authorizeLoadPost(c, postID, canEditPostDetails)
	if !ok || loaded {
		return ok
	}
	post, err := server.store.GetPost(c.Request.Context(), postID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return true
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return false
	}
	if isTrashed(post) {
		postTrashedError().write(c)
		return false
	}
	return true
}
