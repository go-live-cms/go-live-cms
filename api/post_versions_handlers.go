// Package api — Post versions (revisions) and unpublish handlers (#136)
//
// Revisions are the Block Spec v1 snapshots publishPost stores in post_versions,
// not Yjs snapshots, so they don't depend on the collaboration server's storage.
//
// There is deliberately no "restore" endpoint. Restoring loads a version into the
// working copy, and while collaborators are connected the live Yjs doc owns the
// working copy: overwriting posts.block_doc behind its back would be reverted (or
// fought) by the next autosave. The editor fetches the version here and applies it
// through the editor/Yjs path, then saves with the normal PUT /posts/:id/blocks.
package api

import (
	"database/sql"
	"encoding/json"
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

	post, err := server.store.GetPost(c, postID)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "post not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get post"})
		return
	}

	rows, err := server.store.GetPostVersions(c, postID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list versions"})
		return
	}

	versions := make([]PostVersionSummary, len(rows))
	for i, row := range rows {
		versions[i] = PostVersionSummary{
			ID:                row.ID,
			VersionNo:         row.VersionNo,
			Status:            row.Status,
			Label:             nullStringPtr(row.Label),
			Message:           nullStringPtr(row.Message),
			CreatedAt:         row.CreatedAt,
			CreatedBy:         nullInt64Ptr(row.CreatedBy),
			CreatedByUsername: nullStringPtr(row.CreatedByUsername),
			IsPublished:       post.PublishedVersionID.Valid && post.PublishedVersionID.Int64 == row.ID,
		}
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

	var doc BlockDocV1
	if err := json.Unmarshal(row.BlockDoc, &doc); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to parse version document"})
		return
	}

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
		Doc: doc,
	})
}

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

	c.JSON(http.StatusOK, gin.H{"post": toPostResponse(post)})
}
