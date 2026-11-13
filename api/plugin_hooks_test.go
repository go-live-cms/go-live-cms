package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/pluginsdk"
	"github.com/golang/mock/gomock"
	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"
)

// Server hooks (#458) without a database: the Go/manifest comparison, the timeout
// and error caps, panic recovery, and what Host hands out. plugin_hooks_db_test.go
// covers the trigger, the outbox and the dispatcher against the real database.

func noopObserver(context.Context, pluginsdk.Host, pluginsdk.Event) error { return nil }

func hooksManifest(events ...string) PluginManifest {
	manifest := PluginManifest{}
	for _, event := range events {
		manifest.Server.Hooks = append(manifest.Server.Hooks, PluginHook{Event: event})
	}
	return manifest
}

func observing(events ...string) pluginsdk.Plugin {
	p := pluginsdk.Plugin{Observers: map[string]pluginsdk.Observer{}}
	for _, event := range events {
		p.Observers[event] = noopObserver
	}
	return p
}

func TestPluginHooksMismatch(t *testing.T) {
	// Neither declared nor registered: a blocks-only plugin.
	require.Empty(t, pluginHooksMismatch(PluginManifest{}, pluginsdk.Plugin{}, false))
	// The same set, in any order.
	require.Empty(t, pluginHooksMismatch(
		hooksManifest(pluginsdk.EventPostPublished, pluginsdk.EventPostSaved),
		observing(pluginsdk.EventPostSaved, pluginsdk.EventPostPublished), true))

	// Declared in plugin.json, no Go code at all.
	require.Contains(t, pluginHooksMismatch(hooksManifest(pluginsdk.EventPostSaved), pluginsdk.Plugin{}, false),
		"declared without a hook in Go: post.saved")
	// A hook in Go that plugin.json doesn't declare.
	require.Contains(t, pluginHooksMismatch(PluginManifest{}, observing(pluginsdk.EventPostDeleted), true),
		"hooks in Go not declared in plugin.json: post.deleted")
	// Both ways at once.
	both := pluginHooksMismatch(hooksManifest(pluginsdk.EventPostSaved), observing(pluginsdk.EventPostTrashed), true)
	require.Contains(t, both, "post.saved")
	require.Contains(t, both, "post.trashed")
	// A guard (#459) is Plugin.BeforePublish: declared without one doesn't match, and
	// neither does one in Go that plugin.json doesn't declare.
	require.Contains(t, pluginHooksMismatch(hooksManifest(pluginGuardEvent), pluginsdk.Plugin{}, true),
		"declared without a hook in Go: post.before_publish")
	require.Contains(t, pluginHooksMismatch(PluginManifest{}, guarding(allowGuard), true),
		"hooks in Go not declared in plugin.json: post.before_publish")
	require.Empty(t, pluginHooksMismatch(hooksManifest(pluginGuardEvent, pluginsdk.EventPostSaved),
		pluginsdk.Plugin{BeforePublish: allowGuard, Observers: observing(pluginsdk.EventPostSaved).Observers}, true))
}

func TestHookPluginTimeout(t *testing.T) {
	plugin := hookPlugin{manifest: PluginManifest{Server: PluginServer{Hooks: []PluginHook{
		{Event: pluginsdk.EventPostSaved, TimeoutMS: 2500},
		{Event: pluginsdk.EventPostDeleted, TimeoutMS: 90000},
		{Event: pluginsdk.EventPostPublished},
	}}}}
	require.Equal(t, 2500*time.Millisecond, plugin.timeout(pluginsdk.EventPostSaved))
	require.Equal(t, pluginHookMaxTimeout, plugin.timeout(pluginsdk.EventPostDeleted), "capped at 30s")
	require.Equal(t, pluginHookDefaultTimeout, plugin.timeout(pluginsdk.EventPostPublished))
	require.Equal(t, pluginHookDefaultTimeout, plugin.timeout(pluginsdk.EventPostTrashed))
}

func TestCapPluginHookError(t *testing.T) {
	require.Equal(t, "short", capPluginHookError("short"))
	long := strings.Repeat("é", pluginHookErrorMax+50)
	capped := capPluginHookError(long)
	require.Equal(t, pluginHookErrorMax, len([]rune(capped)))
	require.True(t, strings.HasSuffix(capped, "…"))
}

func TestCallObserverRecoversPanics(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	err := callObserver(context.Background(), log, func(context.Context, pluginsdk.Host, pluginsdk.Event) error {
		panic("boom")
	}, nil, pluginsdk.Event{})
	require.EqualError(t, err, "panic: boom")

	require.EqualError(t, callObserver(context.Background(), log, nil, nil, pluginsdk.Event{}), "no hook registered for this event")

	wantErr := errors.New("index unavailable")
	require.ErrorIs(t, callObserver(context.Background(), log, func(context.Context, pluginsdk.Host, pluginsdk.Event) error {
		return wantErr
	}, nil, pluginsdk.Event{}), wantErr)
}

func TestPluginEventFromClaim(t *testing.T) {
	at := time.Now().UTC()
	event := pluginEventFromClaim(db.ClaimDuePluginHookRunsRow{
		EventID: 7, PostID: 9, ActorID: sql.NullInt64{Int64: 3, Valid: true}, Event: pluginsdk.EventPostPublished,
		Data: json.RawMessage(`{"post_type":"post","version_id":12}`), CreatedAt: at,
	})
	require.Equal(t, pluginsdk.Event{
		ID: 7, PostID: 9, ActorID: 3, Name: pluginsdk.EventPostPublished,
		Data: map[string]any{"post_type": "post", "version_id": float64(12)}, OccurredAt: at,
	}, event)
}

func TestPluginHookSlots(t *testing.T) {
	d := newPluginHookDispatcher(&Server{}, nil)
	require.Equal(t, pluginHookSlotsPerPlugin, d.free("a"))
	for i := 0; i < pluginHookSlotsPerPlugin; i++ {
		require.True(t, d.acquire("a"))
	}
	require.False(t, d.acquire("a"), "two per plugin")
	require.Zero(t, d.free("a"))
	// Eight overall.
	for _, slug := range []string{"b", "b", "c", "c", "d", "d"} {
		require.True(t, d.acquire(slug))
	}
	require.False(t, d.acquire("e"), "eight overall")
	require.Zero(t, d.free("e"))
	d.release("a")
	require.Equal(t, 1, d.free("e"))
	require.True(t, d.acquire("e"))
}

func TestPluginHostCapabilities(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)

	bare := &pluginHost{server: server, plugin: hookPlugin{slug: "bare"}, log: server.logger}
	require.Nil(t, bare.Posts(), "posts:read not declared")
	require.Nil(t, bare.Media())
	require.Nil(t, bare.Users())
	require.NotNil(t, bare.Log())

	full := &pluginHost{server: server, log: server.logger, plugin: hookPlugin{slug: "full", manifest: PluginManifest{
		Capabilities: []string{"posts:read", "media:read", "users:read"},
	}}}
	require.NotNil(t, full.Posts())
	require.NotNil(t, full.Media())
	require.NotNil(t, full.Users())

	ctx := context.Background()
	store.EXPECT().GetPost(gomock.Any(), int64(1)).Return(db.Post{}, sql.ErrNoRows).Times(2)
	_, err := full.Posts().Get(ctx, 1)
	require.ErrorIs(t, err, pluginsdk.ErrNotFound)
	_, err = full.Posts().GetPublished(ctx, 1)
	require.ErrorIs(t, err, pluginsdk.ErrNotFound)

	store.EXPECT().GetPost(gomock.Any(), int64(2)).Return(db.Post{
		ID: 2, PostType: "post", PostStatus: "published", Title: "Working title", Description: "Working",
		BlockDoc:           json.RawMessage(`{"working":true}`),
		PublishedBlockDoc:  pqtype.NullRawMessage{RawMessage: json.RawMessage(`{"live":true}`), Valid: true},
		PublishedSettings:  pqtype.NullRawMessage{RawMessage: json.RawMessage(`{"title":"Live title","description":"Live"}`), Valid: true},
		PublishedVersionID: sql.NullInt64{Int64: 5, Valid: true},
	}, nil).Times(2)
	working, err := full.Posts().Get(ctx, 2)
	require.NoError(t, err)
	require.Equal(t, "Working title", working.Title)
	require.JSONEq(t, `{"working":true}`, string(working.BlockDoc))
	live, err := full.Posts().GetPublished(ctx, 2)
	require.NoError(t, err)
	require.Equal(t, "Live title", live.Title)
	require.Equal(t, "Live", live.Excerpt)
	require.JSONEq(t, `{"live":true}`, string(live.BlockDoc))
	require.Equal(t, int64(5), live.PublishedVersionID)

	store.EXPECT().GetPost(gomock.Any(), int64(3)).Return(db.Post{ID: 3, PostStatus: "draft"}, nil)
	_, err = full.Posts().GetPublished(ctx, 3)
	require.ErrorIs(t, err, pluginsdk.ErrNotFound, "a draft has no published snapshot")

	store.EXPECT().GetUser(gomock.Any(), int64(4)).Return(db.User{
		ID: 4, Username: "ana", FullName: "Ana", Email: "ana@example.test", HashedPassword: "secret", Role: RoleEditor,
	}, nil)
	user, err := full.Users().Get(ctx, 4)
	require.NoError(t, err)
	require.Equal(t, pluginsdk.User{ID: 4, Username: "ana", Name: "Ana", Role: RoleEditor}, user, "public fields only")
	store.EXPECT().GetUser(gomock.Any(), int64(5)).Return(db.User{}, sql.ErrNoRows)
	_, err = full.Users().Get(ctx, 5)
	require.ErrorIs(t, err, pluginsdk.ErrNotFound)

	store.EXPECT().GetMedia(gomock.Any(), int64(6)).Return(db.Medium{
		ID: 6, Name: "hero", Alt: "A hill", MimeType: "image/jpeg", MediaPath: server.config.UploadPath + "/hero.jpg", Width: 10, Height: 5,
	}, nil)
	media, err := full.Media().Get(ctx, 6)
	require.NoError(t, err)
	require.Equal(t, "/uploads/media/hero.jpg", media.URL)
	require.Equal(t, "A hill", media.Alt)
	store.EXPECT().GetMedia(gomock.Any(), int64(7)).Return(db.Medium{}, sql.ErrNoRows)
	_, err = full.Media().Get(ctx, 7)
	require.ErrorIs(t, err, pluginsdk.ErrNotFound)
}

func TestPluginHostSettings(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)
	host := &pluginHost{server: server, log: server.logger, plugin: hookPlugin{slug: "rt", manifest: PluginManifest{
		Settings: map[string]PluginSettingSpec{
			"words_per_minute": {ThemeAttrSpec: ThemeAttrSpec{Type: "number", Default: float64(200)}},
			"label":            {ThemeAttrSpec: ThemeAttrSpec{Type: "string"}},
			"mode":             {ThemeAttrSpec: ThemeAttrSpec{Type: "string", Enum: []any{"short", "long"}, Default: "short"}},
			"show":             {ThemeAttrSpec: ThemeAttrSpec{Type: "boolean", Default: true}},
		},
	}}}
	store.EXPECT().ListPluginExtensionSettings(gomock.Any(), "rt").Return([]db.ListPluginExtensionSettingsRow{
		{Key: "plugin:rt:words_per_minute", Value: json.RawMessage(`250`)},
		{Key: "plugin:rt:label", Value: json.RawMessage(`"min read"`)},
		{Key: "plugin:rt:undeclared", Value: json.RawMessage(`1`)},
		{Key: "plugin:other:show", Value: json.RawMessage(`false`)},
		{Key: "plugin:rt:show", Value: json.RawMessage(`not json`)},
		// No longer in the enum (an upgrade narrowed it): the default applies, as on the page.
		{Key: "plugin:rt:mode", Value: json.RawMessage(`"medium"`)},
	}, nil)
	settings, err := host.Settings(context.Background())
	require.NoError(t, err)
	require.Equal(t, map[string]any{"words_per_minute": float64(250), "label": "min read", "show": true, "mode": "short"}, settings)

	store.EXPECT().ListPluginExtensionSettings(gomock.Any(), "rt").Return(nil, errors.New("down"))
	_, err = host.Settings(context.Background())
	require.Error(t, err)
}

// A plugin's presenter says why it's incompatible when its hooks drift (#458).
func TestPluginResponseHooksReason(t *testing.T) {
	server := &Server{pluginRegistry: pluginHookRegistry{}}
	manifest, err := json.Marshal(map[string]any{"plugin_api": 1, "server": map[string]any{"hooks": []any{map[string]any{"event": "post.saved"}}}})
	require.NoError(t, err)
	row := db.Plugin{Slug: "drift", Status: PluginStatusIncompatible, Manifest: manifest}
	require.Equal(t, "hooks", server.toPluginResponse(row, false).IncompatibleReason)

	server.pluginRegistry["drift"] = observing(pluginsdk.EventPostSaved)
	require.Equal(t, "invalid_manifest", server.toPluginResponse(row, false).IncompatibleReason,
		"hooks match, so the stored status must come from a manifest that stopped validating")
}

func TestRunPluginHooksOff(t *testing.T) {
	server := &Server{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	done := make(chan struct{})
	go func() {
		server.RunPluginHooks(context.Background(), 0)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("interval 0 should return at once")
	}
}
