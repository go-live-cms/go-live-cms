package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// getSettings handles GET /settings - get current settings
func (server *Server) getSettings(c *gin.Context) {
	settings, err := server.store.GetSettings(c)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "settings not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get settings"})
		return
	}

	c.JSON(http.StatusOK, server.settingsResponse(c, settings, server.optionalCallerIsAdmin(c)))
}

// settingsResponse is the settings as GET and PUT /settings answer them, the site logo's
// media (#488) looked up with them. admin adds the Discussion word lists (#522).
func (server *Server) settingsResponse(c *gin.Context, settings db.Setting, admin bool) SettingsResponse {
	response := toSettingsResponse(settings, server.siteAddress(), admin)
	response.SiteLogo = server.siteLogo(c.Request.Context(), settings)
	return response
}

// optionalCallerIsAdmin reports whether a public route's request carries a valid access
// token of an admin. It never answers the request: a missing, malformed, expired or
// non-admin token just reads as anonymous (the public answer). GET /settings uses it for
// the fields only admins read (#522); the public cache never stores or serves a request
// with an Authorization header, so the anonymous cached answer stays public.
func (server *Server) optionalCallerIsAdmin(c *gin.Context) bool {
	fields := strings.Fields(c.GetHeader(authorizationHeaderKey))
	if len(fields) != 2 || !strings.EqualFold(fields[0], authorizationTypeBearer) {
		return false
	}
	payload, err := server.tokenMaker.VerifyToken(fields[1])
	if err != nil || payload.TokenType != "access" {
		return false
	}
	user, err := server.store.GetUser(c.Request.Context(), payload.UserID)
	if err != nil || issuedBeforePasswordChange(payload.IssuedAt, user.PasswordChangedAt) {
		return false
	}
	return isSiteAdmin(user)
}

// siteAddress is the public origin the Settings page shows read-only (#330), or "" if
// PUBLIC_BASE_URL isn't usable (NewServer refuses that outside debug/test mode).
func (server *Server) siteAddress() string {
	address, err := server.config.PublicSiteURL()
	if err != nil {
		return ""
	}
	return address
}

// updateSettings handles PUT /settings - update settings
func (server *Server) updateSettings(c *gin.Context) {
	var req UpdateSettingsRequest
	if !bindJSON(c, &req) {
		return
	}

	// Convert request to SQLC parameters
	params := db.UpdateSettingsParams{
		PostUrlStructure: stringToNullString(req.PostURLStructure),
		SiteTitle:        stringToNullString(req.SiteTitle),
		PostsPerPage:     int32ToNullInt32(req.PostsPerPage),
		SiteLanguage:     stringToNullString(req.SiteLanguage),
		SiteTimezone:     stringToNullString(req.SiteTimezone),
		DateFormat:       stringToNullString(req.DateFormat),

		EditorMarkdownShortcuts: boolToNullBool(req.EditorMarkdownShortcuts),
		AllowSignup:             boolToNullBool(req.AllowSignup),
	}
	if req.SiteTagline != nil {
		tagline := strings.TrimSpace(*req.SiteTagline)
		params.SiteTagline = sql.NullString{String: tagline, Valid: true}
	}
	if req.EditorAllowedEmbeds != nil {
		// Non-nil even when empty: [] clears the list, absent keeps it.
		params.EditorAllowedEmbeds = normalizeEmbeds(*req.EditorAllowedEmbeds)
	}
	setFrontPage, frontPageID, err := req.frontPageUpdate()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "invalid_front_page", "fields": gin.H{"front_page_id": err.Error()}})
		return
	}
	if frontPageID != nil && !server.checkFrontPage(c, *frontPageID) {
		return
	}
	params.SetFrontPage = setFrontPage
	if frontPageID != nil {
		params.FrontPageID = sql.NullInt64{Int64: *frontPageID, Valid: true}
	}
	setSiteLogo, siteLogoID, err := req.siteLogoUpdate()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "invalid_site_logo", "fields": gin.H{"site_logo_media_id": err.Error()}})
		return
	}
	if siteLogoID != nil && !server.checkSiteLogo(c, *siteLogoID) {
		return
	}
	params.SetSiteLogo = setSiteLogo
	if siteLogoID != nil {
		params.SiteLogoMediaID = sql.NullInt64{Int64: *siteLogoID, Valid: true}
	}
	// Settings › Discussion (#522).
	privacyPage, err := req.apply(&params)
	if err != nil {
		writeDiscussionSettingsError(c, err)
		return
	}
	if privacyPage != nil && !server.checkPrivacyPage(c, *privacyPage) {
		return
	}

	settings, err := server.store.UpdateSettings(c, params)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update settings"})
		return
	}

	// Which settings, not their values (a title or tagline is site content).
	server.recordRequestActivity(c, activityEvent{
		Verb:       db.ActivitySettingsUpdated,
		ObjectType: db.ActivityObjectSettings,
		ObjectID:   int64(settings.ID),
		Payload:    map[string]any{"fields": req.setFields()},
	})

	// PUT /settings is admins' only (requireSiteAdmin).
	c.JSON(http.StatusOK, server.settingsResponse(c, settings, true))
}

// getExtensionSetting handles GET /extension-settings/:key
func (server *Server) getExtensionSetting(c *gin.Context) {
	key := c.Param("key")

	setting, err := server.store.GetThemeExtensionSetting(c, key)
	if err != nil {
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "setting not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get extension setting"})
		return
	}

	var value interface{}
	if err := json.Unmarshal(setting.Value, &value); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to parse setting value"})
		return
	}

	response := ExtensionSettingResponse{
		Key:           setting.Key,
		Value:         value,
		ExtensionType: setting.ExtensionType,
		ExtensionID:   setting.ExtensionID,
		CreatedAt:     setting.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		ChangedAt:     setting.ChangedAt.Format("2006-01-02T15:04:05Z07:00"),
	}

	c.JSON(http.StatusOK, response)
}

// listExtensionSettings handles GET /extension-settings. It is public, so it
// only ever answers theme rows, whatever the query asks for (#451).
func (server *Server) listExtensionSettings(c *gin.Context) {
	extensionType := c.Query("extension_type")
	extensionID := c.Query("extension_id")

	var settings []db.ExtensionSetting
	var err error

	switch {
	case extensionType != "" && extensionType != extensionTypeTheme:
		// Nothing else is public: an empty list, not a lookup.
	case extensionID != "":
		settings, err = server.store.ListExtensionSettingsByExtension(c, db.ListExtensionSettingsByExtensionParams{
			ExtensionType: extensionTypeTheme,
			ExtensionID:   extensionID,
		})
	default:
		settings, err = server.store.ListThemeExtensionSettings(c)
	}

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list extension settings"})
		return
	}

	responses := make([]ExtensionSettingResponse, 0, len(settings))
	for _, setting := range settings {
		var value interface{}
		if err := json.Unmarshal(setting.Value, &value); err != nil {
			continue
		}

		responses = append(responses, ExtensionSettingResponse{
			Key:           setting.Key,
			Value:         value,
			ExtensionType: setting.ExtensionType,
			ExtensionID:   setting.ExtensionID,
			CreatedAt:     setting.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
			ChangedAt:     setting.ChangedAt.Format("2006-01-02T15:04:05Z07:00"),
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"extension_settings": responses,
		"count":              len(responses),
	})
}

// upsertExtensionSetting handles PUT /extension-settings
func (server *Server) upsertExtensionSetting(c *gin.Context) {
	var req ExtensionSettingRequest
	if !bindJSON(c, &req) {
		return
	}
	if !validThemeSettingKey(req.Key, req.ExtensionID) {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":  "key must be theme:<extension_id>:<name>",
			"fields": gin.H{"key": "must be theme:<extension_id>:<name>"},
		})
		return
	}

	// Convert value to JSONB
	valueBytes, err := json.Marshal(req.Value)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid value format"})
		return
	}

	params := db.UpsertExtensionSettingParams{
		Key:           req.Key,
		Value:         valueBytes,
		ExtensionType: req.ExtensionType,
		ExtensionID:   req.ExtensionID,
	}

	setting, err := server.store.UpsertExtensionSetting(c, params)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to upsert extension setting"})
		return
	}

	var value interface{}
	if err := json.Unmarshal(setting.Value, &value); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to parse setting value"})
		return
	}

	response := ExtensionSettingResponse{
		Key:           setting.Key,
		Value:         value,
		ExtensionType: setting.ExtensionType,
		ExtensionID:   setting.ExtensionID,
		CreatedAt:     setting.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		ChangedAt:     setting.ChangedAt.Format("2006-01-02T15:04:05Z07:00"),
	}

	c.JSON(http.StatusOK, response)
}

// deleteExtensionSetting handles DELETE /extension-settings/:key
func (server *Server) deleteExtensionSetting(c *gin.Context) {
	key := c.Param("key")

	deleted, err := server.store.DeleteThemeExtensionSetting(c, key)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete extension setting"})
		return
	}
	if deleted == 0 {
		// A plugin's row answers like a key that doesn't exist.
		c.JSON(http.StatusNotFound, gin.H{"error": "setting not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "extension setting deleted"})
}
