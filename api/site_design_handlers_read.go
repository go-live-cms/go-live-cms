package api

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// globalStylesState is the active theme, what this build knows of its tokens, and its
// stored row (the zero row before its first save).
type globalStylesState struct {
	theme  db.Theme
	tokens ThemeTokens
	known  bool
	row    db.GlobalStyle
}

func (s globalStylesState) response() GlobalStylesResponse {
	return toGlobalStylesResponse(s.theme, s.tokens, s.known, s.row)
}

// loadGlobalStylesState reads the active theme's styles, answering the request itself
// (404 without an active theme, 500 on a database error) when ok is false.
func (server *Server) loadGlobalStylesState(c *gin.Context) (globalStylesState, bool) {
	theme, err := server.store.GetActiveTheme(c)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "no active theme found"})
			return globalStylesState{}, false
		}
		server.requestLog(c).Error("global_styles_read_failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get active theme"})
		return globalStylesState{}, false
	}
	state := globalStylesState{theme: theme}
	state.tokens, state.known = server.themeTokens.Themes[theme.Slug]
	row, err := server.store.GetGlobalStyles(c, theme.Slug)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		state.row = db.GlobalStyle{ThemeSlug: theme.Slug}
	case err != nil:
		server.requestLog(c).Error("global_styles_read_failed", "theme", theme.Slug, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get global styles"})
		return globalStylesState{}, false
	default:
		state.row = row
	}
	return state, true
}

// getGlobalStyles handles GET /site-design/global-styles (admin): the active theme's
// declared tokens, draft, published override and the draft's failing contrast pairs.
func (server *Server) getGlobalStyles(c *gin.Context) {
	state, ok := server.loadGlobalStylesState(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, state.response())
}
