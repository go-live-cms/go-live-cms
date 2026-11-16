package api

import (
	"database/sql"
	"errors"
	"net/http"
	"reflect"

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
	tokens := state.tokens
	if !globalStylesSupported(state.tokens, state.known) {
		// A theme that lost support (or left the build) can still have its draft
		// cleared: against no declared tokens only {} validates.
		if _, verr := ValidateGlobalStyles(req.Styles, ThemeTokens{}); verr != nil {
			respondGlobalStylesUnsupported(c, state.theme)
			return
		}
		tokens = ThemeTokens{}
	}
	normalized, verr := ValidateGlobalStyles(req.Styles, tokens)
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
