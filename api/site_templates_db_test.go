package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"

	"github.com/go-live-cms/go-live-cms/api/sitedesign"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Templates and parts (#490) against the test database (skipped without one): Customize
// from each source (a slug with `_` included), the collab server's load and store through
// the internal router with the revision guard, the kind's rules on store, the access
// lookup and tickets, and the activity.

func TestSiteTemplatesCustomizeAndCollab(t *testing.T) {
	f := newSiteDesignDBFixture(t)
	ctx := context.Background()
	t.Cleanup(func() { _, _ = f.conn.Exec(`DELETE FROM site_templates WHERE theme_slug = $1`, f.theme.Slug) })

	// The theme ships `single` (what the scan stores in its config).
	root, _ := newShippingTheme(t)
	themes, err := ScanThemesDirectory(root)
	require.NoError(t, err)
	applyThemeBlockTemplates(themes, f.server.themeBlocks)
	config, err := json.Marshal(themes[0].Config)
	require.NoError(t, err)
	_, err = f.store.UpdateTheme(ctx, db.UpdateThemeParams{ID: f.theme.ID, Config: pqtype.NullRawMessage{RawMessage: config, Valid: true}})
	require.NoError(t, err)

	create := func(body string) SiteTemplateResponse {
		t.Helper()
		recorder := f.request(t, &f.admin, http.MethodPost, "/api/v1/site-design/templates", body)
		requireStatus(t, recorder, http.StatusCreated)
		var res SiteTemplateResponse
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &res))
		require.Equal(t, f.theme.Slug, res.ThemeSlug)
		return res
	}

	fromTheme := create(`{"kind":"template","slug":"single","from":"theme"}`)
	require.Equal(t, "theme", fromTheme.Source)
	require.Equal(t, int64(1), fromTheme.BlockRevision)
	shipped, ok := themeBlockTemplateFromConfig(config, sitedesign.KindTemplate, "single")
	require.True(t, ok)
	require.Equal(t, shipped.Hash, fromTheme.SourceHash)
	caseStudy := create(`{"kind":"template","slug":"single-case_study","from":"starter"}`)
	require.Equal(t, "single-case_study", caseStudy.Slug, "a slug with _ stores")
	header := create(`{"kind":"part","slug":"header","from":"starter"}`)
	blank := create(`{"kind":"part","slug":"promo_bar","from":"blank","title":"Promo bar"}`)
	require.Equal(t, "Promo bar", blank.Title)

	recorder := f.request(t, &f.admin, http.MethodPost, "/api/v1/site-design/templates", `{"kind":"template","slug":"single-case_study","from":"blank"}`)
	rsp := requireCode(t, recorder, http.StatusConflict, "template_exists")
	require.JSONEq(t, fmt.Sprint(caseStudy.ID), string(rsp["id"]))
	editor := scheduleUser(t, f.store, RoleEditor)
	requireStatus(t, f.request(t, &editor, http.MethodPost, "/api/v1/site-design/templates", `{"kind":"part","slug":"footer","from":"starter"}`), http.StatusForbidden)

	var created int
	require.NoError(t, f.conn.QueryRow(`SELECT count(*) FROM activity WHERE verb = $1 AND object_type = $2 AND object_id = ANY($3::bigint[])`,
		db.ActivitySiteTemplateCreated, db.ActivityObjectSiteDesign, fmt.Sprintf("{%d,%d,%d,%d}", fromTheme.ID, caseStudy.ID, header.ID, blank.ID)).Scan(&created))
	require.Equal(t, 4, created)

	// The collab server's load of the new row: the working copy, its kind, no state yet.
	internal := func(method, path string, body []byte) (int, map[string]json.RawMessage) {
		t.Helper()
		recorder := internalCollabRequest(t, f.server, method, path, body, "Bearer "+testRoleLookupSecret)
		var out map[string]json.RawMessage
		_ = json.Unmarshal(recorder.Body.Bytes(), &out)
		return recorder.Code, out
	}
	status, loaded := internal(http.MethodGet, fmt.Sprintf("/internal/site-templates/%d/collab", header.ID), nil)
	require.Equal(t, http.StatusOK, status)
	require.JSONEq(t, `"part"`, string(loaded["doc_kind"]))
	require.JSONEq(t, `1`, string(loaded["block_revision"]))
	require.NotContains(t, loaded, "ydoc_state")

	put := func(id int64, fields map[string]any) (int, map[string]json.RawMessage) {
		body := map[string]any{"state": base64.StdEncoding.EncodeToString([]byte{7, 7}), "epoch": "6f1c5f4e-9a59-4d55-9a4d-2b8f0d9e1a01"}
		for k, v := range fields {
			body[k] = v
		}
		data, err := json.Marshal(body)
		require.NoError(t, err)
		return internal(http.MethodPut, fmt.Sprintf("/internal/site-templates/%d/collab", id), data)
	}
	// The seed's state-only store, then an edit.
	status, _ = put(header.ID, map[string]any{"base_revision": 1})
	require.Equal(t, http.StatusOK, status)
	partDoc := map[string]any{"doc_version": 1, "blocks_order": []string{"title-000001"}, "blocks": map[string]any{
		"title-000001": map[string]any{"id": "title-000001", "type": "site_title", "version": 1, "attrs": map[string]any{"level": 2}},
	}}
	status, out := put(header.ID, map[string]any{"base_revision": 1, "block_doc": partDoc, "last_editor_id": f.admin.ID})
	require.Equal(t, http.StatusOK, status, out)
	require.JSONEq(t, `2`, string(out["block_revision"]))
	status, loaded = internal(http.MethodGet, fmt.Sprintf("/internal/site-templates/%d/collab", header.ID), nil)
	require.Equal(t, http.StatusOK, status)
	require.Contains(t, loaded, "ydoc_state")
	require.JSONEq(t, `"6f1c5f4e-9a59-4d55-9a4d-2b8f0d9e1a01"`, string(loaded["epoch"]))

	// The part's rules: a template_part in it is refused, nothing written.
	nested := map[string]any{"doc_version": 1, "blocks_order": []string{"part-000001"}, "blocks": map[string]any{
		"part-000001": map[string]any{"id": "part-000001", "type": "template_part", "version": 1, "attrs": map[string]any{"slug": "footer"}},
	}}
	status, _ = put(header.ID, map[string]any{"base_revision": 2, "block_doc": nested})
	require.Equal(t, http.StatusBadRequest, status)
	// The same doc in a template stores.
	status, _ = put(caseStudy.ID, map[string]any{"base_revision": 1, "block_doc": nested})
	require.Equal(t, http.StatusOK, status)
	// A store behind is refused.
	status, _ = put(header.ID, map[string]any{"base_revision": 1})
	require.Equal(t, http.StatusConflict, status)

	// Written around the collab server: the state is withheld, so the server reseeds.
	_, err = f.conn.Exec(`UPDATE site_templates SET block_revision = block_revision + 1 WHERE id = $1`, header.ID)
	require.NoError(t, err)
	status, loaded = internal(http.MethodGet, fmt.Sprintf("/internal/site-templates/%d/collab", header.ID), nil)
	require.Equal(t, http.StatusOK, status)
	require.NotContains(t, loaded, "ydoc_state")
	require.NotContains(t, loaded, "epoch")
	status, _ = internal(http.MethodGet, "/internal/site-templates/999999999/collab", nil)
	require.Equal(t, http.StatusNotFound, status)

	// The access lookup: admins edit, an editor doesn't (the collab server denies it).
	access := func(user db.User, doc string) (int, string) {
		recorder := internalCollabRequest(t, f.server, http.MethodGet,
			fmt.Sprintf("/internal/users/%d/access?doc=%s&issued_at=%d", user.ID, doc, user.PasswordChangedAt.Unix()+10), nil, "Bearer "+testRoleLookupSecret)
		return recorder.Code, recorder.Body.String()
	}
	code, body := access(f.admin, fromTheme.DocName)
	require.Equal(t, http.StatusOK, code)
	require.JSONEq(t, `{"role":"admin","can_edit":true}`, body)
	code, body = access(editor, fromTheme.DocName)
	require.Equal(t, http.StatusOK, code)
	require.JSONEq(t, `{"role":"editor","can_edit":false}`, body)
	code, _ = access(f.admin, "template-999999999")
	require.Equal(t, http.StatusNotFound, code)

	// Tickets: admins only.
	requireStatus(t, f.request(t, &f.admin, http.MethodPost, "/api/v1/collab/tickets", fmt.Sprintf(`{"doc":%q}`, fromTheme.DocName)), http.StatusOK)
	requireStatus(t, f.request(t, &editor, http.MethodPost, "/api/v1/collab/tickets", fmt.Sprintf(`{"doc":%q}`, fromTheme.DocName)), http.StatusForbidden)

	// Nothing about templates reaches the public reads: the working copy is never public.
	for _, path := range []string{"/api/v1/themes/active", "/public/posts"} {
		recorder := cacheGet(t, f.server, path)
		require.NotContains(t, recorder.Body.String(), "promo_bar", path)
	}
}
