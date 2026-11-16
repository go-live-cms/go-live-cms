package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"

	"github.com/go-live-cms/go-live-cms/api/sitedesign"
	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// GET /public/site-templates/resolve (#491, design 3.2, 3.3, 4.2) on the mock store: the
// rank order, override over shipped, part resolution (override, theme, starter), the menus
// by id, and the failures. site_templates_resolve_db_test.go runs it against the database
// (published copies only, media, the cache).

const resolveTheme = "shipping"

// resolveDoc is a Block Spec doc of the given top-level blocks (id → JSON of type and attrs).
func resolveDoc(t *testing.T, blocks ...[2]string) json.RawMessage {
	t.Helper()
	doc := map[string]any{"doc_version": 1, "blocks_order": []string{}, "blocks": map[string]any{}}
	for _, b := range blocks {
		var block map[string]any
		require.NoError(t, json.Unmarshal([]byte(b[1]), &block))
		block["id"] = b[0]
		block["version"] = 1
		doc["blocks_order"] = append(doc["blocks_order"].([]string), b[0])
		doc["blocks"].(map[string]any)[b[0]] = block
	}
	raw, err := json.Marshal(doc)
	require.NoError(t, err)
	return raw
}

func publishedRow(kind, slug, title string, doc json.RawMessage) db.ListPublishedSiteTemplatesForResolveRow {
	return db.ListPublishedSiteTemplatesForResolveRow{Kind: kind, Slug: slug, Title: title, PublishedBlockDoc: pqtype.NullRawMessage{RawMessage: doc, Valid: true}}
}

// shippingThemeConfig is a theme config as applyThemeBlockTemplates leaves it.
func shippingThemeConfig(t *testing.T, templates, parts map[string]json.RawMessage) json.RawMessage {
	t.Helper()
	config := map[string]any{}
	for key, docs := range map[string]map[string]json.RawMessage{"block_templates": templates, "block_parts": parts} {
		if len(docs) == 0 {
			continue
		}
		byslug := map[string]ThemeBlockTemplate{}
		for slug, doc := range docs {
			byslug[slug] = ThemeBlockTemplate{Title: "Shipped " + slug, Doc: doc, Hash: sitedesign.Hash(doc)}
		}
		config[key] = byslug
	}
	raw, err := json.Marshal(config)
	require.NoError(t, err)
	return raw
}

func resolveRequest(t *testing.T, server *Server, query string) (*httptest.ResponseRecorder, SiteTemplateResolveResponse) {
	t.Helper()
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/public/site-templates/resolve?"+query, nil))
	var res SiteTemplateResolveResponse
	if recorder.Code == http.StatusOK {
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &res), recorder.Body.String())
	}
	return recorder, res
}

func TestParseResolveSlugs(t *testing.T) {
	slugs, ok := parseResolveSlugs("single-case_study,single")
	require.True(t, ok)
	require.Equal(t, []string{"single-case_study", "single"}, slugs)
	for _, bad := range []string{"", ",", "single,", "single,single", "Single", "../x", "a,b,c,d,e,f,g,h,i"} {
		_, ok := parseResolveSlugs(bad)
		require.False(t, ok, bad)
	}
	_, ok = parseResolveSlugs("a,b,c,d,e,f,g,h")
	require.True(t, ok, "eight is the cap")
}

func TestResolvePublicSiteTemplate(t *testing.T) {
	header := resolveDoc(t, [2]string{"title-0001", `{"type":"site_title","attrs":{}}`}, [2]string{"nav-000001", `{"type":"navigation","attrs":{"menuId":5}}`})
	single := resolveDoc(t,
		[2]string{"part-00001", `{"type":"template_part","attrs":{"slug":"header"}}`},
		[2]string{"ptitle-001", `{"type":"post_title","attrs":{}}`},
		[2]string{"part-00002", `{"type":"template_part","attrs":{"slug":"footer"}}`},
		[2]string{"part-00003", `{"type":"template_part","attrs":{"slug":"sidebar"}}`},
		[2]string{"part-00004", `{"type":"template_part","attrs":{"slug":"nowhere"}}`},
		[2]string{"nav-000002", `{"type":"navigation","attrs":{"menuId":6}}`},
	)
	sidebar := resolveDoc(t, [2]string{"tag-000001", `{"type":"site_tagline","attrs":{}}`})
	banner := resolveDoc(t, [2]string{"nav-000003", `{"type":"navigation","attrs":{"menuId":7}}`})
	shippedProduct := resolveDoc(t, [2]string{"ptitle-002", `{"type":"post_title","attrs":{}}`})
	theme := db.Theme{ID: 3, Slug: resolveTheme, Active: true, Config: shippingThemeConfig(t,
		map[string]json.RawMessage{"single-product": shippedProduct, "single": shippedProduct},
		map[string]json.RawMessage{"sidebar": sidebar})}

	setup := func(t *testing.T) (*mockdb.MockStore, *Server) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		return store, newTestServer(t, store)
	}
	menuItems := func(store *mockdb.MockStore) {
		store.EXPECT().GetMenu(gomock.Any(), int64(5)).Return(db.Menu{ID: 5, Name: "Main", Location: sql.NullString{String: "primary", Valid: true}}, nil).AnyTimes()
		store.EXPECT().GetMenu(gomock.Any(), int64(6)).Return(db.Menu{}, sql.ErrNoRows).AnyTimes()
		store.EXPECT().GetMenu(gomock.Any(), int64(7)).Return(db.Menu{}, errors.New("db down")).AnyTimes()
		store.EXPECT().ListMenuItemsWithTargets(gomock.Any(), int64(5)).Return([]db.ListMenuItemsWithTargetsRow{
			{ID: 1, MenuID: 5, ItemType: "custom", Label: "About", Url: "/about"},
		}, nil).AnyTimes()
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{PostUrlStructure: "id"}, nil).AnyTimes()
	}

	t.Run("TheFirstSlugWithABuilderOrShippedTemplateWins", func(t *testing.T) {
		store, server := setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(theme, nil)
		// `single` is customized, but the theme ships `single-product`, the more specific rank.
		store.EXPECT().ListPublishedSiteTemplatesForResolve(gomock.Any(), db.ListPublishedSiteTemplatesForResolveParams{ThemeSlug: resolveTheme, Slugs: []string{"single-product", "single"}}).
			Return([]db.ListPublishedSiteTemplatesForResolveRow{publishedRow("template", "single", "Single post", single)}, nil)
		recorder, res := resolveRequest(t, server, "theme="+resolveTheme+"&slugs=single-product,single")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Equal(t, resolveTheme, res.Theme)
		require.NotNil(t, res.Template)
		require.Equal(t, "single-product", res.Template.Slug)
		require.Equal(t, 0, res.Template.Rank)
		require.Equal(t, siteDesignSourceTheme, res.Template.Source)
		require.Equal(t, "Shipped single-product", res.Template.Title)
		require.Empty(t, res.Parts)
		require.Empty(t, res.Menus)
	})

	t.Run("AnOverrideBeatsTheShippedTemplateOfItsSlug", func(t *testing.T) {
		store, server := setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(theme, nil)
		overrideHeader := publishedRow("part", "header", "Header", header)
		bannerRow := publishedRow("part", "banner", "Banner", banner)
		store.EXPECT().ListPublishedSiteTemplatesForResolve(gomock.Any(), gomock.Any()).
			Return([]db.ListPublishedSiteTemplatesForResolveRow{overrideHeader, bannerRow, publishedRow("template", "single", "Single post", single)}, nil)
		menuItems(store)
		recorder, res := resolveRequest(t, server, "theme="+resolveTheme+"&slugs=single-case_study,single")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.NotNil(t, res.Template)
		require.Equal(t, "single", res.Template.Slug)
		require.Equal(t, 1, res.Template.Rank)
		require.Equal(t, siteDesignSourceOverride, res.Template.Source)
		require.Equal(t, "Single post", res.Template.Title)

		// The parts it places: the override, the theme's, core's starter; a slug none has is absent.
		require.Equal(t, siteDesignSourceOverride, res.Parts["header"].Source)
		require.Equal(t, siteDesignSourceTheme, res.Parts["sidebar"].Source)
		require.Equal(t, siteDesignSourceStarter, res.Parts["footer"].Source)
		require.Equal(t, "Footer", res.Parts["footer"].Title)
		require.NotContains(t, res.Parts, "nowhere")
		// A starter goes through the part's rules, as a Customize copy would.
		footerBlocks, _ := res.Parts["footer"].Doc["blocks"].(map[string]any)
		require.NotEmpty(t, footerBlocks)
		// Every published override part is there for a code layout's <TemplatePart>.
		require.Equal(t, siteDesignSourceOverride, res.Parts["banner"].Source)

		// Menus by id: the one that exists; a deleted one and a failed read are left out.
		require.Equal(t, []string{"5"}, sortedMapKeys(res.Menus))
		require.Equal(t, "Main", res.Menus["5"].Name)
		require.Equal(t, "primary", res.Menus["5"].Location)
		require.Len(t, res.Menus["5"].Items, 1)
		require.Equal(t, "/about", res.Menus["5"].Items[0].URL)
	})

	t.Run("NoTemplateStillCarriesTheOverrideParts", func(t *testing.T) {
		store, server := setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{ID: 3, Slug: resolveTheme, Config: json.RawMessage(`{}`)}, nil)
		store.EXPECT().ListPublishedSiteTemplatesForResolve(gomock.Any(), gomock.Any()).
			Return([]db.ListPublishedSiteTemplatesForResolveRow{publishedRow("part", "header", "Header", header)}, nil)
		menuItems(store)
		recorder, res := resolveRequest(t, server, "theme="+resolveTheme+"&slugs=search")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Nil(t, res.Template)
		require.Contains(t, recorder.Body.String(), `"template":null`)
		require.Equal(t, []string{"header"}, sortedMapKeys(res.Parts), "only overrides: no starter for a part nothing places")
		require.Equal(t, []string{"5"}, sortedMapKeys(res.Menus))
	})

	t.Run("AnUnreadableDocFallsToTheNextSource", func(t *testing.T) {
		store, server := setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(theme, nil)
		store.EXPECT().ListPublishedSiteTemplatesForResolve(gomock.Any(), gomock.Any()).
			Return([]db.ListPublishedSiteTemplatesForResolveRow{publishedRow("template", "single", "Broken", json.RawMessage(`{"blocks_order":"x"}`))}, nil)
		recorder, res := resolveRequest(t, server, "theme="+resolveTheme+"&slugs=single")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.NotNil(t, res.Template)
		require.Equal(t, siteDesignSourceTheme, res.Template.Source)
	})

	t.Run("Refusals", func(t *testing.T) {
		for _, query := range []string{"theme=" + resolveTheme, "theme=" + resolveTheme + "&slugs=a,a", "slugs=single", "theme=" + strings.Repeat("x", maxResolveThemeSlug+1) + "&slugs=single"} {
			_, server := setup(t)
			recorder, _ := resolveRequest(t, server, query)
			require.Equal(t, http.StatusBadRequest, recorder.Code, query)
		}

		store, server := setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, sql.ErrNoRows)
		recorder, _ := resolveRequest(t, server, "theme="+resolveTheme+"&slugs=single")
		require.Equal(t, http.StatusNotFound, recorder.Code)

		store, server = setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{Slug: "other"}, nil)
		recorder, _ = resolveRequest(t, server, "theme="+resolveTheme+"&slugs=single")
		require.Equal(t, http.StatusNotFound, recorder.Code)
		require.Contains(t, recorder.Body.String(), "theme_inactive")

		store, server = setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, errors.New("db down"))
		recorder, _ = resolveRequest(t, server, "theme="+resolveTheme+"&slugs=single")
		require.Equal(t, http.StatusInternalServerError, recorder.Code)

		store, server = setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(theme, nil)
		store.EXPECT().ListPublishedSiteTemplatesForResolve(gomock.Any(), gomock.Any()).Return(nil, errors.New("db down"))
		recorder, _ = resolveRequest(t, server, "theme="+resolveTheme+"&slugs=single")
		require.Equal(t, http.StatusInternalServerError, recorder.Code)
	})
}

func TestResolveMenuLimit(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	blocks := make([][2]string, 0, maxResolveMenus+4)
	for i := 1; i <= maxResolveMenus+4; i++ {
		blocks = append(blocks, [2]string{fmt.Sprintf("nav-%06d", i), fmt.Sprintf(`{"type":"navigation","attrs":{"menuId":%d}}`, i)})
	}
	var doc map[string]interface{}
	require.NoError(t, json.Unmarshal(resolveDoc(t, blocks...), &doc))
	store.EXPECT().GetMenu(gomock.Any(), gomock.Any()).Return(db.Menu{}, sql.ErrNoRows).Times(maxResolveMenus)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/", nil)
	require.Empty(t, server.menusNamedByID(c, []map[string]interface{}{doc}))
}

// Every starter goes through the rules of its kind (design 5.7): "Customize" from it stores,
// and a starter part renders as that copy would.
func TestStartersPassTheirKindsRules(t *testing.T) {
	for _, name := range sitedesign.StarterNames() {
		kind, slug, _ := strings.Cut(name, "/")
		file, ok := sitedesign.Starter(kind, slug)
		require.True(t, ok, name)
		var doc BlockDocV1
		require.NoError(t, json.Unmarshal(file.Doc, &doc), name)
		require.NoError(t, doc.prepareForStoreAs(ThemeBlockManifest{}, blockDocKind(kind)), name)
	}
}
