package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Plugin settings (#457) on a mock store: validation, secrets, activity, delete data.
// The same flows against the real database: plugins_settings_db_test.go.

const settingsFixtureSecret = "sk-live-do-not-leak-0123456789"

// settingsFixturePlugin declares one field of each kind the form draws.
func settingsFixturePlugin(status string) db.Plugin {
	plugin := fixturePlugin("checker", status, true)
	plugin.Manifest = json.RawMessage(`{
		"manifest_version": 1, "id": "checker", "name": "Link checker", "version": "1.0.0", "plugin_api": 1,
		"settings": {
			"title":     {"type": "string", "default": "Broken links", "maxLength": 20, "label": "Report title"},
			"frequency": {"type": "string", "enum": ["daily", "weekly"], "default": "daily"},
			"per_post":  {"type": "number", "integer": true, "minimum": 1, "maximum": 200, "default": 50},
			"skip_own":  {"type": "boolean", "default": true},
			"api_key":   {"type": "string", "secret": true, "label": "API key"}
		}
	}`)
	return plugin
}

func settingRow(name, value string) db.ExtensionSetting {
	return db.ExtensionSetting{
		Key: pluginSettingKey("checker", name), Value: json.RawMessage(value), ExtensionType: "plugin", ExtensionID: "checker",
	}
}

func pluginBodyRequest(t *testing.T, server *Server, store *mockdb.MockStore, caller db.User, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	request := httptest.NewRequest(method, path, bytes.NewReader(raw))
	request.Header.Set("Content-Type", "application/json")
	signInAs(t, server, store, request, caller)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func decodePluginSettings(t *testing.T, recorder *httptest.ResponseRecorder) PluginSettingsResponse {
	t.Helper()
	var rsp PluginSettingsResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	return rsp
}

func TestGetPluginSettings(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	store.EXPECT().GetPluginBySlug(gomock.Any(), "checker").Return(settingsFixturePlugin(PluginStatusInstalled), nil)
	store.EXPECT().ListPluginSettings(gomock.Any(), "checker").Return([]db.ExtensionSetting{
		settingRow("api_key", `"`+settingsFixtureSecret+`"`),
		settingRow("per_post", `120`),
		// No longer valid for the manifest (an upgrade narrowed it): reads as unset.
		settingRow("frequency", `"hourly"`),
		// Not a declared field, and a row that isn't keyed like ours: both left out.
		settingRow("retired", `1`),
		{Key: "legacy-key", Value: json.RawMessage(`"x"`), ExtensionType: "plugin", ExtensionID: "checker"},
	}, nil)

	recorder := pluginRequest(t, server, store, &pluginAdmin, http.MethodGet, "/api/v1/plugins/checker/settings")
	requireStatus(t, recorder, http.StatusOK)
	require.NotContains(t, recorder.Body.String(), settingsFixtureSecret, "a secret is never returned")
	require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))

	rsp := decodePluginSettings(t, recorder)
	names := []string{}
	for _, field := range rsp.Fields {
		names = append(names, field.Name)
	}
	require.Equal(t, []string{"api_key", "frequency", "per_post", "skip_own", "title"}, names)
	require.True(t, rsp.Fields[0].Secret)
	require.Equal(t, "Report title", rsp.Fields[4].Label)
	require.Equal(t, map[string]any{
		"api_key":  map[string]any{"set": true},
		"per_post": float64(120),
	}, rsp.Values)
}

func TestGetPluginSettingsUnsetSecret(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	// Missing from the build: its settings are still readable (kept, section 4.4).
	store.EXPECT().GetPluginBySlug(gomock.Any(), "checker").Return(settingsFixturePlugin(PluginStatusMissing), nil)
	store.EXPECT().ListPluginSettings(gomock.Any(), "checker").Return(nil, nil)

	recorder := pluginRequest(t, server, store, &pluginAdmin, http.MethodGet, "/api/v1/plugins/checker/settings")
	requireStatus(t, recorder, http.StatusOK)
	require.Equal(t, map[string]any{"api_key": map[string]any{"set": false}}, decodePluginSettings(t, recorder).Values)
}

func TestGetPluginSettingsUnknownPlugin(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	recorder := pluginRequest(t, server, store, &pluginAdmin, http.MethodGet, "/api/v1/plugins/Not_A_Slug/settings")
	requireStatus(t, recorder, http.StatusNotFound)
	require.Contains(t, recorder.Body.String(), "plugin_not_found")
}

func TestUpdatePluginSettingsValidation(t *testing.T) {
	cases := []struct {
		name   string
		values map[string]any
		field  string
	}{
		{"unknown field", map[string]any{"nope": 1}, "nope"},
		{"wrong type", map[string]any{"per_post": "ten"}, "per_post"},
		{"not an integer", map[string]any{"per_post": 1.5}, "per_post"},
		{"below the minimum", map[string]any{"per_post": 0}, "per_post"},
		{"above the maximum", map[string]any{"per_post": 500}, "per_post"},
		{"not in the enum", map[string]any{"frequency": "hourly"}, "frequency"},
		{"too long", map[string]any{"title": strings.Repeat("a", 21)}, "title"},
		{"a boolean as a string", map[string]any{"skip_own": "true"}, "skip_own"},
		{"a secret that isn't a string", map[string]any{"api_key": 42}, "api_key"},
		{"no declared maxLength still has a cap", map[string]any{"api_key": strings.Repeat("k", pluginSettingStringMax+1)}, "api_key"},
		{"an object", map[string]any{"title": map[string]any{"set": true}}, "title"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			server := newTestServer(t, store)
			store.EXPECT().GetPluginBySlug(gomock.Any(), "checker").Return(settingsFixturePlugin(PluginStatusInstalled), nil)
			// One valid value beside the bad one: nothing at all is written.
			if tc.field != "skip_own" {
				tc.values["skip_own"] = false
			}
			store.EXPECT().SetPluginSettingsTx(gomock.Any(), gomock.Any()).Times(0)

			recorder := pluginBodyRequest(t, server, store, pluginAdmin, http.MethodPut, "/api/v1/plugins/checker/settings", map[string]any{"values": tc.values})
			requireStatus(t, recorder, http.StatusBadRequest)
			var rsp struct {
				Code   string            `json:"code"`
				Fields map[string]string `json:"fields"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
			require.Equal(t, "invalid_plugin_settings", rsp.Code)
			require.Contains(t, rsp.Fields, tc.field)
			require.Empty(t, activityOf(t, server).verbs())
		})
	}
}

func TestUpdatePluginSettingsBody(t *testing.T) {
	for name, body := range map[string]string{
		"no values":     `{}`,
		"unknown field": `{"values": {}, "extra": 1}`,
		"not an object": `{"values": [1]}`,
	} {
		t.Run(name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			server := newTestServer(t, store)
			store.EXPECT().GetPluginBySlug(gomock.Any(), "checker").Return(settingsFixturePlugin(PluginStatusInstalled), nil)
			request := httptest.NewRequest(http.MethodPut, "/api/v1/plugins/checker/settings", strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			signInAs(t, server, store, request, pluginAdmin)
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			requireStatus(t, recorder, http.StatusBadRequest)
		})
	}
}

func TestUpdatePluginSettingsNotInstalled(t *testing.T) {
	for status, code := range map[string]string{
		PluginStatusMissing:      "plugin_missing",
		PluginStatusIncompatible: "plugin_incompatible",
	} {
		t.Run(status, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			server := newTestServer(t, store)
			store.EXPECT().GetPluginBySlug(gomock.Any(), "checker").Return(settingsFixturePlugin(status), nil)
			store.EXPECT().SetPluginSettingsTx(gomock.Any(), gomock.Any()).Times(0)
			recorder := pluginBodyRequest(t, server, store, pluginAdmin, http.MethodPut, "/api/v1/plugins/checker/settings",
				map[string]any{"values": map[string]any{"per_post": 10}})
			requireStatus(t, recorder, http.StatusConflict)
			require.Contains(t, recorder.Body.String(), code)
		})
	}
}

func TestUpdatePluginSettings(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	store.EXPECT().GetPluginBySlug(gomock.Any(), "checker").Return(settingsFixturePlugin(PluginStatusInstalled), nil)
	gomock.InOrder(
		store.EXPECT().ListPluginSettings(gomock.Any(), "checker").Return([]db.ExtensionSetting{
			settingRow("per_post", `120`),
			settingRow("skip_own", `true`),
			settingRow("title", `"Old title"`),
		}, nil),
		store.EXPECT().SetPluginSettingsTx(gomock.Any(), db.SetPluginSettingsTxParams{
			Slug: "checker",
			Set: []db.PluginSettingWrite{
				{Key: "plugin:checker:api_key", Value: json.RawMessage(`"` + settingsFixtureSecret + `"`)},
				{Key: "plugin:checker:frequency", Value: json.RawMessage(`"weekly"`)},
			},
			Clear: []string{"plugin:checker:title"},
		}).Return(nil),
		store.EXPECT().ListPluginSettings(gomock.Any(), "checker").Return([]db.ExtensionSetting{
			settingRow("api_key", `"`+settingsFixtureSecret+`"`),
			settingRow("frequency", `"weekly"`),
			settingRow("per_post", `120`),
			settingRow("skip_own", `true`),
		}, nil),
	)

	recorder := pluginBodyRequest(t, server, store, pluginAdmin, http.MethodPut, "/api/v1/plugins/checker/settings", map[string]any{
		"values": map[string]any{
			"api_key":   settingsFixtureSecret,
			"frequency": "weekly",
			"per_post":  120,  // unchanged: not written, not recorded
			"title":     nil,  // cleared: the default applies again
			"skip_own":  true, // unchanged
		},
	})
	requireStatus(t, recorder, http.StatusOK)
	require.NotContains(t, recorder.Body.String(), settingsFixtureSecret, "PUT's answer doesn't echo the secret")
	require.Equal(t, map[string]any{
		"api_key": map[string]any{"set": true}, "frequency": "weekly", "per_post": float64(120), "skip_own": true,
	}, decodePluginSettings(t, recorder).Values)

	rec := activityOf(t, server)
	require.Equal(t, []string{"plugin_settings_updated plugin:7"}, rec.verbs())
	require.Equal(t, pluginAdmin.ID, rec.events[0].ActorID.Int64)
	require.JSONEq(t, `{"fields":["api_key","frequency","title"]}`, string(rec.events[0].Payload),
		"the names of the fields that changed, never their values")
}

func TestUpdatePluginSettingsNothingChanged(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	store.EXPECT().GetPluginBySlug(gomock.Any(), "checker").Return(settingsFixturePlugin(PluginStatusInstalled), nil)
	store.EXPECT().ListPluginSettings(gomock.Any(), "checker").Times(2).Return([]db.ExtensionSetting{settingRow("per_post", `120`)}, nil)
	store.EXPECT().SetPluginSettingsTx(gomock.Any(), gomock.Any()).Times(0)

	// The same value, and clearing a field that was never set.
	recorder := pluginBodyRequest(t, server, store, pluginAdmin, http.MethodPut, "/api/v1/plugins/checker/settings",
		map[string]any{"values": map[string]any{"per_post": 120, "title": nil}})
	requireStatus(t, recorder, http.StatusOK)
	require.Empty(t, activityOf(t, server).verbs())
}

func TestDeletePluginSettings(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	server := newTestServer(t, store)
	store.EXPECT().GetPluginBySlug(gomock.Any(), "checker").Times(2).Return(settingsFixturePlugin(PluginStatusMissing), nil)
	gomock.InOrder(
		store.EXPECT().DeletePluginSettings(gomock.Any(), "checker").Return(int64(3), nil),
		store.EXPECT().DeletePluginSettings(gomock.Any(), "checker").Return(int64(0), nil),
	)

	recorder := pluginRequest(t, server, store, &pluginAdmin, http.MethodDelete, "/api/v1/plugins/checker/settings")
	requireStatus(t, recorder, http.StatusOK)
	require.JSONEq(t, `{"deleted":3}`, recorder.Body.String())
	rec := activityOf(t, server)
	require.Equal(t, []string{"plugin_data_deleted plugin:7"}, rec.verbs())
	require.JSONEq(t, `{"count":3}`, string(rec.events[0].Payload))

	// Nothing left to delete: 200, nothing recorded.
	recorder = pluginRequest(t, server, store, &pluginAdmin, http.MethodDelete, "/api/v1/plugins/checker/settings")
	requireStatus(t, recorder, http.StatusOK)
	require.JSONEq(t, `{"deleted":0}`, recorder.Body.String())
	require.Len(t, rec.verbs(), 1)
}

func TestSettingsActivityPayloadFitsTheActivityCheck(t *testing.T) {
	require.Equal(t, map[string]any{"fields": []string{"a", "b"}}, settingsActivityPayload([]string{"a", "b"}))

	// The manifest's worst case: 50 names of 64 characters.
	names := make([]string, pluginSettingsMax)
	for i := range names {
		names[i] = fmt.Sprintf("f%02d_%s", i, strings.Repeat("x", 60))
	}
	payload := settingsActivityPayload(names)
	raw, err := json.Marshal(payload)
	require.NoError(t, err)
	require.LessOrEqual(t, len(raw), 1024, "activity_payload_small_object")
	kept := payload["fields"].([]string)
	require.NotEmpty(t, kept)
	require.Equal(t, names[:len(kept)], kept)
	require.Equal(t, len(names)-len(kept), payload["more"])
}
