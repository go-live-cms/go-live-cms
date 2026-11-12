package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Plugin settings (#457) against the test database (skipped without one): the
// issue's acceptance list through the real router and extension_settings.

func TestPluginSettingsFlow(t *testing.T) {
	conn, store := scheduleTestDB(t)
	server := authFlowServer(t, store, nil)
	ctx := context.Background()
	admin := scheduleUser(t, store, RoleAdmin)
	editor := scheduleUser(t, store, RoleEditor)
	contributor := scheduleUser(t, store, RoleContributor)

	root := t.TempDir()
	slug := pluginDBSlug("settings")
	other := pluginDBSlug("neighbour")
	writePlugin(t, root, slug, pluginJSON(slug, "1.0.0", 1, `"settings":{
		"words_per_minute":{"type":"number","integer":true,"minimum":50,"maximum":600,"default":200,"label":"Words per minute"},
		"style":{"type":"string","enum":["short","long"],"default":"short"},
		"show_icon":{"type":"boolean","default":true},
		"api_key":{"type":"string","secret":true,"maxLength":64}
	}`), nil)
	writePlugin(t, root, other, pluginJSON(other, "1.0.0", 1, `"settings":{"limit":{"type":"number"}}`), nil)
	syncPluginsFrom(t, server, root, slug, other)
	row, err := store.GetPluginBySlug(ctx, slug)
	require.NoError(t, err)
	path := "/api/v1/plugins/" + slug + "/settings"

	// Rows that Delete plugin data must leave alone: another plugin's, and a theme's
	// whose extension_id happens to be the same slug.
	themeKey := "theme:" + slug + ":accent"
	for _, keep := range []db.UpsertExtensionSettingParams{
		{Key: "plugin:" + other + ":limit", Value: json.RawMessage(`5`), ExtensionType: "plugin", ExtensionID: other},
		{Key: themeKey, Value: json.RawMessage(`"red"`), ExtensionType: "theme", ExtensionID: slug},
	} {
		_, err := store.UpsertExtensionSetting(ctx, keep)
		require.NoError(t, err)
	}
	t.Cleanup(func() {
		_, _ = store.DeletePluginSettings(ctx, other)
		_ = store.DeleteExtensionSettingsByExtension(ctx, db.DeleteExtensionSettingsByExtensionParams{ExtensionType: "theme", ExtensionID: slug})
	})

	// Other roles get 403 on every settings route.
	for _, caller := range []db.User{editor, contributor} {
		requireStatus(t, as(t, server, caller, http.MethodGet, path, nil), http.StatusForbidden)
		requireStatus(t, as(t, server, caller, http.MethodPut, path, map[string]any{"values": map[string]any{"style": "long"}}), http.StatusForbidden)
		requireStatus(t, as(t, server, caller, http.MethodDelete, path, nil), http.StatusForbidden)
	}

	// The form's fields come from the manifest; nothing is stored yet.
	recorder := as(t, server, admin, http.MethodGet, path, nil)
	requireStatus(t, recorder, http.StatusOK)
	rsp := decodePluginSettings(t, recorder)
	require.Len(t, rsp.Fields, 4)
	require.Equal(t, map[string]any{"api_key": map[string]any{"set": false}}, rsp.Values)

	// A value outside the manifest's rules is refused and nothing is written.
	bad := as(t, server, admin, http.MethodPut, path, map[string]any{"values": map[string]any{"words_per_minute": 10, "style": "long"}})
	requireStatus(t, bad, http.StatusBadRequest)
	stored, err := store.ListPluginSettings(ctx, slug)
	require.NoError(t, err)
	require.Empty(t, stored)

	// Saving, secret included.
	const secret = "key-that-must-never-come-back-42"
	recorder = as(t, server, admin, http.MethodPut, path, map[string]any{"values": map[string]any{
		"words_per_minute": 250, "style": "long", "show_icon": false, "api_key": secret,
	}})
	requireStatus(t, recorder, http.StatusOK)
	require.NotContains(t, recorder.Body.String(), secret)

	stored, err = store.ListPluginSettings(ctx, slug)
	require.NoError(t, err)
	keys := map[string]string{}
	for _, setting := range stored {
		require.Equal(t, "plugin", setting.ExtensionType)
		require.Equal(t, slug, setting.ExtensionID)
		keys[setting.Key] = string(setting.Value)
	}
	require.Equal(t, map[string]string{
		"plugin:" + slug + ":api_key":          `"` + secret + `"`,
		"plugin:" + slug + ":show_icon":        `false`,
		"plugin:" + slug + ":style":            `"long"`,
		"plugin:" + slug + ":words_per_minute": `250`,
	}, keys)

	// A secret is never returned once stored, by this route or the public ones.
	recorder = as(t, server, admin, http.MethodGet, path, nil)
	requireStatus(t, recorder, http.StatusOK)
	require.NotContains(t, recorder.Body.String(), secret)
	require.Equal(t, map[string]any{
		"api_key": map[string]any{"set": true}, "show_icon": false, "style": "long", "words_per_minute": float64(250),
	}, decodePluginSettings(t, recorder).Values)
	for _, public := range []string{"/api/v1/extension-settings", "/api/v1/extension-settings?extension_type=plugin", "/api/v1/extension-settings/plugin:" + slug + ":api_key"} {
		require.NotContains(t, as(t, server, admin, http.MethodGet, public, nil).Body.String(), secret, public)
	}

	// Clearing one field, keeping the secret by not naming it.
	requireStatus(t, as(t, server, admin, http.MethodPut, path, map[string]any{"values": map[string]any{"style": nil}}), http.StatusOK)
	recorder = as(t, server, admin, http.MethodGet, path, nil)
	values := decodePluginSettings(t, recorder).Values
	require.NotContains(t, values, "style", "cleared: the default applies")
	require.Equal(t, map[string]any{"set": true}, values["api_key"])

	// The activity entries hold field names only.
	events := objectEvents(t, conn, db.ActivityObjectPlugin, row.ID)
	var updates []flowEvent
	for _, e := range events {
		if e.Verb == db.ActivityPluginSettingsUpdated {
			updates = append(updates, e)
		}
	}
	require.Len(t, updates, 2)
	require.JSONEq(t, `{"fields":["api_key","show_icon","style","words_per_minute"]}`, updates[0].Payload)
	require.JSONEq(t, `{"fields":["style"]}`, updates[1].Payload)
	require.Equal(t, sql.NullInt64{Int64: admin.ID, Valid: true}, updates[0].Actor)
	for _, e := range events {
		require.NotContains(t, e.Payload, secret)
		require.NotContains(t, e.Payload, "250")
	}

	// Delete plugin data: this plugin's rows and no others.
	recorder = as(t, server, admin, http.MethodDelete, path, nil)
	requireStatus(t, recorder, http.StatusOK)
	require.JSONEq(t, `{"deleted":3}`, recorder.Body.String())
	stored, err = store.ListPluginSettings(ctx, slug)
	require.NoError(t, err)
	require.Empty(t, stored)
	neighbour, err := store.ListPluginSettings(ctx, other)
	require.NoError(t, err)
	require.Len(t, neighbour, 1)
	theme, err := store.GetThemeExtensionSetting(ctx, themeKey)
	require.NoError(t, err)
	require.JSONEq(t, `"red"`, string(theme.Value))
	events = objectEvents(t, conn, db.ActivityObjectPlugin, row.ID)
	require.Equal(t, db.ActivityPluginDataDeleted, events[len(events)-1].Verb)
	require.JSONEq(t, `{"count":3}`, events[len(events)-1].Payload)
}
