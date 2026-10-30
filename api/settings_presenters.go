package api

import db "github.com/go-live-cms/go-live-cms/db/sqlc"

func toSettingsResponse(settings db.Setting, siteAddress string) SettingsResponse {
	embeds := settings.EditorAllowedEmbeds
	if embeds == nil {
		embeds = []string{}
	}
	return SettingsResponse{
		ID:                      settings.ID,
		PostURLStructure:        settings.PostUrlStructure,
		SiteTitle:               settings.SiteTitle.String,
		PostsPerPage:            settings.PostsPerPage.Int32,
		SiteTagline:             settings.SiteTagline,
		SiteLanguage:            settings.SiteLanguage,
		SiteTimezone:            settings.SiteTimezone,
		DateFormat:              settings.DateFormat,
		EditorMarkdownShortcuts: settings.EditorMarkdownShortcuts,
		EditorAllowedEmbeds:     embeds,
		SiteAddress:             siteAddress,
		CreatedAt:               settings.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		ChangedAt:               settings.ChangedAt.Format("2006-01-02T15:04:05Z07:00"),
	}
}
