package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/pluginsdk"
)

// Publish guards (#459) against the test database (skipped without one): every path
// that publishes asks them before its transaction, and a denial publishes nothing.
//
// The database is shared: each test enables its own guard plugin (disabled again when
// it ends) and its server's registry holds only that plugin's code, so no other
// test's publish runs it.

// dbGuard is a guard plugin's code for a test: it records what it was asked, checks
// that it runs outside any lock on the post, and answers with decide (nil: allow).
type dbGuard struct {
	conn *sql.DB

	mu         sync.Mutex
	candidates []pluginsdk.PublishCandidate
	locked     []bool
	decide     func(pluginsdk.PublishCandidate) (pluginsdk.Decision, error)
}

func (g *dbGuard) guard(ctx context.Context, _ pluginsdk.Host, c pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
	locked := false
	if c.PostID != 0 {
		// 7.3: no plugin code under the publish's row lock. NOWAIT fails at once if a
		// transaction (PublishPostTx's LockPostForPublish) holds the row.
		tx, err := g.conn.BeginTx(ctx, nil)
		if err == nil {
			_, err = tx.ExecContext(ctx, `SELECT id FROM posts WHERE id = $1 FOR UPDATE NOWAIT`, c.PostID)
			locked = err != nil
			_ = tx.Rollback()
		}
	}
	g.mu.Lock()
	g.candidates = append(g.candidates, c)
	g.locked = append(g.locked, locked)
	decide := g.decide
	g.mu.Unlock()
	if decide == nil {
		return pluginsdk.Allow(), nil
	}
	return decide(c)
}

// asked lists what the guard was asked about postID, in order, and fails the test
// if it was asked while the post's row was locked.
func (g *dbGuard) asked(t *testing.T, postID int64) []pluginsdk.PublishCandidate {
	t.Helper()
	g.mu.Lock()
	defer g.mu.Unlock()
	out := []pluginsdk.PublishCandidate{}
	for i, c := range g.candidates {
		if c.PostID == postID {
			out = append(out, c)
			require.False(t, g.locked[i], "the guard ran while post %d was locked", postID)
		}
	}
	return out
}

func (g *dbGuard) setDecide(decide func(pluginsdk.PublishCandidate) (pluginsdk.Decision, error)) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.decide = decide
}

// denyPosts refuses the given posts with reason, and allows the rest.
func denyPosts(reason string, ids ...int64) func(pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
	return func(c pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
		for _, id := range ids {
			if c.PostID == id {
				return pluginsdk.Deny(reason), nil
			}
		}
		return pluginsdk.Allow(), nil
	}
}

// enableGuardPlugin inserts and enables a plugin whose plugin.json declares a guard,
// and returns its slug.
func enableGuardPlugin(t *testing.T, store db.Store, onError string) string {
	t.Helper()
	ctx := context.Background()
	slug := pluginDBSlug("guard")
	hook := map[string]any{"event": pluginGuardEvent}
	if onError != "" {
		hook["on_error"] = onError
	}
	raw, err := json.Marshal(map[string]any{
		"manifest_version": 1, "id": slug, "name": "Guard " + slug, "version": "1.0.0", "plugin_api": 1,
		"server": map[string]any{"hooks": []any{hook}},
	})
	require.NoError(t, err)
	_, err = store.InsertDiscoveredPlugin(ctx, db.InsertDiscoveredPluginParams{
		Slug: slug, Name: "Guard " + slug, Version: "1.0.0", Manifest: raw,
		ContentHash: strings.Repeat("b", 64), Status: PluginStatusInstalled,
	})
	require.NoError(t, err)
	_, err = store.EnablePlugin(ctx, db.EnablePluginParams{Slug: slug})
	require.NoError(t, err)
	t.Cleanup(func() { _, _ = store.DisablePlugin(context.Background(), slug) })
	return slug
}

// guardDBServer is a scheduling-capable server whose registry holds one guard plugin.
func guardDBServer(t *testing.T, conn *sql.DB, store db.Store, onError string) (*Server, *dbGuard, string) {
	t.Helper()
	slug := enableGuardPlugin(t, store, onError)
	guard := &dbGuard{conn: conn}
	server := scheduleServer(t, store, newStubCollab(t, 0))
	server.pluginRegistry = pluginHookRegistry{slug: {BeforePublish: guard.guard}}
	return server, guard, slug
}

func requireRefused(t *testing.T, recorder *httptest.ResponseRecorder, reason string) {
	t.Helper()
	requireStatus(t, recorder, http.StatusConflict)
	var rsp struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	require.Equal(t, codePluginRefused, rsp.Code)
	require.Equal(t, reason, rsp.Error)
}

func getPostResponse(t *testing.T, server *Server, caller db.User, id int64) PostResponse {
	t.Helper()
	recorder := as(t, server, caller, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d", id), nil)
	requireStatus(t, recorder, http.StatusOK)
	var body struct {
		Post PostResponse `json:"post"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	return body.Post
}

// TestPublishGuardsEveryPath: each way a post gets published asks the guards first,
// outside the transaction; a denial publishes nothing and says why.
func TestPublishGuardsEveryPath(t *testing.T) {
	conn, store := scheduleTestDB(t)
	server, guard, slug := guardDBServer(t, conn, store, "")
	editor := scheduleUser(t, store, RoleEditor)
	ctx := context.Background()
	const reason = "Add alt text to every image."

	t.Run("publish button", func(t *testing.T) {
		post := scheduleDraft(t, store, editor, scheduleWord())
		guard.setDecide(denyPosts(reason, post.ID))
		path := fmt.Sprintf("/api/v1/posts/%d/publish", post.ID)
		recorder := as(t, server, editor, http.MethodPost, path, nil)
		requireRefused(t, recorder, reason)
		require.Equal(t, "draft", reloadPost(t, store, post.ID).PostStatus)
		require.Equal(t, 0, versionCount(t, conn, post.ID))

		asked := guard.asked(t, post.ID)
		require.Len(t, asked, 1)
		require.Equal(t, pluginsdk.PublishViaButton, asked[0].Via)
		require.Equal(t, editor.ID, asked[0].ActorID)
		require.Equal(t, "post", asked[0].PostType)
		require.JSONEq(t, string(post.BlockDoc), string(asked[0].BlockDoc), "the working copy the flush stored")

		// Allowed: published as usual.
		guard.setDecide(nil)
		requireStatus(t, as(t, server, editor, http.MethodPost, path, nil), http.StatusOK)
		require.Equal(t, "published", reloadPost(t, store, post.ID).PostStatus)
		require.Len(t, guard.asked(t, post.ID), 2)
	})

	t.Run("bulk", func(t *testing.T) {
		refused := scheduleDraft(t, store, editor, scheduleWord())
		allowed := scheduleDraft(t, store, editor, scheduleWord())
		guard.setDecide(denyPosts(reason, refused.ID))
		answer := bulkCall(t, server, &editor, "publish", refused.ID, allowed.ID)
		require.Equal(t, 1, answer.Succeeded)
		require.Equal(t, 1, answer.Failed)
		require.Equal(t, refused.ID, answer.Results[0].ID)
		require.False(t, answer.Results[0].OK)
		require.Equal(t, http.StatusConflict, answer.Results[0].Status)
		require.Equal(t, codePluginRefused, answer.Results[0].Code)
		require.Equal(t, reason, answer.Results[0].Error)
		require.True(t, answer.Results[1].OK)
		require.Equal(t, "draft", reloadPost(t, store, refused.ID).PostStatus)
		require.Equal(t, "published", reloadPost(t, store, allowed.ID).PostStatus)
		require.Len(t, guard.asked(t, refused.ID), 1)
		require.Len(t, guard.asked(t, allowed.ID), 1)
	})

	t.Run("scheduler", func(t *testing.T) {
		post := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(-time.Minute))
		guard.setDecide(denyPosts(reason, post.ID))
		require.False(t, server.publishScheduledPost(ctx, claimFor(t, store, post.ID)))
		require.Equal(t, "scheduled", reloadPost(t, store, post.ID).PostStatus)
		require.Equal(t, 0, versionCount(t, conn, post.ID))
		asked := guard.asked(t, post.ID)
		require.Len(t, asked, 1)
		require.Equal(t, pluginsdk.PublishViaSchedule, asked[0].Via)
		require.Equal(t, editor.ID, asked[0].ActorID, "who scheduled it")

		// The editor sees why: schedule_failure, retried with the backoff.
		failure := getPostResponse(t, server, editor, post.ID).ScheduleFailure
		require.NotNil(t, failure)
		require.Equal(t, codePluginRefused, failure.Reason)
		require.Equal(t, int32(1), failure.Attempts)
		require.NotNil(t, failure.NextAttemptAt)
		require.True(t, failure.NextAttemptAt.After(time.Now()))

		// Once the guard allows it, the next attempt publishes.
		guard.setDecide(nil)
		_, err := conn.Exec(`UPDATE posts SET publish_next_attempt_at = now() - interval '1 second' WHERE id = $1`, post.ID)
		require.NoError(t, err)
		require.True(t, server.publishScheduledPost(ctx, claimFor(t, store, post.ID)))
		require.Equal(t, "published", reloadPost(t, store, post.ID).PostStatus)
	})

	t.Run("scheduled update", func(t *testing.T) {
		post := publishedPost(t, store, editor)
		liveBefore := publishedBody(t, store, post.ID)
		frozen, later := scheduleWord(), scheduleWord()
		editWorkingCopy(t, conn, post.ID, frozen)
		scheduleUpdateAt(t, store, post.ID, editor, time.Now().Add(-time.Minute))
		editWorkingCopy(t, conn, post.ID, later)

		guard.setDecide(denyPosts(reason, post.ID))
		require.False(t, server.applyScheduledUpdate(ctx, claimUpdateFor(t, store, post.ID)))
		require.Equal(t, liveBefore, publishedBody(t, store, post.ID))
		require.Equal(t, 1, versionCount(t, conn, post.ID))
		asked := guard.asked(t, post.ID)
		require.Len(t, asked, 1)
		require.Equal(t, pluginsdk.PublishViaScheduledUpdate, asked[0].Via)
		require.Contains(t, string(asked[0].BlockDoc), frozen, "the frozen snapshot")
		require.NotContains(t, string(asked[0].BlockDoc), later, "never the working copy")
		require.Equal(t, editor.ID, asked[0].ActorID)

		update := getPostResponse(t, server, editor, post.ID).ScheduledUpdate
		require.NotNil(t, update)
		require.NotNil(t, update.Failure)
		require.Equal(t, codePluginRefused, update.Failure.Reason)

		guard.setDecide(nil)
		_, err := conn.Exec(`UPDATE post_scheduled_updates SET next_attempt_at = now() - interval '1 second' WHERE post_id = $1`, post.ID)
		require.NoError(t, err)
		require.True(t, server.applyScheduledUpdate(ctx, claimUpdateFor(t, store, post.ID)))
		require.Contains(t, publishedBody(t, store, post.ID), frozen)
	})

	t.Run("post_status through PUT", func(t *testing.T) {
		post := scheduleDraft(t, store, editor, scheduleWord())
		guard.setDecide(denyPosts(reason, post.ID))
		path := fmt.Sprintf("/api/v1/posts/%d", post.ID)
		recorder := as(t, server, editor, http.MethodPut, path, gin.H{"post_status": "published", "title": "Not saved"})
		requireRefused(t, recorder, reason)
		reloaded := reloadPost(t, store, post.ID)
		require.Equal(t, "draft", reloaded.PostStatus)
		require.NotEqual(t, "Not saved", reloaded.Title, "nothing in the request is written")
		asked := guard.asked(t, post.ID)
		require.Len(t, asked, 1)
		require.Equal(t, pluginsdk.PublishViaStatus, asked[0].Via)
		require.JSONEq(t, string(emptyBlockDoc), string(asked[0].BlockDoc), "never published: it goes live empty")

		// Allowed; then saving it again as published isn't a publish and isn't asked.
		guard.setDecide(nil)
		requireStatus(t, as(t, server, editor, http.MethodPut, path, gin.H{"post_status": "published"}), http.StatusOK)
		requireStatus(t, as(t, server, editor, http.MethodPut, path, gin.H{"post_status": "published", "title": "Again"}), http.StatusOK)
		requireStatus(t, as(t, server, editor, http.MethodPut, path, gin.H{"title": "And again"}), http.StatusOK)
		require.Len(t, guard.asked(t, post.ID), 2)

		// A post published before and back to draft goes live with its published body.
		live := publishedPost(t, store, editor)
		_, err := store.UnpublishPost(ctx, live.ID)
		require.NoError(t, err)
		requireStatus(t, as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d", live.ID), gin.H{"post_status": "published"}), http.StatusOK)
		asked = guard.asked(t, live.ID)
		require.Len(t, asked, 1)
		if body := reloadPost(t, store, live.ID).PublishedBlockDoc; body.Valid {
			require.JSONEq(t, string(body.RawMessage), string(asked[0].BlockDoc))
		}
	})

	t.Run("post_status through POST", func(t *testing.T) {
		word := scheduleWord()
		create := gin.H{
			"title": "Guarded " + word, "url": "https://example.test/" + word, "author_ids": []int64{editor.ID},
			"post_status": "published", "post_type": "page",
		}
		guard.setDecide(func(c pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
			if c.PostID == 0 && c.Via == pluginsdk.PublishViaStatus {
				return pluginsdk.Deny(reason), nil
			}
			return pluginsdk.Allow(), nil
		})
		recorder := as(t, server, editor, http.MethodPost, "/api/v1/posts", create)
		requireRefused(t, recorder, reason)
		var n int
		require.NoError(t, conn.QueryRow(`SELECT count(*) FROM posts WHERE title = $1`, "Guarded "+word).Scan(&n))
		require.Zero(t, n, "nothing created")
		asked := guard.asked(t, 0)
		require.NotEmpty(t, asked)
		require.Equal(t, "page", asked[len(asked)-1].PostType)
		require.Equal(t, editor.ID, asked[len(asked)-1].ActorID)

		// A draft isn't a publish: not asked.
		before := len(guard.asked(t, 0))
		create["post_status"] = "draft"
		requireStatus(t, as(t, server, editor, http.MethodPost, "/api/v1/posts", create), http.StatusCreated)
		require.Len(t, guard.asked(t, 0), before)

		guard.setDecide(nil)
		create["post_status"] = "published"
		create["title"] = "Guarded again " + word
		create["url"] = "https://example.test/again-" + word
		requireStatus(t, as(t, server, editor, http.MethodPost, "/api/v1/posts", create), http.StatusCreated)
	})

	t.Run("only enabled plugins", func(t *testing.T) {
		_, err := store.DisablePlugin(ctx, slug)
		require.NoError(t, err)
		t.Cleanup(func() {
			_, err := store.EnablePlugin(context.Background(), db.EnablePluginParams{Slug: slug})
			require.NoError(t, err)
		})
		post := scheduleDraft(t, store, editor, scheduleWord())
		guard.setDecide(denyPosts(reason, post.ID))
		requireStatus(t, as(t, server, editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", post.ID), nil), http.StatusOK)
		require.Empty(t, guard.asked(t, post.ID))
	})
}

// TestPublishGuardOnError: a guard that fails lets the publish through by default, and
// refuses it when its plugin.json says on_error "deny"; either way on every path.
func TestPublishGuardOnError(t *testing.T) {
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	failing := func(pluginsdk.PublishCandidate) (pluginsdk.Decision, error) {
		return pluginsdk.Decision{}, fmt.Errorf("the checker is down")
	}

	t.Run("allow", func(t *testing.T) {
		server, guard, _ := guardDBServer(t, conn, store, "allow")
		guard.setDecide(failing)
		post := scheduleDraft(t, store, editor, scheduleWord())
		requireStatus(t, as(t, server, editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", post.ID), nil), http.StatusOK)
		require.Len(t, guard.asked(t, post.ID), 1)
	})

	t.Run("deny", func(t *testing.T) {
		server, guard, slug := guardDBServer(t, conn, store, "deny")
		guard.setDecide(failing)
		post := scheduleDraft(t, store, editor, scheduleWord())
		recorder := as(t, server, editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", post.ID), nil)
		requireRefused(t, recorder, "Guard "+slug+" couldn't check this post, so it wasn't published. Try again.")
		require.Equal(t, "draft", reloadPost(t, store, post.ID).PostStatus)

		scheduled := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(-time.Minute))
		require.False(t, server.publishScheduledPost(context.Background(), claimFor(t, store, scheduled.ID)))
		require.Equal(t, codePluginRefused, reloadPost(t, store, scheduled.ID).PublishError.String)
	})
}
