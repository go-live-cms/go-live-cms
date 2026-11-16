package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Publish site design (#492) against the test database (skipped without one), through the
// routes: one release per publish with versions for changed items only; a failed flush
// publishes nothing; an empty template and an unresolved part are refused, naming them;
// contrast asks first; a reset publishes NULL and a restore brings it back; delete; the
// history routes; the styles restore and discard; the purge and the activity.

type publishDB struct {
	siteDesignDBFixture
	t *testing.T
}

func (p publishDB) call(method, path, body string) (int, map[string]json.RawMessage) {
	p.t.Helper()
	recorder := p.request(p.t, &p.admin, method, path, body)
	var out map[string]json.RawMessage
	_ = json.Unmarshal(recorder.Body.Bytes(), &out)
	return recorder.Code, out
}

func (p publishDB) create(kind, slug, from string) SiteTemplateResponse {
	p.t.Helper()
	recorder := p.request(p.t, &p.admin, http.MethodPost, "/api/v1/site-design/templates", fmt.Sprintf(`{"kind":%q,"slug":%q,"from":%q}`, kind, slug, from))
	requireStatus(p.t, recorder, http.StatusCreated)
	var row SiteTemplateResponse
	require.NoError(p.t, json.Unmarshal(recorder.Body.Bytes(), &row))
	return row
}

// store is what the collab server does after an edit: PUT the derived doc through the
// internal route (the only writer of block_doc, rule 11).
func (p publishDB) store(id int64, doc map[string]any) {
	p.t.Helper()
	row, err := p.siteDesignDBFixture.store.GetSiteTemplate(context.Background(), id)
	require.NoError(p.t, err)
	body, err := json.Marshal(map[string]any{
		"state":         base64.StdEncoding.EncodeToString([]byte{1, 2}),
		"epoch":         "6f1c5f4e-9a59-4d55-9a4d-2b8f0d9e1a01",
		"block_doc":     doc,
		"base_revision": row.BlockRevision,
	})
	require.NoError(p.t, err)
	recorder := internalCollabRequest(p.t, p.server, http.MethodPut, fmt.Sprintf("/internal/site-templates/%d/collab", id), body, "Bearer "+testRoleLookupSecret)
	require.Equal(p.t, http.StatusOK, recorder.Code, recorder.Body.String())
}

func (p publishDB) row(id int64) db.SiteTemplate {
	p.t.Helper()
	row, err := p.siteDesignDBFixture.store.GetSiteTemplate(context.Background(), id)
	require.NoError(p.t, err)
	return row
}

func (p publishDB) count(query string, args ...any) int {
	p.t.Helper()
	var n int
	require.NoError(p.t, p.conn.QueryRow(query, args...).Scan(&n))
	return n
}

func (p publishDB) releases() int {
	return p.count(`SELECT count(*) FROM site_design_releases WHERE theme_slug = $1`, p.theme.Slug)
}

func (p publishDB) versions(id int64) int {
	return p.count(`SELECT count(*) FROM site_template_versions WHERE template_id = $1`, id)
}

func (p publishDB) flushes(id int64) int {
	p.collab.mu.Lock()
	defer p.collab.mu.Unlock()
	return p.collab.flushes[fmt.Sprintf("template-%d", id)]
}

// designDoc is a template doc: a heading, then a template_part per slug.
func designDoc(text string, parts ...string) map[string]any {
	blocks := map[string]any{
		"blk-heading-0001": map[string]any{"id": "blk-heading-0001", "type": "heading", "version": 1, "attrs": map[string]any{"level": 2, "text": text}},
	}
	order := []string{"blk-heading-0001"}
	for i, slug := range parts {
		id := fmt.Sprintf("blk-part-%07d", i)
		blocks[id] = map[string]any{"id": id, "type": "template_part", "version": 1, "attrs": map[string]any{"slug": slug}}
		order = append(order, id)
	}
	return map[string]any{"doc_version": 1, "blocks_order": order, "blocks": blocks}
}

func TestPublishSiteDesignTemplates(t *testing.T) {
	p := publishDB{siteDesignDBFixture: newSiteDesignDBFixture(t), t: t}
	const publish = "/api/v1/site-design/publish"

	single := p.create("template", "single", "starter") // header + footer parts: core's starters resolve them
	header := p.create("part", "header", "starter")

	// The publish dialog's list: both items, and the count.
	status, list := p.call(http.MethodGet, "/api/v1/site-design/templates", "")
	require.Equal(t, http.StatusOK, status)
	require.JSONEq(t, `2`, string(list["unpublished_changes"]))
	require.Contains(t, string(list["templates"]), `"change":"publish"`)

	// The public cache is warm before the publish.
	p.activeThemeStyles(t)
	_, cached := p.activeThemeStyles(t)
	require.Equal(t, "HIT", cached)

	// 1. A failed flush publishes nothing.
	p.collab.fail.Store(true)
	status, out := p.call(http.MethodPost, publish, `{}`)
	require.Equal(t, http.StatusServiceUnavailable, status)
	require.JSONEq(t, `"collab_unavailable"`, string(out["code"]))
	require.Zero(t, p.releases())
	require.False(t, p.row(single.ID).PublishedBlockDoc.Valid)
	p.collab.fail.Store(false)
	// (A 5xx purges anyway, the middleware's caution; re-warm before the real publish.)
	p.activeThemeStyles(t)
	_, cached = p.activeThemeStyles(t)
	require.Equal(t, "HIT", cached)

	// 2. One release, a version for each changed item, both published; every custom row was flushed first.
	status, out = p.call(http.MethodPost, publish, `{}`)
	require.Equal(t, http.StatusOK, status, out)
	require.JSONEq(t, `null`, string(out["global_styles"]), "the styles weren't in it")
	var published []SiteTemplatePublished
	require.NoError(t, json.Unmarshal(out["templates"], &published))
	require.Len(t, published, 2)
	require.Equal(t, "single", published[0].Slug, "templates first")
	require.EqualValues(t, 1, published[0].VersionNo)
	require.Equal(t, 1, p.releases())
	require.Equal(t, 1, p.versions(single.ID))
	require.Equal(t, 1, p.versions(header.ID))
	require.True(t, p.row(single.ID).PublishedBlockDoc.Valid)
	require.JSONEq(t, string(p.row(single.ID).BlockDoc), string(p.row(single.ID).PublishedBlockDoc.RawMessage))
	require.GreaterOrEqual(t, p.flushes(single.ID), 1)
	require.GreaterOrEqual(t, p.flushes(header.ID), 1)
	_, cached = p.activeThemeStyles(t)
	require.Equal(t, "MISS", cached, "the publish purged the public cache after commit")
	require.Equal(t, 1, p.count(`SELECT count(*) FROM activity WHERE verb = $1 AND object_type = $2 AND object_id = (SELECT max(id) FROM site_design_releases WHERE theme_slug = $3)`,
		db.ActivitySiteDesignPublished, db.ActivityObjectSiteDesign, p.theme.Slug))

	// Nothing changed since: nothing to publish.
	status, out = p.call(http.MethodPost, publish, `{}`)
	require.Equal(t, http.StatusConflict, status)
	require.JSONEq(t, `"nothing_to_publish"`, string(out["code"]))

	// 3. An edit to the template only: the next release versions it and not the part.
	p.store(single.ID, designDoc("Edited", "header", "footer"))
	status, _ = p.call(http.MethodPost, publish, `{}`)
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, 2, p.releases())
	require.Equal(t, 2, p.versions(single.ID))
	require.Equal(t, 1, p.versions(header.ID), "an unchanged item gets no version")
	require.Contains(t, string(p.row(single.ID).PublishedBlockDoc.RawMessage), "Edited")

	// 4. An empty template is refused, naming it; nothing is published.
	blank := p.create("template", "archive", "blank")
	status, out = p.call(http.MethodPost, publish, `{}`)
	require.Equal(t, http.StatusConflict, status)
	require.JSONEq(t, `"design_invalid"`, string(out["code"]))
	require.Contains(t, string(out["problems"]), `"code":"template_empty"`)
	require.Contains(t, string(out["problems"]), `"slug":"archive"`)
	require.Contains(t, string(out["error"]), "archive")
	require.Equal(t, 2, p.releases())
	// Delete it: it was never published.
	status, _ = p.call(http.MethodDelete, fmt.Sprintf("/api/v1/site-design/templates/%d", blank.ID), "")
	require.Equal(t, http.StatusOK, status)

	// 5. An unresolved part is refused, naming the template and the part.
	p.store(single.ID, designDoc("Sidebar", "header", "sidebar"))
	status, out = p.call(http.MethodPost, publish, `{}`)
	require.Equal(t, http.StatusConflict, status)
	require.Contains(t, string(out["problems"]), `"code":"part_unresolved"`)
	require.Contains(t, string(out["problems"]), `"part":"sidebar"`)
	require.Contains(t, string(out["error"]), `sidebar`)
	// A part this publish puts live resolves it.
	sidebar := p.create("part", "sidebar", "blank")
	status, out = p.call(http.MethodPost, publish, `{}`)
	require.Equal(t, http.StatusOK, status, out)
	require.Equal(t, 3, p.releases())
	require.Equal(t, 1, p.versions(sidebar.ID), "an empty part may be published")

	// 6. Contrast asks first, also when templates are in the release; nothing is published until confirmed.
	status, _ = p.call(http.MethodPut, "/api/v1/site-design/global-styles", `{"styles":{"colors":{"light":{"text":"#cccccc"}}},"base_revision":0}`)
	require.Equal(t, http.StatusOK, status)
	p.store(single.ID, designDoc("With styles", "header", "sidebar"))
	status, out = p.call(http.MethodPost, publish, `{}`)
	require.Equal(t, http.StatusConflict, status)
	require.JSONEq(t, `"contrast_unconfirmed"`, string(out["code"]))
	require.Equal(t, 3, p.releases())
	status, out = p.call(http.MethodPost, publish, `{"confirm_contrast":true}`)
	require.Equal(t, http.StatusOK, status, out)
	require.Equal(t, 4, p.releases())
	require.Contains(t, string(out["global_styles"]), `"version_no":1`)
	require.Len(t, decodePublished(t, out), 1, "one release holds the styles and the template")

	// 7. Reset to theme default: the editor's working copy stays, publish makes the published copy NULL.
	status, out = p.call(http.MethodPost, fmt.Sprintf("/api/v1/site-design/templates/%d/reset", single.ID), "")
	require.Equal(t, http.StatusOK, status)
	require.JSONEq(t, `"reset"`, string(out["working_state"]))
	require.JSONEq(t, `"reset"`, string(out["change"]))
	before := p.row(single.ID)
	// Keep editing undoes it; reset again.
	status, out = p.call(http.MethodPost, fmt.Sprintf("/api/v1/site-design/templates/%d/keep-editing", single.ID), "")
	require.Equal(t, http.StatusOK, status)
	require.JSONEq(t, `""`, string(out["change"]))
	p.call(http.MethodPost, fmt.Sprintf("/api/v1/site-design/templates/%d/reset", single.ID), "")
	// A published row can't be deleted.
	status, out = p.call(http.MethodDelete, fmt.Sprintf("/api/v1/site-design/templates/%d", single.ID), "")
	require.Equal(t, http.StatusConflict, status)
	require.JSONEq(t, `"template_published"`, string(out["code"]))
	flushesBefore := p.flushes(single.ID)
	status, out = p.call(http.MethodPost, publish, `{}`)
	require.Equal(t, http.StatusOK, status, out)
	resetVersion := decodePublished(t, out)[0]
	require.True(t, resetVersion.Reset)
	reset := p.row(single.ID)
	require.False(t, reset.PublishedBlockDoc.Valid, "a reset publishes NULL")
	require.JSONEq(t, string(before.BlockDoc), string(reset.BlockDoc), "the working copy is untouched (rule 11)")
	require.Equal(t, flushesBefore, p.flushes(single.ID), "a reset row isn't flushed")
	require.Equal(t, 1, p.count(`SELECT count(*) FROM site_template_versions WHERE template_id = $1 AND version_no = $2 AND block_doc IS NULL`, single.ID, resetVersion.VersionNo))

	// 8. History: the versions, the reset one marked, and a version's doc for the editor.
	status, out = p.call(http.MethodGet, fmt.Sprintf("/api/v1/site-design/templates/%d/versions", single.ID), "")
	require.Equal(t, http.StatusOK, status)
	var versions []SiteTemplateVersionResponse
	require.NoError(t, json.Unmarshal(out["versions"], &versions))
	require.Len(t, versions, 5)
	require.True(t, versions[0].Reset)
	require.True(t, versions[0].Current)
	status, out = p.call(http.MethodGet, fmt.Sprintf("/api/v1/site-design/templates/%d/versions/2", single.ID), "")
	require.Equal(t, http.StatusOK, status)
	require.Contains(t, string(out["block_doc"]), "Edited")
	status, out = p.call(http.MethodGet, fmt.Sprintf("/api/v1/site-design/templates/%d/versions/%d", single.ID, resetVersion.VersionNo), "")
	require.Equal(t, http.StatusOK, status)
	require.JSONEq(t, `null`, string(out["block_doc"]))
	status, out = p.call(http.MethodPost, fmt.Sprintf("/api/v1/site-design/templates/%d/versions/%d/restore", single.ID, resetVersion.VersionNo), "")
	require.Equal(t, http.StatusConflict, status)
	require.JSONEq(t, `"version_is_reset"`, string(out["code"]))
	status, out = p.call(http.MethodGet, "/api/v1/site-design/releases?limit=2", "")
	require.Equal(t, http.StatusOK, status)
	var releases []SiteDesignReleaseEntry
	require.NoError(t, json.Unmarshal(out["releases"], &releases))
	require.Len(t, releases, 2)
	require.Equal(t, "single", releases[0].Items[0].Slug)
	require.True(t, releases[0].Items[0].Reset)
	require.NotNil(t, releases[1].GlobalStylesVersion)
	require.NotEqual(t, `null`, string(out["next_before"]))

	// 9. A restore brings it back: the editor stores version 2's doc (rule 9), then the route records it.
	var version2 struct {
		BlockDoc map[string]any `json:"block_doc"`
	}
	_, out = p.call(http.MethodGet, fmt.Sprintf("/api/v1/site-design/templates/%d/versions/2", single.ID), "")
	require.NoError(t, json.Unmarshal(out["block_doc"], &version2.BlockDoc))
	p.store(single.ID, version2.BlockDoc)
	status, out = p.call(http.MethodPost, fmt.Sprintf("/api/v1/site-design/templates/%d/versions/2/restore", single.ID), "")
	require.Equal(t, http.StatusOK, status)
	require.JSONEq(t, `"custom"`, string(out["working_state"]))
	require.JSONEq(t, `"publish"`, string(out["change"]))
	require.Equal(t, 1, p.count(`SELECT count(*) FROM activity WHERE verb = $1 AND object_id = $2 AND payload->>'version_no' = '2'`, db.ActivitySiteTemplateRestored, single.ID))
	status, _ = p.call(http.MethodPost, publish, `{}`)
	require.Equal(t, http.StatusOK, status)
	require.Contains(t, string(p.row(single.ID).PublishedBlockDoc.RawMessage), "Edited", "the restored version is live again")

	// 10. Start over from the starter: the doc to put into the editor, then the source is recorded.
	status, out = p.call(http.MethodGet, fmt.Sprintf("/api/v1/site-design/templates/%d/default", single.ID), "")
	require.Equal(t, http.StatusOK, status)
	require.JSONEq(t, `"starter"`, string(out["source"]))
	require.Contains(t, string(out["block_doc"]), `"template_part"`)
	status, _ = p.call(http.MethodPost, fmt.Sprintf("/api/v1/site-design/templates/%d/start-over", single.ID), `{}`)
	require.Equal(t, http.StatusOK, status)

	// Each verb was recorded.
	for _, verb := range []string{db.ActivitySiteTemplateReset, db.ActivitySiteTemplateResetCancelled, db.ActivitySiteTemplateDeleted, db.ActivitySiteTemplateStartedOver} {
		require.Positive(t, p.count(`SELECT count(*) FROM activity WHERE verb = $1 AND object_type = $2 AND object_id = ANY($3::bigint[])`,
			verb, db.ActivityObjectSiteDesign, fmt.Sprintf("{%d,%d}", single.ID, blank.ID)), verb)
	}
}

func decodePublished(t *testing.T, out map[string]json.RawMessage) []SiteTemplatePublished {
	t.Helper()
	var published []SiteTemplatePublished
	require.NoError(t, json.Unmarshal(out["templates"], &published))
	return published
}

// The styles' history: restore a version into the draft and discard back to the published styles.
func TestGlobalStylesRestoreAndDiscard(t *testing.T) {
	p := publishDB{siteDesignDBFixture: newSiteDesignDBFixture(t), t: t}
	put := func(styles string, base int) {
		t.Helper()
		status, out := p.call(http.MethodPut, "/api/v1/site-design/global-styles", fmt.Sprintf(`{"styles":%s,"base_revision":%d}`, styles, base))
		require.Equal(t, http.StatusOK, status, out)
	}
	put(`{"radius":{"md":"10px"}}`, 0)
	status, _ := p.call(http.MethodPost, "/api/v1/site-design/publish", `{}`)
	require.Equal(t, http.StatusOK, status)
	put(`{"radius":{"md":"12px"}}`, 1)
	status, _ = p.call(http.MethodPost, "/api/v1/site-design/publish", `{}`)
	require.Equal(t, http.StatusOK, status)

	status, out := p.call(http.MethodGet, "/api/v1/site-design/global-styles/versions", "")
	require.Equal(t, http.StatusOK, status)
	require.Contains(t, string(out["versions"]), `"version_no":2`)
	status, out = p.call(http.MethodGet, "/api/v1/site-design/global-styles/versions/1", "")
	require.Equal(t, http.StatusOK, status)
	require.JSONEq(t, `{"radius":{"md":"10px"}}`, string(out["styles"]))

	// A stale base revision is refused with the current draft.
	status, out = p.call(http.MethodPost, "/api/v1/site-design/global-styles/versions/1/restore", `{"base_revision":0}`)
	require.Equal(t, http.StatusConflict, status)
	require.JSONEq(t, `"styles_changed"`, string(out["code"]))
	// Restore version 1 into the draft: the site is unchanged until the next publish.
	status, out = p.call(http.MethodPost, "/api/v1/site-design/global-styles/versions/1/restore", `{"base_revision":2}`)
	require.Equal(t, http.StatusOK, status, out)
	require.JSONEq(t, `{"radius":{"md":"10px"}}`, string(out["draft"]))
	require.JSONEq(t, `true`, string(out["has_unpublished_changes"]))
	styles, _ := p.activeThemeStyles(t)
	require.Contains(t, styles, "12px")

	// Discard: the published styles are the draft again, nothing to publish.
	status, out = p.call(http.MethodPost, "/api/v1/site-design/global-styles/discard", `{"base_revision":3}`)
	require.Equal(t, http.StatusOK, status, out)
	require.JSONEq(t, `{"radius":{"md":"12px"}}`, string(out["draft"]))
	status, out = p.call(http.MethodPost, "/api/v1/site-design/publish", `{}`)
	require.Equal(t, http.StatusConflict, status)
	require.JSONEq(t, `"nothing_to_publish"`, string(out["code"]))
	require.Equal(t, 1, p.count(`SELECT count(*) FROM activity WHERE verb = $1 AND object_id = $2`, db.ActivityGlobalStylesRestored, p.theme.ID))
	require.Equal(t, 1, p.count(`SELECT count(*) FROM activity WHERE verb = $1 AND object_id = $2`, db.ActivityGlobalStylesDiscarded, p.theme.ID))
}

// PublishSiteDesignTx refuses rows that moved since the caller validated them (a store, a
// reset, a new or deleted row), writing nothing.
func TestPublishSiteDesignTxRowsChanged(t *testing.T) {
	p := publishDB{siteDesignDBFixture: newSiteDesignDBFixture(t), t: t}
	ctx := context.Background()
	single := p.create("template", "single", "starter")
	rows, err := p.siteDesignDBFixture.store.ListSiteTemplatesByTheme(ctx, p.theme.Slug)
	require.NoError(t, err)
	stamps := []db.SiteTemplateStamp{db.StampOf(rows[0])}
	params := db.PublishSiteDesignTxParams{ThemeSlug: p.theme.Slug, Summary: json.RawMessage(`{}`), Rows: stamps, Publish: []int64{single.ID}}

	// A store since.
	p.store(single.ID, designDoc("Moved", "header"))
	_, err = p.siteDesignDBFixture.store.PublishSiteDesignTx(ctx, params)
	require.ErrorIs(t, err, db.ErrSiteDesignChanged)
	// A new row since (it would change part resolution).
	rows, err = p.siteDesignDBFixture.store.ListSiteTemplatesByTheme(ctx, p.theme.Slug)
	require.NoError(t, err)
	params.Rows = []db.SiteTemplateStamp{db.StampOf(rows[0])}
	p.create("part", "header", "starter")
	_, err = p.siteDesignDBFixture.store.PublishSiteDesignTx(ctx, params)
	require.ErrorIs(t, err, db.ErrSiteDesignChanged)
	require.Zero(t, p.releases())
	require.Zero(t, p.versions(single.ID))

	// The hook runs inside, once per published row; its error rolls everything back.
	rows, err = p.siteDesignDBFixture.store.ListSiteTemplatesByTheme(ctx, p.theme.Slug)
	require.NoError(t, err)
	params.Rows = nil
	params.Publish = nil
	for _, row := range rows {
		params.Rows = append(params.Rows, db.StampOf(row))
		params.Publish = append(params.Publish, row.ID)
	}
	hooked := 0
	params.PublishedTemplate = func(_ context.Context, _ *db.Queries, row db.SiteTemplate) error {
		hooked++
		if hooked == 2 {
			return fmt.Errorf("hook failed")
		}
		require.True(t, row.PublishedBlockDoc.Valid)
		return nil
	}
	_, err = p.siteDesignDBFixture.store.PublishSiteDesignTx(ctx, params)
	require.Error(t, err)
	require.Zero(t, p.releases())
	require.False(t, p.row(single.ID).PublishedBlockDoc.Valid)
	params.PublishedTemplate = nil
	result, err := p.siteDesignDBFixture.store.PublishSiteDesignTx(ctx, params)
	require.NoError(t, err)
	require.Len(t, result.Templates, 2)
	require.Nil(t, result.Styles)
	require.Equal(t, 1, p.releases())
}
