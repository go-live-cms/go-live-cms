package api

import (
	"context"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// "Used in" for the site design (#496, docs/design/theme-builder.md 1.2 problem 3, 5.6):
// GET /media/:id/posts lists, beside the posts, the templates and parts that show the media
// (site_template_media, synced by every store and publish) and whether it is the site logo
// (settings.site_logo_media_id). The media delete confirmation names them, so a logo or a
// cover image in a header part isn't deleted without a word. A deleted media renders
// nothing there, as in posts: the resolve route lists it in the doc's media_missing.

// MediaSiteTemplateUse is one template or part showing a media.
type MediaSiteTemplateUse struct {
	ID    int64  `json:"id"`
	Theme string `json:"theme"`
	// ThemeActive: Theme is the active theme. Another theme's design (kept for when it is
	// switched back, decision 16.6) isn't on the site, published or not.
	ThemeActive bool `json:"theme_active"`
	// Kind is template or part; Slug and Title name it ("Header", part).
	Kind  string `json:"kind"`
	Slug  string `json:"slug"`
	Title string `json:"title"`
	// Published: its published copy shows the media (on the site when ThemeActive).
	// Working: its working copy does, so the next publish keeps it. Only admins see working
	// copies and other themes' designs: both are the Site editor's, which only admins open.
	Published bool `json:"published"`
	Working   bool `json:"working"`
	// Usages are the blocks showing it, each once (block_id, block_type), or captions of a
	// video block for a captions file (#507), as for posts.
	Usages []MediaUsage `json:"usages"`
}

// siteTemplateMediaRow is either list query's row (the two have the same columns, so a
// captions row converts to it).
type siteTemplateMediaRow = db.ListSiteTemplatesByMediaRow

// groupSiteTemplateUses folds the rows (ordered by template, then copy) into one entry per
// template. Without seesDesign (a caller who isn't an admin) only the active theme's
// published copies count: what readers can see on the site anyway. usage is the usage type
// of each block.
func groupSiteTemplateUses(rows []siteTemplateMediaRow, seesDesign bool, usage string) []MediaSiteTemplateUse {
	out := []MediaSiteTemplateUse{}
	index := map[int64]int{}
	seen := map[int64]map[string]bool{}
	for _, row := range rows {
		if !seesDesign && !(row.Published && row.ThemeActive) {
			continue
		}
		at, ok := index[row.ID]
		if !ok {
			at = len(out)
			index[row.ID] = at
			seen[row.ID] = map[string]bool{}
			out = append(out, MediaSiteTemplateUse{ID: row.ID, Theme: row.ThemeSlug, ThemeActive: row.ThemeActive, Kind: row.Kind, Slug: row.Slug, Title: row.Title, Usages: []MediaUsage{}})
		}
		if row.Published {
			out[at].Published = true
		} else {
			out[at].Working = true
		}
		if !seen[row.ID][row.BlockID] {
			seen[row.ID][row.BlockID] = true
			out[at].Usages = append(out[at].Usages, MediaUsage{Type: usage, BlockID: row.BlockID, BlockType: row.BlockType})
		}
	}
	return out
}

// mediaSiteDesignUses is the site design's side of a media's "Used in": the templates and
// parts showing it (a captions file: showing a video it captions) and whether it is the
// site logo.
func (server *Server) mediaSiteDesignUses(ctx context.Context, media db.Medium, caller db.User) ([]MediaSiteTemplateUse, bool, error) {
	var rows []siteTemplateMediaRow
	usage := MediaUsageBlock
	if media.MimeType == captionsMimeType {
		usage = MediaUsageCaptions
		found, err := server.store.ListSiteTemplatesByCaptionsMedia(ctx, media.ID)
		if err != nil {
			return nil, false, err
		}
		for _, r := range found {
			rows = append(rows, siteTemplateMediaRow(r))
		}
	} else {
		var err error
		if rows, err = server.store.ListSiteTemplatesByMedia(ctx, media.ID); err != nil {
			return nil, false, err
		}
	}
	settings, err := server.store.GetSettings(ctx)
	if err != nil {
		return nil, false, err
	}
	siteLogo := settings.SiteLogoMediaID.Valid && settings.SiteLogoMediaID.Int64 == media.ID
	return groupSiteTemplateUses(rows, isSiteAdmin(caller), usage), siteLogo, nil
}
