// Package api — Post versions (revisions) read handlers (#136)
//
// Revisions are the Block Spec v1 snapshots publishPost stores in post_versions,
// not Yjs snapshots, so they don't depend on the collaboration server's storage.
//
// There is deliberately no endpoint that restores a version's blocks. Restoring loads
// a version into the working copy, and while collaborators are connected the live Yjs
// doc owns the working copy: overwriting posts.block_doc behind its back would be
// reverted (or fought) by the collab server's next store. The editor fetches the
// version here and applies it through the editor/Yjs path; the collab server stores
// it like any edit. The version's settings (#358) aren't in the Yjs doc, so they go
// back through POST /posts/:id/versions/:version_no/restore-settings
// (post_versions_handlers_write.go).
package api

import (
	"database/sql"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// PostVersionSummary is one entry of GET /posts/:id/versions
type PostVersionSummary struct {
	ID                int64     `json:"id"`
	VersionNo         int32     `json:"version_no"`
	Status            string    `json:"status"`
	Label             *string   `json:"label"`
	Message           *string   `json:"message"`
	CreatedAt         time.Time `json:"created_at"`
	CreatedBy         *int64    `json:"created_by"`
	CreatedByUsername *string   `json:"created_by_username"`
	// IsPublished marks the version the public site currently shows.
	IsPublished bool `json:"is_published"`
}

// PostVersionsResponse is the response of GET /posts/:id/versions
type PostVersionsResponse struct {
	PostStatus         string               `json:"post_status"`
	PublishedVersionID *int64               `json:"published_version_id"`
	Versions           []PostVersionSummary `json:"versions"`
}

// PostVersionResponse is the response of GET /posts/:id/versions/:version_no
type PostVersionResponse struct {
	PostVersionSummary
	Doc BlockDocV1 `json:"doc"`
	// Settings are the title, excerpt, featured image and terms published with
	// the version (#358); null for a version published before they were saved.
	Settings *PostSettings `json:"settings"`
}

func nullStringPtr(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	return &s.String
}

func nullInt64Ptr(n sql.NullInt64) *int64 {
	if !n.Valid {
		return nil
	}
	return &n.Int64
}

// listPostVersions handles GET /posts/:id/versions - newest first, without the docs
func (server *Server) listPostVersions(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}

	// One statement: post status, live version and history read consistently.
	rows, err := server.store.GetPostVersions(c, postID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list versions"})
		return
	}
	if len(rows) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
		return
	}

	post := rows[0]
	versions := make([]PostVersionSummary, 0, len(rows))
	for _, row := range rows {
		if !row.VersionID.Valid {
			continue // the post has no versions (LEFT JOIN placeholder row)
		}
		versions = append(versions, PostVersionSummary{
			ID:                row.VersionID.Int64,
			VersionNo:         row.VersionNo.Int32,
			Status:            row.Status.String,
			Label:             nullStringPtr(row.Label),
			Message:           nullStringPtr(row.Message),
			CreatedAt:         row.CreatedAt.Time,
			CreatedBy:         nullInt64Ptr(row.CreatedBy),
			CreatedByUsername: nullStringPtr(row.CreatedByUsername),
			IsPublished:       post.PublishedVersionID.Valid && post.PublishedVersionID.Int64 == row.VersionID.Int64,
		})
	}

	c.JSON(http.StatusOK, PostVersionsResponse{
		PostStatus:         post.PostStatus,
		PublishedVersionID: nullInt64Ptr(post.PublishedVersionID),
		Versions:           versions,
	})
}

// getPostVersion handles GET /posts/:id/versions/:version_no - one version with its doc
func (server *Server) getPostVersion(c *gin.Context) {
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

	row, err := server.store.GetPostVersion(c, db.GetPostVersionParams{
		PostID:    postID,
		VersionNo: int32(versionNo),
	})
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "version not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get version"})
		return
	}

	doc, err := parseStoredBlockDoc(row.BlockDoc)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to parse version document"})
		return
	}
	settings, _ := decodePostSettings(row.Settings)

	c.JSON(http.StatusOK, PostVersionResponse{
		PostVersionSummary: PostVersionSummary{
			ID:                row.ID,
			VersionNo:         row.VersionNo,
			Status:            row.Status,
			Label:             nullStringPtr(row.Label),
			Message:           nullStringPtr(row.Message),
			CreatedAt:         row.CreatedAt,
			CreatedBy:         nullInt64Ptr(row.CreatedBy),
			CreatedByUsername: nullStringPtr(row.CreatedByUsername),
		},
		Doc:      doc,
		Settings: settings,
	})
}

// PostSettingsStateResponse is the response of GET /posts/:id/settings (#358).
type PostSettingsStateResponse struct {
	// Working is what the editor edits; Published what the site shows (null when
	// nothing is published).
	Working   PostSettings  `json:"working"`
	Published *PostSettings `json:"published"`
	// Changed: the post is published and its settings differ from the published
	// ones, so a settings change waits for Update.
	Changed bool `json:"changed"`
	// BlocksChanged: the post is published and its working body differs from the
	// published one (#326).
	BlocksChanged bool `json:"blocks_changed"`
	// HasUnpublishedChanges: the posts list's flag, a published post with either
	// of the two (#326). The editor re-reads it after every store of the body.
	HasUnpublishedChanges bool `json:"has_unpublished_changes"`
}

// getPostSettingsState handles GET /posts/:id/settings: the editor's "changes
// wait for Update" state, settings (#358) and body (#326). Any content role (like
// the editor itself).
func (server *Server) getPostSettingsState(c *gin.Context) {
	postID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid post ID"})
		return
	}
	row, err := server.store.GetPostSettingsState(c, postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post settings"})
		return
	}
	working, ok := decodePostSettingsJSON(row.Working)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read post settings"})
		return
	}
	published, _ := decodePostSettings(row.PublishedSettings)
	c.JSON(http.StatusOK, PostSettingsStateResponse{
		Working:               *working,
		Published:             published,
		Changed:               row.Changed,
		BlocksChanged:         row.BlocksChanged,
		HasUnpublishedChanges: row.HasUnpublishedChanges,
	})
}
