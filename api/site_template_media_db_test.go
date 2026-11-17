package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// "Used in" for templates and parts (#496, docs/design/theme-builder.md 1.2 problem 3, 5.6)
// against the test database (skipped without one), through the routes: every collab store
// syncs the working copy's site_template_media rows and every publish the published copy's
// (a reset removes them); GET /media/:id/posts lists the part (admins: both copies; other
// roles: the published one) and the site logo; deleting the media removes the rows, purges,
// and the part renders without the block (media_missing).

// imageDoc is a part doc: a heading, then an image block per media id (inside a group for
// the second, so the walk reaches nested blocks).
func imageDoc(text string, mediaIDs ...int64) map[string]any {
	doc := designDoc(text)
	blocks := doc["blocks"].(map[string]any)
	order := doc["blocks_order"].([]string)
	for i, id := range mediaIDs {
		blockID := fmt.Sprintf("blk-image-%06d", i)
		blocks[blockID] = map[string]any{"id": blockID, "type": "image", "version": 2, "attrs": map[string]any{"src": fmt.Sprintf("/uploads/media/%d.png", id), "mediaId": id, "alt": "Logo"}}
		if i == 1 {
			blocks["blk-group-0001"] = map[string]any{"id": "blk-group-0001", "type": "group", "version": 1, "attrs": map[string]any{}, "children": []string{blockID}}
			order = append(order, "blk-group-0001")
			continue
		}
		order = append(order, blockID)
	}
	doc["blocks_order"] = order
	return doc
}

func TestSiteTemplateMediaUsedIn(t *testing.T) {
	d := newDesignCacheDB(t)
	ctx := context.Background()
	editor := scheduleUser(t, d.siteDesignDBFixture.store, RoleEditor)
	newMedia := func(name string) db.Medium {
		t.Helper()
		m, err := d.siteDesignDBFixture.store.CreateMedia(ctx, db.CreateMediaParams{Name: name, MediaPath: "/x/" + name + ".png", UserID: d.admin.ID, MimeType: "image/png"})
		require.NoError(t, err)
		t.Cleanup(func() { _, _ = d.conn.Exec(`DELETE FROM media WHERE id = $1`, m.ID) })
		return m
	}
	logo := newMedia("gl496-logo")
	banner := newMedia("gl496-banner")
	rows := func(id int64) []db.SiteTemplateMedium {
		t.Helper()
		out, err := d.siteDesignDBFixture.store.ListSiteTemplateMedia(ctx, id)
		require.NoError(t, err)
		return out
	}
	usedIn := func(caller *db.User, mediaID int64) mediaUsedInBody {
		t.Helper()
		recorder := d.request(t, caller, http.MethodGet, fmt.Sprintf("/api/v1/media/%d/posts", mediaID), "")
		requireStatus(t, recorder, http.StatusOK)
		var body mediaUsedInBody
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		return body
	}

	// 1. A store syncs the working copy: the image at the top and the one in a group.
	header := d.create("part", "header", "blank")
	d.store(header.ID, imageDoc("Header", logo.ID, banner.ID))
	require.Equal(t, []db.SiteTemplateMedium{
		{TemplateID: header.ID, MediaID: logo.ID, BlockID: "blk-image-000000", BlockType: "image", Published: false},
		{TemplateID: header.ID, MediaID: banner.ID, BlockID: "blk-image-000001", BlockType: "image", Published: false},
	}, rows(header.ID))

	// The admin sees the part (working copy only); an editor doesn't (it isn't on the site).
	body := usedIn(&d.admin, logo.ID)
	require.Len(t, body.SiteTemplates, 1)
	require.Equal(t, MediaSiteTemplateUse{ID: header.ID, Theme: d.theme.Slug, Kind: "part", Slug: "header", Title: header.Title, Working: true,
		Usages: []MediaUsage{{Type: MediaUsageBlock, BlockID: "blk-image-000000", BlockType: "image"}}}, body.SiteTemplates[0])
	require.Empty(t, usedIn(&editor, logo.ID).SiteTemplates)

	// 2. A publish syncs the published copy: now both sides, and editors see it.
	d.publish()
	require.Len(t, rows(header.ID), 4)
	body = usedIn(&editor, logo.ID)
	require.Len(t, body.SiteTemplates, 1)
	require.True(t, body.SiteTemplates[0].Published)
	require.False(t, body.SiteTemplates[0].Working, "the working copy is the admin's")

	// 3. A store that drops the banner removes its working row only; the published copy still shows it.
	d.store(header.ID, imageDoc("Header", logo.ID))
	body = usedIn(&d.admin, banner.ID)
	require.Len(t, body.SiteTemplates, 1)
	require.True(t, body.SiteTemplates[0].Published)
	require.False(t, body.SiteTemplates[0].Working)
	d.publish()
	require.Empty(t, usedIn(&d.admin, banner.ID).SiteTemplates, "published without it: no longer used")

	// 4. The site logo is its own entry.
	settings, err := d.siteDesignDBFixture.store.GetSettings(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _, _ = d.conn.Exec(`UPDATE settings SET site_logo_media_id = $1`, settings.SiteLogoMediaID) })
	requireStatus(t, d.request(t, &d.admin, http.MethodPut, "/api/v1/settings", fmt.Sprintf(`{"site_logo_media_id":%d}`, logo.ID)), http.StatusOK)
	require.True(t, usedIn(&editor, logo.ID).SiteLogo)
	require.False(t, usedIn(&editor, banner.ID).SiteLogo)

	// 5. Deleting the media: its rows go, the delete purges, and the part renders without
	// the block (media_missing), as a post does.
	d.warm("single")
	requireStatus(t, d.request(t, &d.admin, http.MethodDelete, fmt.Sprintf("/api/v1/media/%d", logo.ID), ""), http.StatusOK)
	require.Empty(t, rows(header.ID), "the deleted media's rows cascade")
	res, _, result := d.resolve("single")
	require.Equal(t, "MISS", result, "a media delete purges")
	part := res.Parts["header"]
	require.Equal(t, siteDesignSourceOverride, part.Source)
	require.Equal(t, []any{float64(logo.ID)}, part.Doc["media_missing"])
	media, _ := part.Doc["media"].(map[string]any)
	require.NotContains(t, media, fmt.Sprint(logo.ID), "no entry for a deleted media")
	settings, err = d.siteDesignDBFixture.store.GetSettings(ctx)
	require.NoError(t, err)
	require.False(t, settings.SiteLogoMediaID.Valid, "the logo setting is cleared with it")

	// 6. A reset publish removes the published rows; a template's delete removes its rows.
	other := newMedia("gl496-other")
	d.store(header.ID, imageDoc("Header", other.ID))
	d.publish()
	require.Len(t, rows(header.ID), 2)
	status, _ := d.call(http.MethodPost, fmt.Sprintf("/api/v1/site-design/templates/%d/reset", header.ID), "")
	require.Equal(t, http.StatusOK, status)
	d.publish()
	require.Equal(t, []db.SiteTemplateMedium{{TemplateID: header.ID, MediaID: other.ID, BlockID: "blk-image-000000", BlockType: "image", Published: false}}, rows(header.ID),
		"a reset publishes no media; the working copy keeps its row")

	footer := d.create("part", "footer", "blank")
	d.store(footer.ID, imageDoc("Footer", other.ID))
	require.Len(t, rows(footer.ID), 1)
	status, _ = d.call(http.MethodDelete, fmt.Sprintf("/api/v1/site-design/templates/%d", footer.ID), "")
	require.Equal(t, http.StatusOK, status)
	require.Empty(t, rows(footer.ID))
}

// A stale mediaId (no media row) never fails a store or a publish: it is skipped, as for posts.
func TestSiteTemplateMediaSkipsMissingIDs(t *testing.T) {
	d := newDesignCacheDB(t)
	header := d.create("part", "header", "blank")
	d.store(header.ID, imageDoc("Header", 987654321))
	d.publish()
	out, err := d.siteDesignDBFixture.store.ListSiteTemplateMedia(context.Background(), header.ID)
	require.NoError(t, err)
	require.Empty(t, out)
}
