package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

func randomSetting() db.Setting {
	return db.Setting{
		ID:               1,
		PostUrlStructure: "slug",
		SiteTitle:        sql.NullString{String: "My Site", Valid: true},
		PostsPerPage:     sql.NullInt32{Int32: 10, Valid: true},
		CreatedAt:        time.Now(),
		ChangedAt:        time.Now(),

		SiteTagline:             "Notes from the team",
		SiteLanguage:            "pt-BR",
		SiteTimezone:            "America/Sao_Paulo",
		DateFormat:              "day_month_year",
		EditorMarkdownShortcuts: true,
		EditorAllowedEmbeds:     []string{"youtube", "vimeo"},
	}
}

func randomExtensionSetting() db.ExtensionSetting {
	return db.ExtensionSetting{
		Key:           "theme:my-theme:options",
		Value:         json.RawMessage(`"enabled"`),
		ExtensionType: "theme",
		ExtensionID:   "my-theme",
		CreatedAt:     time.Now(),
		ChangedAt:     time.Now(),
	}
}

func TestGetSettingsAPI(t *testing.T) {
	setting := randomSetting()

	testCases := []struct {
		name          string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetSettings(gomock.Any()).
					Times(1).
					Return(setting, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp SettingsResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, setting.PostUrlStructure, resp.PostURLStructure)
				require.Equal(t, setting.SiteTitle.String, resp.SiteTitle)
				require.Equal(t, setting.PostsPerPage.Int32, resp.PostsPerPage)
			},
		},
		{
			name: "NotFound",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetSettings(gomock.Any()).
					Times(1).
					Return(db.Setting{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name: "InternalError",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetSettings(gomock.Any()).
					Times(1).
					Return(db.Setting{}, fmt.Errorf("db error"))
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			request, err := http.NewRequest(http.MethodGet, "/api/v1/settings", nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestUpdateSettingsAPI(t *testing.T) {
	setting := randomSetting()

	testCases := []struct {
		name          string
		body          map[string]interface{}
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			body: map[string]interface{}{
				"post_url_structure": "slug",
				"site_title":         "Updated Site",
				"posts_per_page":     int32(20),
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpdateSettings(gomock.Any(), gomock.Any()).
					Times(1).
					Return(setting, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp SettingsResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, setting.PostUrlStructure, resp.PostURLStructure)
			},
		},
		{
			name: "ForbiddenEditor",
			body: map[string]interface{}{
				"site_title": "Updated Site",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 2, "editor_caller", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				// requireSiteAdmin rejects the editor: settings writes are admin only
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(int64(2))).
					Times(1).
					Return(db.User{ID: 2, Username: "editor_caller", Role: "editor"}, nil)
				store.EXPECT().
					UpdateSettings(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name: "NoAuthorization",
			body: map[string]interface{}{
				"site_title": "Updated Site",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpdateSettings(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "InvalidPostURLStructure",
			body: map[string]interface{}{
				"post_url_structure": "invalid-value", // must be "id" or "slug"
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpdateSettings(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)
			stubRoleLookup(store, db.User{ID: 1, Username: "testuser", Role: "admin"})

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			request, err := http.NewRequest(http.MethodPut, "/api/v1/settings", bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetExtensionSettingAPI(t *testing.T) {
	extSetting := randomExtensionSetting()

	testCases := []struct {
		name          string
		key           string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			key:  extSetting.Key,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetThemeExtensionSetting(gomock.Any(), extSetting.Key).
					Times(1).
					Return(extSetting, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp ExtensionSettingResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, extSetting.Key, resp.Key)
				require.Equal(t, extSetting.ExtensionType, resp.ExtensionType)
				require.Equal(t, extSetting.ExtensionID, resp.ExtensionID)
			},
		},
		{
			name: "NotFound",
			key:  "nonexistent-key",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetThemeExtensionSetting(gomock.Any(), "nonexistent-key").
					Times(1).
					Return(db.ExtensionSetting{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name: "InternalError",
			key:  extSetting.Key,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetThemeExtensionSetting(gomock.Any(), extSetting.Key).
					Times(1).
					Return(db.ExtensionSetting{}, fmt.Errorf("db error"))
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/extension-settings/%s", tc.key)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestListExtensionSettingsAPI(t *testing.T) {
	extSetting := randomExtensionSetting()
	settings := []db.ExtensionSetting{extSetting}

	testCases := []struct {
		name          string
		query         string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:  "OK_AllSettings",
			query: "",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListThemeExtensionSettings(gomock.Any()).
					Times(1).
					Return(settings, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Contains(t, resp, "extension_settings")
				require.Contains(t, resp, "count")
			},
		},
		{
			name:  "OK_FilteredByExtension",
			query: "?extension_type=theme&extension_id=my-theme",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListExtensionSettingsByExtension(gomock.Any(), db.ListExtensionSettingsByExtensionParams{
						ExtensionType: "theme",
						ExtensionID:   "my-theme",
					}).
					Times(1).
					Return(settings, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Contains(t, resp, "extension_settings")
				list, ok := resp["extension_settings"].([]interface{})
				require.True(t, ok)
				require.Len(t, list, 1)
			},
		},
		{
			name:  "OK_ExtensionIDAloneMeansATheme",
			query: "?extension_id=my-plugin",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListExtensionSettingsByExtension(gomock.Any(), db.ListExtensionSettingsByExtensionParams{
						ExtensionType: "theme",
						ExtensionID:   "my-plugin",
					}).
					Times(1).
					Return(nil, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:  "PluginTypeIsNeverLookedUp",
			query: "?extension_type=plugin&extension_id=my-plugin",
			buildStubs: func(store *mockdb.MockStore) {
				// No expectations: the store must not be asked.
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				require.JSONEq(t, `{"extension_settings":[],"count":0}`, recorder.Body.String())
			},
		},
		{
			name:  "InternalError",
			query: "",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListThemeExtensionSettings(gomock.Any()).
					Times(1).
					Return(nil, fmt.Errorf("db error"))
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/extension-settings%s", tc.query)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestUpsertExtensionSettingAPI(t *testing.T) {
	extSetting := randomExtensionSetting()

	testCases := []struct {
		name          string
		body          map[string]interface{}
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			body: map[string]interface{}{
				"key":            "theme:my-theme:options",
				"value":          "enabled",
				"extension_type": "theme",
				"extension_id":   "my-theme",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpsertExtensionSetting(gomock.Any(), gomock.Any()).
					Times(1).
					Return(extSetting, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp ExtensionSettingResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, extSetting.Key, resp.Key)
				require.Equal(t, extSetting.ExtensionType, resp.ExtensionType)
			},
		},
		{
			name: "NoAuthorization",
			body: map[string]interface{}{
				"key":            "theme:my-theme:options",
				"value":          "enabled",
				"extension_type": "theme",
				"extension_id":   "my-theme",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpsertExtensionSetting(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "InvalidExtensionType",
			body: map[string]interface{}{
				"key":            "theme:my-theme:options",
				"value":          "enabled",
				"extension_type": "invalid-type", // only "theme" is accepted here
				"extension_id":   "my-theme",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpsertExtensionSetting(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "PluginType",
			body: map[string]interface{}{
				"key":            "plugin:my-plugin:api_key",
				"value":          "enabled",
				"extension_type": "plugin",
				"extension_id":   "my-plugin",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpsertExtensionSetting(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "MissingRequiredField",
			body: map[string]interface{}{
				// missing "key" field
				"value":          "enabled",
				"extension_type": "theme",
				"extension_id":   "my-theme",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpsertExtensionSetting(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)
			stubRoleLookup(store, db.User{ID: 1, Username: "testuser", Role: "admin"})

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			request, err := http.NewRequest(http.MethodPut, "/api/v1/extension-settings", bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestValidThemeSettingKey(t *testing.T) {
	testCases := []struct {
		name, key, extensionID string
		want                   bool
	}{
		{"its own namespace", "theme:paper:accent", "paper", true},
		{"a name with colons", "theme:paper:a:b", "paper", true},
		{"a bare key", "accent", "paper", false},
		{"the old slug:key shape", "paper:accent", "paper", false},
		{"another theme's namespace", "theme:atlas:accent", "paper", false},
		{"a longer slug sharing the prefix", "theme:paper2:accent", "paper", false},
		{"no name", "theme:paper:", "paper", false},
		{"a plugin's key", "plugin:paper:accent", "paper", false},
		{"a slug with a colon", "theme:a:b:accent", "a:b", false},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, validThemeSettingKey(tc.key, tc.extensionID))
		})
	}
}

func TestDeleteExtensionSettingAPI(t *testing.T) {
	key := "theme:my-theme:options"

	testCases := []struct {
		name          string
		key           string
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			key:  key,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					DeleteThemeExtensionSetting(gomock.Any(), key).
					Times(1).
					Return(int64(1), nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name: "NotAThemeRow",
			key:  "plugin:my-plugin:api_key",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					DeleteThemeExtensionSetting(gomock.Any(), "plugin:my-plugin:api_key").
					Times(1).
					Return(int64(0), nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name: "NoAuthorization",
			key:  key,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					DeleteThemeExtensionSetting(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "InternalError",
			key:  key,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					DeleteThemeExtensionSetting(gomock.Any(), key).
					Times(1).
					Return(int64(0), fmt.Errorf("db error"))
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)
			stubRoleLookup(store, db.User{ID: 1, Username: "testuser", Role: "admin"})

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			url := fmt.Sprintf("/api/v1/extension-settings/%s", tc.key)
			request, err := http.NewRequest(http.MethodDelete, url, nil)
			require.NoError(t, err)

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}
