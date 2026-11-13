package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/pluginsdk"
)

// Server hooks (#458) against the test database (skipped without one): the posts
// trigger on every publish path, the outbox, and the dispatcher's ordering, retries,
// lease, timeouts and pruning.
//
// The database is shared across packages and runs, and locally it may be the dev
// stack's: every assertion is about this test's own posts and plugins, and each test
// plugin is disabled again when its test ends (rows are never deleted, as the scan
// never deletes them).

var allObserverEvents = pluginsdk.ObserverEvents

// enableHookPlugin registers and enables a plugin row whose plugin.json declares a
// hook for each event (timeouts in ms by event, optional) and the capabilities.
func enableHookPlugin(t *testing.T, store db.Store, events []string, timeouts map[string]int, capabilities ...string) db.Plugin {
	t.Helper()
	slug := pluginDBSlug("hooks")
	hooks := []map[string]any{}
	for _, event := range events {
		hook := map[string]any{"event": event}
		if ms := timeouts[event]; ms > 0 {
			hook["timeout_ms"] = ms
		}
		hooks = append(hooks, hook)
	}
	manifest := map[string]any{
		"manifest_version": 1, "id": slug, "name": "Hooks " + slug, "version": "1.0.0", "plugin_api": 1,
		"server": map[string]any{"hooks": hooks},
	}
	if len(capabilities) > 0 {
		manifest["capabilities"] = capabilities
	}
	return enableManifestPlugin(t, store, slug, manifest)
}

// enableManifestPlugin inserts an installed plugin row with this plugin.json (validated
// first) and enables it until the test ends.
func enableManifestPlugin(t *testing.T, store db.Store, slug string, manifest map[string]any) db.Plugin {
	t.Helper()
	ctx := context.Background()
	raw, err := json.Marshal(manifest)
	require.NoError(t, err)
	_, normalized, err := ParsePluginManifest(raw, slug)
	require.NoError(t, err, "the test's plugin.json validates")
	raw = normalized
	// Events left unfanned by an earlier test would go to every plugin subscribed now,
	// this one included (as on a real site): fan them out to their own plugins first.
	for i := 0; i < 100; i++ {
		result, err := store.FanOutPluginEvents(ctx, pluginHooksFanOutBatch)
		require.NoError(t, err)
		if result.Locked && result.FannedOut+result.Dropped < pluginHooksFanOutBatch {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	_, err = store.InsertDiscoveredPlugin(ctx, db.InsertDiscoveredPluginParams{
		Slug: slug, Name: fmt.Sprint(manifest["name"]), Version: "1.0.0", Manifest: raw,
		ContentHash: strings.Repeat("a", 64), Status: PluginStatusInstalled,
	})
	require.NoError(t, err)
	plugin, err := store.EnablePlugin(ctx, db.EnablePluginParams{Slug: slug})
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := store.DisablePlugin(context.Background(), slug)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			t.Errorf("disable %s: %v", slug, err)
		}
	})
	return plugin
}

type pluginEventRow struct {
	ID        int64
	Event     string
	ActorID   sql.NullInt64
	Data      map[string]any
	FannedOut bool
	CreatedAt time.Time
}

// postPluginEvents lists a post's events in id order.
func postPluginEvents(t *testing.T, conn *sql.DB, postID int64) []pluginEventRow {
	t.Helper()
	rows, err := conn.Query(`SELECT id, event, actor_id, data, fanned_out, created_at FROM plugin_events WHERE post_id = $1 ORDER BY id`, postID)
	require.NoError(t, err)
	defer rows.Close()
	out := []pluginEventRow{}
	for rows.Next() {
		var row pluginEventRow
		var data []byte
		require.NoError(t, rows.Scan(&row.ID, &row.Event, &row.ActorID, &data, &row.FannedOut, &row.CreatedAt))
		require.NoError(t, json.Unmarshal(data, &row.Data))
		out = append(out, row)
	}
	require.NoError(t, rows.Err())
	return out
}

func eventsNamed(events []pluginEventRow, name string) []pluginEventRow {
	out := []pluginEventRow{}
	for _, e := range events {
		if e.Event == name {
			out = append(out, e)
		}
	}
	return out
}

func eventNames(events []pluginEventRow) []string {
	out := []string{}
	for _, e := range events {
		out = append(out, e.Event)
	}
	return out
}

// publishedEvents asserts the post has exactly want post.published events and returns
// the last.
func publishedEvents(t *testing.T, conn *sql.DB, postID int64, want int) pluginEventRow {
	t.Helper()
	published := eventsNamed(postPluginEvents(t, conn, postID), pluginsdk.EventPostPublished)
	require.Len(t, published, want, "post %d's post.published events", postID)
	if want == 0 {
		return pluginEventRow{}
	}
	return published[len(published)-1]
}

// requireVersionTransaction asserts the event was written by the transaction that
// published version: now() is the transaction's start, so the two times are equal
// only when both rows come from one transaction.
func requireVersionTransaction(t *testing.T, conn *sql.DB, event pluginEventRow) {
	t.Helper()
	versionID, ok := event.Data["version_id"].(float64)
	require.True(t, ok, "post.published carries version_id: %v", event.Data)
	var created time.Time
	require.NoError(t, conn.QueryRow(`SELECT created_at FROM post_versions WHERE id = $1`, int64(versionID)).Scan(&created))
	require.True(t, created.Equal(event.CreatedAt), "event at %s, version at %s", event.CreatedAt, created)
}

// TestPluginEventsWithoutSubscriber: a site with no subscriber writes no event row,
// whatever happens to a post.
func TestPluginEventsWithoutSubscriber(t *testing.T) {
	conn, store := scheduleTestDB(t)
	var subscribed bool
	require.NoError(t, conn.QueryRow(
		`SELECT bool_or(golive_plugin_event_subscribed(e)) FROM unnest('{post.saved,post.published,post.unpublished,post.trashed,post.restored,post.deleted}'::text[]) e`,
	).Scan(&subscribed))
	if subscribed {
		t.Skip("an enabled plugin in this database subscribes to post events")
	}
	ctx := context.Background()
	editor := scheduleUser(t, store, RoleEditor)
	post := scheduleDraft(t, store, editor, scheduleWord())
	editWorkingCopy(t, conn, post.ID, scheduleWord())
	_, err := store.PublishPostTx(ctx, db.PublishPostTxParams{PostID: post.ID, ContentMedia: publishedContentMedia})
	require.NoError(t, err)
	_, err = store.UnpublishPost(ctx, post.ID)
	require.NoError(t, err)
	_, err = store.TrashPost(ctx, post.ID)
	require.NoError(t, err)
	_, err = store.RestorePostFromTrash(ctx, post.ID)
	require.NoError(t, err)
	_, err = store.TrashPost(ctx, post.ID)
	require.NoError(t, err)
	require.NoError(t, store.DeleteTrashedPostTx(ctx, post.ID))

	require.Empty(t, postPluginEvents(t, conn, post.ID))
}

// TestPluginEventsEveryPublishPath: each way a post gets published writes exactly one
// post.published, in the publish's own transaction.
func TestPluginEventsEveryPublishPath(t *testing.T) {
	conn, store := scheduleTestDB(t)
	enableHookPlugin(t, store, allObserverEvents, nil)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	editor := scheduleUser(t, store, RoleEditor)
	ctx := context.Background()

	t.Run("publish button, then update", func(t *testing.T) {
		post := scheduleDraft(t, store, editor, scheduleWord())
		requireStatus(t, as(t, server, editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", post.ID), nil), http.StatusOK)
		event := publishedEvents(t, conn, post.ID, 1)
		require.Equal(t, editor.ID, event.ActorID.Int64, "credited to who published")
		require.Equal(t, "draft", event.Data["from_status"])
		require.Equal(t, "post", event.Data["post_type"])
		requireVersionTransaction(t, conn, event)

		editWorkingCopy(t, conn, post.ID, scheduleWord())
		requireStatus(t, as(t, server, editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", post.ID), nil), http.StatusOK)
		event = publishedEvents(t, conn, post.ID, 2)
		require.Equal(t, float64(reloadPost(t, store, post.ID).PublishedVersionID.Int64), event.Data["version_id"])
		requireVersionTransaction(t, conn, event)
	})

	t.Run("bulk", func(t *testing.T) {
		a := scheduleDraft(t, store, editor, scheduleWord())
		b := scheduleDraft(t, store, editor, scheduleWord())
		answer := bulkCall(t, server, &editor, "publish", a.ID, b.ID, a.ID)
		require.Equal(t, 2, answer.Succeeded, "duplicates once")
		requireVersionTransaction(t, conn, publishedEvents(t, conn, a.ID, 1))
		requireVersionTransaction(t, conn, publishedEvents(t, conn, b.ID, 1))
	})

	t.Run("scheduler", func(t *testing.T) {
		post := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(-time.Minute))
		require.True(t, server.publishScheduledPost(ctx, claimFor(t, store, post.ID)))
		event := publishedEvents(t, conn, post.ID, 1)
		require.Equal(t, editor.ID, event.ActorID.Int64, "credited to who scheduled it")
		require.Equal(t, "scheduled", event.Data["from_status"])
		requireVersionTransaction(t, conn, event)
		// A second round finds nothing to do and writes nothing.
		server.publishDueScheduledPosts(ctx)
		publishedEvents(t, conn, post.ID, 1)
	})

	t.Run("scheduled update", func(t *testing.T) {
		post := publishedPost(t, store, editor)
		editWorkingCopy(t, conn, post.ID, scheduleWord())
		scheduleUpdateAt(t, store, post.ID, editor, time.Now().Add(time.Hour))
		_, err := conn.Exec(`UPDATE post_scheduled_updates SET update_at = now() - interval '1 second' WHERE post_id = $1`, post.ID)
		require.NoError(t, err)
		require.GreaterOrEqual(t, server.applyDueScheduledUpdates(ctx), 1)
		event := publishedEvents(t, conn, post.ID, 2)
		require.Equal(t, "published", event.Data["from_status"])
		require.Equal(t, float64(reloadPost(t, store, post.ID).PublishedVersionID.Int64), event.Data["version_id"])
		requireVersionTransaction(t, conn, event)
	})

	t.Run("post_status through PUT", func(t *testing.T) {
		post := scheduleDraft(t, store, editor, scheduleWord())
		requireStatus(t, as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d", post.ID), gin.H{"post_status": "published"}), http.StatusOK)
		event := publishedEvents(t, conn, post.ID, 1)
		require.False(t, event.ActorID.Valid, "no version, so no publisher")
		require.NotContains(t, event.Data, "version_id")
		// One statement wrote the status and changed_at: the same transaction.
		require.True(t, reloadPost(t, store, post.ID).ChangedAt.Equal(event.CreatedAt))
		// Saving it again as published is not a second publish.
		requireStatus(t, as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d", post.ID), gin.H{"post_status": "published", "title": "Again"}), http.StatusOK)
		publishedEvents(t, conn, post.ID, 1)
	})

	t.Run("post_status through POST", func(t *testing.T) {
		word := scheduleWord()
		created := as(t, server, editor, http.MethodPost, "/api/v1/posts", gin.H{
			"title": "Hooks " + word, "url": "https://example.test/" + word, "author_ids": []int64{editor.ID},
			"post_status": "published",
		})
		requireStatus(t, created, http.StatusCreated)
		id := decodeID(t, created, "post")
		event := publishedEvents(t, conn, id, 1)
		require.True(t, reloadPost(t, store, id).CreatedAt.Equal(event.CreatedAt), "written by the insert's transaction")
		require.Len(t, eventsNamed(postPluginEvents(t, conn, id), pluginsdk.EventPostSaved), 1)
	})

	t.Run("a publish that rolls back has no event", func(t *testing.T) {
		post := scheduleDraft(t, store, editor, scheduleWord())
		tx, err := conn.Begin()
		require.NoError(t, err)
		_, err = tx.Exec(`UPDATE posts SET post_status = 'published' WHERE id = $1`, post.ID)
		require.NoError(t, err)
		var inside int
		require.NoError(t, tx.QueryRow(`SELECT count(*) FROM plugin_events WHERE post_id = $1 AND event = 'post.published'`, post.ID).Scan(&inside))
		require.Equal(t, 1, inside, "written inside the transaction")
		require.NoError(t, tx.Rollback())
		publishedEvents(t, conn, post.ID, 0)
	})

	t.Run("one transaction publishing twice announces one publish", func(t *testing.T) {
		post := scheduleDraft(t, store, editor, scheduleWord())
		tx, err := conn.Begin()
		require.NoError(t, err)
		_, err = tx.Exec(`UPDATE posts SET post_status = 'published' WHERE id = $1`, post.ID)
		require.NoError(t, err)
		_, err = tx.Exec(`UPDATE posts SET post_status = 'draft' WHERE id = $1`, post.ID)
		require.NoError(t, err)
		_, err = tx.Exec(`UPDATE posts SET post_status = 'published' WHERE id = $1`, post.ID)
		require.NoError(t, err)
		require.NoError(t, tx.Commit())
		publishedEvents(t, conn, post.ID, 1)
	})

	t.Run("unpublish, trash, restore, delete", func(t *testing.T) {
		post := publishedPost(t, store, editor)
		_, err := store.UnpublishPost(ctx, post.ID)
		require.NoError(t, err)
		_, err = store.PublishPostTx(ctx, db.PublishPostTxParams{PostID: post.ID, ContentMedia: publishedContentMedia})
		require.NoError(t, err)
		_, err = store.TrashPost(ctx, post.ID)
		require.NoError(t, err)
		_, err = store.RestorePostFromTrash(ctx, post.ID)
		require.NoError(t, err)
		_, err = store.TrashPost(ctx, post.ID)
		require.NoError(t, err)
		require.NoError(t, store.DeleteTrashedPostTx(ctx, post.ID))

		events := postPluginEvents(t, conn, post.ID)
		lifecycle := []string{}
		for _, name := range eventNames(events) {
			if name != pluginsdk.EventPostSaved {
				lifecycle = append(lifecycle, name)
			}
		}
		require.Equal(t, []string{
			pluginsdk.EventPostPublished, pluginsdk.EventPostUnpublished, pluginsdk.EventPostPublished,
			pluginsdk.EventPostTrashed, pluginsdk.EventPostRestored, pluginsdk.EventPostTrashed, pluginsdk.EventPostDeleted,
		}, lifecycle, "restoring a published post is not a publish")
		deleted := eventsNamed(events, pluginsdk.EventPostDeleted)[0]
		require.Equal(t, "post", deleted.Data["post_type"], "the row is gone; the event says what it was")
		require.Equal(t, "trash", deleted.Data["post_status"])
		restored := eventsNamed(events, pluginsdk.EventPostRestored)[0]
		require.Equal(t, "trash", restored.Data["from_status"])
		require.Equal(t, "published", restored.Data["post_status"])
	})

	t.Run("saves coalesce while waiting for fan-out", func(t *testing.T) {
		post := scheduleDraft(t, store, editor, scheduleWord())
		for i := 0; i < 3; i++ {
			editWorkingCopy(t, conn, post.ID, scheduleWord())
		}
		require.Len(t, eventsNamed(postPluginEvents(t, conn, post.ID), pluginsdk.EventPostSaved), 1)
	})
}

// hookRecorder is a plugin's server code for a test: it records every call and
// answers with behave (nil: success).
type hookRecorder struct {
	mu     sync.Mutex
	calls  []pluginsdk.Event
	hosts  []pluginsdk.Host
	behave func(ctx context.Context, event pluginsdk.Event) error
}

func (r *hookRecorder) observe(ctx context.Context, host pluginsdk.Host, event pluginsdk.Event) error {
	r.mu.Lock()
	r.calls = append(r.calls, event)
	r.hosts = append(r.hosts, host)
	behave := r.behave
	r.mu.Unlock()
	if behave != nil {
		return behave(ctx, event)
	}
	return nil
}

// callsFor lists the events the hook saw for postID, as "event#id".
func (r *hookRecorder) callsFor(postID int64) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []string{}
	for _, call := range r.calls {
		if call.PostID == postID {
			out = append(out, fmt.Sprintf("%s#%d", call.Name, call.ID))
		}
	}
	return out
}

func (r *hookRecorder) plugin(events ...string) pluginsdk.Plugin {
	p := pluginsdk.Plugin{Observers: map[string]pluginsdk.Observer{}}
	for _, event := range events {
		p.Observers[event] = r.observe
	}
	return p
}

// rounds runs n dispatcher rounds, each waiting for the runs it started.
func rounds(d *pluginHookDispatcher, n int) {
	for i := 0; i < n; i++ {
		d.round(context.Background())
		d.inFlight.Wait()
	}
}

// roundsUntil runs rounds until done holds. Other tests' events (here, or in packages
// running at the same time on the shared database) may be queued ahead of this test's
// for the same plugin, and a plugin runs two at a time.
func roundsUntil(t *testing.T, d *pluginHookDispatcher, done func() bool) {
	t.Helper()
	for i := 0; i < 200 && !done(); i++ {
		rounds(d, 1)
	}
	require.True(t, done(), "not reached after 200 rounds")
}

type hookRunRow struct {
	Status    string
	Attempts  int
	LastError sql.NullString
	Finished  sql.NullTime
}

// hookRun reads a run; a run not fanned out yet reads as the zero row (status "").
func hookRun(t *testing.T, conn *sql.DB, eventID, pluginID int64) hookRunRow {
	t.Helper()
	var row hookRunRow
	err := conn.QueryRow(`SELECT status, attempts, last_error, finished_at FROM plugin_hook_runs WHERE event_id = $1 AND plugin_id = $2`,
		eventID, pluginID).Scan(&row.Status, &row.Attempts, &row.LastError, &row.Finished)
	if errors.Is(err, sql.ErrNoRows) {
		return hookRunRow{}
	}
	require.NoError(t, err)
	return row
}

func makeRunDue(t *testing.T, conn *sql.DB, eventID, pluginID int64) {
	t.Helper()
	_, err := conn.Exec(`UPDATE plugin_hook_runs SET next_attempt_at = now() - interval '1 second' WHERE event_id = $1 AND plugin_id = $2`, eventID, pluginID)
	require.NoError(t, err)
}

func hookFailedActivity(t *testing.T, conn *sql.DB, pluginID int64) []map[string]any {
	t.Helper()
	rows, err := conn.Query(`SELECT payload FROM activity WHERE verb = 'plugin_hook_failed' AND object_type = 'plugin' AND object_id = $1 ORDER BY id`, pluginID)
	require.NoError(t, err)
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var raw []byte
		require.NoError(t, rows.Scan(&raw))
		var payload map[string]any
		require.NoError(t, json.Unmarshal(raw, &payload))
		out = append(out, payload)
	}
	return out
}

// hookServer is a server whose registry holds the test's plugins.
func hookServer(t *testing.T, store db.Store, registry pluginHookRegistry) (*Server, *pluginHookDispatcher) {
	t.Helper()
	server := scheduleServer(t, store, newStubCollab(t, 0))
	server.pluginRegistry = registry
	return server, newPluginHookDispatcher(server, registry)
}

// TestPluginHooksOrderAndRetry: a post's events reach a plugin in order, after the
// change committed; a failed run is retried with backoff and holds the later runs
// for that plugin and post meanwhile; the failure reaches the activity log.
func TestPluginHooksOrderAndRetry(t *testing.T) {
	conn, store := scheduleTestDB(t)
	ctx := context.Background()
	events := []string{pluginsdk.EventPostSaved, pluginsdk.EventPostPublished}
	row := enableHookPlugin(t, store, events, nil, "posts:read")
	recorder := &hookRecorder{}
	var failSaves atomic.Bool
	var target atomic.Int64
	failSaves.Store(true)
	recorder.behave = func(_ context.Context, event pluginsdk.Event) error {
		if event.PostID == target.Load() && event.Name == pluginsdk.EventPostSaved && failSaves.Load() {
			return errors.New("search index unavailable")
		}
		return nil
	}
	_, d := hookServer(t, store, pluginHookRegistry{row.Slug: recorder.plugin(events...)})

	editor := scheduleUser(t, store, RoleEditor)
	post := scheduleDraft(t, store, editor, scheduleWord())
	target.Store(post.ID)
	_, err := store.PublishPostTx(ctx, db.PublishPostTxParams{PostID: post.ID, CreatedBy: sql.NullInt64{Int64: editor.ID, Valid: true}, ContentMedia: publishedContentMedia})
	require.NoError(t, err)
	saved := eventsNamed(postPluginEvents(t, conn, post.ID), pluginsdk.EventPostSaved)
	published := eventsNamed(postPluginEvents(t, conn, post.ID), pluginsdk.EventPostPublished)
	require.Len(t, saved, 1)
	require.Len(t, published, 1)
	require.Less(t, saved[0].ID, published[0].ID, "in the order they happened")
	savedID, publishedID := saved[0].ID, published[0].ID
	require.Empty(t, recorder.callsFor(post.ID), "nothing runs inside the publish")

	roundsUntil(t, d, func() bool { return len(recorder.callsFor(post.ID)) > 0 })
	rounds(d, 3)
	require.Equal(t, []string{fmt.Sprintf("post.saved#%d", savedID)}, recorder.callsFor(post.ID),
		"the publish waits behind the failed save")
	run := hookRun(t, conn, savedID, row.ID)
	require.Equal(t, "pending", run.Status)
	require.Equal(t, 1, run.Attempts)
	require.Equal(t, "search index unavailable", run.LastError.String)
	require.Equal(t, "pending", hookRun(t, conn, publishedID, row.ID).Status)
	var retryIn float64
	require.NoError(t, conn.QueryRow(`SELECT extract(epoch FROM next_attempt_at - now()) FROM plugin_hook_runs WHERE event_id = $1 AND plugin_id = $2`,
		savedID, row.ID).Scan(&retryIn))
	require.InDelta(t, scheduledPublishBackoff[0].Seconds(), retryIn, 5, "the scheduler's backoff")
	activity := hookFailedActivity(t, conn, row.ID)
	require.Len(t, activity, 1)
	require.Equal(t, "post.saved", activity[0]["event"])
	require.Equal(t, false, activity[0]["final"])

	failSaves.Store(false)
	makeRunDue(t, conn, savedID, row.ID)
	roundsUntil(t, d, func() bool { return len(recorder.callsFor(post.ID)) >= 3 })
	require.Equal(t, []string{
		fmt.Sprintf("post.saved#%d", savedID), fmt.Sprintf("post.saved#%d", savedID), fmt.Sprintf("post.published#%d", publishedID),
	}, recorder.callsFor(post.ID))
	require.Equal(t, "done", hookRun(t, conn, savedID, row.ID).Status)
	done := hookRun(t, conn, publishedID, row.ID)
	require.Equal(t, "done", done.Status)
	require.True(t, done.Finished.Valid)

	// What the hook was handed: the event's facts, and a host with the declared reader.
	// The last call for this post: on a shared database other tests' posts reach this
	// plugin too, and may run after it.
	recorder.mu.Lock()
	var last pluginsdk.Event
	var host pluginsdk.Host
	for i, call := range recorder.calls {
		if call.PostID == post.ID {
			last, host = call, recorder.hosts[i]
		}
	}
	recorder.mu.Unlock()
	require.Equal(t, editor.ID, last.ActorID)
	require.Equal(t, publishedID, last.ID)
	require.NotNil(t, host.Posts())
	require.Nil(t, host.Users(), "users:read not declared")
	live, err := host.Posts().GetPublished(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, post.ID, live.ID)

	// Delivered: nothing more runs.
	rounds(d, 2)
	require.Len(t, recorder.callsFor(post.ID), 3)
}

// TestPluginHooksGiveUpAfterMaxAttempts: the eighth failure is final; retries reach the
// activity log throttled, the final failure always.
func TestPluginHooksGiveUpAfterMaxAttempts(t *testing.T) {
	conn, store := scheduleTestDB(t)
	row := enableHookPlugin(t, store, []string{pluginsdk.EventPostTrashed}, nil)
	recorder := &hookRecorder{behave: func(context.Context, pluginsdk.Event) error { return errors.New("always fails") }}
	_, d := hookServer(t, store, pluginHookRegistry{row.Slug: recorder.plugin(pluginsdk.EventPostTrashed)})

	editor := scheduleUser(t, store, RoleEditor)
	post := scheduleDraft(t, store, editor, scheduleWord())
	_, err := store.TrashPost(context.Background(), post.ID)
	require.NoError(t, err)
	event := eventsNamed(postPluginEvents(t, conn, post.ID), pluginsdk.EventPostTrashed)[0]

	roundsUntil(t, d, func() bool { return len(recorder.callsFor(post.ID)) == 1 })
	require.Equal(t, "pending", hookRun(t, conn, event.ID, row.ID).Status)
	_, err = conn.Exec(`UPDATE plugin_hook_runs SET attempts = $3 - 1, next_attempt_at = now() WHERE event_id = $1 AND plugin_id = $2`,
		event.ID, row.ID, pluginHookMaxAttempts)
	require.NoError(t, err)
	roundsUntil(t, d, func() bool { return hookRun(t, conn, event.ID, row.ID).Status == "failed" })
	run := hookRun(t, conn, event.ID, row.ID)
	require.Equal(t, "failed", run.Status)
	require.Equal(t, pluginHookMaxAttempts, run.Attempts)
	require.True(t, run.Finished.Valid)
	require.Equal(t, "always fails", run.LastError.String)

	rounds(d, 1)
	require.Len(t, recorder.callsFor(post.ID), 2, "a failed run isn't retried")
	activity := hookFailedActivity(t, conn, row.ID)
	require.Len(t, activity, 2, "retries throttled, the final failure always recorded")
	require.Equal(t, false, activity[0]["final"])
	require.Equal(t, true, activity[1]["final"])
}

// TestPluginHooksLease: a run claimed by a replica that died is taken again when its
// lease passes, and the dead claim's result can't be recorded over it.
func TestPluginHooksLease(t *testing.T) {
	conn, store := scheduleTestDB(t)
	ctx := context.Background()
	row := enableHookPlugin(t, store, []string{pluginsdk.EventPostTrashed}, nil)
	recorder := &hookRecorder{}
	_, d := hookServer(t, store, pluginHookRegistry{row.Slug: recorder.plugin(pluginsdk.EventPostTrashed)})

	editor := scheduleUser(t, store, RoleEditor)
	post := scheduleDraft(t, store, editor, scheduleWord())
	_, err := store.TrashPost(ctx, post.ID)
	require.NoError(t, err)
	d.fanOut(ctx)

	// Another replica claims it and dies.
	claims, err := store.ClaimDuePluginHookRuns(ctx, db.ClaimDuePluginHookRunsParams{
		PluginID: row.ID, Events: []string{pluginsdk.EventPostTrashed}, LeaseSeconds: pluginHookLease.Seconds(), MaxRuns: 10,
	})
	require.NoError(t, err)
	require.Len(t, claims, 1)
	dead := claims[0]
	require.Equal(t, "running", hookRun(t, conn, dead.EventID, row.ID).Status)

	rounds(d, 2)
	require.Empty(t, recorder.callsFor(post.ID), "the lease keeps it off")

	makeRunDue(t, conn, dead.EventID, row.ID)
	roundsUntil(t, d, func() bool { return hookRun(t, conn, dead.EventID, row.ID).Status == "done" })
	require.Len(t, recorder.callsFor(post.ID), 1)
	run := hookRun(t, conn, dead.EventID, row.ID)
	require.Equal(t, "done", run.Status)
	require.Equal(t, 2, run.Attempts)

	n, err := store.RecordPluginHookRunDone(ctx, db.RecordPluginHookRunDoneParams{EventID: dead.EventID, PluginID: row.ID, Claim: dead.Claim})
	require.NoError(t, err)
	require.Zero(t, n, "fenced by the lease value")
	_, err = store.RecordPluginHookRunFailure(ctx, db.RecordPluginHookRunFailureParams{
		MaxAttempts: pluginHookMaxAttempts, LastError: "late", EventID: dead.EventID, PluginID: row.ID, Claim: dead.Claim,
	})
	require.ErrorIs(t, err, sql.ErrNoRows)
}

// TestPluginHooksCantHurtPublishing: a panicking hook and one that hangs past its
// timeout, ignoring its context, fail their own runs only. Publishing goes on
// meanwhile, the hung hook keeps its slot until it returns, and the process lives.
func TestPluginHooksCantHurtPublishing(t *testing.T) {
	conn, store := scheduleTestDB(t)
	ctx := context.Background()
	panicky := enableHookPlugin(t, store, []string{pluginsdk.EventPostPublished}, nil)
	stuck := enableHookPlugin(t, store, []string{pluginsdk.EventPostPublished}, map[string]int{pluginsdk.EventPostPublished: 100})
	release := make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	// Only this test's post misbehaves: other tests' publishes reach these plugins too.
	var target atomic.Int64
	panicRecorder := &hookRecorder{behave: func(_ context.Context, event pluginsdk.Event) error {
		if event.PostID == target.Load() {
			panic("plugin bug")
		}
		return nil
	}}
	stuckRecorder := &hookRecorder{behave: func(_ context.Context, event pluginsdk.Event) error {
		if event.PostID == target.Load() {
			<-release // ignores ctx
		}
		return nil
	}}
	_, d := hookServer(t, store, pluginHookRegistry{
		panicky.Slug: panicRecorder.plugin(pluginsdk.EventPostPublished),
		stuck.Slug:   stuckRecorder.plugin(pluginsdk.EventPostPublished),
	})

	editor := scheduleUser(t, store, RoleEditor)
	post := scheduleDraft(t, store, editor, scheduleWord())
	target.Store(post.ID)
	_, err := store.PublishPostTx(ctx, db.PublishPostTxParams{PostID: post.ID, ContentMedia: publishedContentMedia})
	require.NoError(t, err)
	event := publishedEvents(t, conn, post.ID, 1)

	started := time.Now()
	roundsUntil(t, d, func() bool {
		return hookRun(t, conn, event.ID, panicky.ID).LastError.Valid && hookRun(t, conn, event.ID, stuck.ID).LastError.Valid
	})
	require.Less(t, time.Since(started), 20*time.Second, "rounds wait for the timeout, not the hung hook")
	require.Equal(t, "panic: plugin bug", hookRun(t, conn, event.ID, panicky.ID).LastError.String)
	stuckRun := hookRun(t, conn, event.ID, stuck.ID)
	require.Equal(t, "pending", stuckRun.Status)
	require.Equal(t, "timed out after 100ms", stuckRun.LastError.String)
	require.Equal(t, pluginHookSlotsPerPlugin-1, d.free(stuck.Slug), "the hung goroutine keeps its slot")

	// Publishing isn't held up by either.
	editWorkingCopy(t, conn, post.ID, scheduleWord())
	publishStarted := time.Now()
	_, err = store.PublishPostTx(ctx, db.PublishPostTxParams{PostID: post.ID, ContentMedia: publishedContentMedia})
	require.NoError(t, err)
	require.Less(t, time.Since(publishStarted), 5*time.Second)
	require.Equal(t, postStatusPublished, reloadPost(t, store, post.ID).PostStatus)

	close(release)
	require.Eventually(t, func() bool { return d.free(stuck.Slug) == pluginHookSlotsPerPlugin }, 5*time.Second, 10*time.Millisecond)
}

// TestPluginHooksSkipDisabledPlugins: runs still pending when their plugin is
// disabled are skipped, never run.
func TestPluginHooksSkipDisabledPlugins(t *testing.T) {
	conn, store := scheduleTestDB(t)
	ctx := context.Background()
	row := enableHookPlugin(t, store, []string{pluginsdk.EventPostTrashed}, nil)
	recorder := &hookRecorder{}
	_, d := hookServer(t, store, pluginHookRegistry{row.Slug: recorder.plugin(pluginsdk.EventPostTrashed)})

	editor := scheduleUser(t, store, RoleEditor)
	post := scheduleDraft(t, store, editor, scheduleWord())
	_, err := store.TrashPost(ctx, post.ID)
	require.NoError(t, err)
	d.fanOut(ctx)
	event := eventsNamed(postPluginEvents(t, conn, post.ID), pluginsdk.EventPostTrashed)[0]
	require.True(t, event.FannedOut)

	_, err = store.DisablePlugin(ctx, row.Slug)
	require.NoError(t, err)
	rounds(d, 1)
	run := hookRun(t, conn, event.ID, row.ID)
	require.Equal(t, "skipped", run.Status)
	require.True(t, run.Finished.Valid)
	require.Empty(t, recorder.callsFor(post.ID))
}

// TestPluginHooksSkipDroppedHooks: an upgrade that drops a hook skips that hook's
// pending runs, so they don't hold the plugin's later runs for the same post.
func TestPluginHooksSkipDroppedHooks(t *testing.T) {
	conn, store := scheduleTestDB(t)
	ctx := context.Background()
	events := []string{pluginsdk.EventPostSaved, pluginsdk.EventPostPublished}
	row := enableHookPlugin(t, store, events, nil)
	recorder := &hookRecorder{}
	_, d := hookServer(t, store, pluginHookRegistry{row.Slug: recorder.plugin(pluginsdk.EventPostPublished)})

	editor := scheduleUser(t, store, RoleEditor)
	post := scheduleDraft(t, store, editor, scheduleWord())
	_, err := store.PublishPostTx(ctx, db.PublishPostTxParams{PostID: post.ID, ContentMedia: publishedContentMedia})
	require.NoError(t, err)
	d.fanOut(ctx)
	saved := eventsNamed(postPluginEvents(t, conn, post.ID), pluginsdk.EventPostSaved)[0]
	published := eventsNamed(postPluginEvents(t, conn, post.ID), pluginsdk.EventPostPublished)[0]
	require.Equal(t, "pending", hookRun(t, conn, saved.ID, row.ID).Status)

	// Version 2 declares post.published only (what the scan would store).
	_, err = conn.Exec(`UPDATE plugins SET manifest = jsonb_set(manifest, '{server,hooks}', '[{"event":"post.published"}]') WHERE id = $1`, row.ID)
	require.NoError(t, err)
	roundsUntil(t, d, func() bool { return hookRun(t, conn, published.ID, row.ID).Status == "done" })
	require.Equal(t, "skipped", hookRun(t, conn, saved.ID, row.ID).Status)
	require.Equal(t, []string{fmt.Sprintf("post.published#%d", published.ID)}, recorder.callsFor(post.ID))
}

// TestListHookPluginsNullHooks: a plugin.json with "hooks": null (the validator allows
// it) is a plugin without hooks, not an error that stops every plugin's hooks.
func TestListHookPluginsNullHooks(t *testing.T) {
	_, store := scheduleTestDB(t)
	ctx := context.Background()
	slug := pluginDBSlug("nullhooks")
	_, err := store.InsertDiscoveredPlugin(ctx, db.InsertDiscoveredPluginParams{
		Slug: slug, Name: "Null hooks", Version: "1.0.0", Status: PluginStatusInstalled, ContentHash: strings.Repeat("b", 64),
		Manifest: json.RawMessage(fmt.Sprintf(`{"manifest_version":1,"id":%q,"name":"Null hooks","version":"1.0.0","plugin_api":1,"server":{"hooks":null}}`, slug)),
	})
	require.NoError(t, err)
	_, err = store.EnablePlugin(ctx, db.EnablePluginParams{Slug: slug})
	require.NoError(t, err)
	t.Cleanup(func() { _, _ = store.DisablePlugin(context.Background(), slug) })

	rows, err := store.ListHookPlugins(ctx)
	require.NoError(t, err)
	for _, row := range rows {
		require.NotEqual(t, slug, row.Slug)
	}
	_, err = store.SkipInactivePluginHookRuns(ctx)
	require.NoError(t, err)
	_, err = store.FanOutPluginEvents(ctx, pluginHooksFanOutBatch)
	require.NoError(t, err)
}

// TestPluginHooksSaveBacklog: while a plugin's save run for a post is pending, later
// saves of that post add no run for it (the hook reads the post when it runs), and an
// event that ends up with no run is dropped.
func TestPluginHooksSaveBacklog(t *testing.T) {
	conn, store := scheduleTestDB(t)
	ctx := context.Background()
	row := enableHookPlugin(t, store, []string{pluginsdk.EventPostSaved}, nil)
	// No code registered here, so nothing claims the runs: they stay pending.
	_, d := hookServer(t, store, pluginHookRegistry{})

	editor := scheduleUser(t, store, RoleEditor)
	post := scheduleDraft(t, store, editor, scheduleWord())
	d.fanOut(ctx)
	first := eventsNamed(postPluginEvents(t, conn, post.ID), pluginsdk.EventPostSaved)
	require.Len(t, first, 1)
	require.True(t, first[0].FannedOut)
	require.Equal(t, "pending", hookRun(t, conn, first[0].ID, row.ID).Status)

	editWorkingCopy(t, conn, post.ID, scheduleWord())
	require.Len(t, eventsNamed(postPluginEvents(t, conn, post.ID), pluginsdk.EventPostSaved), 2, "a new pending save after the fan-out")
	d.fanOut(ctx)
	require.Len(t, eventsNamed(postPluginEvents(t, conn, post.ID), pluginsdk.EventPostSaved), 1, "no plugin needed it, so it went")
	var runs int
	require.NoError(t, conn.QueryRow(`SELECT count(*) FROM plugin_hook_runs WHERE post_id = $1 AND plugin_id = $2`, post.ID, row.ID).Scan(&runs))
	require.Equal(t, 1, runs)
}

// TestPluginHooksPrune: done runs go after 7 days, failed after 30, and an event
// with no runs left goes too.
func TestPluginHooksPrune(t *testing.T) {
	conn, store := scheduleTestDB(t)
	ctx := context.Background()
	row := enableHookPlugin(t, store, []string{pluginsdk.EventPostTrashed}, nil)
	_, d := hookServer(t, store, pluginHookRegistry{})

	editor := scheduleUser(t, store, RoleEditor)
	makeFinishedRun := func(status string, age time.Duration) int64 {
		post := scheduleDraft(t, store, editor, scheduleWord())
		_, err := store.TrashPost(ctx, post.ID)
		require.NoError(t, err)
		d.fanOut(ctx)
		event := eventsNamed(postPluginEvents(t, conn, post.ID), pluginsdk.EventPostTrashed)[0]
		_, err = conn.Exec(`UPDATE plugin_hook_runs SET status = $3, finished_at = now() - make_interval(secs => $4) WHERE event_id = $1 AND plugin_id = $2`,
			event.ID, row.ID, status, age.Seconds())
		require.NoError(t, err)
		return event.ID
	}
	oldDone := makeFinishedRun("done", 8*24*time.Hour)
	recentDone := makeFinishedRun("done", 24*time.Hour)
	oldSkipped := makeFinishedRun("skipped", 8*24*time.Hour)
	failed := makeFinishedRun("failed", 8*24*time.Hour)
	oldFailed := makeFinishedRun("failed", 31*24*time.Hour)

	d.prune(ctx)
	exists := func(eventID int64) bool {
		var n int
		require.NoError(t, conn.QueryRow(`SELECT count(*) FROM plugin_events WHERE id = $1`, eventID).Scan(&n))
		return n == 1
	}
	require.False(t, exists(oldDone))
	require.False(t, exists(oldSkipped))
	require.False(t, exists(oldFailed))
	require.True(t, exists(recentDone))
	require.True(t, exists(failed), "failed runs stay 30 days")
}

// TestPluginHooksDriftIsIncompatible: a hook in Go without a manifest entry, or the
// reverse, makes the plugin incompatible at the scan; matching makes it installed.
func TestPluginHooksDriftIsIncompatible(t *testing.T) {
	_, store := scheduleTestDB(t)
	server := authFlowServer(t, store, nil)
	admin := scheduleUser(t, store, RoleAdmin)
	root := t.TempDir()
	declared := pluginDBSlug("declared")
	undeclared := pluginDBSlug("undeclared")
	writePlugin(t, root, declared, pluginJSON(declared, "1.0.0", 1, `"server":{"hooks":[{"event":"post.published"}]}`), nil)
	writePlugin(t, root, undeclared, pluginJSON(undeclared, "1.0.0", 1, ""), nil)

	server.pluginRegistry = pluginHookRegistry{undeclared: observing(pluginsdk.EventPostSaved)}
	syncPluginsFrom(t, server, root, declared, undeclared)
	for _, slug := range []string{declared, undeclared} {
		listed, ok := listedPlugin(t, server, admin, slug)
		require.True(t, ok)
		require.Equal(t, PluginStatusIncompatible, listed.Status, slug)
		require.Equal(t, "hooks", listed.IncompatibleReason, slug)
		requireStatus(t, as(t, server, admin, http.MethodPost, "/api/v1/plugins/"+slug+"/enable", nil), http.StatusConflict)
	}

	server.pluginRegistry = pluginHookRegistry{declared: observing(pluginsdk.EventPostPublished)}
	syncPluginsFrom(t, server, root, declared, undeclared)
	for _, slug := range []string{declared, undeclared} {
		listed, ok := listedPlugin(t, server, admin, slug)
		require.True(t, ok)
		require.Equal(t, PluginStatusInstalled, listed.Status, slug)
	}
}

// TestRunPluginHooksLoop: the loop from main.go runs a hook about an interval after
// the change, and stops on shutdown after the run in flight.
func TestRunPluginHooksLoop(t *testing.T) {
	conn, store := scheduleTestDB(t)
	row := enableHookPlugin(t, store, []string{pluginsdk.EventPostTrashed}, nil)
	recorder := &hookRecorder{behave: func(context.Context, pluginsdk.Event) error {
		time.Sleep(50 * time.Millisecond)
		return nil
	}}
	server, _ := hookServer(t, store, pluginHookRegistry{row.Slug: recorder.plugin(pluginsdk.EventPostTrashed)})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		server.RunPluginHooks(ctx, 20*time.Millisecond)
		close(done)
	}()

	editor := scheduleUser(t, store, RoleEditor)
	post := scheduleDraft(t, store, editor, scheduleWord())
	_, err := store.TrashPost(context.Background(), post.ID)
	require.NoError(t, err)
	require.Eventually(t, func() bool { return len(recorder.callsFor(post.ID)) == 1 }, 10*time.Second, 10*time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("RunPluginHooks didn't stop")
	}
	event := eventsNamed(postPluginEvents(t, conn, post.ID), pluginsdk.EventPostTrashed)[0]
	require.Equal(t, "done", hookRun(t, conn, event.ID, row.ID).Status, "recorded before it stopped")
}
