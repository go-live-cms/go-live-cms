// Package api — Post settings snapshots (#358)
//
// Publishing saves a post's settings with its blocks: each version stores them
// (post_versions.settings) and the published ones sit next to published_block_doc
// (posts.published_settings). The database builds the snapshot
// (golive_post_settings, migration 000027), so the shape lives in one place:
// title, excerpt (description), featured image, term ids and the SEO fields
// (#357, 000030; posts_seo.go). Byline authors (#319) join it later.
//
// The public site and its feeds show the published settings; the admin edits
// the working ones (the post row, its featured image meta and term links). The
// slug isn't part of the snapshot on purpose: a slug change applies at once
// (with its conflict check), because a URL that changes later, on Update, would
// break links nobody expected to move.
package api

import (
	"encoding/json"
	"strconv"

	"github.com/sqlc-dev/pqtype"
)

// PostSettings is a settings snapshot, as golive_post_settings builds it.
type PostSettings struct {
	Title         string                     `json:"title"`
	Description   string                     `json:"description"`
	FeaturedImage *PostSettingsFeaturedImage `json:"featured_image"`
	TermIDs       []int64                    `json:"term_ids"`

	// SEO (#357). A snapshot from before 000030 was given the defaults.
	SEOTitle       string `json:"seo_title"`
	SEODescription string `json:"seo_description"`
	SocialImageID  *int64 `json:"social_image_id"`
	Noindex        bool   `json:"noindex"`
	CanonicalURL   string `json:"canonical_url"`
}

// PostSettingsFeaturedImage is the featured image as the post's meta records it
// (_thumbnail_id, _thumbnail_url). ID is nil for a row with a malformed id.
type PostSettingsFeaturedImage struct {
	ID  *int64 `json:"id"`
	URL string `json:"url"`
}

// decodePostSettings reads a stored snapshot; ok is false when there is none
// (NULL: nothing published, or a version from before #358) or it can't be read.
func decodePostSettings(raw pqtype.NullRawMessage) (*PostSettings, bool) {
	if !raw.Valid {
		return nil, false
	}
	return decodePostSettingsJSON(raw.RawMessage)
}

func decodePostSettingsJSON(raw json.RawMessage) (*PostSettings, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, false
	}
	var settings PostSettings
	if err := json.Unmarshal(raw, &settings); err != nil {
		return nil, false
	}
	if settings.TermIDs == nil {
		settings.TermIDs = []int64{}
	}
	return &settings, true
}

// publicTitleAndDescription is what the site shows for a post: the published
// settings when it has them, else the row's own values (a post marked published
// some other way, without a snapshot).
func publicTitleAndDescription(title, description string, published pqtype.NullRawMessage) (string, string) {
	if settings, ok := decodePostSettings(published); ok {
		return settings.Title, settings.Description
	}
	return title, description
}

// applyPublishedSettings turns a list row into what the public site shows: the
// published title, excerpt and featured image (the _thumbnail_* meta keys the
// lists read). Rows without published settings are left as they are.
func applyPublishedSettings(resp *PostWithMetaResponse, published pqtype.NullRawMessage) {
	settings, ok := decodePostSettings(published)
	if !ok {
		return
	}
	resp.Title = settings.Title
	resp.Description = settings.Description
	if resp.Meta == nil {
		resp.Meta = map[string]interface{}{}
	}
	delete(resp.Meta, "_thumbnail_id")
	delete(resp.Meta, "_thumbnail_url")
	if image := settings.FeaturedImage; image != nil && image.URL != "" {
		resp.Meta["_thumbnail_url"] = image.URL
		if image.ID != nil {
			resp.Meta["_thumbnail_id"] = strconv.FormatInt(*image.ID, 10)
		}
	}
}
