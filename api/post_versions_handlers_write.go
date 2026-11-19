// Package api — Post publish-state write handlers: unpublish (#136), restoring a
// version (#286) and its settings (#358)
//
// Publishing lives in post_blocks_handlers.go (publishPost). A version's blocks
// are restored by the collab server (restoreCollabVersion), never written here.
package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/go-live-cms/go-live-cms/customhtml"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// unpublishPost handles POST /posts/:id/unpublish - back to draft, public snapshot removed.
// The working copy and the version history are untouched.
func (server *Server) unpublishPost(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	post, err := server.store.UnpublishPost(c, postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to unpublish post"})
		return
	}

	server.recordPostActivity(c, db.ActivityUnpublished, postID, nil)

	c.JSON(http.StatusOK, gin.H{"post": toPostResponse(post)})
}

// loadVersionToRestore parses the route of both restore handlers, checks the
// post may be written (not in the trash, #327) and reads the version. It has
// answered the request when ok is false.
func (server *Server) loadVersionToRestore(c *gin.Context) (postID, versionNo int64, version db.GetPostVersionRow, ok bool) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return 0, 0, version, false
	}
	versionNo, err = strconv.ParseInt(c.Param("version_no"), 10, 32)
	if err != nil || versionNo <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid version number"})
		return 0, 0, version, false
	}
	if !server.authorizeWritePost(c, postID) {
		return 0, 0, version, false
	}
	version, err = server.store.GetPostVersion(c, db.GetPostVersionParams{PostID: postID, VersionNo: int32(versionNo)})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "version not found"})
			return 0, 0, version, false
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get version"})
		return 0, 0, version, false
	}
	return postID, versionNo, version, true
}

// restoredVersion is what restoring a version's settings did: Restored is
// false for a version from before #358 (it has none; nothing changed).
type restoredVersion struct {
	Restored bool
	Post     db.Post
}

// restoreVersionSettingsTx writes the version's settings into the post's
// working copy. sql.ErrNoRows: the post is gone.
func (server *Server) restoreVersionSettingsTx(c *gin.Context, postID int64, version db.GetPostVersionRow) (restoredVersion, error) {
	settings, ok := decodePostSettings(version.Settings)
	if !ok {
		return restoredVersion{}, nil
	}
	restored := db.RestoredPostSettings{
		Title:       settings.Title,
		Description: settings.Description,
		TermIDs:     settings.TermIDs,
		ThumbnailURL: func(media db.Medium) string {
			return publicMediaPath(server.config.UploadPath, media.MediaPath)
		},
		SEOTitle:       settings.SEOTitle,
		SEODescription: settings.SEODescription,
		SocialImageID:  settings.SocialImageID,
		Noindex:        settings.Noindex,
		CanonicalURL:   settings.CanonicalURL,
		AuthorIDs:      settings.AuthorIDs,
		PageTemplate:   settings.PageTemplate,
		// Custom HTML (#428): the markup this version was published with, read from the
		// version itself, so nobody can pass any in.
		HTMLSnippets:      customhtml.Markup(version.BlockDoc),
		EmptyHTMLSnippets: customhtml.EmptySnippetIDs(version.BlockDoc),
	}
	if settings.FeaturedImage != nil {
		restored.FeaturedImageID = settings.FeaturedImage.ID
	}
	post, err := server.store.RestorePostSettingsTx(c, db.RestorePostSettingsTxParams{PostID: postID, Settings: restored})
	if err != nil {
		return restoredVersion{}, err
	}
	return restoredVersion{Restored: true, Post: post}, nil
}

// restorePostVersionSettings handles POST /posts/:id/versions/:version_no/restore-settings:
// the version's title, excerpt, featured image, terms, SEO fields (#357) and byline (#319) become the
// post's working settings (#358). They reach the site only on Update: the published settings don't
// change here. A version from before #358 has no settings: 200 with "restored": false and nothing
// changed.
//
// Since #286 the editor restores through POST .../restore (restorePostVersion), which does the
// blocks and the settings in one call. This route stays for editor tabs loaded before that deploy,
// which restore the blocks through their editor (restoreVersionLive) and then call it.
func (server *Server) restorePostVersionSettings(c *gin.Context) {
	postID, versionNo, version, ok := server.loadVersionToRestore(c)
	if !ok {
		return
	}
	result, err := server.restoreVersionSettingsTx(c, postID, version)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		server.requestLog(c).Warn("restoring version settings failed", "post_id", postID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to restore the version's settings"})
		return
	}
	if !result.Restored {
		c.JSON(http.StatusOK, gin.H{"restored": false})
		return
	}

	// The editor restored the blocks through Yjs first (they show up as an
	// "edited" event); this is the restore itself.
	server.recordPostActivity(c, db.ActivityVersionRestored, postID, map[string]any{"version_no": versionNo})

	c.JSON(http.StatusOK, gin.H{"restored": true, "post": toPostResponse(result.Post)})
}

// Codes of a server-side restore that didn't happen (#286).
const (
	codeVersionUnrestorable = "version_unrestorable"
	codeRestoreUnconfirmed  = "restore_unconfirmed"
)

// RestorePostVersionResponse is the answer of POST /posts/:id/versions/:version_no/restore.
type RestorePostVersionResponse struct {
	// Blocks: the version is in the working copy, live in every open editor and stored.
	Blocks RestoredBlocks `json:"blocks"`
	// SettingsRestored is false for a version from before #358 (only its content came back).
	SettingsRestored bool `json:"settings_restored"`
	// Post is the post with the version's settings, when SettingsRestored.
	Post *PostResponse `json:"post,omitempty"`
}

// RestoredBlocks is what the collab server did with the version's blocks.
type RestoredBlocks struct {
	// BlockRevision is the post's block_revision after the restore (null if the collab server didn't say).
	BlockRevision *int64 `json:"block_revision"`
	// Changed is false when the working copy already was the version.
	Changed bool `json:"changed"`
	// Hidden counts the version's blocks the editor can't show (#213), kept and hidden.
	Hidden int `json:"hidden"`
}

// restorePostVersion handles POST /posts/:id/versions/:version_no/restore (#286): the
// version becomes the post's working copy, its blocks and its settings (#358). Same
// access as before (editors and admins, not in the trash); the live post changes only
// on Publish/Update.
//
// The blocks go through the collab server, never around it (rule 11: only it writes
// the Yjs state and block_doc): it puts the version into the live document in one Yjs
// transaction, through a direct connection, so open editors get it as a remote change
// and a post nobody has open is restored too, then stores it, and answers only once
// both happened. If it can't (down, unreachable, its store failed), the answer is 503
// collab_unavailable and nothing changed: neither the blocks nor the settings, which are
// written only after the blocks landed. A version the collab server can't store is 422
// version_unrestorable. Only a timeout can't tell (503 restore_unconfirmed: the restore
// may still land; History and the editor show whether it did).
func (server *Server) restorePostVersion(c *gin.Context) {
	postID, versionNo, version, ok := server.loadVersionToRestore(c)
	if !ok {
		return
	}
	caller := getAuthPayload(c).UserID
	requestID := requestIDFromContext(c)

	blocks, err := server.restoreCollabVersion(c.Request.Context(), postID, caller, version.BlockDoc, requestID)
	if err != nil {
		var refused *collabRestoreError
		if !errors.As(err, &refused) {
			refused = &collabRestoreError{Err: err}
		}
		server.requestLog(c).Warn("collab_restore_failed", "post_id", postID, "version_no", versionNo,
			"status", refused.Status, "reason", refused.Reason, "timeout", refused.Timeout, "error", err.Error())
		switch {
		case refused.Timeout:
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": codeRestoreUnconfirmed,
				"error": "The collaboration server didn't confirm the restore in time. It may still finish: reload the post to see whether it did."})
		// Only the restore's own 404 (its "not-found" reason): a collab server from before
		// #286 answers 404 for the unknown route, which is a collab server that can't restore.
		case refused.Status == http.StatusNotFound && refused.Reason == "not-found":
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		case refused.Status == http.StatusUnprocessableEntity, refused.Status == http.StatusBadRequest, refused.Status == http.StatusRequestEntityTooLarge:
			c.JSON(http.StatusUnprocessableEntity, gin.H{"code": codeVersionUnrestorable,
				"error": "This version can't be restored: its content doesn't pass the editor's checks. Nothing was changed."})
		default:
			c.JSON(http.StatusServiceUnavailable, gin.H{"code": codeCollabSaveFailed,
				"error": "The collaboration server couldn't restore this version. Nothing was changed; try again in a moment."})
		}
		return
	}

	// The blocks are in: now the settings. If this fails, the blocks stay restored
	// (they are live in every editor and stored), and the answer says so.
	result, err := server.restoreVersionSettingsTx(c, postID, version)
	// The restore happened (its blocks at least): it is one event either way.
	server.recordPostActivity(c, db.ActivityVersionRestored, postID, map[string]any{"version_no": versionNo})
	response := RestorePostVersionResponse{Blocks: RestoredBlocks{
		BlockRevision: blocks.Revision,
		Changed:       blocks.BlockDoc != "unchanged",
		Hidden:        blocks.Dropped,
	}}
	if err != nil {
		server.requestLog(c).Warn("restoring version settings failed", "post_id", postID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"code": "settings_not_restored", "blocks": response.Blocks,
			"error": "The version's content was restored, but its title, excerpt, image, terms and custom HTML couldn't be."})
		return
	}
	if result.Restored {
		post := toPostResponse(result.Post)
		response.SettingsRestored = true
		response.Post = &post
	}
	c.JSON(http.StatusOK, response)
}
