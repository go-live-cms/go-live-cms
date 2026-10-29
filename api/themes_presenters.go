package api

import (
	"encoding/json"
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// ThemeResponse represents a theme in API responses
type ThemeResponse struct {
	ID          int64           `json:"id"`
	Name        string          `json:"name"`
	Slug        string          `json:"slug"`
	Description string          `json:"description"`
	Version     string          `json:"version"`
	Author      string          `json:"author"`
	Config      json.RawMessage `json:"config"`
	Active      bool            `json:"active"`
	CreatedAt   string          `json:"created_at"`
	ChangedAt   string          `json:"changed_at"`
}

// ActiveThemeWithSettingsResponse includes theme + settings
type ActiveThemeWithSettingsResponse struct {
	ID          int64           `json:"id"`
	Name        string          `json:"name"`
	Slug        string          `json:"slug"`
	Description string          `json:"description"`
	Version     string          `json:"version"`
	Author      string          `json:"author"`
	Config      json.RawMessage `json:"config"`
	Active      bool            `json:"active"`
	Settings    interface{}     `json:"settings"`
	CreatedAt   string          `json:"created_at"`
	ChangedAt   string          `json:"changed_at"`
}

// ThemeSettingResponse represents a theme setting
type ThemeSettingResponse struct {
	ID           int64           `json:"id"`
	ThemeID      int64           `json:"theme_id"`
	SettingKey   string          `json:"setting_key"`
	SettingValue json.RawMessage `json:"setting_value"`
	CreatedAt    string          `json:"created_at"`
	ChangedAt    string          `json:"changed_at"`
}

// UpdateThemeSettingRequest for updating a single setting
type UpdateThemeSettingRequest struct {
	Value interface{} `json:"value" binding:"required"`
}

// UpdateThemeSettingsRequest for batch updating settings
type UpdateThemeSettingsRequest struct {
	Settings map[string]interface{} `json:"settings" binding:"required,max=200,dive,keys,min=1,max=255,setting_key,endkeys"`
}

// Converter functions
func toThemeResponse(theme db.Theme) ThemeResponse {
	return ThemeResponse{
		ID:          theme.ID,
		Name:        theme.Name,
		Slug:        theme.Slug,
		Description: theme.Description.String,
		Version:     theme.Version,
		Author:      theme.Author.String,
		Config:      theme.Config,
		Active:      theme.Active,
		CreatedAt:   theme.CreatedAt.Format(time.RFC3339),
		ChangedAt:   theme.ChangedAt.Format(time.RFC3339),
	}
}

func toActiveThemeWithSettingsResponse(theme db.GetActiveThemeWithSettingsRow) ActiveThemeWithSettingsResponse {
	return ActiveThemeWithSettingsResponse{
		ID:          theme.ID,
		Name:        theme.Name,
		Slug:        theme.Slug,
		Description: theme.Description.String,
		Version:     theme.Version,
		Author:      theme.Author.String,
		Config:      theme.Config,
		Active:      theme.Active,
		Settings:    themeSettingsObject(theme.Settings),
		CreatedAt:   theme.CreatedAt.Format(time.RFC3339),
		ChangedAt:   theme.ChangedAt.Format(time.RFC3339),
	}
}

func toThemeSettingResponse(setting db.ThemeSetting) ThemeSettingResponse {
	return ThemeSettingResponse{
		ID:           setting.ID,
		ThemeID:      setting.ThemeID,
		SettingKey:   setting.SettingKey,
		SettingValue: setting.SettingValue,
		CreatedAt:    setting.CreatedAt.Format(time.RFC3339),
		ChangedAt:    setting.ChangedAt.Format(time.RFC3339),
	}
}

// themeSettingsObject returns the active theme's settings as a JSON object. The query
// aggregates them with jsonb_object_agg, which the driver hands back as []byte: passed
// through as is, that encoded as a base64 string, so readers of settings.layout_variants
// (the public post route, the admin Themes screen) never saw the saved layouts (#345).
func themeSettingsObject(settings interface{}) map[string]interface{} {
	object := map[string]interface{}{}
	switch v := settings.(type) {
	case []byte:
		decodeJSONBestEffort(v, &object)
	case string:
		decodeJSONBestEffort([]byte(v), &object)
	case map[string]interface{}:
		object = v
	}
	if object == nil { // a stored JSON null
		object = map[string]interface{}{}
	}
	return object
}
