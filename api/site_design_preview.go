package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

// Design preview (#486, docs/design/theme-builder.md 8.3, 11 and 12). /public never serves
// a draft. An admin asks POST /site-design/preview for a short-lived preview token; the
// Astro server keeps it in an HttpOnly cookie (POST /gl-preview) and, on each page it
// renders while the cookie is there, reads the draft from GET /site-design/draft with the
// token as bearer. The token is never in a URL, and nothing here logs it.

// designPreviewTTL is how long a preview token, and the cookie that holds it, lasts.
const designPreviewTTL = 15 * time.Minute

// designPreviewCacheControl is on every answer of both routes: a token or a draft is
// never stored by a browser or a cache in between.
const designPreviewCacheControl = "private, no-store"

// designPreviewMaker is the slice of the PASETO v4 maker the preview routes use. Preview
// tokens are v4-only, so it isn't part of token.Maker.
type designPreviewMaker interface {
	CreateDesignPreviewToken(userID int64, theme string, dur time.Duration) (string, *token.DesignPreviewPayload, error)
	VerifyDesignPreviewToken(tok string) (*token.DesignPreviewPayload, error)
}

// DesignPreviewResponse is a new preview token: the theme it previews and when it ends.
type DesignPreviewResponse struct {
	Token     string    `json:"token"`
	Theme     string    `json:"theme"`
	ExpiresAt time.Time `json:"expires_at"`
}

// DesignDraftResponse is the unpublished design a preview renders. One key per kind of
// design item: global styles today; #492 adds the templates and parts (asked for by
// `?slugs=`, design 8.3) beside them, so a reader of this response ignores keys it
// doesn't know. Posts and pages are never in it: a preview shows the published ones.
type DesignDraftResponse struct {
	// Theme is the theme the draft belongs to: the active one (the token's).
	Theme string `json:"theme"`
	// GlobalStyles is the styles draft, `{}` when the theme has none: the override the
	// theme's base layout merges into its tokens instead of the published one.
	GlobalStyles json.RawMessage `json:"global_styles"`
	// ExpiresAt is the token's expiry, after which the preview shows the published site.
	ExpiresAt time.Time `json:"expires_at"`
	// Template, Parts and Menus answer `?slugs=` (#493, design 8.3) as the public resolve
	// does, from the **working copies**: a customized template or part renders as it is being
	// edited, a reset one as the theme's default (what the next publish puts live). Absent
	// without `slugs`.
	Template *ResolvedSiteTemplate         `json:"template,omitempty"`
	Parts    map[string]ResolvedSitePart   `json:"parts,omitempty"`
	Menus    map[string]PublicMenuResponse `json:"menus,omitempty"`
}

// createDesignPreview handles POST /site-design/preview (admin): a preview token for the
// caller and the active theme, valid designPreviewTTL.
//
// Returns:
//   - 200 OK: DesignPreviewResponse
//   - 401/403: see authMiddleware and requireSiteAdmin
//   - 404 Not Found: no active theme
func (server *Server) createDesignPreview(c *gin.Context) {
	c.Header("Cache-Control", designPreviewCacheControl)
	theme, err := server.store.GetActiveTheme(c)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "no active theme found"})
			return
		}
		server.requestLog(c).Error("design_preview_theme_read_failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get active theme"})
		return
	}
	user, ok := server.callerUser(c)
	if !ok {
		return
	}
	tok, payload, err := server.designPreviews.CreateDesignPreviewToken(user.ID, theme.Slug, designPreviewTTL)
	if err != nil {
		server.requestLog(c).Error("design_preview_token_failed", "user_id", user.ID)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create preview token"})
		return
	}
	c.JSON(http.StatusOK, DesignPreviewResponse{Token: tok, Theme: payload.Theme, ExpiresAt: payload.ExpiredAt})
}

// getDesignDraft handles GET /site-design/draft, the one /site-design route that isn't
// requireSiteAdmin (design 12): its bearer is a design preview token, not an access
// token, so it verifies the token's signature, audience and expiry itself, then makes
// requireSiteAdmin's check by another path: the token's user must still exist, still be
// an admin and not have changed their password since. A demoted admin's token stops
// working at the next read.
//
// Returns:
//   - 200 OK: DesignDraftResponse
//   - 401 Unauthorized: no bearer, not a preview token, expired (`code:
//     preview_expired`), or issued before the user's latest password change
//   - 403 Forbidden: the token's user is gone or no longer an admin
//   - 404 Not Found: no active theme
//   - 409 Conflict: `code: preview_theme_inactive`, another theme was activated since
func (server *Server) getDesignDraft(c *gin.Context) {
	c.Header("Cache-Control", designPreviewCacheControl)
	payload, ok := server.designPreviewPayload(c)
	if !ok {
		return
	}

	user, err := server.store.GetUser(c, payload.UserID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
			return
		}
		server.requestLog(c).Error("design_preview_user_read_failed", "user_id", payload.UserID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify user"})
		return
	}
	if issuedBeforePasswordChange(payload.IssuedAt, user.PasswordChangedAt) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "token was issued before the latest password change"})
		return
	}
	if !isSiteAdmin(user) {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}

	state, ok := server.loadGlobalStylesState(c)
	if !ok {
		return
	}
	if state.theme.Slug != payload.Theme {
		c.JSON(http.StatusConflict, gin.H{"code": "preview_theme_inactive", "error": "the previewed theme is no longer active"})
		return
	}
	resp := DesignDraftResponse{
		Theme:        state.theme.Slug,
		GlobalStyles: emptyObjectIfBlank(state.row.Draft),
		ExpiresAt:    payload.ExpiredAt,
	}
	if raw := c.Query("slugs"); raw != "" {
		slugs, ok := parseResolveSlugs(raw)
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"code": "invalid_slugs", "error": "slugs must be 1 to 8 distinct template slugs"})
			return
		}
		rows, err := server.store.ListSiteTemplatesByTheme(c, state.theme.Slug)
		if err != nil {
			server.requestLog(c).Error("design_preview_templates_failed", "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read the templates"})
			return
		}
		design := server.resolveSiteDesign(c, state.theme, workingSiteDesignOverrides(rows), slugs)
		resp.Template, resp.Parts, resp.Menus = design.Template, design.Parts, design.Menus
	}
	c.JSON(http.StatusOK, resp)
}

// workingSiteDesignOverrides are the rows a preview renders in place of the theme's own: each
// customized row's working copy. A reset row is left out, so the theme's default renders, as
// it will after the next publish (design 9).
func workingSiteDesignOverrides(rows []db.SiteTemplate) []siteDesignOverride {
	overrides := make([]siteDesignOverride, 0, len(rows))
	for _, row := range rows {
		if row.WorkingState != siteTemplateCustom {
			continue
		}
		overrides = append(overrides, siteDesignOverride{Kind: row.Kind, Slug: row.Slug, Title: row.Title, Doc: row.BlockDoc})
	}
	return overrides
}

// designPreviewPayload reads and verifies the request's bearer as a design preview
// token, answering 401 itself when ok is false. Errors never echo the token.
func (server *Server) designPreviewPayload(c *gin.Context) (*token.DesignPreviewPayload, bool) {
	fields := strings.Fields(c.GetHeader(authorizationHeaderKey))
	if len(fields) != 2 || !strings.EqualFold(fields[0], authorizationTypeBearer) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "a design preview token is required"})
		return nil, false
	}
	payload, err := server.designPreviews.VerifyDesignPreviewToken(fields[1])
	if err != nil {
		if errors.Is(err, token.ErrExpiredToken) {
			c.JSON(http.StatusUnauthorized, gin.H{"code": "preview_expired", "error": "the preview has expired"})
			return nil, false
		}
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid design preview token"})
		return nil, false
	}
	return payload, true
}
