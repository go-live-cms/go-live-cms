package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The site design routes (#485) on a mock store: validation, revisions, contrast and the
// publish's phases. The same flows against the real database: site_design_db_test.go.

var (
	siteDesignAdmin = db.User{ID: 4_000_000_485, Username: "design_admin", Role: RoleAdmin}
	siteDesignTheme = db.Theme{ID: 31, Name: "Vectors", Slug: globalStylesFixtureSlug, Active: true}
)

func siteDesignServer(t *testing.T) (*Server, *mockdb.MockStore) {
	t.Helper()
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	server.themeTokens = fixtureThemeTokens(t, globalStylesFixtureSlug)
	return server, store
}

func siteDesignRequest(t *testing.T, server *Server, store *mockdb.MockStore, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	signInAs(t, server, store, request, siteDesignAdmin)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

// expectStylesRow stubs the active theme and its stored row (nil = never saved).
func expectStylesRow(store *mockdb.MockStore, row *db.GlobalStyle) {
	store.EXPECT().GetActiveTheme(gomock.Any()).Return(siteDesignTheme, nil)
	if row == nil {
		store.EXPECT().GetGlobalStyles(gomock.Any(), siteDesignTheme.Slug).Return(db.GlobalStyle{}, sql.ErrNoRows)
		return
	}
	store.EXPECT().GetGlobalStyles(gomock.Any(), siteDesignTheme.Slug).Return(*row, nil)
}

func stylesRow(draft, published string, revision int64) *db.GlobalStyle {
	return &db.GlobalStyle{
		ThemeSlug:     siteDesignTheme.Slug,
		Draft:         json.RawMessage(draft),
		DraftRevision: revision,
		Published:     json.RawMessage(published),
		ChangedAt:     time.Date(2026, 11, 14, 10, 2, 0, 0, time.UTC),
	}
}

func decodeStyles(t *testing.T, recorder *httptest.ResponseRecorder) GlobalStylesResponse {
	t.Helper()
	var rsp GlobalStylesResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	return rsp
}

func decodeError(t *testing.T, recorder *httptest.ResponseRecorder) map[string]json.RawMessage {
	t.Helper()
	var rsp map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	return rsp
}

func requireCode(t *testing.T, recorder *httptest.ResponseRecorder, status int, code string) map[string]json.RawMessage {
	t.Helper()
	requireStatus(t, recorder, status)
	rsp := decodeError(t, recorder)
	require.JSONEq(t, `"`+code+`"`, string(rsp["code"]), recorder.Body.String())
	return rsp
}

func TestGetGlobalStyles(t *testing.T) {
	t.Run("never saved", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, nil)
		recorder := siteDesignRequest(t, server, store, http.MethodGet, "/api/v1/site-design/global-styles", "")
		requireStatus(t, recorder, http.StatusOK)
		rsp := decodeStyles(t, recorder)
		require.True(t, rsp.Supported)
		require.Equal(t, siteDesignTheme.Slug, rsp.Theme.Slug)
		require.JSONEq(t, `{}`, string(rsp.Draft))
		require.JSONEq(t, `{}`, string(rsp.Published))
		require.Zero(t, rsp.DraftRevision)
		require.False(t, rsp.HasUnpublishedChanges)
		require.Empty(t, rsp.Contrast)
		require.Nil(t, rsp.ChangedAt)
		require.Contains(t, rsp.Tokens, "colors")
		require.Equal(t, systemFontIDs, rsp.SystemFonts)
		require.Equal(t, "literata", rsp.FontOptions[0].ID)
	})

	t.Run("a draft that fails contrast", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, stylesRow(`{"colors":{"light":{"text":"#cccccc"}}}`, `{}`, 4))
		recorder := siteDesignRequest(t, server, store, http.MethodGet, "/api/v1/site-design/global-styles", "")
		requireStatus(t, recorder, http.StatusOK)
		rsp := decodeStyles(t, recorder)
		require.True(t, rsp.HasUnpublishedChanges)
		require.EqualValues(t, 4, rsp.DraftRevision)
		require.NotNil(t, rsp.ChangedAt)
		require.Len(t, rsp.Contrast, 3)
		require.Equal(t, "light:text/background", rsp.Contrast[0].ID())
	})

	t.Run("a theme this build doesn't know", func(t *testing.T) {
		server, store := siteDesignServer(t)
		server.themeTokens = ThemeTokenManifest{}
		expectStylesRow(store, nil)
		recorder := siteDesignRequest(t, server, store, http.MethodGet, "/api/v1/site-design/global-styles", "")
		requireStatus(t, recorder, http.StatusOK)
		rsp := decodeStyles(t, recorder)
		require.False(t, rsp.Supported)
		require.Empty(t, rsp.Tokens)
		require.Empty(t, rsp.FontOptions)
	})

	t.Run("no active theme", func(t *testing.T) {
		server, store := siteDesignServer(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, sql.ErrNoRows)
		recorder := siteDesignRequest(t, server, store, http.MethodGet, "/api/v1/site-design/global-styles", "")
		requireStatus(t, recorder, http.StatusNotFound)
	})

	t.Run("database errors", func(t *testing.T) {
		server, store := siteDesignServer(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, errors.New("down"))
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodGet, "/api/v1/site-design/global-styles", ""), http.StatusInternalServerError)

		store.EXPECT().GetActiveTheme(gomock.Any()).Return(siteDesignTheme, nil)
		store.EXPECT().GetGlobalStyles(gomock.Any(), siteDesignTheme.Slug).Return(db.GlobalStyle{}, errors.New("down"))
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodGet, "/api/v1/site-design/global-styles", ""), http.StatusInternalServerError)
	})
}

func TestSaveGlobalStylesRefuses(t *testing.T) {
	cases := map[string]struct {
		styles string
		code   string
		path   string
	}{
		"an unknown key":     {`{"colors":{"light":{"brandNew":"#123456"}}}`, globalStyleUnknownToken, "colors.light.brandNew"},
		"an unknown group":   {`{"shadows":{}}`, globalStyleUnknownToken, "shadows"},
		";":                  {`{"colors":{"light":{"primary":"#1b7760;"}}}`, globalStyleInvalidValue, "colors.light.primary"},
		"}":                  {`{"radius":{"md":"8px}body{display:none"}}`, globalStyleInvalidValue, "radius.md"},
		"</style>":           {`{"radius":{"md":"8px</style>"}}`, globalStyleInvalidValue, "radius.md"},
		"url(":               {`{"layout":{"gutter":"url(https://tracker.example/p.gif)"}}`, globalStyleInvalidValue, "layout.gutter"},
		"var(":               {`{"typography":{"fontSize":{"base":"clamp(1rem, var(--x), 2rem)"}}}`, globalStyleInvalidValue, "typography.fontSize.base"},
		"expression(":        {`{"colors":{"dark":{"text":"expression(alert(1))"}}}`, globalStyleInvalidValue, "colors.dark.text"},
		"order":              {`{"layout":{"contentWidth":"1000px"}}`, globalStyleTokenOrder, "layout.contentWidth"},
		"styles not object":  {`[]`, globalStyleInvalidValue, ""},
		"a font that is CSS": {`{"typography":{"fontFamily":{"base":"x;}"}}}`, globalStyleInvalidValue, "typography.fontFamily.base"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			server, store := siteDesignServer(t)
			expectStylesRow(store, nil)
			recorder := siteDesignRequest(t, server, store, http.MethodPut, "/api/v1/site-design/global-styles", `{"styles":`+tc.styles+`,"base_revision":0}`)
			rsp := requireCode(t, recorder, http.StatusBadRequest, tc.code)
			require.JSONEq(t, `"`+tc.path+`"`, string(rsp["path"]))
			require.Empty(t, activityOf(t, server).verbs())
		})
	}

	t.Run("bad bodies", func(t *testing.T) {
		server, store := siteDesignServer(t)
		for _, body := range []string{`{"styles":{}}`, `{"base_revision":0}`, `{"styles":{},"base_revision":-1}`, `{"styles":{},"base_revision":0,"extra":1}`} {
			requireStatus(t, siteDesignRequest(t, server, store, http.MethodPut, "/api/v1/site-design/global-styles", body), http.StatusBadRequest)
		}
		big := `{"styles":{"x":"` + strings.Repeat("a", maxGlobalStylesBytes) + `"},"base_revision":0}`
		requireCode(t, siteDesignRequest(t, server, store, http.MethodPut, "/api/v1/site-design/global-styles", big), http.StatusBadRequest, globalStyleInvalidValue)
	})

	t.Run("a theme without global styles", func(t *testing.T) {
		server, store := siteDesignServer(t)
		tokens := server.themeTokens.Themes[globalStylesFixtureSlug]
		tokens.SupportsGlobalStyles = false
		server.themeTokens.Themes[globalStylesFixtureSlug] = tokens
		expectStylesRow(store, nil)
		recorder := siteDesignRequest(t, server, store, http.MethodPut, "/api/v1/site-design/global-styles", `{"styles":{"radius":{"md":"10px"}},"base_revision":0}`)
		requireCode(t, recorder, http.StatusConflict, "global_styles_unsupported")

		// It can still clear a draft left from when it supported them.
		expectStylesRow(store, stylesRow(`{"radius":{"md":"10px"}}`, `{}`, 3))
		store.EXPECT().EnsureGlobalStyles(gomock.Any(), siteDesignTheme.Slug).Return(nil)
		store.EXPECT().UpdateGlobalStylesDraft(gomock.Any(), gomock.Any()).DoAndReturn(func(_ any, arg db.UpdateGlobalStylesDraftParams) (db.GlobalStyle, error) {
			require.JSONEq(t, `{}`, string(arg.Draft))
			return *stylesRow(`{}`, `{}`, 4), nil
		})
		recorder = siteDesignRequest(t, server, store, http.MethodPut, "/api/v1/site-design/global-styles", `{"styles":{},"base_revision":3}`)
		requireStatus(t, recorder, http.StatusOK)
		require.False(t, decodeStyles(t, recorder).HasUnpublishedChanges)
	})
}

func TestSaveGlobalStyles(t *testing.T) {
	t.Run("stores the normalized draft and records the groups, never the values", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, stylesRow(`{"spacing":{"1":"2px"}}`, `{}`, 2))
		store.EXPECT().EnsureGlobalStyles(gomock.Any(), siteDesignTheme.Slug).Return(nil)
		store.EXPECT().UpdateGlobalStylesDraft(gomock.Any(), gomock.Any()).DoAndReturn(func(_ any, arg db.UpdateGlobalStylesDraftParams) (db.GlobalStyle, error) {
			require.JSONEq(t, `{"colors":{"light":{"primary":"#155e4b"}},"typography":{"fontSize":{"base":"clamp(1rem, 1rem + 0.5vw, 1.25rem)"}}}`, string(arg.Draft))
			require.EqualValues(t, 2, arg.BaseRevision)
			require.Equal(t, siteDesignAdmin.ID, arg.ChangedBy.Int64)
			row := stylesRow(string(arg.Draft), `{}`, 3)
			return *row, nil
		})
		body := `{"styles":{"colors":{"light":{"primary":"#155E4B"}},"typography":{"fontSize":{"base":"clamp(1rem,1rem+0.5vw,1.25rem)"}}},"base_revision":2}`
		recorder := siteDesignRequest(t, server, store, http.MethodPut, "/api/v1/site-design/global-styles", body)
		requireStatus(t, recorder, http.StatusOK)
		rsp := decodeStyles(t, recorder)
		require.EqualValues(t, 3, rsp.DraftRevision)
		require.True(t, rsp.HasUnpublishedChanges)

		rec := activityOf(t, server)
		require.Equal(t, []string{"global_styles_updated site_design:31~"}, rec.verbs())
		require.JSONEq(t, `{"groups":["colors","typeScale","spacing"]}`, string(rec.throttled[0].Payload))
		require.NotContains(t, string(rec.throttled[0].Payload), "#155e4b")
	})

	t.Run("a stale base_revision answers the current draft", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, stylesRow(`{"colors":{"dark":{"primary":"#3fe0b3"}}}`, `{}`, 5))
		recorder := siteDesignRequest(t, server, store, http.MethodPut, "/api/v1/site-design/global-styles", `{"styles":{},"base_revision":4}`)
		rsp := requireCode(t, recorder, http.StatusConflict, "styles_changed")
		var current GlobalStylesResponse
		require.NoError(t, json.Unmarshal(rsp["current"], &current))
		require.EqualValues(t, 5, current.DraftRevision)
		require.JSONEq(t, `{"colors":{"dark":{"primary":"#3fe0b3"}}}`, string(current.Draft))
		require.Empty(t, activityOf(t, server).verbs())
	})

	t.Run("saved by another admin between the read and the write", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, stylesRow(`{}`, `{}`, 1))
		store.EXPECT().EnsureGlobalStyles(gomock.Any(), siteDesignTheme.Slug).Return(nil)
		store.EXPECT().UpdateGlobalStylesDraft(gomock.Any(), gomock.Any()).Return(db.GlobalStyle{}, sql.ErrNoRows)
		expectStylesRow(store, stylesRow(`{"radius":{"md":"10px"}}`, `{}`, 2))
		recorder := siteDesignRequest(t, server, store, http.MethodPut, "/api/v1/site-design/global-styles", `{"styles":{"radius":{"sm":"2px"}},"base_revision":1}`)
		rsp := requireCode(t, recorder, http.StatusConflict, "styles_changed")
		require.Contains(t, string(rsp["current"]), `"draft_revision":2`)
	})

	t.Run("the same draft again is no new revision", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, stylesRow(`{"colors":{"light":{"primary":"#155e4b"}}}`, `{}`, 7))
		recorder := siteDesignRequest(t, server, store, http.MethodPut, "/api/v1/site-design/global-styles", `{"styles":{"colors":{"light":{"primary":"#155E4B"},"dark":{}}},"base_revision":7}`)
		requireStatus(t, recorder, http.StatusOK)
		require.EqualValues(t, 7, decodeStyles(t, recorder).DraftRevision)
		require.Empty(t, activityOf(t, server).verbs())
	})

	t.Run("database errors", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, nil)
		store.EXPECT().EnsureGlobalStyles(gomock.Any(), siteDesignTheme.Slug).Return(errors.New("down"))
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodPut, "/api/v1/site-design/global-styles", `{"styles":{"radius":{"sm":"2px"}},"base_revision":0}`), http.StatusInternalServerError)

		expectStylesRow(store, nil)
		store.EXPECT().EnsureGlobalStyles(gomock.Any(), siteDesignTheme.Slug).Return(nil)
		store.EXPECT().UpdateGlobalStylesDraft(gomock.Any(), gomock.Any()).Return(db.GlobalStyle{}, errors.New("down"))
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodPut, "/api/v1/site-design/global-styles", `{"styles":{"radius":{"sm":"2px"}},"base_revision":0}`), http.StatusInternalServerError)
	})
}

func TestPublishSiteDesign(t *testing.T) {
	const failing = `{"colors":{"light":{"text":"#cccccc"}}}`

	t.Run("nothing to publish", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, stylesRow(`{"radius":{"md":"10px"}}`, `{"radius":{"md":"10px"}}`, 3))
		requireCode(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusConflict, "nothing_to_publish")

		expectStylesRow(store, nil)
		requireCode(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", `{}`), http.StatusConflict, "nothing_to_publish")
	})

	t.Run("failing contrast asks for confirmation, naming the pairs", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, stylesRow(failing, `{}`, 2))
		recorder := siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", `{"confirm_contrast":false}`)
		rsp := requireCode(t, recorder, http.StatusConflict, "contrast_unconfirmed")
		var pairs []ContrastFailure
		require.NoError(t, json.Unmarshal(rsp["pairs"], &pairs))
		ids := []string{}
		for _, pair := range pairs {
			ids = append(ids, pair.ID())
			require.Less(t, pair.Ratio, pair.Minimum)
		}
		require.Equal(t, []string{"light:text/background", "light:text/surface", "light:text/blockColors.red.background"}, ids)
		require.Empty(t, activityOf(t, server).verbs())
	})

	t.Run("confirmed, it publishes anyway and records how many pairs failed", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, stylesRow(failing, `{"radius":{"md":"10px"}}`, 2))
		store.EXPECT().PublishGlobalStylesTx(gomock.Any(), gomock.Any()).DoAndReturn(func(_ any, arg db.PublishGlobalStylesTxParams) (db.PublishGlobalStylesTxResult, error) {
			require.Equal(t, siteDesignTheme.Slug, arg.ThemeSlug)
			require.EqualValues(t, 2, arg.DraftRevision)
			require.Equal(t, siteDesignAdmin.ID, arg.PublishedBy.Int64)
			require.JSONEq(t, `{"global_styles":{"groups":["colors","radius"],"contrast_failures":3}}`, string(arg.Summary))
			return db.PublishGlobalStylesTxResult{
				Release: db.SiteDesignRelease{ID: 77, ThemeSlug: arg.ThemeSlug, PublishedAt: time.Now()},
				Version: db.GlobalStyleVersion{ID: 5, VersionNo: 4},
				Styles:  *stylesRow(failing, failing, 2),
			}, nil
		})
		recorder := siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", `{"confirm_contrast":true}`)
		requireStatus(t, recorder, http.StatusOK)
		var rsp SiteDesignPublishResponse
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
		require.EqualValues(t, 77, rsp.Release.ID)
		require.EqualValues(t, 4, rsp.GlobalStyles.VersionNo)
		require.Equal(t, 3, rsp.GlobalStyles.ContrastFailures)
		require.Equal(t, []string{"colors", "radius"}, rsp.GlobalStyles.Groups)
		require.False(t, rsp.Styles.HasUnpublishedChanges)

		rec := activityOf(t, server)
		require.Equal(t, []string{"site_design_published site_design:77"}, rec.verbs())
		require.JSONEq(t, `{"theme_slug":"vectors","global_styles_groups":["colors","radius"],"contrast_failures":3}`, string(rec.events[0].Payload))
	})

	t.Run("passing contrast needs no confirmation", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, stylesRow(`{"layout":{"contentWidth":"720px"}}`, `{}`, 1))
		store.EXPECT().PublishGlobalStylesTx(gomock.Any(), gomock.Any()).Return(db.PublishGlobalStylesTxResult{
			Release: db.SiteDesignRelease{ID: 78, ThemeSlug: siteDesignTheme.Slug, PublishedAt: time.Now()},
			Version: db.GlobalStyleVersion{VersionNo: 1},
		}, nil)
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusOK)
	})

	t.Run("the draft changed during the publish", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, stylesRow(`{"radius":{"md":"10px"}}`, `{}`, 1))
		store.EXPECT().PublishGlobalStylesTx(gomock.Any(), gomock.Any()).Return(db.PublishGlobalStylesTxResult{}, db.ErrGlobalStylesChanged)
		expectStylesRow(store, stylesRow(`{"radius":{"md":"12px"}}`, `{}`, 2))
		rsp := requireCode(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusConflict, "styles_changed")
		require.Contains(t, string(rsp["current"]), "12px")
		require.Empty(t, activityOf(t, server).verbs())
	})

	t.Run("a draft the theme no longer fits", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, stylesRow(`{"colors":{"light":{"retired":"#123456"}}}`, `{}`, 1))
		rsp := requireCode(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusConflict, "styles_invalid")
		require.JSONEq(t, `"colors.light.retired"`, string(rsp["path"]))
		require.JSONEq(t, `"unknown_token"`, string(rsp["reason"]))
	})

	t.Run("a theme without global styles", func(t *testing.T) {
		server, store := siteDesignServer(t)
		server.themeTokens = ThemeTokenManifest{}
		expectStylesRow(store, stylesRow(`{"radius":{"md":"10px"}}`, `{}`, 1))
		requireCode(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusConflict, "global_styles_unsupported")
	})

	t.Run("a failed transaction", func(t *testing.T) {
		server, store := siteDesignServer(t)
		expectStylesRow(store, stylesRow(`{"radius":{"md":"10px"}}`, `{}`, 1))
		store.EXPECT().PublishGlobalStylesTx(gomock.Any(), gomock.Any()).Return(db.PublishGlobalStylesTxResult{}, errors.New("down"))
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", ""), http.StatusInternalServerError)
		require.Empty(t, activityOf(t, server).verbs())
	})

	t.Run("a bad body", func(t *testing.T) {
		server, store := siteDesignServer(t)
		requireStatus(t, siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/publish", `{"confirm_contrast":"yes"}`), http.StatusBadRequest)
	})
}

// GET /themes/active is public: it serves the published override, never the draft (the
// query reads global_styles.published only), and {} when there is none.
func TestActiveThemeServesPublishedGlobalStyles(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	row := db.GetActiveThemeWithSettingsRow{ID: 1, Slug: "default", Name: "Default", Active: true, Config: json.RawMessage(`{}`), Settings: []byte(`{}`)}

	store.EXPECT().GetActiveThemeWithSettings(gomock.Any()).Return(row, nil)
	recorder := cacheGet(t, server, "/api/v1/themes/active")
	requireStatus(t, recorder, http.StatusOK)
	require.JSONEq(t, `{}`, string(decodeError(t, recorder)["global_styles"]))

	row.GlobalStyles = json.RawMessage(`{"colors":{"light":{"primary":"#155e4b"}}}`)
	store.EXPECT().GetActiveThemeWithSettings(gomock.Any()).Return(row, nil)
	recorder = cacheGet(t, server, "/api/v1/themes/active")
	requireStatus(t, recorder, http.StatusOK)
	require.JSONEq(t, `{"colors":{"light":{"primary":"#155e4b"}}}`, string(decodeError(t, recorder)["global_styles"]))
}
