package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The public read cache (#185) against the test database (skipped without one): every
// path that changes what the site shows purges it after its commit, so the next read is
// a miss with the new content; drafts are never served, cached or not.

// publicListPath is a cached list a new published post appears in (newest first).
const publicListPath = "/public/posts?type=post&limit=100"

// cachedListIDs reads publicListPath anonymously: the post ids and X-Cache.
func cachedListIDs(t *testing.T, server *Server) ([]int64, string) {
	t.Helper()
	recorder := cacheGet(t, server, publicListPath)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var body struct {
		Posts []struct {
			ID int64 `json:"id"`
		} `json:"posts"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	ids := make([]int64, 0, len(body.Posts))
	for _, p := range body.Posts {
		ids = append(ids, p.ID)
	}
	return ids, recorder.Header().Get(publicCacheHeader)
}

// primeList reads the list twice and checks the second read came from the cache.
func primeList(t *testing.T, server *Server) []int64 {
	t.Helper()
	cachedListIDs(t, server)
	ids, result := cachedListIDs(t, server)
	require.Equal(t, "HIT", result, "the list is cached before the write")
	return ids
}

// afterWrite reads the list once more: it must be a miss (the write purged) and the
// post must be listed or not.
func afterWrite(t *testing.T, server *Server, postID int64, listed bool, what string) {
	t.Helper()
	ids, result := cachedListIDs(t, server)
	require.Equal(t, "MISS", result, "%s didn't purge the public cache", what)
	require.Equal(t, listed, containsID(ids, postID), "%s: post %d listed = %v", what, postID, !listed)
}

func containsID(ids []int64, id int64) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

func publicCacheDBServer(t *testing.T) (*sql.DB, db.Store, *Server) {
	t.Helper()
	conn, store := scheduleTestDB(t)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	withMiniredis(t, server)
	return conn, store, server
}

func TestPublicCachePurgedByEveryPublishPath(t *testing.T) {
	conn, store, server := publicCacheDBServer(t)
	editor := scheduleUser(t, store, RoleEditor)
	ctx := context.Background()

	call := func(method, path string, body any) {
		t.Helper()
		recorder := trashCall(t, server, &editor, method, path, body)
		require.Less(t, recorder.Code, 300, "%s %s: %s", method, path, recorder.Body.String())
	}

	t.Run("publish button", func(t *testing.T) {
		post := scheduleDraft(t, store, editor, scheduleWord())
		require.False(t, containsID(primeList(t, server), post.ID))
		call(http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", post.ID), nil)
		afterWrite(t, server, post.ID, true, "publish")

		// Update (publish again) purges too.
		primeList(t, server)
		call(http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", post.ID), nil)
		afterWrite(t, server, post.ID, true, "update")

		primeList(t, server)
		call(http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/unpublish", post.ID), nil)
		afterWrite(t, server, post.ID, false, "unpublish")
	})

	t.Run("bulk publish, trash, restore, delete", func(t *testing.T) {
		post := scheduleDraft(t, store, editor, scheduleWord())
		bulk := func(action string) {
			t.Helper()
			recorder := trashCall(t, server, &editor, http.MethodPost, "/api/v1/posts/bulk", map[string]any{"action": action, "ids": []int64{post.ID}})
			require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
			require.Contains(t, recorder.Body.String(), `"succeeded":1`, recorder.Body.String())
		}
		primeList(t, server)
		bulk("publish")
		afterWrite(t, server, post.ID, true, "bulk publish")
		primeList(t, server)
		bulk("trash")
		afterWrite(t, server, post.ID, false, "bulk trash")
		primeList(t, server)
		bulk("restore")
		afterWrite(t, server, post.ID, true, "bulk restore")
		bulk("trash")
		primeList(t, server)
		bulk("delete")
		afterWrite(t, server, post.ID, false, "bulk delete")
	})

	t.Run("single trash, restore, permanent delete", func(t *testing.T) {
		post := publishForTest(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor)
		server.purgePublicCache(ctx, slog.Default(), "test") // published behind the API's back
		primeList(t, server)
		call(http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d", post.ID), nil)
		afterWrite(t, server, post.ID, false, "trash")
		primeList(t, server)
		call(http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/restore", post.ID), nil)
		afterWrite(t, server, post.ID, true, "restore")
		call(http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d", post.ID), nil)
		primeList(t, server)
		call(http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d/permanent", post.ID), nil)
		afterWrite(t, server, post.ID, false, "permanent delete")
	})

	t.Run("post_status through PUT and POST", func(t *testing.T) {
		post := scheduleDraft(t, store, editor, scheduleWord())
		primeList(t, server)
		call(http.MethodPut, fmt.Sprintf("/api/v1/posts/%d", post.ID), map[string]any{"post_status": "published"})
		afterWrite(t, server, post.ID, true, "PUT post_status")

		primeList(t, server)
		slug := "cache-" + strings.ReplaceAll(uuid.NewString(), "-", "")
		recorder := trashCall(t, server, &editor, http.MethodPost, "/api/v1/posts", map[string]any{
			"title": "Cache " + scheduleWord(), "url": "https://example.test/" + slug, "slug": slug,
			"post_type": "post", "post_status": "published", "author_ids": []int64{editor.ID},
		})
		require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
		var created struct {
			Post struct {
				ID int64 `json:"id"`
			} `json:"post"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &created))
		require.NotZero(t, created.Post.ID)
		afterWrite(t, server, created.Post.ID, true, "POST published")
	})

	t.Run("scheduler publish and scheduled update", func(t *testing.T) {
		due := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(-time.Minute))
		primeList(t, server)
		require.True(t, server.publishScheduledPost(ctx, claimFor(t, store, due.ID)))
		afterWrite(t, server, due.ID, true, "scheduled publish")

		post := publishedPost(t, store, editor)
		word := scheduleWord()
		editWorkingCopy(t, conn, post.ID, word)
		scheduleUpdateAt(t, store, post.ID, editor, time.Now().Add(-time.Minute))
		server.purgePublicCache(ctx, slog.Default(), "test")
		before := cacheGet(t, server, fmt.Sprintf("/public/posts/%d", post.ID))
		require.NotContains(t, before.Body.String(), word)
		require.Equal(t, "HIT", cacheGet(t, server, fmt.Sprintf("/public/posts/%d", post.ID)).Header().Get(publicCacheHeader))
		require.True(t, server.applyScheduledUpdate(ctx, claimUpdateFor(t, store, post.ID)))
		after := cacheGet(t, server, fmt.Sprintf("/public/posts/%d", post.ID))
		require.Equal(t, "MISS", after.Header().Get(publicCacheHeader))
		require.Contains(t, after.Body.String(), word, "the update is live at once")
	})
}

// Site settings and menus purge too; a refused write (4xx) doesn't.
func TestPublicCachePurgedBySettingsAndMenus(t *testing.T) {
	_, store, server := publicCacheDBServer(t)
	admin := scheduleUser(t, store, RoleAdmin)
	editor := scheduleUser(t, store, RoleEditor)
	ctx := context.Background()

	settings, err := store.GetSettings(ctx)
	require.NoError(t, err)
	primeList(t, server)
	// The same tagline: a real save (2xx) without changing the shared database.
	recorder := trashCall(t, server, &admin, http.MethodPut, "/api/v1/settings", map[string]any{"site_tagline": settings.SiteTagline})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	_, result := cachedListIDs(t, server)
	require.Equal(t, "MISS", result, "a settings save purges")

	primeList(t, server)
	recorder = trashCall(t, server, &editor, http.MethodPut, "/api/v1/settings", map[string]any{"site_tagline": "x"})
	require.Equal(t, http.StatusForbidden, recorder.Code)
	_, result = cachedListIDs(t, server)
	require.Equal(t, "HIT", result, "a refused write purges nothing")

	location := "cache" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	menu, err := store.SaveMenuTx(ctx, db.SaveMenuTxParams{Name: "Cache test", Location: sql.NullString{String: location, Valid: true}})
	require.NoError(t, err)
	server.purgePublicCache(ctx, slog.Default(), "test")
	require.Equal(t, http.StatusOK, cacheGet(t, server, "/public/menus/"+location).Code)
	require.Equal(t, "HIT", cacheGet(t, server, "/public/menus/"+location).Header().Get(publicCacheHeader))
	recorder = trashCall(t, server, &editor, http.MethodPut, fmt.Sprintf("/api/v1/menus/%d", menu.ID), map[string]any{"name": "Cache renamed", "location": location})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	renamed := cacheGet(t, server, "/public/menus/"+location)
	require.Equal(t, http.StatusOK, renamed.Code)
	require.Equal(t, "MISS", renamed.Header().Get(publicCacheHeader), "a menu save purges")
	require.Contains(t, renamed.Body.String(), "Cache renamed")
}

// A draft is never served from the public routes, cached or not, and the admin's read of
// it (signed in, the working copy) is never cached.
func TestPublicCacheNeverHoldsDrafts(t *testing.T) {
	_, store, server := publicCacheDBServer(t)
	editor := scheduleUser(t, store, RoleEditor)
	word := scheduleWord()
	draft := scheduleDraft(t, store, editor, word)

	for i := 0; i < 2; i++ {
		recorder := cacheGet(t, server, fmt.Sprintf("/public/posts/%d", draft.ID))
		require.Equal(t, http.StatusNotFound, recorder.Code)
		require.Equal(t, "MISS", recorder.Header().Get(publicCacheHeader), "a 404 for a post is never stored")
		recorder = cacheGet(t, server, "/public/posts/slug/"+draft.Slug)
		require.Equal(t, http.StatusNotFound, recorder.Code)
	}
	ids, _ := cachedListIDs(t, server)
	require.False(t, containsID(ids, draft.ID))

	for i := 0; i < 2; i++ {
		recorder := trashCall(t, server, &editor, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d", draft.ID), nil)
		require.Equal(t, http.StatusOK, recorder.Code)
		require.Contains(t, recorder.Body.String(), word)
		require.Empty(t, recorder.Header().Get(publicCacheHeader), "the admin's working copy never touches the cache")
	}
}

// A purge that fails (Valkey down) never fails the write.
func TestPublicCachePurgeFailureDoesNotFailTheWrite(t *testing.T) {
	_, store, server := publicCacheDBServer(t)
	editor := scheduleUser(t, store, RoleEditor)
	mr := withMiniredis(t, server)
	mr.Close()

	post := scheduleDraft(t, store, editor, scheduleWord())
	recorder := trashCall(t, server, &editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", post.ID), nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Equal(t, postStatusPublished, reloadPost(t, store, post.ID).PostStatus)
	ids, result := cachedListIDs(t, server)
	require.Equal(t, "BYPASS", result)
	require.True(t, containsID(ids, post.ID))
}

// Saving a draft's fields (the editor's debounced title saves) changes nothing public and
// doesn't purge; the same save on a published post, or a status change, does.
func TestPublicCacheDraftSavesDoNotPurge(t *testing.T) {
	_, store, server := publicCacheDBServer(t)
	editor := scheduleUser(t, store, RoleEditor)
	draft := scheduleDraft(t, store, editor, scheduleWord())
	save := func(id int64, body map[string]any) {
		t.Helper()
		recorder := trashCall(t, server, &editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d", id), body)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	}

	primeList(t, server)
	save(draft.ID, map[string]any{"title": "Draft " + scheduleWord()})
	recorder := trashCall(t, server, &editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/meta", draft.ID), map[string]any{"meta_key": "cache_test", "meta_value": "x"})
	require.Less(t, recorder.Code, 300, recorder.Body.String())
	_, result := cachedListIDs(t, server)
	require.Equal(t, "HIT", result, "a draft's saves leave the public cache alone")

	save(draft.ID, map[string]any{"post_status": "published"})
	afterWrite(t, server, draft.ID, true, "draft published through PUT")

	primeList(t, server)
	save(draft.ID, map[string]any{"title": "Live " + scheduleWord()})
	_, result = cachedListIDs(t, server)
	require.Equal(t, "MISS", result, "a published post's save purges")

	primeList(t, server)
	save(draft.ID, map[string]any{"post_status": "draft"})
	afterWrite(t, server, draft.ID, false, "unpublished through PUT")
}
