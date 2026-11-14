package api

import (
	"encoding/json"
	"reflect"
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// GlobalStylesTheme is the theme an override belongs to.
type GlobalStylesTheme struct {
	ID   int64  `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// GlobalStylesResponse is what the styles screen (#487) needs: the theme's declared
// tokens with their defaults (what can be edited, and what "Reset" goes back to), the
// draft and its revision, the published override, and the contrast pairs the draft fails.
// Admin-only: it carries the draft.
type GlobalStylesResponse struct {
	Theme GlobalStylesTheme `json:"theme"`
	// Supported: the theme's base layout merges global styles (supports.globalStyles) and
	// this build knows its tokens. Saving and publishing need it.
	Supported             bool              `json:"supported"`
	Tokens                map[string]any    `json:"tokens"`
	FontOptions           []FontOption      `json:"font_options"`
	SystemFonts           []string          `json:"system_fonts"`
	Draft                 json.RawMessage   `json:"draft"`
	DraftRevision         int64             `json:"draft_revision"`
	Published             json.RawMessage   `json:"published"`
	HasUnpublishedChanges bool              `json:"has_unpublished_changes"`
	Contrast              []ContrastFailure `json:"contrast"`
	ChangedAt             *string           `json:"changed_at"`
}

func emptyObjectIfBlank(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	return raw
}

// globalStylesSupported: the build knows the theme's tokens and its layout applies them.
func globalStylesSupported(tokens ThemeTokens, known bool) bool {
	return known && tokens.SupportsGlobalStyles
}

// toGlobalStylesResponse shapes a theme's row; a theme never saved has the zero row.
func toGlobalStylesResponse(theme db.Theme, tokens ThemeTokens, known bool, row db.GlobalStyle) GlobalStylesResponse {
	draft := decodeStoredStyles(row.Draft)
	published := decodeStoredStyles(row.Published)
	declared := tokens.Tokens
	if declared == nil {
		declared = map[string]any{}
	}
	fontOptions := tokens.FontOptions
	if fontOptions == nil {
		fontOptions = []FontOption{}
	}
	contrast := []ContrastFailure{}
	if known {
		contrast = globalStyleContrast(tokens, draft)
	}
	response := GlobalStylesResponse{
		Theme:                 GlobalStylesTheme{ID: theme.ID, Slug: theme.Slug, Name: theme.Name},
		Supported:             globalStylesSupported(tokens, known),
		Tokens:                declared,
		FontOptions:           fontOptions,
		SystemFonts:           systemFontIDs,
		Draft:                 emptyObjectIfBlank(row.Draft),
		DraftRevision:         row.DraftRevision,
		Published:             emptyObjectIfBlank(row.Published),
		HasUnpublishedChanges: !reflect.DeepEqual(draft, published),
		Contrast:              contrast,
	}
	if !row.ChangedAt.IsZero() {
		changed := row.ChangedAt.Format(time.RFC3339)
		response.ChangedAt = &changed
	}
	return response
}

// SiteDesignPublishResponse is a publish's result: the release, what the styles part of
// it changed (group names), how many contrast pairs failed (published anyway), and the
// styles as they now are.
type SiteDesignPublishResponse struct {
	Release      SiteDesignReleaseResponse `json:"release"`
	GlobalStyles GlobalStylesPublished     `json:"global_styles"`
	Styles       GlobalStylesResponse      `json:"styles"`
}

type SiteDesignReleaseResponse struct {
	ID          int64  `json:"id"`
	ThemeSlug   string `json:"theme_slug"`
	PublishedAt string `json:"published_at"`
}

type GlobalStylesPublished struct {
	VersionNo        int32    `json:"version_no"`
	Groups           []string `json:"groups"`
	ContrastFailures int      `json:"contrast_failures"`
}
