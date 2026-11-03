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
//     status. The working copy only goes live when a moderator publishes.
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
//   - Publishing, unpublishing and revisions are moderator-only
//     (requireContentEditor on those routes).
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
// read-write collab connection. The working copy is not public.
func canEditPost(user db.User, post db.Post) bool {
	return canModeratePosts(user) || (hasRole(user, RoleContributor) && post.UserID == user.ID)
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
// owner without moderation rights can do that only while it isn't published.
func canEditPostDetails(user db.User, post db.Post) bool {
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

// checkPost is authorizePost for a handler that already loaded the post.
func (server *Server) checkPost(c *gin.Context, user db.User, post db.Post, allowed func(db.User, db.Post) bool) bool {
	if !allowed(user, post) {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return false
	}
	return true
}
