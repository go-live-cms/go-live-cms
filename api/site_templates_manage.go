package api

// Templates and parts after creation (#492, docs/design/theme-builder.md 5.3, 8.1, 9):
// what the Site editor reads, Reset to theme default / Keep editing / Delete, Start over
// from the theme default, and the version history with its restore.
//
// None of these writes block_doc (rule 11). Restoring a version, Discard changes (restore
// the published version) and Start over replace the working copy through the editor
// (restoreVersionLive, rule 9): these routes hand the editor the doc, and record what it
// did afterwards (working_state, source, activity).

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/sqlc-dev/pqtype"

	"github.com/go-live-cms/go-live-cms/api/sitedesign"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// SiteTemplateDetailResponse is a row with its published side and what a publish would
// do to it (8.1): for the Site editor's overview, the publish dialog and Discard changes.
type SiteTemplateDetailResponse struct {
	SiteTemplateResponse
	// Change: "publish" (the working copy goes live), "reset" (the theme default comes
	// back) or "" (nothing to publish).
	Change                string          `json:"change"`
	HasUnpublishedChanges bool            `json:"has_unpublished_changes"`
	PublishedBlockDoc     json.RawMessage `json:"published_block_doc"`
	PublishedVersionNo    *int32          `json:"published_version_no"`
	// DefaultChanged: the theme's default (or the starter) this row started from has
	// changed since (section 9's "Default changed since you customized").
	DefaultChanged bool `json:"default_changed"`
	// CanDelete: nothing of it is published (section 9's Delete).
	CanDelete bool `json:"can_delete"`
}

// siteTemplateDefault is the doc "Start over" puts back (section 9): the theme's shipped
// default for the row's slug, else core's starter. from narrows it ("theme" or "starter",
// "" = either). The doc is as shipped; callers that hand it out copy it with fresh ids.
func (server *Server) siteTemplateDefault(theme db.Theme, row db.SiteTemplate, from string) (doc json.RawMessage, hash, source string, ok bool) {
	if from != siteTemplateFromStarter {
		if shipped, ok := themeBlockTemplateFromConfig(theme.Config, row.Kind, row.Slug); ok {
			return shipped.Doc, shipped.Hash, siteTemplateFromTheme, true
		}
		if from == siteTemplateFromTheme {
			return nil, "", "", false
		}
	}
	starter, found := sitedesign.Starter(row.Kind, row.Slug)
	if !found {
		return nil, "", "", false
	}
	normalized, err := server.normalizeSiteTemplateDoc(starter.Doc, row.Kind)
	if err != nil {
		return nil, "", "", false
	}
	return starter.Doc, sitedesign.Hash(normalized), siteTemplateFromStarter, true
}

func (server *Server) siteTemplateDetail(c *gin.Context, theme *db.Theme, row db.SiteTemplate) SiteTemplateDetailResponse {
	change := siteTemplateChange(row)
	detail := SiteTemplateDetailResponse{
		SiteTemplateResponse:  toSiteTemplateResponse(row),
		Change:                change,
		HasUnpublishedChanges: change != "",
		CanDelete:             !row.PublishedBlockDoc.Valid,
		PublishedBlockDoc:     json.RawMessage(`null`),
	}
	if row.PublishedBlockDoc.Valid {
		detail.PublishedBlockDoc = row.PublishedBlockDoc.RawMessage
	}
	if row.PublishedVersionID.Valid {
		if version, err := server.store.GetSiteTemplateVersionByID(c, row.PublishedVersionID.Int64); err == nil {
			no := version.VersionNo
			detail.PublishedVersionNo = &no
		}
	}
	if theme != nil && theme.Slug == row.ThemeSlug && row.Source != siteTemplateFromBlank {
		if _, hash, _, ok := server.siteTemplateDefault(*theme, row, row.Source); ok && hash != row.SourceHash {
			detail.DefaultChanged = true
		}
	}
	return detail
}

// siteTemplateParam reads :id and its row, answering 400/404/500 itself.
func (server *Server) siteTemplateParam(c *gin.Context) (db.SiteTemplate, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid template ID"})
		return db.SiteTemplate{}, false
	}
	row, err := server.store.GetSiteTemplate(c, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
			return db.SiteTemplate{}, false
		}
		server.requestLog(c).Error("site_template_read_failed", "template_id", id, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get template"})
		return db.SiteTemplate{}, false
	}
	return row, true
}

// activeThemeOrNil is the active theme for the "default changed" check; a failure
// leaves the check out rather than failing a read.
func (server *Server) activeThemeOrNil(c *gin.Context) *db.Theme {
	theme, err := server.store.GetActiveTheme(c)
	if err != nil {
		return nil
	}
	return &theme
}

// listSiteTemplates handles GET /site-design/templates (admin): the active theme's
// templates and parts with what a publish would do to each, and the count the Publish
// button shows (8.1), styles included.
func (server *Server) listSiteTemplates(c *gin.Context) {
	theme, ok := server.siteDesignTheme(c)
	if !ok {
		return
	}
	rows, ok := server.listSiteDesignRows(c, theme.Slug)
	if !ok {
		return
	}
	state, ok := server.loadGlobalStylesState(c)
	if !ok {
		return
	}
	items := make([]SiteTemplateDetailResponse, 0, len(rows))
	changes := 0
	for _, row := range rows {
		detail := server.siteTemplateDetail(c, &theme, row)
		if detail.HasUnpublishedChanges {
			changes++
		}
		items = append(items, detail)
	}
	styles := state.response()
	if styles.HasUnpublishedChanges {
		changes++
	}
	c.JSON(http.StatusOK, gin.H{
		"theme":                 gin.H{"id": theme.ID, "slug": theme.Slug, "name": theme.Name},
		"templates":             items,
		"global_styles_changed": styles.HasUnpublishedChanges,
		"global_styles_groups":  changedGlobalStyleGroups(decodeStoredStyles(state.row.Published), decodeStoredStyles(state.row.Draft)),
		"unpublished_changes":   changes,
	})
}

// getSiteTemplate handles GET /site-design/templates/:id (admin): one row, any theme's.
func (server *Server) getSiteTemplate(c *gin.Context) {
	row, ok := server.siteTemplateParam(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, server.siteTemplateDetail(c, server.activeThemeOrNil(c), row))
}

// setSiteTemplateWorkingState is Reset to theme default (state reset) and Keep editing
// (state custom), section 9: it sets working_state only, never block_doc (rule 11). The
// editor turns read-only on reset; the next publish makes the published copy NULL. Doing
// it twice is a 200 with no event.
func (server *Server) setSiteTemplateWorkingState(c *gin.Context, state, verb string) {
	row, ok := server.siteTemplateParam(c)
	if !ok {
		return
	}
	if row.WorkingState != state {
		updated, err := server.store.SetSiteTemplateWorkingState(c, db.SetSiteTemplateWorkingStateParams{WorkingState: state, ID: row.ID})
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
				return
			}
			server.requestLog(c).Error("site_template_state_failed", "template_id", row.ID, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update template"})
			return
		}
		row = updated
		server.recordRequestActivity(c, activityEvent{
			Verb:       verb,
			ObjectType: db.ActivityObjectSiteDesign,
			ObjectID:   row.ID,
			Payload:    map[string]any{"kind": row.Kind, "slug": row.Slug},
		})
	}
	c.JSON(http.StatusOK, server.siteTemplateDetail(c, server.activeThemeOrNil(c), row))
}

// resetSiteTemplate handles POST /site-design/templates/:id/reset (admin).
func (server *Server) resetSiteTemplate(c *gin.Context) {
	server.setSiteTemplateWorkingState(c, siteTemplateReset, db.ActivitySiteTemplateReset)
}

// keepEditingSiteTemplate handles POST /site-design/templates/:id/keep-editing (admin):
// undoes a reset that hasn't been published, or after one was, makes the working copy
// what the next publish puts live again.
func (server *Server) keepEditingSiteTemplate(c *gin.Context) {
	server.setSiteTemplateWorkingState(c, siteTemplateCustom, db.ActivitySiteTemplateResetCancelled)
}

// deleteSiteTemplate handles DELETE /site-design/templates/:id (admin, section 9): only a
// row with no published override (never published, or its reset was published), which
// is the only way history goes. 409 template_published otherwise. Open editors of it are
// closed by the collab re-check (the access lookup answers 404 for a deleted row).
func (server *Server) deleteSiteTemplate(c *gin.Context) {
	row, ok := server.siteTemplateParam(c)
	if !ok {
		return
	}
	deleted, err := server.store.DeleteUnpublishedSiteTemplate(c, row.ID)
	if err != nil {
		server.requestLog(c).Error("site_template_delete_failed", "template_id", row.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete template"})
		return
	}
	if deleted == 0 {
		if _, err := server.store.GetSiteTemplate(c, row.ID); errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
			return
		}
		c.JSON(http.StatusConflict, gin.H{
			"error": "this " + row.Kind + " is published; reset it to the theme default and publish before deleting it",
			"code":  "template_published",
		})
		return
	}
	server.recordRequestActivity(c, activityEvent{
		Verb:       db.ActivitySiteTemplateDeleted,
		ObjectType: db.ActivityObjectSiteDesign,
		ObjectID:   row.ID,
		Payload:    map[string]any{"kind": row.Kind, "slug": row.Slug},
	})
	server.recheckCollabTemplate(requestIDFromContext(c), row.ID)
	c.JSON(http.StatusOK, gin.H{"deleted": true, "id": row.ID})
}

// StartOverSiteTemplateRequest is GET /site-design/templates/:id/default's `?from=` and
// POST .../start-over's body: which default ("theme", "starter"; empty = the theme's,
// else the starter).
type StartOverSiteTemplateRequest struct {
	From string `json:"from" binding:"omitempty,oneof=theme starter"`
}

// getSiteTemplateDefault handles GET /site-design/templates/:id/default?from= (admin): the
// doc "Start over from the theme default" puts into the editor (section 9), copied with
// fresh block ids, with its source and hash. 404 no_default when neither exists (a row
// of another theme has none: the active theme's config is what ships it).
func (server *Server) getSiteTemplateDefault(c *gin.Context) {
	from := c.Query("from")
	if from != "" && from != siteTemplateFromTheme && from != siteTemplateFromStarter {
		c.JSON(http.StatusBadRequest, gin.H{"error": "from must be theme or starter"})
		return
	}
	row, ok := server.siteTemplateParam(c)
	if !ok {
		return
	}
	theme, ok := server.siteDesignTheme(c)
	if !ok {
		return
	}
	if theme.Slug != row.ThemeSlug {
		c.JSON(http.StatusNotFound, gin.H{"error": "this " + row.Kind + " belongs to another theme", "code": "no_default"})
		return
	}
	doc, hash, source, found := server.siteTemplateDefault(theme, row, from)
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "there is no theme default or starter for this " + row.Kind, "code": "no_default"})
		return
	}
	copied, err := server.copySiteTemplateDoc(doc, row.Kind)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "code": "template_invalid"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"source": source, "source_hash": hash, "block_doc": copied})
}

// startOverSiteTemplate handles POST /site-design/templates/:id/start-over {from?}
// (admin), after the editor put the default into the working copy (rule 9): the row now
// starts from it (source, source_hash, so "Default changed" clears) and is custom again.
// The hash is the server's, never the client's.
func (server *Server) startOverSiteTemplate(c *gin.Context) {
	var req StartOverSiteTemplateRequest
	if !bindOptionalJSON(c, &req) {
		return
	}
	row, ok := server.siteTemplateParam(c)
	if !ok {
		return
	}
	theme, ok := server.siteDesignTheme(c)
	if !ok {
		return
	}
	if theme.Slug != row.ThemeSlug {
		c.JSON(http.StatusNotFound, gin.H{"error": "this " + row.Kind + " belongs to another theme", "code": "no_default"})
		return
	}
	_, hash, source, found := server.siteTemplateDefault(theme, row, req.From)
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "there is no theme default or starter for this " + row.Kind, "code": "no_default"})
		return
	}
	updated, err := server.store.SetSiteTemplateSource(c, db.SetSiteTemplateSourceParams{Source: source, SourceHash: hash, ID: row.ID})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
			return
		}
		server.requestLog(c).Error("site_template_start_over_failed", "template_id", row.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update template"})
		return
	}
	server.recordRequestActivity(c, activityEvent{
		Verb:       db.ActivitySiteTemplateStartedOver,
		ObjectType: db.ActivityObjectSiteDesign,
		ObjectID:   updated.ID,
		Payload:    map[string]any{"kind": updated.Kind, "slug": updated.Slug, "source": source},
	})
	c.JSON(http.StatusOK, server.siteTemplateDetail(c, &theme, updated))
}

// SiteTemplateVersionResponse is one row of an item's history.
type SiteTemplateVersionResponse struct {
	VersionNo       int32  `json:"version_no"`
	ReleaseID       int64  `json:"release_id"`
	Reset           bool   `json:"reset"`
	CreatedAt       string `json:"created_at"`
	PublishedBy     *int64 `json:"published_by"`
	PublishedByName string `json:"published_by_name"`
	Current         bool   `json:"current"`
}

// listSiteTemplateVersions handles GET /site-design/templates/:id/versions (admin):
// newest first, the published one marked current.
func (server *Server) listSiteTemplateVersions(c *gin.Context) {
	row, ok := server.siteTemplateParam(c)
	if !ok {
		return
	}
	versions, err := server.store.ListSiteTemplateVersions(c, row.ID)
	if err != nil {
		server.requestLog(c).Error("site_template_versions_failed", "template_id", row.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get versions"})
		return
	}
	items := make([]SiteTemplateVersionResponse, 0, len(versions))
	for _, version := range versions {
		item := SiteTemplateVersionResponse{
			VersionNo:       version.VersionNo,
			ReleaseID:       version.ReleaseID,
			Reset:           version.Reset,
			CreatedAt:       version.CreatedAt.Format(time.RFC3339),
			PublishedByName: version.PublishedByName,
			Current:         row.PublishedVersionID.Valid && row.PublishedVersionID.Int64 == version.ID,
		}
		if version.PublishedBy.Valid {
			id := version.PublishedBy.Int64
			item.PublishedBy = &id
		}
		items = append(items, item)
	}
	c.JSON(http.StatusOK, gin.H{"versions": items})
}

// siteTemplateVersionParam reads :no and the row's version, answering itself.
func (server *Server) siteTemplateVersionParam(c *gin.Context, row db.SiteTemplate) (db.SiteTemplateVersion, bool) {
	no, err := strconv.ParseInt(c.Param("no"), 10, 32)
	if err != nil || no <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid version number"})
		return db.SiteTemplateVersion{}, false
	}
	version, err := server.store.GetSiteTemplateVersion(c, db.GetSiteTemplateVersionParams{TemplateID: row.ID, VersionNo: int32(no)})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "version not found"})
			return db.SiteTemplateVersion{}, false
		}
		server.requestLog(c).Error("site_template_version_failed", "template_id", row.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get version"})
		return db.SiteTemplateVersion{}, false
	}
	return version, true
}

func versionBlockDoc(doc pqtype.NullRawMessage) json.RawMessage {
	if !doc.Valid {
		return json.RawMessage(`null`)
	}
	if parsed, err := parseStoredBlockDoc(doc.RawMessage); err == nil {
		if encoded, err := json.Marshal(parsed); err == nil {
			return encoded
		}
	}
	return doc.RawMessage
}

// getSiteTemplateVersion handles GET /site-design/templates/:id/versions/:no (admin): the
// version's doc (null for a reset), for History's preview and for the editor's restore.
func (server *Server) getSiteTemplateVersion(c *gin.Context) {
	row, ok := server.siteTemplateParam(c)
	if !ok {
		return
	}
	version, ok := server.siteTemplateVersionParam(c, row)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"version_no": version.VersionNo,
		"release_id": version.ReleaseID,
		"reset":      !version.BlockDoc.Valid,
		"created_at": version.CreatedAt.Format(time.RFC3339),
		"block_doc":  versionBlockDoc(version.BlockDoc),
	})
}

// restoredSiteTemplateVersion handles POST /site-design/templates/:id/versions/:no/restore
// (admin): called **after** the editor put the version into the working copy
// (restoreVersionLive, rule 9; also Discard changes, which restores the published
// version). It writes no doc: a reset row becomes custom again, so the restored working
// copy is what the next publish puts live (a reset publishes NULL, a restore brings it
// back), and site_template_restored is recorded. A reset version has no doc to restore:
// 409 version_is_reset (Reset to theme default does that).
func (server *Server) restoredSiteTemplateVersion(c *gin.Context) {
	row, ok := server.siteTemplateParam(c)
	if !ok {
		return
	}
	version, ok := server.siteTemplateVersionParam(c, row)
	if !ok {
		return
	}
	if !version.BlockDoc.Valid {
		c.JSON(http.StatusConflict, gin.H{"error": "this version reset the " + row.Kind + " to the theme default; use Reset to theme default", "code": "version_is_reset"})
		return
	}
	if row.WorkingState != siteTemplateCustom {
		updated, err := server.store.SetSiteTemplateWorkingState(c, db.SetSiteTemplateWorkingStateParams{WorkingState: siteTemplateCustom, ID: row.ID})
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				c.JSON(http.StatusNotFound, gin.H{"error": "template not found"})
				return
			}
			server.requestLog(c).Error("site_template_restore_failed", "template_id", row.ID, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to restore the version"})
			return
		}
		row = updated
	}
	server.recordRequestActivity(c, activityEvent{
		Verb:       db.ActivitySiteTemplateRestored,
		ObjectType: db.ActivityObjectSiteDesign,
		ObjectID:   row.ID,
		Payload:    map[string]any{"version_no": version.VersionNo},
	})
	c.JSON(http.StatusOK, server.siteTemplateDetail(c, server.activeThemeOrNil(c), row))
}
