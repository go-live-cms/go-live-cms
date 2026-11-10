// Package api — Post publish-state write handlers: unpublish (#136), restoring a
// version's settings (#358)
//
// Publishing lives in post_blocks_handlers.go (publishPost). A version's blocks
// are restored in the editor, never here; see post_versions_handlers_read.go.
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

// restorePostVersionSettings handles POST /posts/:id/versions/:version_no/restore-settings:
// the version's title, excerpt, featured image, terms, SEO fields (#357) and byline (#319) become the
// post's working settings (#358). Like the blocks (restoreVersionLive), they reach the site only on
// Update: the published settings don't change here. The editor calls it after it has
// restored the blocks. A version from before #358 has no settings: 200 with
// "restored": false and nothing changed.
func (server *Server) restorePostVersionSettings(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	versionNo, err := strconv.ParseInt(c.Param("version_no"), 10, 32)
	if err != nil || versionNo <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid version number"})
		return
	}
	// Not while the post is in the trash (#327).
	if !server.authorizeWritePost(c, postID) {
		return
	}

	version, err := server.store.GetPostVersion(c, db.GetPostVersionParams{PostID: postID, VersionNo: int32(versionNo)})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "version not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get version"})
		return
	}
	settings, ok := decodePostSettings(version.Settings)
	if !ok {
		c.JSON(http.StatusOK, gin.H{"restored": false})
		return
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
		HTMLSnippets: customhtml.Markup(version.BlockDoc),
	}
	if settings.FeaturedImage != nil {
		restored.FeaturedImageID = settings.FeaturedImage.ID
	}
	post, err := server.store.RestorePostSettingsTx(c, db.RestorePostSettingsTxParams{PostID: postID, Settings: restored})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		server.requestLog(c).Warn("restoring version settings failed", "post_id", postID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to restore the version's settings"})
		return
	}

	// The editor restores the blocks through Yjs first (they show up as an
	// "edited" event); this is the restore itself.
	server.recordPostActivity(c, db.ActivityVersionRestored, postID, map[string]any{"version_no": versionNo})

	c.JSON(http.StatusOK, gin.H{"restored": true, "post": toPostResponse(post)})
}
