package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// memoryPluginStore is the plugins table in memory, with plugins.sql's semantics (a
// write returns no row when it changes nothing), for the sync's decisions. The real
// statements are run by plugins_db_test.go.
type memoryPluginStore struct {
	db.Store
	rows   map[string]*db.Plugin
	nextID int64
	// fail makes every write to that slug fail; failMissing fails MarkMissingPlugins.
	fail        map[string]bool
	failMissing bool
}

func newMemoryPluginStore() *memoryPluginStore {
	return &memoryPluginStore{rows: map[string]*db.Plugin{}, fail: map[string]bool{}}
}

var errMemoryStore = errors.New("store down")

func (s *memoryPluginStore) InsertDiscoveredPlugin(_ context.Context, arg db.InsertDiscoveredPluginParams) (db.Plugin, error) {
	if s.fail[arg.Slug] {
		return db.Plugin{}, errMemoryStore
	}
	if _, ok := s.rows[arg.Slug]; ok {
		return db.Plugin{}, sql.ErrNoRows
	}
	s.nextID++
	row := db.Plugin{ID: s.nextID, Slug: arg.Slug, Name: arg.Name, Version: arg.Version, Author: arg.Author,
		Description: arg.Description, Manifest: arg.Manifest, ContentHash: arg.ContentHash, Status: arg.Status}
	s.rows[arg.Slug] = &row
	return row, nil
}

func (s *memoryPluginStore) UpdateDiscoveredPlugin(_ context.Context, arg db.UpdateDiscoveredPluginParams) (db.UpdateDiscoveredPluginRow, error) {
	row, ok := s.rows[arg.Slug]
	if !ok || (row.ContentHash == arg.ContentHash && row.Status == arg.Status) {
		return db.UpdateDiscoveredPluginRow{}, sql.ErrNoRows
	}
	prev := *row
	row.Name, row.Version, row.Author, row.Description = arg.Name, arg.Version, arg.Author, arg.Description
	row.Manifest, row.ContentHash, row.Status = arg.Manifest, arg.ContentHash, arg.Status
	return db.UpdateDiscoveredPluginRow{ID: row.ID, Slug: row.Slug, Version: row.Version, Status: row.Status,
		PreviousVersion: prev.Version, PreviousStatus: prev.Status}, nil
}

func (s *memoryPluginStore) MarkPluginInvalid(_ context.Context, arg db.MarkPluginInvalidParams) (db.MarkPluginInvalidRow, error) {
	if s.fail[arg.Slug] {
		return db.MarkPluginInvalidRow{}, errMemoryStore
	}
	row, ok := s.rows[arg.Slug]
	if !ok || (row.Status == PluginStatusIncompatible && row.ContentHash == arg.ContentHash) {
		return db.MarkPluginInvalidRow{}, sql.ErrNoRows
	}
	prevStatus := row.Status
	row.Status, row.ContentHash = PluginStatusIncompatible, arg.ContentHash
	return db.MarkPluginInvalidRow{ID: row.ID, Slug: row.Slug, Version: row.Version, Status: row.Status, PreviousStatus: prevStatus}, nil
}

func (s *memoryPluginStore) MarkMissingPlugins(_ context.Context, present []string) ([]db.Plugin, error) {
	if s.failMissing {
		return nil, errMemoryStore
	}
	marked := []db.Plugin{}
	for slug, row := range s.rows {
		if row.Status != PluginStatusMissing && !slices.Contains(present, slug) {
			row.Status = PluginStatusMissing
			marked = append(marked, *row)
		}
	}
	return marked, nil
}

// syncTestServer is a server whose store is the in-memory plugins table, recording
// activity in memory.
func syncTestServer(t *testing.T) (*Server, *memoryPluginStore) {
	t.Helper()
	server := newTestServer(t, mockdb.NewMockStore(gomock.NewController(t)))
	store := newMemoryPluginStore()
	server.store = store
	return server, store
}

func discovered(t *testing.T, slug, version string, api int, hash byte) DiscoveredPlugin {
	t.Helper()
	manifest, normalized, err := ParsePluginManifest([]byte(pluginJSON(slug, version, api, "")), slug)
	require.NoError(t, err)
	return DiscoveredPlugin{Slug: slug, Manifest: manifest, ManifestJSON: normalized, ContentHash: strings.Repeat(string(hash), 64)}
}

type syncEvent struct {
	Verb    string
	Object  int64
	Payload map[string]any
}

// takeEvents returns what the sync recorded since the last call, and checks every
// event is the system's (no actor) on a plugin.
func takeEvents(t *testing.T, server *Server) []syncEvent {
	t.Helper()
	rec := activityOf(t, server)
	rec.mu.Lock()
	defer rec.mu.Unlock()
	out := []syncEvent{}
	for _, e := range rec.events {
		require.False(t, e.ActorID.Valid, "scan events are the system's")
		require.Equal(t, db.ActivityObjectPlugin, e.ObjectType)
		var payload map[string]any
		require.NoError(t, json.Unmarshal(e.Payload, &payload))
		out = append(out, syncEvent{Verb: e.Verb, Object: e.ObjectID, Payload: payload})
	}
	require.Empty(t, rec.throttled)
	rec.events = nil
	return out
}

func TestSyncPluginsToDatabase(t *testing.T) {
	ctx := context.Background()
	server, store := syncTestServer(t)

	// First scan: two new plugins, one outside core's plugin_api range.
	require.NoError(t, server.SyncPluginsToDatabase(ctx, []DiscoveredPlugin{
		discovered(t, "alpha", "1.0.0", 1, 'a'),
		discovered(t, "future", "1.0.0", PluginAPIMax+1, 'f'),
	}))
	require.Equal(t, PluginStatusInstalled, store.rows["alpha"].Status)
	require.False(t, store.rows["alpha"].Enabled, "a new plugin starts disabled")
	require.Equal(t, PluginStatusIncompatible, store.rows["future"].Status)
	require.ElementsMatch(t, []syncEvent{
		{Verb: db.ActivityPluginInstalled, Object: store.rows["alpha"].ID, Payload: map[string]any{"version": "1.0.0", "status": "installed"}},
		{Verb: db.ActivityPluginInstalled, Object: store.rows["future"].ID, Payload: map[string]any{"version": "1.0.0", "status": "incompatible"}},
	}, takeEvents(t, server))

	// The same scan again (a restart, another replica): nothing changes, nothing recorded.
	require.NoError(t, server.SyncPluginsToDatabase(ctx, []DiscoveredPlugin{
		discovered(t, "alpha", "1.0.0", 1, 'a'),
		discovered(t, "future", "1.0.0", PluginAPIMax+1, 'f'),
	}))
	require.Empty(t, takeEvents(t, server))

	// alpha is enabled, then removed from the build: missing, flag kept.
	store.rows["alpha"].Enabled = true
	require.NoError(t, server.SyncPluginsToDatabase(ctx, []DiscoveredPlugin{discovered(t, "future", "1.0.0", PluginAPIMax+1, 'f')}))
	require.Equal(t, PluginStatusMissing, store.rows["alpha"].Status)
	require.True(t, store.rows["alpha"].Enabled)
	require.Equal(t, []syncEvent{{Verb: db.ActivityPluginMissing, Object: store.rows["alpha"].ID, Payload: map[string]any{"version": "1.0.0"}}}, takeEvents(t, server))

	// Back, upgraded: restored, still enabled.
	require.NoError(t, server.SyncPluginsToDatabase(ctx, []DiscoveredPlugin{
		discovered(t, "alpha", "1.1.0", 1, 'b'),
		discovered(t, "future", "1.0.0", PluginAPIMax+1, 'f'),
	}))
	require.Equal(t, PluginStatusInstalled, store.rows["alpha"].Status)
	require.True(t, store.rows["alpha"].Enabled)
	require.Equal(t, []syncEvent{{Verb: db.ActivityPluginInstalled, Object: store.rows["alpha"].ID, Payload: map[string]any{
		"version": "1.1.0", "status": "installed", "restored": true, "previous_version": "1.0.0",
	}}}, takeEvents(t, server))

	// An upgrade in place, and future fixed for this core.
	require.NoError(t, server.SyncPluginsToDatabase(ctx, []DiscoveredPlugin{
		discovered(t, "alpha", "1.2.0", 1, 'c'),
		discovered(t, "future", "1.0.1", 1, 'g'),
	}))
	require.ElementsMatch(t, []syncEvent{
		{Verb: db.ActivityPluginUpdated, Object: store.rows["alpha"].ID, Payload: map[string]any{
			"previous_version": "1.1.0", "version": "1.2.0", "previous_status": "installed", "status": "installed"}},
		{Verb: db.ActivityPluginUpdated, Object: store.rows["future"].ID, Payload: map[string]any{
			"previous_version": "1.0.0", "version": "1.0.1", "previous_status": "incompatible", "status": "installed"}},
	}, takeEvents(t, server))

	// alpha's plugin.json stops validating: incompatible, last valid manifest kept,
	// recorded once; a never-valid plugin writes nothing; neither is marked missing.
	invalid := DiscoveredPlugin{Slug: "alpha", ContentHash: strings.Repeat("d", 64), Err: errors.New("plugin.json: version is required")}
	neverValid := DiscoveredPlugin{Slug: "never-valid", ContentHash: strings.Repeat("e", 64), Err: errors.New("bad")}
	scan := []DiscoveredPlugin{invalid, neverValid, discovered(t, "future", "1.0.1", 1, 'g')}
	require.NoError(t, server.SyncPluginsToDatabase(ctx, scan))
	require.Equal(t, PluginStatusIncompatible, store.rows["alpha"].Status)
	require.Equal(t, "1.2.0", store.rows["alpha"].Version)
	require.NotContains(t, store.rows, "never-valid")
	require.Equal(t, []syncEvent{{Verb: db.ActivityPluginUpdated, Object: store.rows["alpha"].ID, Payload: map[string]any{
		"version": "1.2.0", "previous_status": "installed", "status": "incompatible", "reason": "invalid_manifest",
	}}}, takeEvents(t, server))
	require.NoError(t, server.SyncPluginsToDatabase(ctx, scan))
	require.Empty(t, takeEvents(t, server), "an unchanged invalid plugin is recorded once")

	// Fixed again: installed.
	require.NoError(t, server.SyncPluginsToDatabase(ctx, []DiscoveredPlugin{discovered(t, "alpha", "1.2.1", 1, 'h'), discovered(t, "future", "1.0.1", 1, 'g')}))
	require.Equal(t, PluginStatusInstalled, store.rows["alpha"].Status)
	require.Equal(t, db.ActivityPluginUpdated, takeEvents(t, server)[0].Verb)
}

func TestSyncPluginsToDatabaseFailures(t *testing.T) {
	ctx := context.Background()

	t.Run("a failed write skips that plugin and never marks it missing", func(t *testing.T) {
		server, store := syncTestServer(t)
		require.NoError(t, server.SyncPluginsToDatabase(ctx, []DiscoveredPlugin{discovered(t, "alpha", "1.0.0", 1, 'a')}))
		takeEvents(t, server)

		store.fail["alpha"] = true
		require.NoError(t, server.SyncPluginsToDatabase(ctx, []DiscoveredPlugin{
			discovered(t, "alpha", "1.1.0", 1, 'b'),
			{Slug: "alpha", ContentHash: strings.Repeat("c", 64), Err: errors.New("bad")},
			discovered(t, "beta", "1.0.0", 1, 'd'),
		}))
		require.Equal(t, PluginStatusInstalled, store.rows["alpha"].Status)
		require.Equal(t, "1.0.0", store.rows["alpha"].Version)
		require.Equal(t, []string{db.ActivityPluginInstalled}, []string{takeEvents(t, server)[0].Verb})
	})

	t.Run("files that couldn't be read write nothing", func(t *testing.T) {
		server, store := syncTestServer(t)
		require.NoError(t, server.SyncPluginsToDatabase(ctx, []DiscoveredPlugin{discovered(t, "alpha", "1.0.0", 1, 'a')}))
		takeEvents(t, server)
		require.NoError(t, server.SyncPluginsToDatabase(ctx, []DiscoveredPlugin{{Slug: "alpha", Err: errors.New("hash plugin files: denied")}}))
		require.Equal(t, PluginStatusInstalled, store.rows["alpha"].Status, "unreadable is not missing")
		require.Empty(t, takeEvents(t, server))
	})

	t.Run("marking the missing ones fails", func(t *testing.T) {
		server, store := syncTestServer(t)
		store.failMissing = true
		require.ErrorIs(t, server.SyncPluginsToDatabase(ctx, nil), errMemoryStore)
	})
}
