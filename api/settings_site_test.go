package api

import (
	"bytes"
	"encoding/json"
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

// The General and Editor settings (#330): validation, what PUT stores and what /settings
// returns.

func putSettings(t *testing.T, store *mockdb.MockStore, role string, body string) *httptest.ResponseRecorder {
	t.Helper()
	stubRoleLookup(store, db.User{ID: 1, Username: "testuser", Role: role})
	server := newTestServer(t, store)
	recorder := httptest.NewRecorder()
	request, err := http.NewRequest(http.MethodPut, "/api/v1/settings", bytes.NewReader([]byte(body)))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func TestUpdateSiteSettingsValidation(t *testing.T) {
	testCases := []struct {
		name  string
		body  string
		field string
	}{
		{"UnknownTimeZone", `{"site_timezone":"Mars/Olympus_Mons"}`, "site_timezone"},
		{"LocalTimeZone", `{"site_timezone":"Local"}`, "site_timezone"},
		{"EmptyTimeZone", `{"site_timezone":""}`, "site_timezone"},
		{"PaddedTimeZone", `{"site_timezone":" UTC"}`, "site_timezone"},
		{"UnknownLanguage", `{"site_language":"xx-YY"}`, "site_language"},
		{"LanguageWrongCase", `{"site_language":"pt-br"}`, "site_language"},
		{"EmptyLanguage", `{"site_language":""}`, "site_language"},
		{"UnknownDatePreset", `{"date_format":"yyyy/mm/dd"}`, "date_format"},
		{"TaglineTooLong", `{"site_tagline":"` + strings.Repeat("a", SiteTaglineMax+1) + `"}`, "site_tagline"},
		{"TaglineMultiLine", `{"site_tagline":"one\ntwo"}`, "site_tagline"},
		{"EmbedNotAllowed", `{"editor_allowed_embeds":["youtube","evil.example"]}`, "editor_allowed_embeds[1]"},
		{"TooManyEmbeds", `{"editor_allowed_embeds":[` + strings.TrimSuffix(strings.Repeat(`"youtube",`, maxAllowedEmbeds+1), ",") + `]}`, "editor_allowed_embeds"},
		{"MarkdownShortcutsNotBool", `{"editor_markdown_shortcuts":"yes"}`, "editor_markdown_shortcuts"},
		{"SiteAddressIsReadOnly", `{"site_address":"https://evil.example"}`, "site_address"},
	}
	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(0)

			recorder := putSettings(t, store, "admin", tc.body)
			require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
			var resp struct {
				Fields map[string]string `json:"fields"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
			require.Contains(t, resp.Fields, tc.field)
		})
	}
}

func TestUpdateSiteSettingsStores(t *testing.T) {
	testCases := []struct {
		name  string
		body  string
		check func(t *testing.T, params db.UpdateSettingsParams)
	}{
		{
			name: "AllFields",
			body: `{"site_tagline":"  Notes from the team  ","site_language":"pt-BR","site_timezone":"America/Sao_Paulo",
				"date_format":"iso","editor_markdown_shortcuts":false,"editor_allowed_embeds":["vimeo","youtube","vimeo"]}`,
			check: func(t *testing.T, p db.UpdateSettingsParams) {
				require.Equal(t, "Notes from the team", p.SiteTagline.String)
				require.True(t, p.SiteTagline.Valid)
				require.Equal(t, "pt-BR", p.SiteLanguage.String)
				require.Equal(t, "America/Sao_Paulo", p.SiteTimezone.String)
				require.Equal(t, "iso", p.DateFormat.String)
				require.True(t, p.EditorMarkdownShortcuts.Valid)
				require.False(t, p.EditorMarkdownShortcuts.Bool)
				require.Equal(t, []string{"vimeo", "youtube"}, p.EditorAllowedEmbeds)
			},
		},
		{
			name: "AbsentKeepsEverything",
			body: `{"site_title":"Field Notes"}`,
			check: func(t *testing.T, p db.UpdateSettingsParams) {
				require.False(t, p.SiteTagline.Valid)
				require.False(t, p.SiteLanguage.Valid)
				require.False(t, p.SiteTimezone.Valid)
				require.False(t, p.DateFormat.Valid)
				require.False(t, p.EditorMarkdownShortcuts.Valid)
				require.Nil(t, p.EditorAllowedEmbeds)
			},
		},
		{
			name: "EmptyClears",
			body: `{"site_tagline":"","editor_allowed_embeds":[]}`,
			check: func(t *testing.T, p db.UpdateSettingsParams) {
				require.True(t, p.SiteTagline.Valid)
				require.Equal(t, "", p.SiteTagline.String)
				require.NotNil(t, p.EditorAllowedEmbeds)
				require.Empty(t, p.EditorAllowedEmbeds)
			},
		},
		{
			name: "UTCAndOtherLanguages",
			body: `{"site_timezone":"UTC","site_language":"en-GB","date_format":"day_month_year"}`,
			check: func(t *testing.T, p db.UpdateSettingsParams) {
				require.Equal(t, "UTC", p.SiteTimezone.String)
				require.Equal(t, "en-GB", p.SiteLanguage.String)
			},
		},
	}
	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(1).
				DoAndReturn(func(_ any, p db.UpdateSettingsParams) (db.Setting, error) {
					tc.check(t, p)
					return randomSetting(), nil
				})

			recorder := putSettings(t, store, "admin", tc.body)
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		})
	}
}

func TestUpdateSiteSettingsPermissions(t *testing.T) {
	for _, role := range []string{"editor", "contributor"} {
		t.Run(role, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(0)

			recorder := putSettings(t, store, role, `{"editor_markdown_shortcuts":false}`)
			require.Equal(t, http.StatusForbidden, recorder.Code)
		})
	}
}

func TestGetSettingsReturnsSiteSettings(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	setting := randomSetting()
	store.EXPECT().GetSettings(gomock.Any()).Times(1).Return(setting, nil)

	server := newTestServer(t, store)
	recorder := httptest.NewRecorder()
	request, err := http.NewRequest(http.MethodGet, "/api/v1/settings", nil)
	require.NoError(t, err)
	server.router.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	var resp map[string]any
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
	require.Equal(t, "Notes from the team", resp["site_tagline"])
	require.Equal(t, "pt-BR", resp["site_language"])
	require.Equal(t, "America/Sao_Paulo", resp["site_timezone"])
	require.Equal(t, "day_month_year", resp["date_format"])
	require.Equal(t, true, resp["editor_markdown_shortcuts"])
	require.Equal(t, []any{"youtube", "vimeo"}, resp["editor_allowed_embeds"])
	// PUBLIC_BASE_URL from newTestConfig.
	require.Equal(t, server.config.PublicBaseURL, resp["site_address"])
}

func TestSettingsResponseNilEmbedsIsEmptyList(t *testing.T) {
	setting := randomSetting()
	setting.EditorAllowedEmbeds = nil
	data, err := json.Marshal(toSettingsResponse(setting, ""))
	require.NoError(t, err)
	require.Contains(t, string(data), `"editor_allowed_embeds":[]`)
}

func TestSiteSettingsHelpers(t *testing.T) {
	require.True(t, isTimeZone("UTC"))
	require.True(t, isTimeZone("America/Sao_Paulo"))
	require.True(t, isTimeZone("Asia/Kathmandu"))
	require.False(t, isTimeZone("../../etc/passwd"))

	require.Equal(t, "portuguese", searchConfigForLanguage("pt-BR"))
	require.Equal(t, "english", searchConfigForLanguage("en-GB"))
	require.Equal(t, "simple", searchConfigForLanguage("xx-YY"))
	require.Equal(t, "simple", searchConfigForLanguage(""))
	for _, l := range siteLanguages {
		require.True(t, isSiteLanguage(l.Tag))
		require.NotEmpty(t, l.SearchConfig)
	}

	require.Nil(t, normalizeEmbeds(nil))
	require.Equal(t, []string{"x", "loom"}, normalizeEmbeds([]string{"x", "loom", "x"}))
	require.False(t, isSingleLine("a\tb"))
	require.True(t, isSingleLine("Notes — from the team"))
}

func TestSiteAddressUnusableConfig(t *testing.T) {
	server := &Server{}
	server.config.PublicBaseURL = "ftp://cms.example.com"
	require.Equal(t, "", server.siteAddress())
	server.config.PublicBaseURL = "https://cms.example.com/"
	require.Equal(t, "https://cms.example.com", server.siteAddress())
}
