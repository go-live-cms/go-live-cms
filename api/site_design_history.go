package api

// Site design history (#492, docs/design/theme-builder.md 5.3): the releases, the global
// styles' versions, and restoring one (or Discard changes) into the styles draft by REST.
// Styles aren't a collab document, so this is an ordinary optimistic write on
// draft_revision, like PUT /site-design/global-styles. Templates and parts restore
// through the editor (site_templates_manage.go).

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

const (
	defaultReleasesPage = 20
	maxReleasesPage     = 100
)

// SiteDesignReleaseItem is one template or part a release published.
type SiteDesignReleaseItem struct {
	ID        int64  `json:"id"`
	Kind      string `json:"kind"`
	Slug      string `json:"slug"`
	Title     string `json:"title"`
	VersionNo int32  `json:"version_no"`
	Reset     bool   `json:"reset"`
}

// SiteDesignReleaseEntry is one row of History: "Nov 14, 10:02 · Ana · Header, Single
// post, Colours". Items are the templates and parts it versioned (rows deleted since
// are gone with their versions); global_styles_version is set when it published the styles.
type SiteDesignReleaseEntry struct {
	ID                  int64                   `json:"id"`
	ThemeSlug           string                  `json:"theme_slug"`
	PublishedAt         string                  `json:"published_at"`
	PublishedBy         *int64                  `json:"published_by"`
	PublishedByName     string                  `json:"published_by_name"`
	Summary             json.RawMessage         `json:"summary"`
	Items               []SiteDesignReleaseItem `json:"items"`
	GlobalStylesVersion *int32                  `json:"global_styles_version"`
}

// listSiteDesignReleases handles GET /site-design/releases?limit=&before= (admin): the
// active theme's releases, newest first, paged by id (next_before).
func (server *Server) listSiteDesignReleases(c *gin.Context) {
	limit := defaultReleasesPage
	if raw := c.Query("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > maxReleasesPage {
			c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be 1-100"})
			return
		}
		limit = n
	}
	var before sql.NullInt64
	if raw := c.Query("before"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid before"})
			return
		}
		before = sql.NullInt64{Int64: n, Valid: true}
	}
	theme, ok := server.siteDesignTheme(c)
	if !ok {
		return
	}
	releases, err := server.store.ListSiteDesignReleases(c, db.ListSiteDesignReleasesParams{ThemeSlug: theme.Slug, Before: before, LimitCount: int32(limit)})
	if err != nil {
		server.requestLog(c).Error("site_design_releases_failed", "theme", theme.Slug, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the site design history"})
		return
	}
	ids := make([]int64, 0, len(releases))
	for _, release := range releases {
		ids = append(ids, release.ID)
	}
	items := map[int64][]SiteDesignReleaseItem{}
	styles := map[int64]int32{}
	if len(ids) > 0 {
		versions, err := server.store.ListSiteTemplateVersionsByRelease(c, ids)
		if err != nil {
			server.requestLog(c).Error("site_design_releases_failed", "theme", theme.Slug, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the site design history"})
			return
		}
		for _, v := range versions {
			items[v.ReleaseID] = append(items[v.ReleaseID], SiteDesignReleaseItem{ID: v.TemplateID, Kind: v.Kind, Slug: v.Slug, Title: v.Title, VersionNo: v.VersionNo, Reset: v.Reset})
		}
		styleVersions, err := server.store.ListGlobalStyleVersionsByRelease(c, ids)
		if err != nil {
			server.requestLog(c).Error("site_design_releases_failed", "theme", theme.Slug, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get the site design history"})
			return
		}
		for _, v := range styleVersions {
			styles[v.ReleaseID] = v.VersionNo
		}
	}
	entries := make([]SiteDesignReleaseEntry, 0, len(releases))
	for _, release := range releases {
		entry := SiteDesignReleaseEntry{
			ID:              release.ID,
			ThemeSlug:       release.ThemeSlug,
			PublishedAt:     release.PublishedAt.Format(time.RFC3339),
			PublishedByName: release.PublishedByName,
			Summary:         emptyObjectIfBlank(release.Summary),
			Items:           items[release.ID],
		}
		if entry.Items == nil {
			entry.Items = []SiteDesignReleaseItem{}
		}
		if release.PublishedBy.Valid {
			id := release.PublishedBy.Int64
			entry.PublishedBy = &id
		}
		if no, ok := styles[release.ID]; ok {
			n := no
			entry.GlobalStylesVersion = &n
		}
		entries = append(entries, entry)
	}
	response := gin.H{"releases": entries, "next_before": nil}
	if len(releases) == limit {
		response["next_before"] = releases[len(releases)-1].ID
	}
	c.JSON(http.StatusOK, response)
}

// listGlobalStyleVersions handles GET /site-design/global-styles/versions (admin): the
// active theme's styles versions, newest first, the published one marked current.
func (server *Server) listGlobalStyleVersions(c *gin.Context) {
	state, ok := server.loadGlobalStylesState(c)
	if !ok {
		return
	}
	versions, err := server.store.ListGlobalStyleVersions(c, state.theme.Slug)
	if err != nil {
		server.requestLog(c).Error("global_style_versions_failed", "theme", state.theme.Slug, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get versions"})
		return
	}
	items := make([]gin.H, 0, len(versions))
	for _, v := range versions {
		item := gin.H{
			"version_no":        v.VersionNo,
			"release_id":        v.ReleaseID,
			"created_at":        v.CreatedAt.Format(time.RFC3339),
			"published_by":      nil,
			"published_by_name": v.PublishedByName,
			"current":           state.row.PublishedVersionID.Valid && state.row.PublishedVersionID.Int64 == v.ID,
		}
		if v.PublishedBy.Valid {
			item["published_by"] = v.PublishedBy.Int64
		}
		items = append(items, item)
	}
	c.JSON(http.StatusOK, gin.H{"versions": items})
}

func (server *Server) globalStyleVersionParam(c *gin.Context, theme string) (db.GlobalStyleVersion, bool) {
	no, err := strconv.ParseInt(c.Param("no"), 10, 32)
	if err != nil || no <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid version number"})
		return db.GlobalStyleVersion{}, false
	}
	version, err := server.store.GetGlobalStyleVersion(c, db.GetGlobalStyleVersionParams{ThemeSlug: theme, VersionNo: int32(no)})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "version not found"})
			return db.GlobalStyleVersion{}, false
		}
		server.requestLog(c).Error("global_style_version_failed", "theme", theme, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get version"})
		return db.GlobalStyleVersion{}, false
	}
	return version, true
}

// getGlobalStyleVersion handles GET /site-design/global-styles/versions/:no (admin).
func (server *Server) getGlobalStyleVersion(c *gin.Context) {
	state, ok := server.loadGlobalStylesState(c)
	if !ok {
		return
	}
	version, ok := server.globalStyleVersionParam(c, state.theme.Slug)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"version_no": version.VersionNo,
		"release_id": version.ReleaseID,
		"created_at": version.CreatedAt.Format(time.RFC3339),
		"styles":     emptyObjectIfBlank(version.Styles),
	})
}

// GlobalStylesDraftWriteRequest is restore and discard's body: the revision the screen
// shows, so a draft another admin saved since is never overwritten unseen (409
// styles_changed with it, as a stale save).
type GlobalStylesDraftWriteRequest struct {
	BaseRevision *int64 `json:"base_revision" binding:"required,min=0"`
}

// replaceGlobalStylesDraft writes styles (already canonical JSON) as the draft at
// base_revision, answering the request itself. ok is false when it answered an error;
// changed is false when the draft already was that (no new revision).
func (server *Server) replaceGlobalStylesDraft(c *gin.Context, state *globalStylesState, base int64, styles json.RawMessage) (changed, ok bool) {
	if base != state.row.DraftRevision {
		respondStylesChanged(c, state.response())
		return false, false
	}
	if reflect.DeepEqual(decodeStoredStyles(state.row.Draft), decodeStoredStyles(styles)) {
		return false, true
	}
	if err := server.store.EnsureGlobalStyles(c, state.theme.Slug); err != nil {
		server.requestLog(c).Error("global_styles_save_failed", "theme", state.theme.Slug, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save global styles"})
		return false, false
	}
	row, err := server.store.UpdateGlobalStylesDraft(c, db.UpdateGlobalStylesDraftParams{
		Draft:        styles,
		ChangedBy:    sql.NullInt64{Int64: getAuthPayload(c).UserID, Valid: true},
		ThemeSlug:    state.theme.Slug,
		BaseRevision: base,
	})
	if errors.Is(err, sql.ErrNoRows) {
		if current, ok := server.loadGlobalStylesState(c); ok {
			respondStylesChanged(c, current.response())
		}
		return false, false
	}
	if err != nil {
		server.requestLog(c).Error("global_styles_save_failed", "theme", state.theme.Slug, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save global styles"})
		return false, false
	}
	state.row = row
	return true, true
}

// restoreGlobalStyleVersion handles POST /site-design/global-styles/versions/:no/restore
// {base_revision} (admin, 5.3): the version's styles become the draft; they reach the
// site on the next publish. Validated against the theme as it is now: a version using a
// token the theme stopped declaring is 409 styles_invalid (nothing written). Activity
// global_styles_restored {version_no}.
func (server *Server) restoreGlobalStyleVersion(c *gin.Context) {
	var req GlobalStylesDraftWriteRequest
	if !bindJSON(c, &req) {
		return
	}
	state, ok := server.loadGlobalStylesState(c)
	if !ok {
		return
	}
	version, ok := server.globalStyleVersionParam(c, state.theme.Slug)
	if !ok {
		return
	}
	if !globalStylesSupported(state.tokens, state.known) {
		respondGlobalStylesUnsupported(c, state.theme)
		return
	}
	normalized, verr := ValidateGlobalStyles(emptyObjectIfBlank(version.Styles), state.tokens)
	if verr != nil {
		c.JSON(http.StatusConflict, gin.H{
			"error":  "this version no longer fits the theme: " + verr.Error(),
			"code":   "styles_invalid",
			"reason": verr.Code,
			"path":   verr.Path,
		})
		return
	}
	_, encoded, err := canonicalStyles(normalized)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to restore the version"})
		return
	}
	changed, ok := server.replaceGlobalStylesDraft(c, &state, *req.BaseRevision, encoded)
	if !ok {
		return
	}
	if changed {
		server.recordRequestActivity(c, activityEvent{
			Verb:       db.ActivityGlobalStylesRestored,
			ObjectType: db.ActivityObjectSiteDesign,
			ObjectID:   state.theme.ID,
			Payload:    map[string]any{"version_no": version.VersionNo},
		})
	}
	c.JSON(http.StatusOK, state.response())
}

// discardGlobalStyles handles POST /site-design/global-styles/discard {base_revision}
// (admin, 8.2's Discard changes): the published styles become the draft again, so the
// next publish leaves the styles out. Activity global_styles_discarded {groups}.
func (server *Server) discardGlobalStyles(c *gin.Context) {
	var req GlobalStylesDraftWriteRequest
	if !bindJSON(c, &req) {
		return
	}
	state, ok := server.loadGlobalStylesState(c)
	if !ok {
		return
	}
	groups := changedGlobalStyleGroups(decodeStoredStyles(state.row.Published), decodeStoredStyles(state.row.Draft))
	changed, ok := server.replaceGlobalStylesDraft(c, &state, *req.BaseRevision, emptyObjectIfBlank(state.row.Published))
	if !ok {
		return
	}
	if changed {
		server.recordRequestActivity(c, activityEvent{
			Verb:       db.ActivityGlobalStylesDiscarded,
			ObjectType: db.ActivityObjectSiteDesign,
			ObjectID:   state.theme.ID,
			Payload:    map[string]any{"groups": groups},
		})
	}
	c.JSON(http.StatusOK, state.response())
}
