package api

import db "github.com/go-live-cms/go-live-cms/db/sqlc"

// toSettingsResponse shapes the settings row. admin adds what only admins read (the
// Discussion word lists, #522).
func toSettingsResponse(settings db.Setting, siteAddress string, admin bool) SettingsResponse {
	embeds := settings.EditorAllowedEmbeds
	if embeds == nil {
		embeds = []string{}
	}
	return SettingsResponse{
		ID:                         settings.ID,
		PostURLStructure:           settings.PostUrlStructure,
		SiteTitle:                  settings.SiteTitle.String,
		PostsPerPage:               settings.PostsPerPage.Int32,
		SiteTagline:                settings.SiteTagline,
		SiteLanguage:               settings.SiteLanguage,
		SiteTimezone:               settings.SiteTimezone,
		DateFormat:                 settings.DateFormat,
		EditorMarkdownShortcuts:    settings.EditorMarkdownShortcuts,
		EditorAllowedEmbeds:        embeds,
		AllowSignup:                settings.AllowSignup,
		FrontPageID:                nullInt64Ptr(settings.FrontPageID),
		SiteLogoMediaID:            nullInt64Ptr(settings.SiteLogoMediaID),
		SiteAddress:                siteAddress,
		discussionSettingsResponse: toDiscussionSettingsResponse(settings, admin),
		CreatedAt:                  settings.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		ChangedAt:                  settings.ChangedAt.Format("2006-01-02T15:04:05Z07:00"),
	}
}
