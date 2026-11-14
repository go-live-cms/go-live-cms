package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

func respondGlobalStylesUnsupported(c *gin.Context, theme db.Theme) {
	c.JSON(http.StatusConflict, gin.H{
		"error": "the active theme doesn't support global styles",
		"code":  "global_styles_unsupported",
		"theme": theme.Slug,
	})
}

func respondStylesChanged(c *gin.Context, current GlobalStylesResponse) {
	c.JSON(http.StatusConflict, gin.H{
		"error":   "another admin changed the styles; this is their draft",
		"code":    "styles_changed",
		"current": current,
	})
}

// saveGlobalStyles handles PUT /site-design/global-styles (admin, design 6.5): validate
// the whole draft against the active theme's declared tokens (400 unknown_token,
// invalid_value or token_order, naming the path), then store it if base_revision is
// still the current one (else 409 styles_changed with the current draft). Contrast is
// computed and returned, never refused. Nothing public changes: the draft reaches the
// site on publish.
func (server *Server) saveGlobalStyles(c *gin.Context) {
	var req SaveGlobalStylesRequest
	if !bindJSON(c, &req) {
		return
	}
	if len(req.Styles) > maxGlobalStylesBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "styles is too large", "code": globalStyleInvalidValue, "path": ""})
		return
	}
	state, ok := server.loadGlobalStylesState(c)
	if !ok {
		return
	}
	if !globalStylesSupported(state.tokens, state.known) {
		respondGlobalStylesUnsupported(c, state.theme)
		return
	}
	normalized, verr := ValidateGlobalStyles(req.Styles, state.tokens)
	if verr != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": verr.Error(), "code": verr.Code, "path": verr.Path})
		return
	}
	draft, encoded, err := canonicalStyles(normalized)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save global styles"})
		return
	}

	if *req.BaseRevision != state.row.DraftRevision {
		respondStylesChanged(c, state.response())
		return
	}
	previous := decodeStoredStyles(state.row.Draft)
	if reflect.DeepEqual(previous, draft) {
		// The debounced form saving what it already saved: no new revision, no activity.
		c.JSON(http.StatusOK, state.response())
		return
	}

	if err := server.store.EnsureGlobalStyles(c, state.theme.Slug); err != nil {
		server.requestLog(c).Error("global_styles_save_failed", "theme", state.theme.Slug, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save global styles"})
		return
	}
	row, err := server.store.UpdateGlobalStylesDraft(c, db.UpdateGlobalStylesDraftParams{
		Draft:        encoded,
		ChangedBy:    sql.NullInt64{Int64: getAuthPayload(c).UserID, Valid: true},
		ThemeSlug:    state.theme.Slug,
		BaseRevision: *req.BaseRevision,
	})
	if errors.Is(err, sql.ErrNoRows) {
		// Saved by someone else between the read and the update.
		if current, ok := server.loadGlobalStylesState(c); ok {
			respondStylesChanged(c, current.response())
		}
		return
	}
	if err != nil {
		server.requestLog(c).Error("global_styles_save_failed", "theme", state.theme.Slug, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save global styles"})
		return
	}
	state.row = row

	server.recordRequestActivity(c, activityEvent{
		Verb:       db.ActivityGlobalStylesUpdated,
		ObjectType: db.ActivityObjectSiteDesign,
		ObjectID:   state.theme.ID,
		Payload:    map[string]any{"groups": changedGlobalStyleGroups(previous, draft)},
		Throttled:  true,
	})
	c.JSON(http.StatusOK, state.response())
}

// publishSiteDesign handles POST /site-design/publish (admin, design 8.2). For now it
// publishes the active theme's global styles; #492 adds templates and parts to the same
// release, as more steps of the same three phases:
//
//  1. outside any transaction: re-validate the draft (409 styles_invalid if the theme
//     stopped declaring a token it uses) and compute contrast (409 contrast_unconfirmed,
//     naming the pairs, unless confirm_contrast: it asks, never refuses);
//  2. PublishGlobalStylesTx: the release, the version and the published copy;
//  3. after commit: the public cache purge (purgePublicCacheAfterWrite, this route is in
//     publicCachePurgeRoutes) and the site_design_published activity.
//
// Nothing to publish is 409 nothing_to_publish, so nothing is purged.
func (server *Server) publishSiteDesign(c *gin.Context) {
	var req PublishSiteDesignRequest
	if !bindOptionalJSON(c, &req) {
		return
	}
	state, ok := server.loadGlobalStylesState(c)
	if !ok {
		return
	}
	draft := decodeStoredStyles(state.row.Draft)
	published := decodeStoredStyles(state.row.Published)
	if reflect.DeepEqual(draft, published) {
		c.JSON(http.StatusConflict, gin.H{"error": "the site design has no unpublished changes", "code": "nothing_to_publish"})
		return
	}
	if !globalStylesSupported(state.tokens, state.known) {
		respondGlobalStylesUnsupported(c, state.theme)
		return
	}
	if _, verr := ValidateGlobalStyles(emptyObjectIfBlank(state.row.Draft), state.tokens); verr != nil {
		c.JSON(http.StatusConflict, gin.H{
			"error":  "the styles draft no longer fits the theme: " + verr.Error(),
			"code":   "styles_invalid",
			"reason": verr.Code,
			"path":   verr.Path,
		})
		return
	}
	failures := globalStyleContrast(state.tokens, draft)
	if len(failures) > 0 && !req.ConfirmContrast {
		c.JSON(http.StatusConflict, gin.H{
			"error": "some colour pairs fail contrast; publish again with confirm_contrast to publish anyway",
			"code":  "contrast_unconfirmed",
			"pairs": failures,
		})
		return
	}

	groups := changedGlobalStyleGroups(published, draft)
	summary, err := json.Marshal(map[string]any{
		"global_styles": map[string]any{"groups": groups, "contrast_failures": len(failures)},
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to publish the site design"})
		return
	}
	userID := getAuthPayload(c).UserID
	result, err := server.store.PublishGlobalStylesTx(c, db.PublishGlobalStylesTxParams{
		ThemeSlug:     state.theme.Slug,
		DraftRevision: state.row.DraftRevision,
		PublishedBy:   sql.NullInt64{Int64: userID, Valid: true},
		Summary:       summary,
	})
	if errors.Is(err, db.ErrGlobalStylesChanged) {
		if current, ok := server.loadGlobalStylesState(c); ok {
			respondStylesChanged(c, current.response())
		}
		return
	}
	if err != nil {
		server.requestLog(c).Error("site_design_publish_failed", "theme", state.theme.Slug, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to publish the site design"})
		return
	}
	state.row = result.Styles

	server.recordRequestActivity(c, activityEvent{
		Verb:       db.ActivitySiteDesignPublished,
		ObjectType: db.ActivityObjectSiteDesign,
		ObjectID:   result.Release.ID,
		Payload: map[string]any{
			"theme_slug":           state.theme.Slug,
			"global_styles_groups": groups,
			"contrast_failures":    len(failures),
		},
	})
	c.JSON(http.StatusOK, SiteDesignPublishResponse{
		Release: SiteDesignReleaseResponse{
			ID:          result.Release.ID,
			ThemeSlug:   result.Release.ThemeSlug,
			PublishedAt: result.Release.PublishedAt.Format(time.RFC3339),
		},
		GlobalStyles: GlobalStylesPublished{VersionNo: result.Version.VersionNo, Groups: groups, ContrastFailures: len(failures)},
		Styles:       state.response(),
	})
}
