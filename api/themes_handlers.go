package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// listThemes handles GET /themes - list all themes
func (server *Server) listThemes(c *gin.Context) {
	themes, err := server.store.ListThemes(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list themes"})
		return
	}

	var response []ThemeResponse
	for _, theme := range themes {
		response = append(response, toThemeResponse(theme))
	}

	c.JSON(http.StatusOK, response)
}

// getActiveTheme handles GET /themes/active - get active theme with settings
func (server *Server) getActiveTheme(c *gin.Context) {
	theme, err := server.store.GetActiveThemeWithSettings(c)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "no active theme found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get active theme"})
		return
	}

	response := toActiveThemeWithSettingsResponse(theme)
	c.JSON(http.StatusOK, response)
}

// getTheme handles GET /themes/:id - get theme by ID
func (server *Server) getTheme(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid theme ID"})
		return
	}

	theme, err := server.store.GetTheme(c, id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "theme not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get theme"})
		return
	}

	response := toThemeResponse(theme)
	c.JSON(http.StatusOK, response)
}

// activateTheme handles PUT /themes/:id/activate - activate a theme
func (server *Server) activateTheme(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid theme ID"})
		return
	}

	// Get the previously active theme (if any) to deactivate its post types
	oldTheme, oldErr := server.store.GetActiveTheme(c)

	// First deactivate all themes
	err = server.store.DeactivateAllThemes(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to deactivate themes"})
		return
	}

	// Deactivate old theme's post types
	if oldErr == nil {
		_ = server.store.SetPostTypeActiveByRegisteredBy(c, db.SetPostTypeActiveByRegisteredByParams{
			IsActive:     false,
			RegisteredBy: fmt.Sprintf("theme:%s", oldTheme.Slug),
		})
	}

	// Then activate the requested theme
	theme, err := server.store.ActivateTheme(c, id)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "theme not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to activate theme"})
		return
	}

	// Activate new theme's post types
	_ = server.store.SetPostTypeActiveByRegisteredBy(c, db.SetPostTypeActiveByRegisteredByParams{
		IsActive:     true,
		RegisteredBy: fmt.Sprintf("theme:%s", theme.Slug),
	})

	response := toThemeResponse(theme)
	c.JSON(http.StatusOK, response)
}

// getThemeSettings handles GET /themes/:id/settings - get theme settings
func (server *Server) getThemeSettings(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid theme ID"})
		return
	}

	settings, err := server.store.ListThemeSettings(c, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get theme settings"})
		return
	}

	var response []ThemeSettingResponse
	for _, setting := range settings {
		response = append(response, toThemeSettingResponse(setting))
	}

	c.JSON(http.StatusOK, response)
}

// updateThemeSetting handles PUT /themes/:id/settings/:key - update a theme setting
func (server *Server) updateThemeSetting(c *gin.Context) {
	idParam := c.Param("id")
	id, err := strconv.ParseInt(idParam, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid theme ID"})
		return
	}

	key := c.Param("key")
	if key == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "setting key is required"})
		return
	}

	var req UpdateThemeSettingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Convert value to JSON
	valueJSON, err := json.Marshal(req.Value)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid setting value"})
		return
	}

	params := db.UpsertThemeSettingParams{
		ThemeID:      id,
		SettingKey:   key,
		SettingValue: valueJSON,
	}

	setting, err := server.store.UpsertThemeSetting(c, params)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update theme setting"})
		return
	}

	response := toThemeSettingResponse(setting)
	c.JSON(http.StatusOK, response)
}

// updateActiveThemeSettings handles PUT /themes/active/settings - update active theme settings (shortcut)
func (server *Server) updateActiveThemeSettings(c *gin.Context) {
	// Get active theme first
	theme, err := server.store.GetActiveTheme(c)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "no active theme found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get active theme"})
		return
	}

	var req UpdateThemeSettingsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Update each setting
	var updatedSettings []ThemeSettingResponse
	for key, value := range req.Settings {
		valueJSON, err := json.Marshal(value)
		if err != nil {
			continue
		}

		params := db.UpsertThemeSettingParams{
			ThemeID:      theme.ID,
			SettingKey:   key,
			SettingValue: valueJSON,
		}

		setting, err := server.store.UpsertThemeSetting(c, params)
		if err != nil {
			continue
		}

		updatedSettings = append(updatedSettings, toThemeSettingResponse(setting))
	}

	c.JSON(http.StatusOK, gin.H{
		"theme_id": theme.ID,
		"settings": updatedSettings,
	})
}
