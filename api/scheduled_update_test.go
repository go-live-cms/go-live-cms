package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Scheduled updates to published posts (#335) against the test database, with
// the helpers of scheduled_publish_test.go (#147): the claim, SKIP LOCKED, the
// fencing and the frozen snapshot are only real there.

// updateBody is a one-paragraph block doc saying word.
func updateBody(t *testing.T, word string) json.RawMessage {
	t.Helper()
	body, err := json.Marshal(map[string]interface{}{
		"doc_version":  1,
		"blocks_order": []string{"b1"},
		"blocks": map[string]interface{}{
			"b1": map[string]interface{}{"id": "b1", "type": "paragraph", "version": 1, "attrs": map[string]interface{}{"text": "The body says " + word}},
		},
	})
	require.NoError(t, err)
	return body
}

// publishedPost is a post published once (one version) by owner.
func publishedPost(t *testing.T, store db.Store, owner db.User) db.Post {
	t.Helper()
	post := scheduleDraft(t, store, owner, scheduleWord())
	_, err := store.PublishPostTx(context.Background(), db.PublishPostTxParams{
		PostID: post.ID, CreatedBy: sql.NullInt64{Int64: owner.ID, Valid: true}, ContentMedia: publishedContentMedia,
	})
	require.NoError(t, err)
	return reloadPost(t, store, post.ID)
}

// editWorkingCopy stands in for the collab server's store: the working body and
// title change, the live post doesn't.
func editWorkingCopy(t *testing.T, conn *sql.DB, postID int64, word string) {
	t.Helper()
	_, err := conn.Exec(`UPDATE posts SET block_doc = $2, title = $3, changed_at = now() WHERE id = $1`,
		postID, []byte(updateBody(t, word)), "Title "+word)
	require.NoError(t, err)
}

// scheduleUpdateAt freezes the working copy as an update due at updateAt (the
// handler refuses a past time; a due update is one scheduled in the past).
func scheduleUpdateAt(t *testing.T, store db.Store, postID int64, by db.User, updateAt time.Time) db.PostScheduledUpdateRow {
	t.Helper()
	row, err := store.ScheduleUpdateTx(context.Background(), db.ScheduleUpdateTxParams{
		PostID: postID, UpdateAt: updateAt, ScheduledBy: sql.NullInt64{Int64: by.ID, Valid: true},
	})
	require.NoError(t, err)
	return row
}

func hasScheduledUpdate(t *testing.T, conn *sql.DB, postID int64) bool {
	t.Helper()
	var n int
	require.NoError(t, conn.QueryRow(`SELECT count(*) FROM post_scheduled_updates WHERE post_id = $1`, postID).Scan(&n))
	return n == 1
}

// publishedBody is the live body's JSON text.
func publishedBody(t *testing.T, store db.Store, postID int64) string {
	t.Helper()
	return string(reloadPost(t, store, postID).PublishedBlockDoc.RawMessage)
}

// claimUpdateFor claims due updates until it has postID's claim.
func claimUpdateFor(t *testing.T, store db.Store, postID int64) db.ClaimDueScheduledUpdatesRow {
	t.Helper()
	claims, err := store.ClaimDueScheduledUpdates(context.Background(), db.ClaimDueScheduledUpdatesParams{
		LeaseSeconds: scheduledPublishLease.Seconds(),
		MaxPosts:     10000,
	})
	require.NoError(t, err)
	for _, claim := range claims {
		if claim.PostID == postID {
			return claim
		}
	}
	t.Fatalf("post %d's update was not claimed", postID)
	return db.ClaimDueScheduledUpdatesRow{}
}

// TestScheduledUpdatePublishesFrozenSnapshot: scheduling freezes the working copy
// (after a collab flush). Until the time the public site shows the old version.
// At the time the scheduler publishes exactly the frozen body and settings as a
// new version credited to whoever scheduled it; an edit made after scheduling
// stays in the working copy only.
func TestScheduledUpdatePublishesFrozenSnapshot(t *testing.T) {
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	owner := scheduleUser(t, store, RoleContributor)
	collab := newStubCollab(t, 0)
	server := scheduleServer(t, store, collab)

	post := publishedPost(t, store, owner)
	liveBefore := publishedBody(t, store, post.ID)
	scheduled, later := scheduleWord(), scheduleWord()
	editWorkingCopy(t, conn, post.ID, scheduled)

	at := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	recorder := scheduleRequest(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/scheduled-update", post.ID),
		`{"publish_at":"`+at.Format(time.RFC3339)+`"}`)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var body struct {
		ScheduledUpdate ScheduledUpdateResponse `json:"scheduled_update"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.True(t, at.Equal(body.ScheduledUpdate.UpdateAt))
	require.Equal(t, editor.ID, *body.ScheduledUpdate.ScheduledBy)
	require.Equal(t, 1, collab.flushCount(post.ID), "the working copy is flushed before it's frozen")

	// Edits made after scheduling aren't part of it.
	editWorkingCopy(t, conn, post.ID, later)

	// Before the time: nothing changes on the site, and a round leaves it alone.
	public := func() string {
		r := flowServe(server, httptest.NewRequest(http.MethodGet, fmt.Sprintf("/public/posts/%d", post.ID), nil))
		require.Equal(t, http.StatusOK, r.Code)
		return r.Body.String()
	}
	require.NotContains(t, public(), scheduled)
	server.applyDueScheduledUpdates(context.Background())
	require.Equal(t, liveBefore, publishedBody(t, store, post.ID))
	require.Equal(t, 1, versionCount(t, conn, post.ID))
	require.True(t, hasScheduledUpdate(t, conn, post.ID))

	// The time comes.
	_, err := conn.Exec(`UPDATE post_scheduled_updates SET update_at = now() - interval '1 second' WHERE post_id = $1`, post.ID)
	require.NoError(t, err)
	require.GreaterOrEqual(t, server.applyDueScheduledUpdates(context.Background()), 1)

	got := reloadPost(t, store, post.ID)
	require.Equal(t, postStatusPublished, got.PostStatus)
	require.Equal(t, 2, versionCount(t, conn, post.ID))
	live := publishedBody(t, store, post.ID)
	require.Contains(t, live, scheduled)
	require.NotContains(t, live, later, "an edit made after scheduling leaked into the update")
	var createdBy sql.NullInt64
	var settings []byte
	require.NoError(t, conn.QueryRow(`SELECT created_by, settings FROM post_versions WHERE post_id = $1 AND version_no = 2`, post.ID).Scan(&createdBy, &settings))
	require.Equal(t, editor.ID, createdBy.Int64)
	require.Contains(t, string(settings), "Title "+scheduled, "the settings are the frozen ones")
	require.Contains(t, string(got.PublishedSettings.RawMessage), "Title "+scheduled)
	require.False(t, hasScheduledUpdate(t, conn, post.ID), "an applied update is done")
	// #324: scheduling it and applying it are in the activity log, both the editor's.
	events := objectEvents(t, conn, db.ActivityObjectPost, post.ID)
	require.Equal(t, []string{"update_scheduled", "published"}, eventVerbs(events))
	for _, e := range events {
		require.Equal(t, editor.ID, e.Actor.Int64, e.Verb)
	}
	require.JSONEq(t, fmt.Sprintf(`{"update_at":%q}`, at.Format(time.RFC3339)), events[0].Payload)
	require.JSONEq(t, `{"version_no":2,"scheduled":true,"scheduled_update":true}`, events[1].Payload)

	// The public page shows it; the working copy keeps the later edit, still unpublished.
	require.Contains(t, public(), scheduled)
	require.Contains(t, string(got.BlockDoc), later)
	changed, err := store.GetPostHasUnpublishedChanges(context.Background(), post.ID)
	require.NoError(t, err)
	require.True(t, changed)

	// A second round finds nothing more to do.
	server.applyDueScheduledUpdates(context.Background())
	require.Equal(t, 2, versionCount(t, conn, post.ID))
}

// TestScheduledUpdateTwoReplicasApplyOnce: two API processes run their rounds
// at the same moment against the same due updates: one version each.
func TestScheduledUpdateTwoReplicasApplyOnce(t *testing.T) {
	conn, store := scheduleTestDB(t)
	_, otherStore := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	collab := newStubCollab(t, 0)
	replicas := []*Server{scheduleServer(t, store, collab), scheduleServer(t, otherStore, collab)}

	var posts []db.Post
	for i := 0; i < 8; i++ {
		post := publishedPost(t, store, editor)
		editWorkingCopy(t, conn, post.ID, scheduleWord())
		scheduleUpdateAt(t, store, post.ID, editor, time.Now().Add(-time.Minute))
		posts = append(posts, post)
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	for _, replica := range replicas {
		wg.Add(1)
		go func(server *Server) {
			defer wg.Done()
			<-start
			server.applyDueScheduledUpdates(context.Background())
		}(replica)
	}
	close(start)
	wg.Wait()

	for _, post := range posts {
		require.Equal(t, 2, versionCount(t, conn, post.ID), "post %d", post.ID)
		require.False(t, hasScheduledUpdate(t, conn, post.ID), "post %d", post.ID)
		require.Zero(t, collab.flushCount(post.ID), "the scheduler doesn't flush: the content was frozen")
	}
}

// TestScheduledUpdateClaimIsFenced: an apply only goes ahead while the update it
// claimed is still pending under that claim. A reschedule (a new snapshot), a
// cancel, an Update by hand, an unpublish, an archive and a second claim after
// the lease ran out all make an older claim publish nothing.
func TestScheduledUpdateClaimIsFenced(t *testing.T) {
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	ctx := context.Background()
	apply := func(claim db.ClaimDueScheduledUpdatesRow) error {
		_, err := store.PublishScheduledUpdateTx(ctx, db.PublishScheduledUpdateTxParams{
			PostID: claim.PostID, Claim: claim.Claim.Time, ContentMedia: publishedContentMedia,
		})
		return err
	}
	due := func() db.Post {
		post := publishedPost(t, store, editor)
		editWorkingCopy(t, conn, post.ID, scheduleWord())
		scheduleUpdateAt(t, store, post.ID, editor, time.Now().Add(-time.Minute))
		return post
	}

	t.Run("Rescheduled", func(t *testing.T) {
		post := due()
		claim := claimUpdateFor(t, store, post.ID)
		scheduleUpdateAt(t, store, post.ID, editor, time.Now().Add(-time.Minute))
		require.ErrorIs(t, apply(claim), db.ErrScheduleChanged)
		require.Equal(t, 1, versionCount(t, conn, post.ID))
		require.True(t, hasScheduledUpdate(t, conn, post.ID), "the new schedule stays")
	})

	t.Run("Cancelled", func(t *testing.T) {
		post := due()
		claim := claimUpdateFor(t, store, post.ID)
		rows, err := store.CancelPostScheduledUpdate(ctx, post.ID)
		require.NoError(t, err)
		require.EqualValues(t, 1, rows)
		require.ErrorIs(t, apply(claim), db.ErrScheduleChanged)
		require.Equal(t, 1, versionCount(t, conn, post.ID))
	})

	t.Run("UpdatedByHand", func(t *testing.T) {
		post := due()
		claim := claimUpdateFor(t, store, post.ID)
		_, err := store.PublishPostTx(ctx, db.PublishPostTxParams{PostID: post.ID, ContentMedia: publishedContentMedia})
		require.NoError(t, err)
		require.False(t, hasScheduledUpdate(t, conn, post.ID), "an Update by hand supersedes the scheduled one")
		require.ErrorIs(t, apply(claim), db.ErrScheduleChanged)
		require.Equal(t, 2, versionCount(t, conn, post.ID))
	})

	t.Run("Unpublished", func(t *testing.T) {
		post := due()
		claim := claimUpdateFor(t, store, post.ID)
		_, err := store.UnpublishPost(ctx, post.ID)
		require.NoError(t, err)
		require.False(t, hasScheduledUpdate(t, conn, post.ID), "unpublishing cancels it")
		require.ErrorIs(t, apply(claim), db.ErrScheduleChanged)
		got := reloadPost(t, store, post.ID)
		require.Equal(t, "draft", got.PostStatus)
		require.False(t, got.PublishedBlockDoc.Valid)
	})

	t.Run("Archived", func(t *testing.T) {
		post := due()
		_, err := conn.Exec(`UPDATE posts SET post_status = 'archived' WHERE id = $1`, post.ID)
		require.NoError(t, err)
		require.False(t, hasScheduledUpdate(t, conn, post.ID), "archiving cancels it")
	})

	t.Run("LeaseExpired", func(t *testing.T) {
		post := due()
		stale := claimUpdateFor(t, store, post.ID)
		_, err := conn.Exec(`UPDATE post_scheduled_updates SET next_attempt_at = now() - interval '1 second' WHERE post_id = $1`, post.ID)
		require.NoError(t, err)
		fresh := claimUpdateFor(t, store, post.ID)
		require.Equal(t, stale.Attempts+1, fresh.Attempts)

		require.ErrorIs(t, apply(stale), db.ErrScheduleChanged)
		require.NoError(t, apply(fresh))
		require.ErrorIs(t, apply(fresh), db.ErrScheduleChanged, "a claim applies once")
		require.Equal(t, 2, versionCount(t, conn, post.ID))
	})

	t.Run("PostDeleted", func(t *testing.T) {
		post := due()
		claim := claimUpdateFor(t, store, post.ID)
		_, err := conn.Exec(`DELETE FROM posts WHERE id = $1`, post.ID)
		require.NoError(t, err)
		require.False(t, hasScheduledUpdate(t, conn, post.ID))
		require.ErrorIs(t, apply(claim), db.ErrScheduleChanged)
	})
}

// failingUpdateStore fails PublishScheduledUpdateTx its first `failures` times.
type failingUpdateStore struct {
	db.Store
	failures atomic.Int32
}

func (s *failingUpdateStore) PublishScheduledUpdateTx(ctx context.Context, arg db.PublishScheduledUpdateTxParams) (db.PublishPostTxResult, error) {
	if s.failures.Add(-1) >= 0 {
		return db.PublishPostTxResult{}, errors.New("injected failure")
	}
	return s.Store.PublishScheduledUpdateTx(ctx, arg)
}

// TestScheduledUpdateFailureRetries: a failed apply changes nothing on the site,
// is recorded on the update (GET /posts/:id's scheduled_update.failure) and is
// retried after the backoff, not before. Then it goes live and the failure is gone.
func TestScheduledUpdateFailureRetries(t *testing.T) {
	conn, realStore := scheduleTestDB(t)
	store := &failingUpdateStore{Store: realStore}
	store.failures.Store(1)
	editor := scheduleUser(t, realStore, RoleEditor)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	post := publishedPost(t, realStore, editor)
	word := scheduleWord()
	editWorkingCopy(t, conn, post.ID, word)
	scheduleUpdateAt(t, realStore, post.ID, editor, time.Now().Add(-time.Minute))

	server.applyDueScheduledUpdates(context.Background())
	require.Equal(t, 1, versionCount(t, conn, post.ID))
	require.NotContains(t, publishedBody(t, realStore, post.ID), word)
	row, err := realStore.GetPostScheduledUpdate(context.Background(), post.ID)
	require.NoError(t, err)
	require.Equal(t, int32(1), row.Attempts)
	require.True(t, row.FailedAt.Valid)
	require.Equal(t, scheduledUpdateFailed, row.Error.String)
	require.WithinDuration(t, time.Now().Add(scheduledPublishBackoff[0]), row.NextAttemptAt.Time, 10*time.Second)

	recorder := scheduleRequest(t, server, editor, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d", post.ID), "")
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var body struct {
		Post PostResponse `json:"post"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.NotNil(t, body.Post.ScheduledUpdate)
	require.NotNil(t, body.Post.UpdateAt)
	require.NotNil(t, body.Post.ScheduledUpdate.Failure)
	require.Equal(t, scheduledUpdateFailed, body.Post.ScheduledUpdate.Failure.Reason)

	// Within the backoff the next round leaves it alone.
	server.applyDueScheduledUpdates(context.Background())
	require.Equal(t, 1, versionCount(t, conn, post.ID))

	// Once the backoff is over it goes live.
	_, err = conn.Exec(`UPDATE post_scheduled_updates SET next_attempt_at = now() - interval '1 second' WHERE post_id = $1`, post.ID)
	require.NoError(t, err)
	server.applyDueScheduledUpdates(context.Background())
	require.Equal(t, 2, versionCount(t, conn, post.ID))
	require.Contains(t, publishedBody(t, realStore, post.ID), word)
	require.False(t, hasScheduledUpdate(t, conn, post.ID))
}

// TestRunScheduledPublishingAppliesUpdates: the #147 loop runs the updates too.
func TestRunScheduledPublishingAppliesUpdates(t *testing.T) {
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		server.RunScheduledPublishing(ctx, 20*time.Millisecond)
	}()

	post := publishedPost(t, store, editor)
	editWorkingCopy(t, conn, post.ID, scheduleWord())
	scheduleUpdateAt(t, store, post.ID, editor, time.Now().Add(-time.Second))
	require.Eventually(t, func() bool { return versionCount(t, conn, post.ID) == 2 }, 10*time.Second, 20*time.Millisecond)
	cancel()
	<-done
}

// TestScheduledUpdateRoutes: Schedule update, Reschedule and Cancel update through
// the real routes and database, who may use them, and the refusals.
func TestScheduledUpdateRoutes(t *testing.T) {
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	admin := scheduleUser(t, store, RoleAdmin)
	contributor := scheduleUser(t, store, RoleContributor)
	collab := newStubCollab(t, 0)
	server := scheduleServer(t, store, collab)
	at := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	when := func(t time.Time) string { return `{"publish_at":"` + t.Format(time.RFC3339) + `"}` }
	path := func(id int64) string { return fmt.Sprintf("/api/v1/posts/%d/scheduled-update", id) }

	post := publishedPost(t, store, contributor)
	first := scheduleWord()
	editWorkingCopy(t, conn, post.ID, first)

	// Contributors can't schedule or cancel, even on their own post.
	require.Equal(t, http.StatusForbidden, scheduleRequest(t, server, contributor, http.MethodPut, path(post.ID), when(at)).Code)
	require.Equal(t, http.StatusForbidden, scheduleRequest(t, server, contributor, http.MethodDelete, path(post.ID), "").Code)
	require.False(t, hasScheduledUpdate(t, conn, post.ID))

	// The collab server can't flush: 503 and nothing scheduled. Then it works.
	collab.fail.Store(true)
	require.Equal(t, http.StatusServiceUnavailable, scheduleRequest(t, server, editor, http.MethodPut, path(post.ID), when(at)).Code)
	require.False(t, hasScheduledUpdate(t, conn, post.ID))
	collab.fail.Store(false)
	recorder := scheduleRequest(t, server, editor, http.MethodPut, path(post.ID), when(at))
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

	// GET /posts/:id and the lists show it.
	recorder = scheduleRequest(t, server, contributor, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d", post.ID), "")
	require.Equal(t, http.StatusOK, recorder.Code)
	var detail struct {
		Post PostResponse `json:"post"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &detail))
	require.NotNil(t, detail.Post.ScheduledUpdate)
	require.True(t, at.Equal(*detail.Post.UpdateAt))
	for _, list := range []string{
		fmt.Sprintf("/api/v1/posts?status=published&user_id=%d", contributor.ID),
		fmt.Sprintf("/api/v1/posts?status=published&user_id=%d&with_meta=true&meta_level=basic", contributor.ID),
		"/api/v1/posts/search?q=" + first,
	} {
		recorder = scheduleRequest(t, server, editor, http.MethodGet, list, "")
		require.Equal(t, http.StatusOK, recorder.Code, list)
		require.Contains(t, recorder.Body.String(), `"update_at":"`+at.Format(time.RFC3339)+`"`, list)
	}
	// The settings state every open editor re-reads carries it too.
	recorder = scheduleRequest(t, server, contributor, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d/settings", post.ID), "")
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Contains(t, recorder.Body.String(), `"scheduled_update":{"update_at":"`+at.Format(time.RFC3339)+`"`)
	// Not on the public lists.
	publicList := flowServe(server, httptest.NewRequest(http.MethodGet, "/public/posts?type=post&limit=100", nil)).Body.String()
	require.NotContains(t, publicList, `"update_at"`)
	require.NotContains(t, publicList, `"has_unpublished_changes"`)

	// Reschedule takes a new snapshot at a new time and forgets an earlier failure.
	second := scheduleWord()
	editWorkingCopy(t, conn, post.ID, second)
	_, err := conn.Exec(`UPDATE post_scheduled_updates SET failed_at = now(), error = 'update_failed', attempts = 3 WHERE post_id = $1`, post.ID)
	require.NoError(t, err)
	later := at.Add(24 * time.Hour)
	recorder = scheduleRequest(t, server, admin, http.MethodPut, path(post.ID), when(later))
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var frozen []byte
	var attempts int32
	var failed sql.NullTime
	var updateAt time.Time
	require.NoError(t, conn.QueryRow(`SELECT block_doc, attempts, failed_at, update_at FROM post_scheduled_updates WHERE post_id = $1`, post.ID).Scan(&frozen, &attempts, &failed, &updateAt))
	require.Contains(t, string(frozen), second)
	require.Zero(t, attempts)
	require.False(t, failed.Valid)
	require.True(t, later.Equal(updateAt))

	// A past time, both kinds of time, no time and a site-time local value.
	require.Equal(t, http.StatusBadRequest, scheduleRequest(t, server, editor, http.MethodPut, path(post.ID), when(time.Now().Add(-time.Minute))).Code)
	require.Equal(t, http.StatusBadRequest, scheduleRequest(t, server, editor, http.MethodPut, path(post.ID), `{"publish_at":"`+at.Format(time.RFC3339)+`","local":"2030-01-01T09:00"}`).Code)
	require.Equal(t, http.StatusBadRequest, scheduleRequest(t, server, editor, http.MethodPut, path(post.ID), `{}`).Code)
	require.Equal(t, http.StatusBadRequest, scheduleRequest(t, server, editor, http.MethodPut, path(post.ID), `{"local":"tomorrow"}`).Code)
	require.Equal(t, http.StatusBadRequest, scheduleRequest(t, server, editor, http.MethodPut, "/api/v1/posts/abc/scheduled-update", when(at)).Code)

	// Cancel: the snapshot goes, the live post and working copy stay. Twice is a conflict.
	liveBefore := publishedBody(t, store, post.ID)
	recorder = scheduleRequest(t, server, editor, http.MethodDelete, path(post.ID), "")
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.False(t, hasScheduledUpdate(t, conn, post.ID))
	require.Equal(t, liveBefore, publishedBody(t, store, post.ID))
	require.Contains(t, string(reloadPost(t, store, post.ID).BlockDoc), second)
	recorder = scheduleRequest(t, server, editor, http.MethodDelete, path(post.ID), "")
	require.Equal(t, http.StatusConflict, recorder.Code)
	require.Contains(t, recorder.Body.String(), scheduledUpdateNotScheduled)
	require.Equal(t, http.StatusNotFound, scheduleRequest(t, server, editor, http.MethodDelete, path(1<<60), "").Code)
	require.Equal(t, http.StatusBadRequest, scheduleRequest(t, server, editor, http.MethodDelete, "/api/v1/posts/abc/scheduled-update", "").Code)

	// Update by hand, then Unpublish, through the routes: both end a scheduled update.
	require.Equal(t, http.StatusOK, scheduleRequest(t, server, editor, http.MethodPut, path(post.ID), when(at)).Code)
	recorder = scheduleRequest(t, server, editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", post.ID), "")
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), `"cancelled_scheduled_update":true`, "the editor says the Update cancelled it")
	require.False(t, hasScheduledUpdate(t, conn, post.ID))

	recorder = scheduleRequest(t, server, editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", post.ID), "")
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.NotContains(t, recorder.Body.String(), "cancelled_scheduled_update")

	// Nothing to update now: the live post matches the working copy.
	recorder = scheduleRequest(t, server, editor, http.MethodPut, path(post.ID), when(at))
	require.Equal(t, http.StatusConflict, recorder.Code)
	require.Contains(t, recorder.Body.String(), scheduledUpdateNoChanges)

	editWorkingCopy(t, conn, post.ID, scheduleWord())
	require.Equal(t, http.StatusOK, scheduleRequest(t, server, editor, http.MethodPut, path(post.ID), when(at)).Code)
	recorder = scheduleRequest(t, server, editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/unpublish", post.ID), "")
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.False(t, hasScheduledUpdate(t, conn, post.ID))

	// Only a published post: a draft is a conflict (its publish is scheduled
	// with /schedule), a missing post a 404. Neither is flushed.
	flushes := collab.flushCount(post.ID)
	recorder = scheduleRequest(t, server, editor, http.MethodPut, path(post.ID), when(at))
	require.Equal(t, http.StatusConflict, recorder.Code)
	require.Contains(t, recorder.Body.String(), `"post_status":"draft"`)
	require.Equal(t, flushes, collab.flushCount(post.ID))
	require.Equal(t, http.StatusNotFound, scheduleRequest(t, server, editor, http.MethodPut, path(1<<60), when(at)).Code)

	// An archived post names its status.
	_, err = conn.Exec(`UPDATE posts SET post_status = 'archived' WHERE id = $1`, post.ID)
	require.NoError(t, err)
	recorder = scheduleRequest(t, server, editor, http.MethodPut, path(post.ID), when(at))
	require.Equal(t, http.StatusConflict, recorder.Code)
	require.Contains(t, recorder.Body.String(), `this post is archived`)
}

// TestScheduleUpdateTxRefusals: the transaction's own checks, for a caller that
// skipped the handler's (or raced it).
func TestScheduleUpdateTxRefusals(t *testing.T) {
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	at := time.Now().Add(time.Hour)
	params := func(id int64) db.ScheduleUpdateTxParams {
		return db.ScheduleUpdateTxParams{PostID: id, UpdateAt: at, ScheduledBy: sql.NullInt64{Int64: editor.ID, Valid: true}}
	}

	draft := scheduleDraft(t, store, editor, scheduleWord())
	_, err := store.ScheduleUpdateTx(context.Background(), params(draft.ID))
	require.ErrorIs(t, err, db.ErrPostNotPublished)

	post := publishedPost(t, store, editor)
	_, err = store.ScheduleUpdateTx(context.Background(), params(post.ID))
	require.ErrorIs(t, err, db.ErrNoUnpublishedChanges)

	_, err = store.ScheduleUpdateTx(context.Background(), params(1<<60))
	require.ErrorIs(t, err, sql.ErrNoRows)

	// A settings-only change counts as something to update.
	_, err = conn.Exec(`UPDATE posts SET description = description || ' changed' WHERE id = $1`, post.ID)
	require.NoError(t, err)
	_, err = store.ScheduleUpdateTx(context.Background(), params(post.ID))
	require.NoError(t, err)
}
