package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"

	"github.com/go-live-cms/go-live-cms/cache"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The purges of section 10 (#523, discussion_purge.go) against #185's store (miniredis)
// and the test database: each event that changes what readers see makes the next thread
// read a miss with the change; the ones readers can't see (a pending POST, a confirmation
// still waiting) leave the cached answer alone; and the purge runs after the commit.

// cachedComments is a commentsFixture whose server caches in miniredis.
type cachedComments struct {
	commentsFixture
	mr *miniredis.Miniredis
}

func newCachedComments(t *testing.T) cachedComments {
	t.Helper()
	f := newCommentsFixture(t)
	return cachedComments{commentsFixture: f, mr: withMiniredis(t, f.server)}
}

// prime reads path twice: the second read is a hit.
func (f cachedComments) prime(t *testing.T, path string) {
	t.Helper()
	f.read(t, path)
	recorder := f.read(t, path)
	require.Equal(t, "HIT", recorder.Header().Get(publicCacheHeader), "%s is cached before the write: %s", path, recorder.Body.String())
}

// next reads path once more: X-Cache and the body.
func (f cachedComments) next(t *testing.T, path string) (string, string) {
	t.Helper()
	recorder := f.read(t, path)
	return recorder.Header().Get(publicCacheHeader), recorder.Body.String()
}

// Every comment event of section 10: the purge after it shows the change; the events
// readers can't see don't purge.
func TestDiscussionEventsPurge(t *testing.T) {
	f := newCachedComments(t)
	ctx := context.Background()
	log := slog.Default()
	post := f.publishedPost(t)
	path := commentsPath(post, "")
	ana := f.commenter(t)

	// A POST that waits for its confirmation, then one held for moderation (#524's
	// outcomes): nothing a reader sees, no purge.
	f.prime(t, path)
	unconfirmed := f.says(t, post, ana, nil, db.ReaderCommentUnconfirmed, marker("unconfirmed"))
	require.False(t, f.server.purgeDiscussion(ctx, log, post.ID, discussionStatusEvent("", db.ReaderCommentUnconfirmed)))
	pending := f.says(t, post, ana, nil, db.ReaderCommentPending, marker("pending"))
	require.False(t, f.server.purgeDiscussion(ctx, log, post.ID, discussionStatusEvent("", db.ReaderCommentPending)))
	// A confirm that leaves it pending.
	_, err := f.conn.Exec(`UPDATE reader_comments SET status = 'pending', confirm_token_hash = NULL WHERE id = $1`, unconfirmed.ID)
	require.NoError(t, err)
	require.False(t, f.server.purgeDiscussion(ctx, log, post.ID, discussionStatusEvent(db.ReaderCommentUnconfirmed, db.ReaderCommentPending)))
	// A pending comment marked spam.
	_, err = f.conn.Exec(`UPDATE reader_comments SET status = 'spam' WHERE id = $1`, unconfirmed.ID)
	require.NoError(t, err)
	require.False(t, f.server.purgeDiscussion(ctx, log, post.ID, discussionStatusEvent(db.ReaderCommentPending, db.ReaderCommentSpam)))
	result, body := f.next(t, path)
	require.Equal(t, "HIT", result, "a pending-only write doesn't purge")
	require.NotContains(t, body, pending.Body)

	steps := []struct {
		name  string
		write func()
		event discussionEvent
		check func(body string)
	}{
		{"approve (published)", func() {
			_, err := f.conn.Exec(`UPDATE reader_comments SET status = 'approved', approved_at = now() WHERE id = $1`, pending.ID)
			require.NoError(t, err)
		}, discussionStatusEvent(db.ReaderCommentPending, db.ReaderCommentApproved), func(body string) {
			require.Contains(t, body, pending.Body)
		}},
		{"edit (a member's)", func() {
			_, err := f.conn.Exec(`UPDATE reader_comments SET body = 'Edited text', edited_at = now() WHERE id = $1`, pending.ID)
			require.NoError(t, err)
		}, discussionEventEdited, func(body string) {
			require.Contains(t, body, "Edited text")
			require.Contains(t, body, `"edited":true`)
		}},
		{"trash (hidden)", func() {
			_, err := f.store.TrashReaderComment(ctx, db.TrashReaderCommentParams{ID: pending.ID})
			require.NoError(t, err)
		}, discussionStatusEvent(db.ReaderCommentApproved, db.ReaderCommentTrash), func(body string) {
			require.NotContains(t, body, "Edited text")
		}},
		{"restore (published)", func() {
			_, err := f.store.RestoreReaderComment(ctx, db.RestoreReaderCommentParams{ID: pending.ID})
			require.NoError(t, err)
		}, discussionStatusEvent(db.ReaderCommentTrash, db.ReaderCommentApproved), func(body string) {
			require.Contains(t, body, "Edited text")
		}},
		{"delete (removed)", func() {
			_, err := f.store.DeleteReaderCommentTx(ctx, pending.ID)
			require.NoError(t, err)
		}, discussionEventRemoved, func(body string) {
			require.NotContains(t, body, "Edited text")
		}},
		{"a member's comment, bulk (one purge for several posts)", func() {
			f.byMember(t, post, f.editor, "Staff says hello")
		}, discussionEventBulkModerated, func(body string) {
			require.Contains(t, body, "Staff says hello")
		}},
	}
	for _, step := range steps {
		f.prime(t, path)
		step.write()
		postID := post.ID
		if step.event == discussionEventBulkModerated {
			postID = 0
		}
		require.True(t, f.server.purgeDiscussion(ctx, log, postID, step.event), step.name)
		result, body := f.next(t, path)
		require.Equal(t, "MISS", result, "%s purges", step.name)
		step.check(body)
	}

	// A tombstone: the root goes, its approved reply keeps it as a placeholder.
	root := f.says(t, post, ana, nil, db.ReaderCommentApproved, marker("root to delete"))
	f.says(t, post, ana, &root, db.ReaderCommentApproved, marker("its reply"))
	require.True(t, f.server.purgeDiscussion(ctx, log, post.ID, discussionEventPublished))
	f.prime(t, path)
	deleted, err := f.store.DeleteReaderCommentTx(ctx, root.ID)
	require.NoError(t, err)
	require.True(t, deleted.Tombstoned)
	require.True(t, f.server.purgeDiscussion(ctx, log, post.ID, discussionEventRemoved))
	result, body = f.next(t, path)
	require.Equal(t, "MISS", result, "a tombstone purges")
	require.NotContains(t, body, root.Body)
	require.Contains(t, body, `"removed":true`)

	// A comment on a post the site doesn't show changes nothing public.
	draft := scheduleDraft(t, f.store, f.editor, scheduleWord())
	f.prime(t, path)
	f.says(t, draft, ana, nil, db.ReaderCommentApproved, marker("on a draft"))
	require.False(t, f.server.purgeDiscussion(ctx, log, draft.ID, discussionEventPublished))
	result, _ = f.next(t, path)
	require.Equal(t, "HIT", result)
}

// The route events: the post's Discussion choice (published posts only), a Settings ›
// Discussion save, and the events that take a post off the site (unpublish, trash),
// which cover its thread.
func TestDiscussionRoutesPurgeTheThread(t *testing.T) {
	f := newCachedComments(t)
	post := f.publishedPost(t)
	path := commentsPath(post, "")
	postPath := fmt.Sprintf("/public/posts/%d", post.ID)
	ana := f.commenter(t)
	comment := f.says(t, post, ana, nil, db.ReaderCommentApproved, marker("shown"))

	f.prime(t, path)
	f.prime(t, postPath)
	recorder := trashCall(t, f.server, &f.editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/discussion", post.ID), map[string]any{"discussion": "closed"})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	result, body := f.next(t, path)
	require.Equal(t, "MISS", result, "a published post's Discussion choice purges")
	require.Contains(t, body, `"state":"closed"`)
	result, body = f.next(t, postPath)
	require.Equal(t, "MISS", result)
	require.Contains(t, body, `"state":"closed"`)

	// A draft's choice changes nothing public.
	draft := scheduleDraft(t, f.store, f.editor, scheduleWord())
	f.prime(t, path)
	recorder = trashCall(t, f.server, &f.editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/discussion", draft.ID), map[string]any{"discussion": "off"})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	result, _ = f.next(t, path)
	require.Equal(t, "HIT", result, "a draft's choice doesn't purge")

	// Settings › Discussion.
	f.prime(t, path)
	f.settings(t, map[string]any{"comments_order": "newest"})
	result, _ = f.next(t, path)
	require.Equal(t, "MISS", result, "a Settings › Discussion save purges")
	f.prime(t, path)
	f.settings(t, map[string]any{"comments_enabled": false})
	result, body = f.next(t, path)
	require.Equal(t, "MISS", result)
	require.Contains(t, body, `"state":"off"`)
	require.NotContains(t, body, comment.Body)
	f.settings(t, map[string]any{"comments_enabled": true})

	// Unpublish and trash: the thread goes with the post.
	f.prime(t, path)
	recorder = trashCall(t, f.server, &f.editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/unpublish", post.ID), nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Equal(t, http.StatusNotFound, f.read(t, path).Code, "unpublished: no thread")

	other := f.publishedPost(t)
	otherPath := commentsPath(other, "")
	f.says(t, other, ana, nil, db.ReaderCommentApproved, marker("on the other post"))
	f.server.purgePublicCache(context.Background(), slog.Default(), "test")
	f.prime(t, otherPath)
	recorder = trashCall(t, f.server, &f.editor, http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d", other.ID), nil)
	require.Less(t, recorder.Code, 300, recorder.Body.String())
	require.Equal(t, http.StatusNotFound, f.read(t, otherPath).Code, "trashed: no thread")
}

// No purge runs inside a transaction: when the cache's generation moves, the write is
// already visible from another connection, for the route purge and for purgeDiscussion.
func TestDiscussionPurgeRunsAfterCommit(t *testing.T) {
	f := newCachedComments(t)
	ctx := context.Background()
	post := f.publishedPost(t)
	ana := f.commenter(t)

	var mu sync.Mutex
	var check func() bool
	var seen []bool
	client := redis.NewClient(&redis.Options{Addr: f.mr.Addr(), DialerRetries: 1})
	t.Cleanup(func() { _ = client.Close() })
	f.server.SetCache(purgeWatch{Cache: cache.NewRedisFromClient(client), check: func() {
		mu.Lock()
		defer mu.Unlock()
		if check != nil {
			seen = append(seen, check())
		}
	}})
	f.read(t, commentsPath(post, "")) // the generation exists

	visible := func(query string, args ...any) func() bool {
		return func() bool {
			var n int
			require.NoError(t, f.conn.QueryRow(query, args...).Scan(&n))
			return n == 1
		}
	}
	mu.Lock()
	check = visible(`SELECT count(*) FROM posts WHERE id = $1 AND discussion = 'closed'`, post.ID)
	mu.Unlock()
	recorder := trashCall(t, f.server, &f.editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/discussion", post.ID), map[string]any{"discussion": "closed"})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

	root := f.says(t, post, ana, nil, db.ReaderCommentApproved, marker("root"))
	f.says(t, post, ana, &root, db.ReaderCommentApproved, marker("reply"))
	mu.Lock()
	check = visible(`SELECT count(*) FROM reader_comments WHERE id = $1 AND removed_at IS NOT NULL`, root.ID)
	mu.Unlock()
	_, err := f.store.DeleteReaderCommentTx(ctx, root.ID)
	require.NoError(t, err)
	require.True(t, f.server.purgeDiscussion(ctx, slog.Default(), post.ID, discussionEventRemoved))

	mu.Lock()
	defer mu.Unlock()
	require.Equal(t, []bool{true, true}, seen, "each purge saw its write committed")
}

// The retention job deletes and tombstones only what readers don't see, so it doesn't
// purge: the thread reads the same before and after it.
func TestDiscussionMaintenanceKeepsPublicThreads(t *testing.T) {
	f := newCommentsFixture(t)
	post := f.publishedPost(t)
	ana := f.commenter(t)
	shown := f.says(t, post, ana, nil, db.ReaderCommentApproved, marker("shown"))
	f.says(t, post, ana, &shown, db.ReaderCommentApproved, marker("shown reply"))
	// A pending root past 90 days with an approved reply: tombstoned by the job, shown as
	// a placeholder before and after.
	old := f.says(t, post, ana, nil, db.ReaderCommentApproved, marker("old root"))
	f.says(t, post, ana, &old, db.ReaderCommentApproved, marker("old reply"))
	_, err := f.conn.Exec(`UPDATE reader_comments SET status = 'pending' WHERE id = $1`, old.ID)
	require.NoError(t, err)
	f.age(t, old.ID, 91*24*time.Hour)
	// Expired and never shown.
	gone := f.says(t, post, ana, nil, db.ReaderCommentUnconfirmed, marker("unconfirmed"))
	f.age(t, gone.ID, 49*time.Hour)
	spam := f.says(t, post, ana, nil, db.ReaderCommentSpam, marker("spam"))
	f.age(t, spam.ID, 31*24*time.Hour)

	before := f.read(t, commentsPath(post, "")).Body.String()
	f.maintain(t)
	require.True(t, f.reload(t, old.ID).RemovedAt.Valid, "the old root is a tombstone now")
	require.False(t, f.exists(t, gone.ID))
	require.False(t, f.exists(t, spam.ID))
	require.JSONEq(t, before, f.read(t, commentsPath(post, "")).Body.String(), "nothing a reader sees changed")
}
