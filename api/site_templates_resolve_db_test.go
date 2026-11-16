package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// GET /public/site-templates/resolve (#491) against the test database (skipped without
// one): only published copies reach it (a working copy, a reset part and a never-published
// template don't), the media of every doc is attached, a menu by id comes along, and the
// answer is cached under the theme and slugs and purged by the writes that change it.

func TestResolvePublicSiteTemplateDB(t *testing.T) {
	f := newSiteDesignDBFixture(t)
	t.Cleanup(func() {
		_, _ = f.conn.Exec(`DELETE FROM site_templates WHERE theme_slug = $1`, f.theme.Slug)
	})
	var menuID int64
	require.NoError(t, f.conn.QueryRow(`INSERT INTO menus (name) VALUES ('Resolve test menu') RETURNING id`).Scan(&menuID))
	t.Cleanup(func() { _, _ = f.conn.Exec(`DELETE FROM menus WHERE id = $1`, menuID) })
	_, err := f.conn.Exec(`INSERT INTO menu_items (menu_id, sort_order, item_type, label, url) VALUES ($1, 0, 'custom', 'Resolve link', '/resolve-link')`, menuID)
	require.NoError(t, err)

	const missingMedia = 987654321
	doc := func(marker string, blocks string) string {
		return `{"doc_version":1,"blocks_order":["para-00001","part-00001","imag-00001","navi-00001"],"blocks":{` +
			`"para-00001":{"id":"para-00001","type":"paragraph","version":1,"attrs":{"text":"` + marker + `"}},` +
			`"part-00001":{"id":"part-00001","type":"template_part","version":1,"attrs":{"slug":"header"}},` +
			`"imag-00001":{"id":"imag-00001","type":"image","version":1,"attrs":{"src":"/uploads/x.jpg","mediaId":` + fmt.Sprint(missingMedia) + `}},` +
			`"navi-00001":{"id":"navi-00001","type":"navigation","version":1,"attrs":{"menuId":` + fmt.Sprint(menuID) + `}}` + blocks + `}}`
	}
	insert := func(kind, slug, working string, published *string, state string) {
		t.Helper()
		_, err := f.conn.Exec(`INSERT INTO site_templates (theme_slug, kind, slug, title, block_doc, working_state, source, published_block_doc)
			VALUES ($1, $2, $3, $4, $5, $6, 'blank', $7)`, f.theme.Slug, kind, slug, "T "+slug, working, state, published)
		require.NoError(t, err)
	}
	published := doc("PUBLISHED-TEMPLATE", "")
	insert("template", "single", doc("WORKING-TEMPLATE", ""), &published, "custom")
	// A template customized but never published, and a header part reset (published NULL)
	// with a working copy still there: neither is the site's.
	insert("template", "single-post", doc("WORKING-ONLY", ""), nil, "custom")
	insert("part", "header", `{"doc_version":1,"blocks_order":["para-00002"],"blocks":{"para-00002":{"id":"para-00002","type":"paragraph","version":1,"attrs":{"text":"WORKING-PART"}}}}`, nil, "reset")
	bannerPublished := `{"doc_version":1,"blocks_order":["para-00003"],"blocks":{"para-00003":{"id":"para-00003","type":"paragraph","version":1,"attrs":{"text":"PUBLISHED-BANNER"}}}}`
	insert("part", "banner", `{"doc_version":1,"blocks_order":[],"blocks":{}}`, &bannerPublished, "custom")

	path := "/public/site-templates/resolve?theme=" + f.theme.Slug + "&slugs=single-post,single"
	recorder := cacheGet(t, f.server, path)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	body := recorder.Body.String()
	for _, never := range []string{"WORKING-TEMPLATE", "WORKING-ONLY", "WORKING-PART"} {
		require.NotContains(t, body, never)
	}
	var res SiteTemplateResolveResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &res))
	require.NotNil(t, res.Template)
	require.Equal(t, "single", res.Template.Slug)
	require.Equal(t, 1, res.Template.Rank)
	require.Contains(t, body, "PUBLISHED-TEMPLATE")
	// The media of the doc, as /public/posts/:id/blocks attaches it.
	require.Equal(t, []any{float64(missingMedia)}, res.Template.Doc["media_missing"])
	// The reset header renders core's starter; the published banner is there for <TemplatePart>.
	require.Equal(t, siteDesignSourceStarter, res.Parts["header"].Source)
	require.Equal(t, siteDesignSourceOverride, res.Parts["banner"].Source)
	require.Contains(t, body, "PUBLISHED-BANNER")
	key := fmt.Sprint(menuID)
	require.Contains(t, res.Menus, key)
	require.Equal(t, "Resolve test menu", res.Menus[key].Name)
	require.Equal(t, "/resolve-link", res.Menus[key].Items[0].URL)

	// Cached under the theme and the slugs.
	require.Equal(t, "MISS", recorder.Header().Get(publicCacheHeader))
	require.Equal(t, "HIT", cacheGet(t, f.server, path).Header().Get(publicCacheHeader))
	require.Equal(t, "MISS", cacheGet(t, f.server, strings.Replace(path, "single-post,single", "single", 1)).Header().Get(publicCacheHeader))

	// Another theme's slug is a 404, never its design.
	require.Equal(t, http.StatusNotFound, cacheGet(t, f.server, "/public/site-templates/resolve?theme=default-x&slugs=single").Code)

	// A menu save purges it (navigation blocks): the next read is a miss with the new label.
	requireStatus(t, f.request(t, &f.admin, http.MethodPut, fmt.Sprintf("/api/v1/menus/%d/items", menuID),
		`{"items":[{"type":"custom","label":"Renamed link","url":"/resolve-link"}]}`), http.StatusOK)
	after := cacheGet(t, f.server, path)
	require.Equal(t, "MISS", after.Header().Get(publicCacheHeader))
	require.Contains(t, after.Body.String(), "Renamed link")
}
