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
	Settings map[string]interface{} `json:"settings" binding:"required"`
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
		Settings:    theme.Settings,
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
