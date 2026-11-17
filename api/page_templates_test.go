package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Page templates (#336): the theme scan's list, the names PUT /posts/:id/template
// accepts, and the published template /public answers.

func writePageLayouts(t *testing.T, dir string, names ...string) {
	t.Helper()
	pageDir := filepath.Join(dir, "layouts", "page")
	require.NoError(t, os.MkdirAll(pageDir, 0o755))
	for _, name := range names {
		require.NoError(t, os.WriteFile(filepath.Join(pageDir, name), []byte("---\n---\n"), 0o644))
	}
}

func TestScanPageTemplatesRepoThemes(t *testing.T) {
	// The default theme declares both of its layouts with labels and descriptions.
	defaults := scanPageTemplates(filepath.Join("..", "web", "themes", "default"), readThemeConfig(t, "default"))
	require.Equal(t, []PageTemplate{
		{Name: "default", Label: "Default", Description: "One reading column"},
		{Name: "fullwidth", Label: "Full width", Description: "A title band across the page; content can run edge to edge"},
	}, defaults)

	// The example theme lists "fullwidth" in the simple form but has no file for it:
	// only what can be rendered is offered.
	example := scanPageTemplates(filepath.Join("..", "web", "themes", "example"), readThemeConfig(t, "example"))
	require.Equal(t, []PageTemplate{{Name: "default", Label: "Default"}}, example)
}

func readThemeConfig(t *testing.T, slug string) string {
	t.Helper()
	content, err := os.ReadFile(filepath.Join("..", "web", "themes", slug, "theme.config.ts"))
	require.NoError(t, err)
	return string(content)
}

func TestScanPageTemplates(t *testing.T) {
	dir := t.TempDir()
	writePageLayouts(t, dir, "default.astro", "landing.astro", "full-width.astro", "zeta_page.astro", "bad name.astro", "notes.md")
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "layouts", "page", "partials.astro"), 0o755))

	config := `
export interface ThemeConfig {
  layouts: { post: Record<string, LayoutVariant>; page: Record<string, LayoutVariant> }
}
export const themeConfig = {
  supports: { postTypes: ["post", "page"] },
  layouts: {
    post: { default: { file: "layouts/post/default.astro", label: "Post" } },
    page: {
      landing: { file: "layouts/page/landing.astro", label: "Landing", description: 'A hero, then sections' },
      "full-width": { file: "layouts/page/full-width.astro", description: "Edge to edge" },
      ghost: { file: "layouts/page/ghost.astro", label: "Never shipped" },
      default: { file: "layouts/page/default.astro", label: "Standard" },
    },
  },
}`
	require.Equal(t, []PageTemplate{
		// "default" first whatever the declared order, with its declared label.
		{Name: "default", Label: "Standard"},
		{Name: "landing", Label: "Landing", Description: "A hero, then sections"},
		// No label: from its name.
		{Name: "full-width", Label: "Full width", Description: "Edge to edge"},
		// Undeclared files follow, by name; "ghost" has no file, "bad name" isn't a
		// name, notes.md and the directory aren't layouts.
		{Name: "zeta_page", Label: "Zeta page"},
	}, scanPageTemplates(dir, config))

	// No layouts/page directory: none.
	require.Nil(t, scanPageTemplates(t.TempDir(), config))
}

func TestParseDeclaredPageLayoutsSimpleForm(t *testing.T) {
	require.Nil(t, parseDeclaredPageLayouts(`layouts: { page: { default: "default", variants: ["default", "fullwidth"] } }`))
	require.Nil(t, parseDeclaredPageLayouts(`export default {}`))
	// An unclosed block still parses what it has.
	require.Equal(t, []PageTemplate{{Name: "default", Label: "D"}}, parseDeclaredPageLayouts(`page: { default: { label: "D" }`))
}

func TestHumanizeTemplateName(t *testing.T) {
	for in, want := range map[string]string{
		"default":    "Default",
		"full-width": "Full width",
		"BIG_hero":   "Big hero",
		"x":          "X",
		"--":         "--",
	} {
		require.Equal(t, want, humanizeTemplateName(in), in)
	}
}

func TestNormalizePageTemplate(t *testing.T) {
	for _, tc := range []struct {
		in, want string
		ok       bool
	}{
		{"", "", true},
		{"default", "", true},
		{"  default ", "", true},
		{" fullwidth ", "fullwidth", true},
		{"full-width_2", "full-width_2", true},
		{"../secret", "../secret", false},
		{"page/default", "page/default", false},
		{"two words", "two words", false},
		{"fullwidth.astro", "fullwidth.astro", false},
		// Builder page templates (#494): block:<name> in the builder's alphabet.
		{" block:landing ", "block:landing", true},
		{"block:spring-2", "block:spring-2", true},
		{"block:Landing", "", false},
		{"block:", "", false},
		{"block:a_b", "", false},
		{"block:../x", "", false},
		{"block:" + strings.Repeat("a", 65), "", false},
		{"custom-landing:x", "", false},
	} {
		got, ok := normalizePageTemplate(tc.in)
		require.Equal(t, tc.ok, ok, tc.in)
		if ok {
			require.Equal(t, tc.want, got, tc.in)
		}
	}
}

func TestThemePageTemplates(t *testing.T) {
	require.Nil(t, themePageTemplates(nil))
	require.Nil(t, themePageTemplates(json.RawMessage(`not json`)))
	require.Nil(t, themePageTemplates(json.RawMessage(`{"layouts": {}}`)))
	templates := themePageTemplates(json.RawMessage(`{"page_templates": [{"name": "default", "label": "Default"}, {"name": "fullwidth", "label": "Full width"}]}`))
	require.True(t, hasPageTemplate(templates, "fullwidth"))
	require.False(t, hasPageTemplate(templates, "sidebar"))
}

var templateTheme = db.Theme{ID: 1, Name: "Paper", Slug: "default", Active: true,
	Config: json.RawMessage(`{"page_templates": [{"name": "default", "label": "Default"}, {"name": "fullwidth", "label": "Full width"}]}`)}

// builderRow answers whether the active theme has a published custom-landing (#494).
func builderRow(store *mockdb.MockStore, published bool, err error) {
	store.EXPECT().HasPublishedSiteTemplate(gomock.Any(), db.HasPublishedSiteTemplateParams{ThemeSlug: "default", Slug: "custom-landing"}).Times(1).Return(published, err)
}

// shippingTheme ships custom-promo as a block template (config.block_templates, 5.7).
var shippingTheme = db.Theme{ID: 1, Name: "Paper", Slug: "default", Active: true,
	Config: json.RawMessage(`{"page_templates": [{"name": "default", "label": "Default"}],
		"block_templates": {"custom-promo": {"title": "Promo", "doc": {}, "hash": "h"}, "single": {"title": "Single", "doc": {}, "hash": "s"}}}`)}

func TestBuilderPageTemplateName(t *testing.T) {
	require.Equal(t, "landing", builderPageTemplateName("block:landing"))
	require.Equal(t, "", builderPageTemplateName("landing"))
	require.Equal(t, "", builderPageTemplateName("block:Landing"))
	require.Equal(t, "", builderPageTemplateName("block:"))
}

func TestBuilderPageTemplatesList(t *testing.T) {
	require.Equal(t, []BuilderPageTemplate{}, builderPageTemplates(nil, nil))
	require.Equal(t, []BuilderPageTemplate{
		{Name: "block:docs", Label: "Docs"},
		// Shipped by the theme, with no override: its shipped title.
		{Name: "block:promo", Label: "Promo"},
		// No title: from its name.
		{Name: "block:spring-launch", Label: "Spring launch"},
	}, builderPageTemplates([]db.ListPublishedCustomPageTemplatesRow{
		{Slug: "custom-spring-launch", Title: ""},
		{Slug: "custom-docs", Title: " Docs "},
		// A slug the site template CHECK allows but block:<name> doesn't, and a non-custom one.
		{Slug: "custom-a_b", Title: "Underscore"},
		{Slug: "custom-", Title: "Empty"},
		{Slug: "page", Title: "Page"},
	}, map[string]ThemeBlockTemplate{
		"custom-promo": {Title: "Promo"},
		// A published override of a shipped template is listed once, by the override's title.
		"custom-docs": {Title: "Shipped docs"},
		"single":      {Title: "Single"},
	}))
}

func TestListPageTemplates(t *testing.T) {
	contributor := db.User{ID: 31, Username: "list_contributor", Role: RoleContributor}
	const url = "/api/v1/posts/page-templates"
	for _, tc := range []struct {
		name  string
		user  db.User
		stubs func(store *mockdb.MockStore)
		want  int
		body  string
	}{
		{"Both kinds", contributor, func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(templateTheme, nil)
			store.EXPECT().ListPublishedCustomPageTemplates(gomock.Any(), "default").Return([]db.ListPublishedCustomPageTemplatesRow{{Slug: "custom-landing", Title: "Landing"}}, nil)
		}, http.StatusOK, `{"theme":{"slug":"default","name":"Paper"},
			"templates":[{"name":"default","label":"Default"},{"name":"fullwidth","label":"Full width"}],
			"builder_templates":[{"name":"block:landing","label":"Landing"}]}`},
		{"Shipped by the theme", contributor, func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(shippingTheme, nil)
			store.EXPECT().ListPublishedCustomPageTemplates(gomock.Any(), "default").Return(nil, nil)
		}, http.StatusOK, `{"theme":{"slug":"default","name":"Paper"},"templates":[{"name":"default","label":"Default"}],
			"builder_templates":[{"name":"block:promo","label":"Promo"}]}`},
		{"No scan yet", contributor, func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{Name: "Bare", Slug: "bare", Config: json.RawMessage(`{}`)}, nil)
			store.EXPECT().ListPublishedCustomPageTemplates(gomock.Any(), "bare").Return(nil, nil)
		}, http.StatusOK, `{"theme":{"slug":"bare","name":"Bare"},"templates":[{"name":"default","label":"Default"}],"builder_templates":[]}`},
		{"No active theme", contributor, func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, sql.ErrNoRows)
			store.EXPECT().ListPublishedCustomPageTemplates(gomock.Any(), gomock.Any()).Times(0)
		}, http.StatusOK, `{"theme":null,"templates":[{"name":"default","label":"Default"}],"builder_templates":[]}`},
		{"Theme error", contributor, func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, fmt.Errorf("db down"))
		}, http.StatusInternalServerError, ""},
		{"List error", contributor, func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(templateTheme, nil)
			store.EXPECT().ListPublishedCustomPageTemplates(gomock.Any(), "default").Return(nil, fmt.Errorf("db down"))
		}, http.StatusInternalServerError, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			tc.stubs(store)
			stubRoleLookup(store, tc.user)
			recorder := seoRequest(t, newTestServer(t, store), http.MethodGet, url, "", tc.user)
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
			if tc.body != "" {
				require.JSONEq(t, tc.body, recorder.Body.String())
			}
		})
	}

	t.Run("SignedOut", func(t *testing.T) {
		recorder := serveJSON(t, newTestServer(t, mockdb.NewMockStore(gomock.NewController(t))), http.MethodGet, url, "")
		require.Equal(t, http.StatusUnauthorized, recorder.Code)
	})
}

func TestUpdatePostPageTemplate(t *testing.T) {
	owner := db.User{ID: 21, Username: "pages_owner", Role: RoleContributor}
	other := db.User{ID: 22, Username: "pages_other", Role: RoleContributor}
	admin := db.User{ID: 23, Username: "pages_admin", Role: RoleAdmin}
	page := func(status string, userID int64) db.Post {
		post := db.Post{ID: 7, PostType: "page", PostStatus: status, UserID: userID}
		if status == "trash" {
			post.DeletedAt = sql.NullTime{Valid: true}
			post.TrashedFromStatus = sql.NullString{String: "draft", Valid: true}
		}
		return post
	}
	url := "/api/v1/posts/7/template"

	saves := func(want string) func(store *mockdb.MockStore) {
		return func(store *mockdb.MockStore) {
			store.EXPECT().UpdatePostPageTemplate(gomock.Any(), db.UpdatePostPageTemplateParams{ID: 7, PageTemplate: want}).Times(1).
				Return(db.Post{ID: 7, PostType: "page", PageTemplate: want}, nil)
		}
	}
	none := func(store *mockdb.MockStore) {
		store.EXPECT().UpdatePostPageTemplate(gomock.Any(), gomock.Any()).Times(0)
	}

	for _, tc := range []struct {
		name  string
		user  db.User
		url   string
		body  string
		post  db.Post
		stubs func(store *mockdb.MockStore)
		want  int
		code  string
	}{
		{"AdminSetsTemplate", admin, url, `{"page_template": "fullwidth"}`, page("published", owner.ID), func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Times(1).Return(templateTheme, nil)
			saves("fullwidth")(store)
		}, http.StatusOK, ""},
		// "default" and "" both clear it, without asking the theme.
		{"DefaultClears", admin, url, `{"page_template": "default"}`, page("draft", owner.ID), func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Times(0)
			saves("")(store)
		}, http.StatusOK, ""},
		{"EmptyClears", admin, url, `{"page_template": ""}`, page("draft", owner.ID), saves(""), http.StatusOK, ""},
		{"OwnerDraft", owner, url, `{"page_template": "fullwidth"}`, page("draft", owner.ID), func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(templateTheme, nil)
			saves("fullwidth")(store)
		}, http.StatusOK, ""},
		// A contributor's published page is locked to them, like its other settings.
		{"OwnerPublished", owner, url, `{"page_template": "fullwidth"}`, page("published", owner.ID), none, http.StatusForbidden, ""},
		{"SomeoneElsesPage", other, url, `{"page_template": "fullwidth"}`, page("draft", owner.ID), none, http.StatusForbidden, ""},
		{"Trashed", admin, url, `{"page_template": "fullwidth"}`, page("trash", owner.ID), none, http.StatusConflict, "post_trashed"},
		{"NotAPage", admin, url, `{"page_template": "fullwidth"}`, db.Post{ID: 7, PostType: "post", PostStatus: "draft"}, none, http.StatusBadRequest, "template_pages_only"},
		{"UnknownTemplate", admin, url, `{"page_template": "sidebar"}`, page("draft", owner.ID), func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(templateTheme, nil)
			none(store)
		}, http.StatusBadRequest, "unknown_template"},
		{"NoActiveTheme", admin, url, `{"page_template": "fullwidth"}`, page("draft", owner.ID), func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, sql.ErrNoRows)
			none(store)
		}, http.StatusBadRequest, "unknown_template"},
		{"ThemeError", admin, url, `{"page_template": "fullwidth"}`, page("draft", owner.ID), func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, fmt.Errorf("db down"))
			none(store)
		}, http.StatusInternalServerError, ""},
		{"PathName", admin, url, `{"page_template": "../post/default"}`, page("draft", owner.ID), none, http.StatusBadRequest, "invalid_template"},
		{"TooLong", admin, url, fmt.Sprintf(`{"page_template": "%065d"}`, 0), page("draft", owner.ID), none, http.StatusBadRequest, ""},
		{"TooLongForBinding", admin, url, fmt.Sprintf(`{"page_template": "block:%065d"}`, 0), page("draft", owner.ID), none, http.StatusBadRequest, ""},
		// Builder page templates (#494): what the site renders for custom-<name>: a published
		// override of the active theme, or a block template it ships.
		{"BuilderPublished", owner, url, `{"page_template": "block:landing"}`, page("draft", owner.ID), func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(templateTheme, nil)
			builderRow(store, true, nil)
			saves("block:landing")(store)
		}, http.StatusOK, ""},
		// Unpublished, reset (published as NULL) or deleted: no published copy.
		{"BuilderNotPublished", admin, url, `{"page_template": "block:landing"}`, page("draft", owner.ID), func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(templateTheme, nil)
			builderRow(store, false, nil)
			none(store)
		}, http.StatusBadRequest, "unknown_template"},
		{"BuilderLookupError", admin, url, `{"page_template": "block:landing"}`, page("draft", owner.ID), func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(templateTheme, nil)
			builderRow(store, false, fmt.Errorf("db down"))
			none(store)
		}, http.StatusInternalServerError, ""},
		{"BuilderShippedByTheTheme", admin, url, `{"page_template": "block:promo"}`, page("draft", owner.ID), func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(shippingTheme, nil)
			store.EXPECT().HasPublishedSiteTemplate(gomock.Any(), gomock.Any()).Times(0)
			saves("block:promo")(store)
		}, http.StatusOK, ""},
		{"BuilderNoActiveTheme", admin, url, `{"page_template": "block:landing"}`, page("draft", owner.ID), func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, sql.ErrNoRows)
			store.EXPECT().HasPublishedSiteTemplate(gomock.Any(), gomock.Any()).Times(0)
			none(store)
		}, http.StatusBadRequest, "unknown_template"},
		// A layout name never asks the Site editor, a builder name never the theme's layouts.
		{"BuilderNameNotALayout", admin, url, `{"page_template": "block:fullwidth"}`, page("draft", owner.ID), func(store *mockdb.MockStore) {
			store.EXPECT().GetActiveTheme(gomock.Any()).Return(templateTheme, nil)
			store.EXPECT().HasPublishedSiteTemplate(gomock.Any(), db.HasPublishedSiteTemplateParams{ThemeSlug: "default", Slug: "custom-fullwidth"}).Return(false, nil)
			none(store)
		}, http.StatusBadRequest, "unknown_template"},
		{"BuilderBadName", admin, url, `{"page_template": "block:Landing"}`, page("draft", owner.ID), none, http.StatusBadRequest, "invalid_template"},
		{"UnknownField", admin, url, `{"template": "fullwidth"}`, page("draft", owner.ID), none, http.StatusBadRequest, ""},
		{"BadID", admin, "/api/v1/posts/x/template", `{}`, page("draft", owner.ID), none, http.StatusBadRequest, ""},
		{"UpdateMissing", admin, url, `{}`, page("draft", owner.ID), func(store *mockdb.MockStore) {
			store.EXPECT().UpdatePostPageTemplate(gomock.Any(), gomock.Any()).Return(db.Post{}, sql.ErrNoRows)
		}, http.StatusNotFound, ""},
		{"UpdateError", admin, url, `{}`, page("draft", owner.ID), func(store *mockdb.MockStore) {
			store.EXPECT().UpdatePostPageTemplate(gomock.Any(), gomock.Any()).Return(db.Post{}, fmt.Errorf("db down"))
		}, http.StatusInternalServerError, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(tc.post, nil).AnyTimes()
			tc.stubs(store)
			stubRoleLookup(store, tc.user)
			server := newTestServer(t, store)
			recorder := seoRequest(t, server, http.MethodPut, tc.url, tc.body, tc.user)
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
			if tc.code != "" {
				require.Contains(t, recorder.Body.String(), fmt.Sprintf(`"code":%q`, tc.code))
			}
			if tc.want == http.StatusOK {
				require.Equal(t, []string{"updated post:7~"}, activityOf(t, server).verbs())
			}
		})
	}

	t.Run("MissingPost", func(t *testing.T) {
		for _, user := range []db.User{admin, owner} {
			store := mockdb.NewMockStore(gomock.NewController(t))
			store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(db.Post{}, sql.ErrNoRows)
			stubRoleLookup(store, user)
			recorder := seoRequest(t, newTestServer(t, store), http.MethodPut, url, `{"page_template": "fullwidth"}`, user)
			require.Equal(t, http.StatusNotFound, recorder.Code, recorder.Body.String())
		}
	})

	t.Run("PostError", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(db.Post{}, fmt.Errorf("db down"))
		stubRoleLookup(store, admin)
		recorder := seoRequest(t, newTestServer(t, store), http.MethodPut, url, `{"page_template": "fullwidth"}`, admin)
		require.Equal(t, http.StatusInternalServerError, recorder.Code, recorder.Body.String())
	})

	t.Run("SignedOut", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		recorder := serveJSON(t, newTestServer(t, store), http.MethodPut, url, `{"page_template": "fullwidth"}`)
		require.Equal(t, http.StatusUnauthorized, recorder.Code)
	})
}

// The site renders a page with its published template: a template chosen after
// publishing waits for Update, like the other settings (#358).
func TestPublicPostPageTemplate(t *testing.T) {
	published := editedPublishedPost()
	published.PostType = "page"
	published.PageTemplate = "landing"
	published.PublishedSettings = publishedSettings(`{"title": "Published title", "description": "", "featured_image": null,
		"term_ids": [], "page_template": "fullwidth"}`)

	for _, tc := range []struct {
		name string
		post func() db.Post
		want string
	}{
		{"Published", func() db.Post { return published }, "fullwidth"},
		// 000045 gave every snapshot a template; one without it published the default.
		{"SnapshotWithout", func() db.Post {
			p := published
			p.PublishedSettings = publishedSettings(`{"title": "T", "description": "", "featured_image": null, "term_ids": []}`)
			return p
		}, ""},
		// Published some other way, with no snapshot: the live settings, as before #358.
		{"NoSnapshot", func() db.Post {
			p := published
			p.PublishedSettings.Valid = false
			return p
		}, "landing"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			post := tc.post()
			store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(post, nil)
			store.EXPECT().GetPublishedPostTaxonomyTerms(gomock.Any(), int64(7)).Return(nil, nil).AnyTimes()
			store.EXPECT().GetPostMetaByKey(gomock.Any(), gomock.Any()).Return(db.PostMetum{}, sql.ErrNoRows).AnyTimes()
			store.EXPECT().GetPostTaxonomyTerms(gomock.Any(), int64(7)).Return(nil, nil).AnyTimes()
			recorder := serveSettingsGET(t, newTestServer(t, store), "/public/posts/7")
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
			var view publicPostView
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &view))
			require.Equal(t, tc.want, view.Post.PageTemplate)
		})
	}

	t.Run("List", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPostType(gomock.Any(), "page").Return(db.PostType{Name: "page", Public: true, IsActive: true}, nil)
		store.EXPECT().CountFilteredPosts(gomock.Any(), gomock.Any()).Return(int64(1), nil)
		store.EXPECT().ListPosts(gomock.Any(), gomock.Any()).Return([]db.ListPostsRow{
			{ID: 7, Title: "Working", PostType: "page", PostStatus: "published", PageTemplate: "landing", PublishedSettings: published.PublishedSettings},
		}, nil)
		recorder := serveSettingsGET(t, newTestServer(t, store), "/public/posts?type=page")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Contains(t, recorder.Body.String(), `"page_template":"fullwidth"`)
		require.NotContains(t, recorder.Body.String(), "landing", "the working template waits for Update")
	})
}

// The admin's list rows carry the working template, for the Pages list's column.
func TestListPostsPageTemplate(t *testing.T) {
	require.Equal(t, "landing", toPostResponseFromListRow(db.ListPostsRow{ID: 1, PageTemplate: "landing"}).PageTemplate)
	require.Equal(t, "landing", toPostResponse(db.Post{ID: 1, PageTemplate: "landing"}).PageTemplate)
}
