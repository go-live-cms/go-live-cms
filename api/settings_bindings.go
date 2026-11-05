package api

import "database/sql"

// UpdateSettingsRequest represents the request body for updating settings
type UpdateSettingsRequest struct {
	PostURLStructure *string `json:"post_url_structure" binding:"omitempty,oneof=id slug"`
	SiteTitle        *string `json:"site_title" binding:"omitempty,min=1,max=200"`
	PostsPerPage     *int32  `json:"posts_per_page" binding:"omitempty,min=1,max=100"`
	// #330. Absent keeps the stored value; "" clears the tagline.
	SiteTagline             *string   `json:"site_tagline" binding:"omitempty,max=160,single_line"`
	SiteLanguage            *string   `json:"site_language" binding:"omitempty,max=35,site_language"`
	SiteTimezone            *string   `json:"site_timezone" binding:"omitempty,max=64,time_zone"`
	DateFormat              *string   `json:"date_format" binding:"omitempty,oneof=month_day_year day_month_year iso"`
	EditorMarkdownShortcuts *bool     `json:"editor_markdown_shortcuts"`
	EditorAllowedEmbeds     *[]string `json:"editor_allowed_embeds" binding:"omitempty,max=20,dive,max=32,embed_provider"`
	// "Allow anyone to sign up" (#191). Admins only, like every settings write.
	AllowSignup *bool `json:"allow_signup"`
}

// setFields lists the JSON names of the settings the request sets, in field
// order: the activity log's "settings_updated" payload (#324).
func (req UpdateSettingsRequest) setFields() []string {
	fields := []string{}
	add := func(set bool, name string) {
		if set {
			fields = append(fields, name)
		}
	}
	add(req.PostURLStructure != nil, "post_url_structure")
	add(req.SiteTitle != nil, "site_title")
	add(req.PostsPerPage != nil, "posts_per_page")
	add(req.SiteTagline != nil, "site_tagline")
	add(req.SiteLanguage != nil, "site_language")
	add(req.SiteTimezone != nil, "site_timezone")
	add(req.DateFormat != nil, "date_format")
	add(req.EditorMarkdownShortcuts != nil, "editor_markdown_shortcuts")
	add(req.EditorAllowedEmbeds != nil, "editor_allowed_embeds")
	add(req.AllowSignup != nil, "allow_signup")
	return fields
}

// SettingsResponse represents the settings response
type SettingsResponse struct {
	ID                      int32    `json:"id"`
	PostURLStructure        string   `json:"post_url_structure"`
	SiteTitle               string   `json:"site_title"`
	PostsPerPage            int32    `json:"posts_per_page"`
	SiteTagline             string   `json:"site_tagline"`
	SiteLanguage            string   `json:"site_language"`
	SiteTimezone            string   `json:"site_timezone"`
	DateFormat              string   `json:"date_format"`
	EditorMarkdownShortcuts bool     `json:"editor_markdown_shortcuts"`
	EditorAllowedEmbeds     []string `json:"editor_allowed_embeds"`
	// Open signup (#191). Public on purpose: the sign-in page reads it to decide
	// whether to offer "Create an account".
	AllowSignup bool `json:"allow_signup"`
	// The public origin (PUBLIC_BASE_URL), read-only: the domain is deploy config
	// (docs/operations/deploy.md, "Change domain"). "" when it isn't configured.
	SiteAddress string `json:"site_address"`
	CreatedAt   string `json:"created_at"`
	ChangedAt   string `json:"changed_at"`
}

// ExtensionSettingRequest represents the request body for upserting an extension setting
type ExtensionSettingRequest struct {
	Key           string      `json:"key" binding:"required,min=1,max=255,setting_key"`
	Value         interface{} `json:"value" binding:"required"`
	ExtensionType string      `json:"extension_type" binding:"required,oneof=plugin theme"`
	ExtensionID   string      `json:"extension_id" binding:"required,min=1,max=100,setting_key"`
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
