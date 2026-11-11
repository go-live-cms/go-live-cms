package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The plugin registry (#455) against the test database (skipped without one): the
// issue's acceptance list, through the scan and the real router.
//
// The scan is global by design (a plugin not in the directory is marked missing), so
// these tests sync through syncPlugins with every row that isn't theirs kept present:
// the database is shared, and locally it may be the dev stack's.

func pluginDBSlug(prefix string) string {
	return prefix + "-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
}

// syncPluginsFrom scans root and syncs it, treating every plugin row that isn't one of
// own as present, so a shared (or local dev) database's other plugins are never marked
// missing by a test. own are this test's slugs, whose removal must be seen.
func syncPluginsFrom(t *testing.T, server *Server, root string, own ...string) {
	t.Helper()
	plugins, err := ScanPluginsDirectory(root)
	require.NoError(t, err)
	require.NoError(t, server.syncPlugins(context.Background(), plugins, othersPresent(t, server, own)))
}

func othersPresent(t *testing.T, server *Server, own []string) []string {
	t.Helper()
	rows, err := server.store.ListPlugins(context.Background())
	require.NoError(t, err)
	others := []string{}
	for _, row := range rows {
		if !slices.Contains(own, row.Slug) {
			others = append(others, row.Slug)
		}
	}
	return others
}

func listedPlugin(t *testing.T, server *Server, admin db.User, slug string) (PluginResponse, bool) {
	t.Helper()
	recorder := as(t, server, admin, http.MethodGet, "/api/v1/plugins", nil)
	requireStatus(t, recorder, http.StatusOK)
	var rsp struct {
		Plugins []PluginResponse `json:"plugins"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	for _, plugin := range rsp.Plugins {
		if plugin.Slug == slug {
			return plugin, true
		}
	}
	return PluginResponse{}, false
}

func enabledSlugs(t *testing.T, server *Server, caller db.User) []string {
	t.Helper()
	recorder := as(t, server, caller, http.MethodGet, "/api/v1/plugins/enabled", nil)
	requireStatus(t, recorder, http.StatusOK)
	var rsp struct {
		Plugins []string `json:"plugins"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	return rsp.Plugins
}

func TestPluginRegistryFlow(t *testing.T) {
	conn, store := scheduleTestDB(t)
	server := authFlowServer(t, store, nil)
	ctx := context.Background()
	admin := scheduleUser(t, store, RoleAdmin)
	editor := scheduleUser(t, store, RoleEditor)
	contributor := scheduleUser(t, store, RoleContributor)

	root := t.TempDir()
	good := pluginDBSlug("good")
	future := pluginDBSlug("future")
	writePlugin(t, root, good, pluginJSON(good, "1.0.0", 1, `"capabilities":["posts:read"]`), map[string]string{"README.md": "# Good"})
	writePlugin(t, root, future, pluginJSON(future, "1.0.0", PluginAPIMax+1, ""), nil)

	// A valid plugin directory appears in GET /plugins after a restart, disabled.
	syncPluginsFrom(t, server, root, good, future)
	listed, ok := listedPlugin(t, server, admin, good)
	require.True(t, ok)
	require.Equal(t, PluginStatusInstalled, listed.Status)
	require.False(t, listed.Enabled)
	require.Equal(t, []string{"posts:read"}, listed.Capabilities)
	require.Regexp(t, `^[0-9a-f]{64}$`, listed.ContentHash)
	pluginID := listed.ID

	// Other roles get 403 on the admin routes.
	for _, caller := range []db.User{editor, contributor} {
		requireStatus(t, as(t, server, caller, http.MethodGet, "/api/v1/plugins", nil), http.StatusForbidden)
		requireStatus(t, as(t, server, caller, http.MethodGet, "/api/v1/plugins/"+good, nil), http.StatusForbidden)
		requireStatus(t, as(t, server, caller, http.MethodPost, "/api/v1/plugins/"+good+"/enable", nil), http.StatusForbidden)
		requireStatus(t, as(t, server, caller, http.MethodPost, "/api/v1/plugins/"+good+"/disable", nil), http.StatusForbidden)
	}

	// An incompatible plugin_api can't be enabled.
	refused := as(t, server, admin, http.MethodPost, "/api/v1/plugins/"+future+"/enable", nil)
	requireStatus(t, refused, http.StatusConflict)
	require.Contains(t, refused.Body.String(), `"plugin_incompatible"`)
	futureRow, err := store.GetPluginBySlug(ctx, future)
	require.NoError(t, err)
	require.False(t, futureRow.Enabled)

	// Enabling, recorded; the content roles see the slug.
	requireStatus(t, as(t, server, admin, http.MethodPost, "/api/v1/plugins/"+good+"/enable", nil), http.StatusOK)
	requireStatus(t, as(t, server, admin, http.MethodPost, "/api/v1/plugins/"+good+"/enable", nil), http.StatusOK)
	row, err := store.GetPluginBySlug(ctx, good)
	require.NoError(t, err)
	require.True(t, row.Enabled)
	require.Equal(t, sql.NullInt64{Int64: admin.ID, Valid: true}, row.EnabledBy)
	require.True(t, row.EnabledAt.Valid)
	require.Contains(t, enabledSlugs(t, server, contributor), good)
	require.NotContains(t, enabledSlugs(t, server, contributor), future)

	// A setting of the plugin's, which the scan must never touch.
	settingKey := "plugin:" + good + ":limit"
	_, err = store.UpsertExtensionSetting(ctx, db.UpsertExtensionSettingParams{
		Key: settingKey, Value: json.RawMessage(`5`), ExtensionType: "plugin", ExtensionID: good,
	})
	require.NoError(t, err)

	// Removing the plugin marks it missing and keeps its row, `enabled` and settings.
	goodDir := filepath.Join(root, good)
	parked := filepath.Join(t.TempDir(), good)
	require.NoError(t, os.Rename(goodDir, parked))
	syncPluginsFrom(t, server, root, good, future)
	row, err = store.GetPluginBySlug(ctx, good)
	require.NoError(t, err)
	require.Equal(t, PluginStatusMissing, row.Status)
	require.True(t, row.Enabled)
	require.Equal(t, pluginID, row.ID)
	settings, err := store.ListExtensionSettingsByExtension(ctx, db.ListExtensionSettingsByExtensionParams{ExtensionType: "plugin", ExtensionID: good})
	require.NoError(t, err)
	require.Len(t, settings, 1)
	require.NotContains(t, enabledSlugs(t, server, contributor), good, "a missing plugin isn't running")
	missingEnable := as(t, server, admin, http.MethodPost, "/api/v1/plugins/"+good+"/enable", nil)
	requireStatus(t, missingEnable, http.StatusConflict)
	require.Contains(t, missingEnable.Body.String(), "plugin_missing")

	// Putting it back restores it as it was.
	require.NoError(t, os.Rename(parked, goodDir))
	syncPluginsFrom(t, server, root, good, future)
	row, err = store.GetPluginBySlug(ctx, good)
	require.NoError(t, err)
	require.Equal(t, PluginStatusInstalled, row.Status)
	require.True(t, row.Enabled)
	require.Contains(t, enabledSlugs(t, server, contributor), good)

	// An upgrade, scanned by several replicas at once, is recorded exactly once.
	writePlugin(t, root, good, pluginJSON(good, "1.1.0", 1, ""), nil)
	plugins, err := ScanPluginsDirectory(root)
	require.NoError(t, err)
	others := othersPresent(t, server, []string{good, future})
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- server.syncPlugins(ctx, plugins, others)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	row, err = store.GetPluginBySlug(ctx, good)
	require.NoError(t, err)
	require.Equal(t, "1.1.0", row.Version)
	require.True(t, row.Enabled, "an upgrade keeps the flag")

	// Disabling, recorded.
	requireStatus(t, as(t, server, admin, http.MethodPost, "/api/v1/plugins/"+good+"/disable", nil), http.StatusOK)
	requireStatus(t, as(t, server, admin, http.MethodPost, "/api/v1/plugins/"+good+"/disable", nil), http.StatusOK)
	row, err = store.GetPluginBySlug(ctx, good)
	require.NoError(t, err)
	require.False(t, row.Enabled)
	require.False(t, row.EnabledBy.Valid)

	// The history: scan events by the system, enable and disable by the admin, each once.
	events := objectEvents(t, conn, db.ActivityObjectPlugin, pluginID)
	require.Equal(t, []string{
		db.ActivityPluginInstalled, db.ActivityPluginEnabled, db.ActivityPluginMissing,
		db.ActivityPluginInstalled, db.ActivityPluginUpdated, db.ActivityPluginDisabled,
	}, eventVerbs(events))
	adminActor := sql.NullInt64{Int64: admin.ID, Valid: true}
	for _, e := range events {
		switch e.Verb {
		case db.ActivityPluginEnabled, db.ActivityPluginDisabled:
			require.Equal(t, adminActor, e.Actor, e.Verb)
		default:
			require.False(t, e.Actor.Valid, "%s is the system's", e.Verb)
		}
	}
	require.JSONEq(t, `{"version":"1.0.0","status":"installed","restored":true}`, events[3].Payload)
	require.JSONEq(t, `{"previous_version":"1.0.0","version":"1.1.0","previous_status":"installed","status":"installed"}`, events[4].Payload)

	// The feed names the plugin, for admins only.
	feed, err := store.ListActivity(ctx, db.ListActivityParams{
		ObjectType: sql.NullString{String: db.ActivityObjectPlugin, Valid: true},
		ObjectID:   sql.NullInt64{Int64: pluginID, Valid: true},
		IsAdmin:    true, RowLimit: 10,
	})
	require.NoError(t, err)
	require.Len(t, feed, len(events))
	shown := toActivityResponse(feed[0])
	require.NotNil(t, shown.Plugin)
	require.Equal(t, good, shown.Plugin.Slug)
	require.Equal(t, "Plugin "+good, shown.Plugin.Name)
	editorFeed, err := store.ListActivity(ctx, db.ListActivityParams{
		ObjectType:  sql.NullString{String: db.ActivityObjectPlugin, Valid: true},
		ObjectID:    sql.NullInt64{Int64: pluginID, Valid: true},
		IsModerator: true, ViewerID: editor.ID, RowLimit: 10,
	})
	require.NoError(t, err)
	require.Empty(t, editorFeed, "plugin events are admin-only")

	// Removing the admin who enabled a plugin keeps the plugin (enabled_by SET NULL).
	requireStatus(t, as(t, server, admin, http.MethodPost, "/api/v1/plugins/"+good+"/enable", nil), http.StatusOK)
	_, err = conn.Exec(`DELETE FROM users WHERE id = $1`, admin.ID)
	require.NoError(t, err)
	row, err = store.GetPluginBySlug(ctx, good)
	require.NoError(t, err)
	require.True(t, row.Enabled)
	require.False(t, row.EnabledBy.Valid)
}

// TestPluginInvalidManifestDB: a registered plugin whose plugin.json stops validating
// becomes incompatible (not missing), can't be enabled, and comes back when fixed.
func TestPluginInvalidManifestDB(t *testing.T) {
	conn, store := scheduleTestDB(t)
	server := authFlowServer(t, store, nil)
	ctx := context.Background()
	admin := scheduleUser(t, store, RoleAdmin)

	root := t.TempDir()
	slug := pluginDBSlug("brittle")
	writePlugin(t, root, slug, pluginJSON(slug, "1.0.0", 1, ""), nil)
	syncPluginsFrom(t, server, root, slug)

	writePlugin(t, root, slug, `{"manifest_version": 1, "id": "`+slug+`"}`, nil)
	syncPluginsFrom(t, server, root, slug)
	syncPluginsFrom(t, server, root, slug)
	row, err := store.GetPluginBySlug(ctx, slug)
	require.NoError(t, err)
	require.Equal(t, PluginStatusIncompatible, row.Status)
	require.Equal(t, "Plugin "+slug, row.Name, "the last valid manifest is kept")
	listed, ok := listedPlugin(t, server, admin, slug)
	require.True(t, ok)
	require.Equal(t, "invalid_manifest", listed.IncompatibleReason)
	requireStatus(t, as(t, server, admin, http.MethodPost, "/api/v1/plugins/"+slug+"/enable", nil), http.StatusConflict)

	writePlugin(t, root, slug, pluginJSON(slug, "1.0.1", 1, ""), nil)
	syncPluginsFrom(t, server, root, slug)
	row, err = store.GetPluginBySlug(ctx, slug)
	require.NoError(t, err)
	require.Equal(t, PluginStatusInstalled, row.Status)
	require.Equal(t, "1.0.1", row.Version)

	require.Equal(t, []string{db.ActivityPluginInstalled, db.ActivityPluginUpdated, db.ActivityPluginUpdated},
		eventVerbs(objectEvents(t, conn, db.ActivityObjectPlugin, row.ID)))
}
