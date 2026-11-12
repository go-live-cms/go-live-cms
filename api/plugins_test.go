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
	"github.com/go-live-cms/go-live-cms/pluginsdk"
)

// The plugin registry's routes and startup sync (#455) on a mock store. The same flows
// against the real database: plugins_db_test.go.

var (
	pluginAdmin       = db.User{ID: 61, Username: "plugin_admin", Role: RoleAdmin}
	pluginEditor      = db.User{ID: 62, Username: "plugin_editor", Role: RoleEditor}
	pluginContributor = db.User{ID: 63, Username: "plugin_contrib", Role: RoleContributor}
)

func fixturePlugin(slug, status string, enabled bool) db.Plugin {
	manifest, _ := json.Marshal(map[string]any{
		"manifest_version": 1, "id": slug, "name": "Plugin " + slug, "version": "1.0.0", "plugin_api": 1,
		"capabilities": []string{"posts:read"}, "blocks": []string{"Note"},
		"settings": map[string]any{"limit": map[string]any{"type": "number"}},
		"server":   map[string]any{"hooks": []map[string]any{{"event": "post.saved"}}},
	})
	plugin := db.Plugin{
		ID: 7, Slug: slug, Name: "Plugin " + slug, Version: "1.0.0", Manifest: manifest,
		ContentHash: strings.Repeat("a", 64), Status: status, Enabled: enabled,
		InstalledAt: time.Now(), ChangedAt: time.Now(),
	}
	if enabled {
		plugin.EnabledAt = sql.NullTime{Time: time.Now(), Valid: true}
		plugin.EnabledBy = sql.NullInt64{Int64: pluginAdmin.ID, Valid: true}
	}
	return plugin
}

func pluginRequest(t *testing.T, server *Server, store *mockdb.MockStore, caller *db.User, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, nil)
	if caller != nil {
		signInAs(t, server, store, request, *caller)
	}
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

// pluginRoutes are the registry's routes and who may call them. A plugin is trusted
// code (design section 2), so TestPluginRoutesRequireRole fails for a route added
// without being listed here.
var pluginRoutes = map[string]string{
	"GET /api/v1/plugins":                "requireSiteAdmin",
	"GET /api/v1/plugins/:slug":          "requireSiteAdmin",
	"POST /api/v1/plugins/:slug/enable":  "requireSiteAdmin",
	"POST /api/v1/plugins/:slug/disable": "requireSiteAdmin",
	"GET /api/v1/plugins/enabled":        "content roles: slugs only",
	// #457: settings are admin-only, secrets included.
	"GET /api/v1/plugins/:slug/settings":    "requireSiteAdmin",
	"PUT /api/v1/plugins/:slug/settings":    "requireSiteAdmin",
	"DELETE /api/v1/plugins/:slug/settings": "requireSiteAdmin",
}

func TestPluginRoutesRequireRole(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	store.EXPECT().ListEnabledPluginSlugs(gomock.Any()).AnyTimes().Return([]string{}, nil)

	registered := map[string]bool{}
	for _, route := range server.router.Routes() {
		if !strings.HasPrefix(route.Path, "/api/v1/plugins") {
			continue
		}
		key := route.Method + " " + route.Path
		registered[key] = true
		rule, listed := pluginRoutes[key]
		require.True(t, listed, "%s is a plugin route missing from pluginRoutes", key)

		t.Run(key, func(t *testing.T) {
			path := routeExample(route.Path)
			require.Equal(t, http.StatusUnauthorized, pluginRequest(t, server, store, nil, route.Method, path).Code, "anonymous")
			if rule != "requireSiteAdmin" {
				for _, caller := range []db.User{pluginEditor, pluginContributor} {
					require.Equal(t, http.StatusOK, pluginRequest(t, server, store, &caller, route.Method, path).Code, caller.Role)
				}
				return
			}
			for _, caller := range []db.User{pluginEditor, pluginContributor} {
				require.Equal(t, http.StatusForbidden, pluginRequest(t, server, store, &caller, route.Method, path).Code, caller.Role)
			}
		})
	}
	for key := range pluginRoutes {
		require.True(t, registered[key], "pluginRoutes lists %s, which is no longer a route", key)
	}
	require.Empty(t, activityOf(t, server).verbs(), "a refused request records nothing")
}

func TestListPlugins(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)

	incompatible := fixturePlugin("future", PluginStatusIncompatible, false)
	incompatible.Manifest = json.RawMessage(`{"plugin_api": 9, "id": "future"}`)
	invalid := fixturePlugin("broken", PluginStatusIncompatible, true)
	// Its code still has the hook its last valid plugin.json declares (#458), so the
	// manifest is what's wrong, not the hooks.
	server.pluginRegistry = pluginHookRegistry{"broken": observing(pluginsdk.EventPostSaved)}
	store.EXPECT().ListPlugins(gomock.Any()).Return([]db.Plugin{
		fixturePlugin("alpha", PluginStatusInstalled, true),
		fixturePlugin("gone", PluginStatusMissing, true),
		incompatible, invalid,
	}, nil)

	recorder := pluginRequest(t, server, store, &pluginAdmin, http.MethodGet, "/api/v1/plugins")
	requireStatus(t, recorder, http.StatusOK)
	var rsp struct {
		Plugins   []PluginResponse `json:"plugins"`
		Count     int              `json:"count"`
		PluginAPI PluginAPIRange   `json:"plugin_api"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	require.Equal(t, 4, rsp.Count)
	require.Equal(t, PluginAPIRange{Min: PluginAPIMin, Max: PluginAPIMax}, rsp.PluginAPI)

	alpha := rsp.Plugins[0]
	require.True(t, alpha.Enabled)
	require.True(t, alpha.Active)
	require.Equal(t, []string{"posts:read"}, alpha.Capabilities)
	require.Equal(t, []string{"Note"}, alpha.Blocks)
	require.Equal(t, []PluginHook{{Event: "post.saved"}}, alpha.Hooks)
	require.True(t, alpha.HasSettings)
	require.Equal(t, pluginAdmin.ID, *alpha.EnabledBy)
	require.NotNil(t, alpha.EnabledAt)
	require.Nil(t, alpha.Manifest, "the list leaves the manifest out")
	require.Empty(t, alpha.IncompatibleReason)

	gone := rsp.Plugins[1]
	require.True(t, gone.Enabled, "a missing plugin keeps its flag")
	require.False(t, gone.Active, "but isn't running")

	require.Equal(t, "plugin_api", rsp.Plugins[2].IncompatibleReason)
	require.Equal(t, []string{}, rsp.Plugins[2].Capabilities)
	require.Equal(t, []PluginHook{}, rsp.Plugins[2].Hooks)
	require.Nil(t, rsp.Plugins[2].EnabledBy)
	require.Equal(t, "invalid_manifest", rsp.Plugins[3].IncompatibleReason)
	require.False(t, rsp.Plugins[3].Active)

	t.Run("a store failure is a 500", func(t *testing.T) {
		store.EXPECT().ListPlugins(gomock.Any()).Return(nil, errors.New("down"))
		requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodGet, "/api/v1/plugins"), http.StatusInternalServerError)
	})
}

func TestGetPlugin(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)

	plugin := fixturePlugin("alpha", PluginStatusInstalled, false)
	store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(plugin, nil)
	recorder := pluginRequest(t, server, store, &pluginAdmin, http.MethodGet, "/api/v1/plugins/alpha")
	requireStatus(t, recorder, http.StatusOK)
	var rsp struct {
		Plugin PluginResponse `json:"plugin"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	require.JSONEq(t, string(plugin.Manifest), string(rsp.Plugin.Manifest))
	require.Nil(t, rsp.Plugin.EnabledAt)

	store.EXPECT().GetPluginBySlug(gomock.Any(), "nope").Return(db.Plugin{}, sql.ErrNoRows)
	recorder = pluginRequest(t, server, store, &pluginAdmin, http.MethodGet, "/api/v1/plugins/nope")
	requireStatus(t, recorder, http.StatusNotFound)
	require.Contains(t, recorder.Body.String(), `"plugin_not_found"`)

	// Not a valid slug: 404 without a lookup.
	requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodGet, "/api/v1/plugins/Bad_Slug"), http.StatusNotFound)

	store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(db.Plugin{}, errors.New("down"))
	requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodGet, "/api/v1/plugins/alpha"), http.StatusInternalServerError)
}

func TestListEnabledPlugins(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)

	store.EXPECT().ListEnabledPluginSlugs(gomock.Any()).Return([]string{"alpha", "beta"}, nil)
	recorder := pluginRequest(t, server, store, &pluginContributor, http.MethodGet, "/api/v1/plugins/enabled")
	requireStatus(t, recorder, http.StatusOK)
	require.JSONEq(t, `{"plugins": ["alpha", "beta"]}`, recorder.Body.String())

	store.EXPECT().ListEnabledPluginSlugs(gomock.Any()).Return(nil, errors.New("down"))
	requireStatus(t, pluginRequest(t, server, store, &pluginContributor, http.MethodGet, "/api/v1/plugins/enabled"), http.StatusInternalServerError)
}

func TestEnablePlugin(t *testing.T) {
	path := "/api/v1/plugins/alpha/enable"

	t.Run("enables and records it", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, false), nil)
		store.EXPECT().EnablePlugin(gomock.Any(), db.EnablePluginParams{
			Slug: "alpha", EnabledBy: sql.NullInt64{Int64: pluginAdmin.ID, Valid: true},
		}).Return(fixturePlugin("alpha", PluginStatusInstalled, true), nil)

		recorder := pluginRequest(t, server, store, &pluginAdmin, http.MethodPost, path)
		requireStatus(t, recorder, http.StatusOK)
		require.Contains(t, recorder.Body.String(), `"enabled":true`)
		events := activityOf(t, server)
		require.Equal(t, []string{"plugin_enabled plugin:7"}, events.verbs())
		require.Equal(t, sql.NullInt64{Int64: pluginAdmin.ID, Valid: true}, events.events[0].ActorID)
		require.JSONEq(t, `{"version": "1.0.0"}`, string(events.events[0].Payload))
	})

	t.Run("already enabled: 200, nothing written or recorded", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, true), nil)
		requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodPost, path), http.StatusOK)
		require.Empty(t, activityOf(t, server).verbs())
	})

	for status, code := range map[string]string{PluginStatusIncompatible: "plugin_incompatible", PluginStatusMissing: "plugin_missing"} {
		t.Run(status+" can't be enabled", func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			server := newTestServer(t, store)
			store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", status, false), nil)
			recorder := pluginRequest(t, server, store, &pluginAdmin, http.MethodPost, path)
			requireStatus(t, recorder, http.StatusConflict)
			require.Contains(t, recorder.Body.String(), `"code":"`+code+`"`)
			require.Empty(t, activityOf(t, server).verbs())
		})
	}

	t.Run("marked incompatible between the read and the write: 409", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		gomock.InOrder(
			store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, false), nil),
			store.EXPECT().EnablePlugin(gomock.Any(), gomock.Any()).Return(db.Plugin{}, sql.ErrNoRows),
			store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusIncompatible, false), nil),
		)
		requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodPost, path), http.StatusConflict)
		require.Empty(t, activityOf(t, server).verbs())
	})

	t.Run("enabled and disabled again meanwhile: 409 plugin_changed", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		gomock.InOrder(
			store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, false), nil),
			store.EXPECT().EnablePlugin(gomock.Any(), gomock.Any()).Return(db.Plugin{}, sql.ErrNoRows),
			store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, false), nil),
		)
		recorder := pluginRequest(t, server, store, &pluginAdmin, http.MethodPost, path)
		requireStatus(t, recorder, http.StatusConflict)
		require.Contains(t, recorder.Body.String(), `"code":"plugin_changed"`)
	})

	t.Run("enabled by someone else meanwhile: 200, recorded by them", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		gomock.InOrder(
			store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, false), nil),
			store.EXPECT().EnablePlugin(gomock.Any(), gomock.Any()).Return(db.Plugin{}, sql.ErrNoRows),
			store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, true), nil),
		)
		requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodPost, path), http.StatusOK)
		require.Empty(t, activityOf(t, server).verbs())
	})

	t.Run("failures", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, false), nil)
		store.EXPECT().EnablePlugin(gomock.Any(), gomock.Any()).Return(db.Plugin{}, errors.New("down"))
		requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodPost, path), http.StatusInternalServerError)

		gomock.InOrder(
			store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, false), nil),
			store.EXPECT().EnablePlugin(gomock.Any(), gomock.Any()).Return(db.Plugin{}, sql.ErrNoRows),
			store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(db.Plugin{}, errors.New("down")),
		)
		requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodPost, path), http.StatusInternalServerError)

		gomock.InOrder(
			store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, false), nil),
			store.EXPECT().EnablePlugin(gomock.Any(), gomock.Any()).Return(db.Plugin{}, sql.ErrNoRows),
			store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(db.Plugin{}, sql.ErrNoRows),
		)
		requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodPost, path), http.StatusNotFound)

		store.EXPECT().GetPluginBySlug(gomock.Any(), "ghost").Return(db.Plugin{}, sql.ErrNoRows)
		requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodPost, "/api/v1/plugins/ghost/enable"), http.StatusNotFound)
		require.Empty(t, activityOf(t, server).verbs())
	})
}

func TestDisablePlugin(t *testing.T) {
	path := "/api/v1/plugins/alpha/disable"

	// Any status: a missing or incompatible plugin can be turned off too.
	for _, status := range []string{PluginStatusInstalled, PluginStatusMissing, PluginStatusIncompatible} {
		t.Run("disables a "+status+" plugin and records it", func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			server := newTestServer(t, store)
			store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", status, true), nil)
			store.EXPECT().DisablePlugin(gomock.Any(), "alpha").Return(fixturePlugin("alpha", status, false), nil)
			recorder := pluginRequest(t, server, store, &pluginAdmin, http.MethodPost, path)
			requireStatus(t, recorder, http.StatusOK)
			require.Contains(t, recorder.Body.String(), `"enabled":false`)
			require.Equal(t, []string{"plugin_disabled plugin:7"}, activityOf(t, server).verbs())
		})
	}

	t.Run("already disabled: 200, nothing recorded", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, false), nil)
		requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodPost, path), http.StatusOK)
		require.Empty(t, activityOf(t, server).verbs())
	})

	t.Run("disabled by someone else meanwhile", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		gomock.InOrder(
			store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, true), nil),
			store.EXPECT().DisablePlugin(gomock.Any(), "alpha").Return(db.Plugin{}, sql.ErrNoRows),
			store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, false), nil),
		)
		requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodPost, path), http.StatusOK)
		require.Empty(t, activityOf(t, server).verbs())
	})

	t.Run("a store failure is a 500", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		store.EXPECT().GetPluginBySlug(gomock.Any(), "alpha").Return(fixturePlugin("alpha", PluginStatusInstalled, true), nil)
		store.EXPECT().DisablePlugin(gomock.Any(), "alpha").Return(db.Plugin{}, errors.New("down"))
		requireStatus(t, pluginRequest(t, server, store, &pluginAdmin, http.MethodPost, path), http.StatusInternalServerError)
	})
}
