package api

import (
	"bytes"
	"context"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/pluginsdk"
)

// Plugin webhooks (#460) against the test database (skipped without one): delivery
// through the hook dispatcher's own fan-out, claim, retry and timeout, the SSRF policy
// on the real path, and no secret in logs, activity, last_error or API answers.
//
// The database is shared: another test's publish reaches this test's plugin too, so
// every assertion is about this test's own post.

// syncBuffer is a log sink the dispatcher's goroutines can share.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// enableWebhookPlugin enables a webhook plugin: a URL setting, a secret setting, and a
// hook per event (timeoutMS on each when > 0).
func enableWebhookPlugin(t *testing.T, store db.Store, timeoutMS int, events ...string) db.Plugin {
	t.Helper()
	slug := pluginDBSlug("webhook")
	hooks := []map[string]any{}
	for _, event := range events {
		hook := map[string]any{"event": event}
		if timeoutMS > 0 {
			hook["timeout_ms"] = timeoutMS
		}
		hooks = append(hooks, hook)
	}
	return enableManifestPlugin(t, store, slug, map[string]any{
		"manifest_version": 1, "id": slug, "name": "Webhook " + slug, "version": "1.0.0", "plugin_api": 1,
		"capabilities": []string{"network"},
		"settings": map[string]any{
			"url":            map[string]any{"type": "string", "maxLength": 2048},
			"signing_secret": map[string]any{"type": "string", "secret": true},
		},
		"server": map[string]any{
			"webhook": map[string]any{"url_setting": "url", "secret_setting": "signing_secret"},
			"hooks":   hooks,
		},
	})
}

// webhookServer is a hook server with no Go plugins, logging into a buffer.
func webhookServer(t *testing.T, store db.Store) (*Server, *pluginHookDispatcher, *syncBuffer) {
	t.Helper()
	server, d := hookServer(t, store, pluginHookRegistry{})
	logs := &syncBuffer{}
	server.logger = slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	return server, d, logs
}

func saveWebhookSettings(t *testing.T, server *Server, admin db.User, slug string, values gin.H) *httptest.ResponseRecorder {
	t.Helper()
	return as(t, server, admin, http.MethodPut, "/api/v1/plugins/"+slug+"/settings", gin.H{"values": values})
}

// forPost is what the receiver got for postID.
func (rcv *webhookReceiver) forPost(postID int64) []receivedWebhook {
	out := []receivedWebhook{}
	for _, req := range rcv.received() {
		var payload pluginsdk.WebhookPayload
		if json.Unmarshal(req.body, &payload) == nil && payload.PostID == postID {
			out = append(out, req)
		}
	}
	return out
}

func webhookPostID(body []byte) int64 {
	var payload pluginsdk.WebhookPayload
	_ = json.Unmarshal(body, &payload)
	return payload.PostID
}

func publishForHooks(t *testing.T, store db.Store, post db.Post, by db.User) {
	t.Helper()
	_, err := store.PublishPostTx(context.Background(), db.PublishPostTxParams{
		PostID: post.ID, CreatedBy: sql.NullInt64{Int64: by.ID, Valid: true}, ContentMedia: publishedContentMedia,
	})
	require.NoError(t, err)
}

// requireNoSecret: none of the needles appears in haystack.
func requireNoSecret(t *testing.T, where, haystack string, needles ...string) {
	t.Helper()
	for _, needle := range needles {
		require.NotContains(t, haystack, needle, "%s holds a secret", where)
	}
}

// TestPluginWebhookDelivery: a subscribed event reaches the URL, signed, through the
// dispatcher; a failed attempt is retried with the same event id; nothing secret leaks.
func TestPluginWebhookDelivery(t *testing.T) {
	conn, store := scheduleTestDB(t)
	row := enableWebhookPlugin(t, store, 0, pluginsdk.EventPostPublished)
	server, d, logs := webhookServer(t, store)

	editor := scheduleUser(t, store, RoleEditor)
	admin := scheduleUser(t, store, RoleAdmin)
	post := scheduleDraft(t, store, editor, scheduleWord())

	var failFirst sync.Once
	rcv := &webhookReceiver{answer: func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		status := http.StatusNoContent
		if webhookPostID(body) == post.ID {
			failFirst.Do(func() { status = http.StatusBadGateway })
		}
		w.WriteHeader(status)
	}}
	srv := httptest.NewTLSServer(rcv)
	defer srv.Close()
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	server.webhooks = newWebhookSender(true, pool) // a loopback receiver: the dev allowance

	token := "tok-" + scheduleWord()
	secret := "whsec-" + scheduleWord() + "-0123456789"
	target := srv.URL + "/golive?token=" + token
	requireStatus(t, saveWebhookSettings(t, server, admin, row.Slug, gin.H{"url": target, "signing_secret": secret}), http.StatusOK)

	publishForHooks(t, store, post, editor)
	event := publishedEvents(t, conn, post.ID, 1)

	// First attempt: answered 502, so pending again with the scheduler's backoff.
	roundsUntil(t, d, func() bool { return len(rcv.forPost(post.ID)) >= 1 })
	roundsUntil(t, d, func() bool { return hookRun(t, conn, event.ID, row.ID).Status == "pending" })
	run := hookRun(t, conn, event.ID, row.ID)
	require.Equal(t, 1, run.Attempts)
	require.Equal(t, "webhook answered HTTP 502", run.LastError.String)

	// The retry delivers the same event again: at least once, keyed by its id.
	makeRunDue(t, conn, event.ID, row.ID)
	roundsUntil(t, d, func() bool { return hookRun(t, conn, event.ID, row.ID).Status == "done" })
	got := rcv.forPost(post.ID)
	require.Len(t, got, 2)
	for _, req := range got {
		require.Equal(t, strconv.FormatInt(event.ID, 10), req.header.Get(pluginsdk.WebhookHeaderEventID))
		require.Equal(t, pluginsdk.EventPostPublished, req.header.Get(pluginsdk.WebhookHeaderEvent))
		require.NoError(t, pluginsdk.VerifyWebhook(secret, req.header.Get(pluginsdk.WebhookHeaderTimestamp),
			req.header.Get(pluginsdk.WebhookHeaderSignature), req.body, time.Now(), 0))
		var payload pluginsdk.WebhookPayload
		require.NoError(t, json.Unmarshal(req.body, &payload))
		require.Equal(t, event.ID, payload.ID)
		require.Equal(t, row.Slug, payload.Plugin)
		require.Equal(t, editor.ID, *payload.ActorID)
		require.Equal(t, "post", payload.Data["post_type"])
	}
	require.Equal(t, got[0].body, got[1].body)

	// Delivered: nothing more is sent.
	rounds(d, 2)
	require.Len(t, rcv.forPost(post.ID), 2)

	// No secret anywhere: the logs, last_error, the activity log, the settings answer.
	needles := []string{secret, token, srv.URL}
	requireNoSecret(t, "the logs", logs.String(), needles...)
	require.Contains(t, logs.String(), "plugin_hook_failed", "the failure was logged, without the URL")
	requireNoSecret(t, "last_error", hookRun(t, conn, event.ID, row.ID).LastError.String, needles...)
	activity := hookFailedActivity(t, conn, row.ID)
	require.NotEmpty(t, activity)
	var payloads []string
	rows, err := conn.Query(`SELECT payload::text FROM activity WHERE object_type = 'plugin' AND object_id = $1`, row.ID)
	require.NoError(t, err)
	for rows.Next() {
		var p string
		require.NoError(t, rows.Scan(&p))
		payloads = append(payloads, p)
	}
	require.NoError(t, rows.Close())
	requireNoSecret(t, "the activity log", strings.Join(payloads, "\n"), needles[:2]...)
	answer := as(t, server, admin, http.MethodGet, "/api/v1/plugins/"+row.Slug+"/settings", nil)
	requireStatus(t, answer, http.StatusOK)
	requireNoSecret(t, "GET settings", answer.Body.String(), secret)
	require.Contains(t, answer.Body.String(), `"signing_secret":{"set":true}`)
}

// TestPluginWebhookRefusedTargets: with the real policy, a URL whose name resolves to a
// loopback address is refused at connect time and retried like any failure; the target
// is never reached.
func TestPluginWebhookRefusedTargets(t *testing.T) {
	conn, store := scheduleTestDB(t)
	row := enableWebhookPlugin(t, store, 0, pluginsdk.EventPostPublished)
	server, d, logs := webhookServer(t, store)
	server.webhooks = newWebhookSender(false, nil)

	editor := scheduleUser(t, store, RoleEditor)
	admin := scheduleUser(t, store, RoleAdmin)
	rcv := &webhookReceiver{}
	srv := httptest.NewTLSServer(rcv)
	defer srv.Close()
	_, port, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "https://"))
	require.NoError(t, err)

	// What the settings form refuses outright.
	for _, refused := range []string{"http://hooks.example.com/", "https://127.0.0.1:" + port + "/", "https://[::ffff:169.254.169.254]/", "https://u:p@hooks.example.com/"} {
		answer := saveWebhookSettings(t, server, admin, row.Slug, gin.H{"url": refused})
		requireStatus(t, answer, http.StatusBadRequest)
		require.Contains(t, answer.Body.String(), `"code":"invalid_plugin_settings"`)
		require.NotContains(t, answer.Body.String(), refused)
	}
	requireStatus(t, saveWebhookSettings(t, server, admin, row.Slug, gin.H{"signing_secret": "short"}), http.StatusBadRequest)

	// A name is checked where it matters, on the address DNS answers.
	secret := "whsec-" + scheduleWord() + "-0123456789"
	requireStatus(t, saveWebhookSettings(t, server, admin, row.Slug, gin.H{
		"url": "https://localhost:" + port + "/golive", "signing_secret": secret,
	}), http.StatusOK)
	post := scheduleDraft(t, store, editor, scheduleWord())
	publishForHooks(t, store, post, editor)
	event := publishedEvents(t, conn, post.ID, 1)
	roundsUntil(t, d, func() bool {
		return hookRun(t, conn, event.ID, row.ID).Attempts >= 1 && hookRun(t, conn, event.ID, row.ID).Status == "pending"
	})
	run := hookRun(t, conn, event.ID, row.ID)
	require.Equal(t, string(webhookAddressRefuse), run.LastError.String)
	require.Empty(t, rcv.received(), "the loopback receiver was never reached")
	requireNoSecret(t, "the logs", logs.String(), secret, "localhost:"+port)
}

// TestPluginWebhookTimeout: a receiver slower than timeout_ms fails the attempt, which
// is retried like an in-process hook's.
func TestPluginWebhookTimeout(t *testing.T) {
	conn, store := scheduleTestDB(t)
	row := enableWebhookPlugin(t, store, 300, pluginsdk.EventPostTrashed)
	server, d, _ := webhookServer(t, store)
	editor := scheduleUser(t, store, RoleEditor)
	admin := scheduleUser(t, store, RoleAdmin)
	post := scheduleDraft(t, store, editor, scheduleWord())

	rcv := &webhookReceiver{answer: func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	}}
	srv := httptest.NewServer(rcv)
	defer srv.Close()
	server.webhooks = newWebhookSender(true, nil)
	requireStatus(t, saveWebhookSettings(t, server, admin, row.Slug, gin.H{
		"url": srv.URL + "/slow", "signing_secret": "whsec-" + scheduleWord() + "-0123456789",
	}), http.StatusOK)

	_, err := store.TrashPost(context.Background(), post.ID)
	require.NoError(t, err)
	event := eventsNamed(postPluginEvents(t, conn, post.ID), pluginsdk.EventPostTrashed)[0]
	started := time.Now()
	roundsUntil(t, d, func() bool {
		return hookRun(t, conn, event.ID, row.ID).Status == "pending" && hookRun(t, conn, event.ID, row.ID).Attempts == 1
	})
	require.Less(t, time.Since(started), 30*time.Second)
	run := hookRun(t, conn, event.ID, row.ID)
	require.Contains(t, run.LastError.String, "timed out")
	require.Len(t, rcv.forPost(post.ID), 1)
}

// TestPluginWebhookOnlyEnabledPluginsDeliver: a plugin disabled before its run is
// claimed delivers nothing; its run is skipped.
func TestPluginWebhookOnlyEnabledPluginsDeliver(t *testing.T) {
	conn, store := scheduleTestDB(t)
	row := enableWebhookPlugin(t, store, 0, pluginsdk.EventPostPublished)
	server, d, _ := webhookServer(t, store)
	editor := scheduleUser(t, store, RoleEditor)
	admin := scheduleUser(t, store, RoleAdmin)
	rcv := &webhookReceiver{}
	srv := httptest.NewServer(rcv)
	defer srv.Close()
	server.webhooks = newWebhookSender(true, nil)
	requireStatus(t, saveWebhookSettings(t, server, admin, row.Slug, gin.H{
		"url": srv.URL, "signing_secret": "whsec-" + scheduleWord() + "-0123456789",
	}), http.StatusOK)

	post := scheduleDraft(t, store, editor, scheduleWord())
	publishForHooks(t, store, post, editor)
	event := publishedEvents(t, conn, post.ID, 1)
	// Fanned out while enabled: the run waits, pending.
	for i := 0; i < 50 && hookRun(t, conn, event.ID, row.ID).Status == ""; i++ {
		d.fanOut(context.Background())
	}
	require.Equal(t, "pending", hookRun(t, conn, event.ID, row.ID).Status)

	_, err := store.DisablePlugin(context.Background(), row.Slug)
	require.NoError(t, err)
	roundsUntil(t, d, func() bool { return hookRun(t, conn, event.ID, row.ID).Status == "skipped" })
	rounds(d, 2)
	require.Empty(t, rcv.forPost(post.ID), "a disabled plugin delivers nothing")
}
