package api

import "database/sql"

// UpdateSettingsRequest represents the request body for updating settings
type UpdateSettingsRequest struct {
	PostURLStructure *string `json:"post_url_structure" binding:"omitempty,oneof=id slug"`
	SiteTitle        *string `json:"site_title" binding:"omitempty,min=1,max=200"`
	PostsPerPage     *int32  `json:"posts_per_page" binding:"omitempty,min=1,max=100"`
}

// SettingsResponse represents the settings response
type SettingsResponse struct {
	ID               int32  `json:"id"`
	PostURLStructure string `json:"post_url_structure"`
	SiteTitle        string `json:"site_title"`
	PostsPerPage     int32  `json:"posts_per_page"`
	CreatedAt        string `json:"created_at"`
	ChangedAt        string `json:"changed_at"`
}

// ExtensionSettingRequest represents the request body for upserting an extension setting
type ExtensionSettingRequest struct {
	Key           string      `json:"key" binding:"required,min=1,max=255"`
	Value         interface{} `json:"value" binding:"required"`
	ExtensionType string      `json:"extension_type" binding:"required,oneof=plugin theme"`
	ExtensionID   string      `json:"extension_id" binding:"required,min=1,max=100"`
}

// ExtensionSettingResponse represents an extension setting response
type ExtensionSettingResponse struct {
	Key           string      `json:"key"`
	Value         interface{} `json:"value"`
	ExtensionType string      `json:"extension_type"`
	ExtensionID   string      `json:"extension_id"`
	CreatedAt     string      `json:"created_at"`
	ChangedAt     string      `json:"changed_at"`
}

func int32ToNullInt32(i *int32) sql.NullInt32 {
	if i == nil {
		return sql.NullInt32{Valid: false}
	}
	return sql.NullInt32{Int32: *i, Valid: true}
}
