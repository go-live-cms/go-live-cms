package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Builder page templates (#494, docs/design/theme-builder.md section 10) against the test
// database (skipped without one), through the routes: a custom-<name> template is offered
// and accepted only once it is published; the page stores block:<name>, which goes live
// on Update; a reset leaves the name stored (the page renders the default) and versions
// restore it; the column takes block:<name> and nothing looser.
func TestBuilderPageTemplates(t *testing.T) {
	p := publishDB{siteDesignDBFixture: newSiteDesignDBFixture(t), t: t}
	ctx := context.Background()
	store := p.siteDesignDBFixture.store
	editor := scheduleUser(t, store, RoleEditor)
	suffix := lettersOnly(uuid.NewString())[:12]
	page := createTestPage(t, store, editor, "Pricing "+suffix, "pricing-"+suffix)

	offered := func() PageTemplatesResponse {
		t.Helper()
		recorder := p.request(t, &editor, http.MethodGet, "/api/v1/posts/page-templates", "")
		requireStatus(t, recorder, http.StatusOK)
		var list PageTemplatesResponse
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &list))
		require.NotNil(t, list.Theme)
		require.Equal(t, p.theme.Slug, list.Theme.Slug)
		return list
	}
	pick := func(name string) *httptest.ResponseRecorder {
		t.Helper()
		return p.request(t, &editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/template", page.ID), fmt.Sprintf(`{"page_template":%q}`, name))
	}
	stored := func() string {
		t.Helper()
		post, err := store.GetPost(ctx, page.ID)
		require.NoError(t, err)
		return post.PageTemplate
	}
	public := func() string {
		t.Helper()
		recorder := httptest.NewRecorder()
		p.server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, fmt.Sprintf("/public/posts/%d", page.ID), nil))
		requireStatus(t, recorder, http.StatusOK)
		var view publicPostView
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &view))
		return view.Post.PageTemplate
	}
	resolved := func() string {
		t.Helper()
		recorder := httptest.NewRecorder()
		p.server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/public/site-templates/resolve?theme="+p.theme.Slug+"&slugs=custom-landing,page", nil))
		requireStatus(t, recorder, http.StatusOK)
		var body struct {
			Template *struct {
				Slug string `json:"slug"`
			} `json:"template"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		if body.Template == nil {
			return ""
		}
		return body.Template.Slug
	}

	// Not published yet: neither offered nor accepted.
	landing := p.create("template", "custom-landing", "starter")
	require.Empty(t, offered().BuilderTemplates)
	recorder := pick("block:landing")
	requireStatus(t, recorder, http.StatusBadRequest)
	require.Contains(t, recorder.Body.String(), `"code":"unknown_template"`)

	// Published: offered by its title, and a page can store it.
	status, out := p.call(http.MethodPost, "/api/v1/site-design/publish", `{}`)
	require.Equal(t, http.StatusOK, status, out)
	require.Equal(t, []BuilderPageTemplate{{Name: "block:landing", Label: landing.Title}}, offered().BuilderTemplates)
	requireStatus(t, pick("block:landing"), http.StatusOK)
	require.Equal(t, "block:landing", stored())
	require.Equal(t, "custom-landing", resolved())

	// It goes live with the page (version 1), like any setting: Publish and Update go
	// through the route, which purges the public cache (#185).
	update := func() {
		t.Helper()
		requireStatus(t, p.request(t, &editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", page.ID), `{}`), http.StatusOK)
	}
	update()
	require.Equal(t, "block:landing", public())

	// Back to the default: the site keeps the published name until Update (version 2).
	requireStatus(t, pick("default"), http.StatusOK)
	require.Equal(t, "block:landing", public())
	update()
	require.Equal(t, "", public())

	// Reset and published: no longer offered or accepted, nothing to resolve but `page`.
	status, out = p.call(http.MethodPost, fmt.Sprintf("/api/v1/site-design/templates/%d/reset", landing.ID), "")
	require.Equal(t, http.StatusOK, status, out)
	status, out = p.call(http.MethodPost, "/api/v1/site-design/publish", `{}`)
	require.Equal(t, http.StatusOK, status, out)
	require.Empty(t, offered().BuilderTemplates)
	requireStatus(t, pick("block:landing"), http.StatusBadRequest)
	require.Equal(t, "", resolved())

	// Version 1 had the builder template: restoring its settings brings the name back
	// although the template is reset. The page keeps it and renders the default until the
	// template is published again (the web's pageLayoutVariant and resolveTemplate).
	recorder = settingsRequest(t, p.server, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/versions/1/restore-settings", page.ID), editor)
	requireStatus(t, recorder, http.StatusOK)
	require.Equal(t, "block:landing", stored())
	update()
	require.Equal(t, "block:landing", public())

	// 000062's CHECK: block:<name> in the builder's own alphabet only.
	for _, bad := range []string{"block:Landing", "block:", "block:a_b", "block:../x", "blocks:landing"} {
		_, err := store.UpdatePostPageTemplate(ctx, db.UpdatePostPageTemplateParams{ID: page.ID, PageTemplate: bad})
		require.Error(t, err, bad)
	}
}
