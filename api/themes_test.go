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

func randomTheme(active bool) db.Theme {
	return db.Theme{
		ID:          1,
		Name:        "Test Theme",
		Slug:        "test-theme",
		Description: sql.NullString{String: "A test theme", Valid: true},
		Version:     "1.0.0",
		Author:      sql.NullString{String: "Tester", Valid: true},
		Config:      json.RawMessage(`{}`),
		Active:      active,
		CreatedAt:   time.Now(),
		ChangedAt:   time.Now(),
	}
}

func randomThemeSetting(themeID int64) db.ThemeSetting {
	return db.ThemeSetting{
		ID:           1,
		ThemeID:      themeID,
		SettingKey:   "primary_color",
		SettingValue: json.RawMessage(`"#ffffff"`),
		CreatedAt:    time.Now(),
		ChangedAt:    time.Now(),
	}
}

// -----------------------------------------------------------------------
// GET /themes
// -----------------------------------------------------------------------

func TestListThemesAPI(t *testing.T) {
	theme := randomTheme(true)

	testCases := []struct {
		name          string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListThemes(gomock.Any()).
					Times(1).
					Return([]db.Theme{theme}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp []ThemeResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Len(t, resp, 1)
				require.Equal(t, theme.Slug, resp[0].Slug)
			},
		},
		{
			name: "EmptyList",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListThemes(gomock.Any()).
					Times(1).
					Return([]db.Theme{}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name: "InternalError",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListThemes(gomock.Any()).
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

			request, err := http.NewRequest(http.MethodGet, "/api/v1/themes", nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// -----------------------------------------------------------------------
// GET /themes/active
// -----------------------------------------------------------------------

func TestGetActiveThemeAPI(t *testing.T) {
	theme := randomTheme(true)
	activeRow := db.GetActiveThemeWithSettingsRow{
		ID:          theme.ID,
		Name:        theme.Name,
		Slug:        theme.Slug,
		Description: theme.Description,
		Version:     theme.Version,
		Author:      theme.Author,
		Config:      theme.Config,
		Active:      true,
		CreatedAt:   theme.CreatedAt,
		ChangedAt:   theme.ChangedAt,
		Settings:    nil,
	}

	testCases := []struct {
		name          string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetActiveThemeWithSettings(gomock.Any()).
					Times(1).
					Return(activeRow, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp ActiveThemeWithSettingsResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, theme.Slug, resp.Slug)
				require.True(t, resp.Active)
			},
		},
		{
			name: "NotFound",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetActiveThemeWithSettings(gomock.Any()).
					Times(1).
					Return(db.GetActiveThemeWithSettingsRow{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name: "InternalError",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetActiveThemeWithSettings(gomock.Any()).
					Times(1).
					Return(db.GetActiveThemeWithSettingsRow{}, fmt.Errorf("db error"))
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

			request, err := http.NewRequest(http.MethodGet, "/api/v1/themes/active", nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// -----------------------------------------------------------------------
// GET /themes/:id
// -----------------------------------------------------------------------

func TestGetThemeAPI(t *testing.T) {
	theme := randomTheme(false)

	testCases := []struct {
		name          string
		themeID       int64
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:    "OK",
			themeID: theme.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTheme(gomock.Any(), theme.ID).
					Times(1).
					Return(theme, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp ThemeResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, theme.ID, resp.ID)
				require.Equal(t, theme.Slug, resp.Slug)
			},
		},
		{
			name:    "NotFound",
			themeID: 999,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTheme(gomock.Any(), int64(999)).
					Times(1).
					Return(db.Theme{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:    "InternalError",
			themeID: theme.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetTheme(gomock.Any(), theme.ID).
					Times(1).
					Return(db.Theme{}, fmt.Errorf("db error"))
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

			url := fmt.Sprintf("/api/v1/themes/%d", tc.themeID)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// -----------------------------------------------------------------------
// PUT /themes/:id/activate
// -----------------------------------------------------------------------

func TestActivateThemeAPI(t *testing.T) {
	oldTheme := randomTheme(true)
	oldTheme.ID = 1
	newTheme := randomTheme(false)
	newTheme.ID = 2
	newTheme.Slug = "new-theme"

	testCases := []struct {
		name          string
		themeID       int64
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:    "OK",
			themeID: newTheme.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				// Get old active theme (succeeds)
				store.EXPECT().
					GetActiveTheme(gomock.Any()).
					Times(1).
					Return(oldTheme, nil)
				// Deactivate all
				store.EXPECT().
					DeactivateAllThemes(gomock.Any()).
					Times(1).
					Return(nil)
				// Deactivate old theme's post types
				store.EXPECT().
					SetPostTypeActiveByRegisteredBy(gomock.Any(), db.SetPostTypeActiveByRegisteredByParams{
						IsActive:     false,
						RegisteredBy: fmt.Sprintf("theme:%s", oldTheme.Slug),
					}).
					Times(1).
					Return(nil)
				// Activate new theme
				store.EXPECT().
					ActivateTheme(gomock.Any(), newTheme.ID).
					Times(1).
					Return(newTheme, nil)
				// Activate new theme's post types
				store.EXPECT().
					SetPostTypeActiveByRegisteredBy(gomock.Any(), db.SetPostTypeActiveByRegisteredByParams{
						IsActive:     true,
						RegisteredBy: fmt.Sprintf("theme:%s", newTheme.Slug),
					}).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp ThemeResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, newTheme.Slug, resp.Slug)
			},
		},
		{
			name:    "ForbiddenEditor",
			themeID: newTheme.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 2, "editor_caller", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				// requireSiteAdmin rejects the editor before any theme work
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(int64(2))).
					Times(1).
					Return(db.User{ID: 2, Username: "editor_caller", Role: "editor"}, nil)
				store.EXPECT().
					ActivateTheme(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:    "OK_NoCurrentActiveTheme",
			themeID: newTheme.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				// No currently active theme
				store.EXPECT().
					GetActiveTheme(gomock.Any()).
					Times(1).
					Return(db.Theme{}, sql.ErrNoRows)
				store.EXPECT().
					DeactivateAllThemes(gomock.Any()).
					Times(1).
					Return(nil)
				// SetPostTypeActive not called for old theme (oldErr != nil)
				store.EXPECT().
					ActivateTheme(gomock.Any(), newTheme.ID).
					Times(1).
					Return(newTheme, nil)
				store.EXPECT().
					SetPostTypeActiveByRegisteredBy(gomock.Any(), db.SetPostTypeActiveByRegisteredByParams{
						IsActive:     true,
						RegisteredBy: fmt.Sprintf("theme:%s", newTheme.Slug),
					}).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:    "ThemeNotFound",
			themeID: 999,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetActiveTheme(gomock.Any()).
					Times(1).
					Return(db.Theme{}, sql.ErrNoRows)
				store.EXPECT().
					DeactivateAllThemes(gomock.Any()).
					Times(1).
					Return(nil)
				store.EXPECT().
					ActivateTheme(gomock.Any(), int64(999)).
					Times(1).
					Return(db.Theme{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:    "NoAuthorization",
			themeID: newTheme.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetActiveTheme(gomock.Any()).Times(0)
				store.EXPECT().DeactivateAllThemes(gomock.Any()).Times(0)
				store.EXPECT().ActivateTheme(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:    "DeactivateError",
			themeID: newTheme.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetActiveTheme(gomock.Any()).
					Times(1).
					Return(db.Theme{}, sql.ErrNoRows)
				store.EXPECT().
					DeactivateAllThemes(gomock.Any()).
					Times(1).
					Return(fmt.Errorf("db error"))
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

			url := fmt.Sprintf("/api/v1/themes/%d/activate", tc.themeID)
			request, err := http.NewRequest(http.MethodPut, url, bytes.NewReader([]byte(`{}`)))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// -----------------------------------------------------------------------
// GET /themes/:id/settings
// -----------------------------------------------------------------------

func TestGetThemeSettingsAPI(t *testing.T) {
	theme := randomTheme(true)
	setting := randomThemeSetting(theme.ID)

	testCases := []struct {
		name          string
		themeID       int64
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:    "OK",
			themeID: theme.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListThemeSettings(gomock.Any(), theme.ID).
					Times(1).
					Return([]db.ThemeSetting{setting}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp []ThemeSettingResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Len(t, resp, 1)
				require.Equal(t, setting.SettingKey, resp[0].SettingKey)
			},
		},
		{
			name:    "EmptySettings",
			themeID: theme.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListThemeSettings(gomock.Any(), theme.ID).
					Times(1).
					Return([]db.ThemeSetting{}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:    "InternalError",
			themeID: theme.ID,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					ListThemeSettings(gomock.Any(), theme.ID).
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

			url := fmt.Sprintf("/api/v1/themes/%d/settings", tc.themeID)
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// -----------------------------------------------------------------------
// PUT /themes/:id/settings/:key
// -----------------------------------------------------------------------

func TestUpdateThemeSettingAPI(t *testing.T) {
	theme := randomTheme(true)
	setting := randomThemeSetting(theme.ID)

	testCases := []struct {
		name          string
		themeID       int64
		key           string
		body          map[string]interface{}
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:    "OK",
			themeID: theme.ID,
			key:     setting.SettingKey,
			body:    map[string]interface{}{"value": "#ffffff"},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpsertThemeSetting(gomock.Any(), gomock.Any()).
					Times(1).
					Return(setting, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp ThemeSettingResponse
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Equal(t, setting.SettingKey, resp.SettingKey)
			},
		},
		{
			name:    "NoAuthorization",
			themeID: theme.ID,
			key:     setting.SettingKey,
			body:    map[string]interface{}{"value": "#ffffff"},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpsertThemeSetting(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:    "InvalidBody",
			themeID: theme.ID,
			key:     setting.SettingKey,
			body:    map[string]interface{}{}, // missing required "value"
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().UpsertThemeSetting(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:    "InternalError",
			themeID: theme.ID,
			key:     setting.SettingKey,
			body:    map[string]interface{}{"value": "#ffffff"},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					UpsertThemeSetting(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.ThemeSetting{}, fmt.Errorf("db error"))
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

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := fmt.Sprintf("/api/v1/themes/%d/settings/%s", tc.themeID, tc.key)
			request, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

// -----------------------------------------------------------------------
// PUT /themes/active/settings
// -----------------------------------------------------------------------

func TestUpdateActiveThemeSettingsAPI(t *testing.T) {
	theme := randomTheme(true)
	setting := randomThemeSetting(theme.ID)

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
				"settings": map[string]interface{}{
					"primary_color": "#ffffff",
				},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetActiveTheme(gomock.Any()).
					Times(1).
					Return(theme, nil)
				store.EXPECT().
					UpsertThemeSetting(gomock.Any(), gomock.Any()).
					Times(1).
					Return(setting, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var resp map[string]interface{}
				err := json.Unmarshal(recorder.Body.Bytes(), &resp)
				require.NoError(t, err)
				require.Contains(t, resp, "theme_id")
				require.Contains(t, resp, "settings")
			},
		},
		{
			name: "NoAuthorization",
			body: map[string]interface{}{
				"settings": map[string]interface{}{"primary_color": "#ffffff"},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetActiveTheme(gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "NoActiveTheme",
			body: map[string]interface{}{
				"settings": map[string]interface{}{"primary_color": "#ffffff"},
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetActiveTheme(gomock.Any()).
					Times(1).
					Return(db.Theme{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name: "InvalidBody",
			body: map[string]interface{}{}, // missing required "settings"
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, 1, "testuser", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				// Handler fetches active theme before binding the body
				store.EXPECT().
					GetActiveTheme(gomock.Any()).
					Times(1).
					Return(theme, nil)
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

			request, err := http.NewRequest(http.MethodPut, "/api/v1/themes/active/settings", bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}
