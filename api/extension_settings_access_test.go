package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// What /api/v1/extension-settings serves, by extension type (#451), through the
// real router and queries against the test database. These routes are public
// because the public theme reads them, so a plugin's row must never come back:
// it may hold an API key. marker is in the plugin row's value, key and slug, and
// no response may contain it.

type extensionSettingsFixture struct {
	server *Server
	store  db.Store
	admin  db.User

	marker              string
	themeSlug, themeKey string
	pluginSlug, pluginK string
}

func newExtensionSettingsFixture(t *testing.T) extensionSettingsFixture {
	t.Helper()
	store := authFlowStore(t)
	server := authFlowServer(t, store, nil)

	suffix := lettersOnly(uuid.NewString())[:16]
	f := extensionSettingsFixture{
		server:     server,
		store:      store,
		admin:      postReadUser(t, store, "admin"+suffix, RoleAdmin),
		marker:     "secret" + suffix,
		themeSlug:  "theme-" + suffix,
		pluginSlug: "secret" + suffix,
	}
	f.themeKey = "theme:" + f.themeSlug + ":accent"
	f.pluginK = "plugin:" + f.pluginSlug + ":api_key"

	ctx := context.Background()
	for _, row := range []db.UpsertExtensionSettingParams{
		{Key: f.themeKey, Value: json.RawMessage(`"indigo"`), ExtensionType: "theme", ExtensionID: f.themeSlug},
		{Key: f.pluginK, Value: json.RawMessage(`"` + f.marker + `"`), ExtensionType: "plugin", ExtensionID: f.pluginSlug},
	} {
		_, err := store.UpsertExtensionSetting(ctx, row)
		require.NoError(t, err)
	}
	t.Cleanup(func() {
		_ = store.DeleteExtensionSettingsByExtension(ctx, db.DeleteExtensionSettingsByExtensionParams{ExtensionType: "theme", ExtensionID: f.themeSlug})
		_ = store.DeleteExtensionSettingsByExtension(ctx, db.DeleteExtensionSettingsByExtensionParams{ExtensionType: "plugin", ExtensionID: f.pluginSlug})
	})
	return f
}

func (f extensionSettingsFixture) do(t *testing.T, method, path, body string, auth func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	request, err := http.NewRequest(method, path, strings.NewReader(body))
	require.NoError(t, err)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if auth != nil {
		auth(request)
	}
	recorder := httptest.NewRecorder()
	f.server.router.ServeHTTP(recorder, request)
	return recorder
}

func (f extensionSettingsFixture) pluginValueUnchanged(t *testing.T) {
	t.Helper()
	rows, err := f.store.ListExtensionSettingsByExtension(context.Background(), db.ListExtensionSettingsByExtensionParams{
		ExtensionType: "plugin", ExtensionID: f.pluginSlug,
	})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, f.pluginK, rows[0].Key)
	require.JSONEq(t, `"`+f.marker+`"`, string(rows[0].Value))
}

func TestPublicExtensionSettingsServeThemesOnly(t *testing.T) {
	f := newExtensionSettingsFixture(t)
	const base = "/api/v1/extension-settings"

	t.Run("a theme's row is public by key", func(t *testing.T) {
		recorder := f.do(t, http.MethodGet, base+"/"+f.themeKey, "", nil)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var row ExtensionSettingResponse
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &row))
		require.Equal(t, "indigo", row.Value)
		require.Equal(t, "theme", row.ExtensionType)
	})

	t.Run("a theme's rows are public by extension", func(t *testing.T) {
		recorder := f.do(t, http.MethodGet, base+"?extension_type=theme&extension_id="+f.themeSlug, "", nil)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var list struct {
			ExtensionSettings []ExtensionSettingResponse `json:"extension_settings"`
			Count             int                        `json:"count"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &list))
		require.Equal(t, 1, list.Count)
		require.Equal(t, f.themeKey, list.ExtensionSettings[0].Key)
	})

	t.Run("a plugin's row answers like an unknown key", func(t *testing.T) {
		recorder := f.do(t, http.MethodGet, base+"/"+f.pluginK, "", nil)
		unknown := f.do(t, http.MethodGet, base+"/plugin:nothing:here", "", nil)
		require.Equal(t, http.StatusNotFound, recorder.Code)
		require.Equal(t, unknown.Code, recorder.Code)
		require.NotContains(t, recorder.Body.String(), f.marker)
	})

	for _, query := range []string{
		"",
		"?extension_type=plugin",
		"?extension_type=plugin&extension_id=" + f.pluginSlug,
		"?extension_id=" + f.pluginSlug,
		"?extension_type=theme&extension_id=" + f.pluginSlug,
	} {
		t.Run("no list shows a plugin's row: "+strings.TrimPrefix(query, "?"), func(t *testing.T) {
			recorder := f.do(t, http.MethodGet, base+query, "", nil)
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
			require.NotContains(t, recorder.Body.String(), f.marker)
		})
	}

	t.Run("an admin's token unlocks nothing on these routes", func(t *testing.T) {
		auth := asUser(t, f.server, f.admin)
		require.Equal(t, http.StatusNotFound, f.do(t, http.MethodGet, base+"/"+f.pluginK, "", auth).Code)
		require.NotContains(t, f.do(t, http.MethodGet, base+"?extension_type=plugin", "", auth).Body.String(), f.marker)
	})
}

func TestExtensionSettingsWritesRefusePlugins(t *testing.T) {
	f := newExtensionSettingsFixture(t)
	const base = "/api/v1/extension-settings"
	auth := asUser(t, f.server, f.admin)

	put := func(key, extensionType, extensionID string) *httptest.ResponseRecorder {
		body, err := json.Marshal(map[string]any{"key": key, "value": "overwritten", "extension_type": extensionType, "extension_id": extensionID})
		require.NoError(t, err)
		return f.do(t, http.MethodPut, base, string(body), auth)
	}

	t.Run("PUT refuses the plugin type", func(t *testing.T) {
		require.Equal(t, http.StatusBadRequest, put(f.pluginK, "plugin", f.pluginSlug).Code)
		f.pluginValueUnchanged(t)
	})

	t.Run("PUT refuses a plugin's key under the theme type", func(t *testing.T) {
		require.Equal(t, http.StatusBadRequest, put(f.pluginK, "theme", f.pluginSlug).Code)
		f.pluginValueUnchanged(t)
	})

	t.Run("DELETE leaves a plugin's row alone", func(t *testing.T) {
		require.Equal(t, http.StatusNotFound, f.do(t, http.MethodDelete, base+"/"+f.pluginK, "", auth).Code)
		f.pluginValueUnchanged(t)
	})

	t.Run("a theme's row can be written and deleted", func(t *testing.T) {
		recorder := put(f.themeKey, "theme", f.themeSlug)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		stored, err := f.store.GetThemeExtensionSetting(context.Background(), f.themeKey)
		require.NoError(t, err)
		require.JSONEq(t, `"overwritten"`, string(stored.Value))

		require.Equal(t, http.StatusOK, f.do(t, http.MethodDelete, base+"/"+f.themeKey, "", auth).Code)
		_, err = f.store.GetThemeExtensionSetting(context.Background(), f.themeKey)
		require.True(t, errors.Is(err, sql.ErrNoRows))
	})

	t.Run("anonymous writes still need a token", func(t *testing.T) {
		require.Equal(t, http.StatusUnauthorized, f.do(t, http.MethodDelete, base+"/"+f.themeKey, "", nil).Code)
	})
}
