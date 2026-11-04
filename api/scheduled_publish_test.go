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
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
)

// Scheduled publishing (#147) against the test database (skipped without one,
// like auth_flow_test.go): the claim, SKIP LOCKED and the fenced publish are
// only real there. The collab server is a stub that counts flushes per doc
// and can fail.
//
// The database is shared across runs and packages, so other due posts may be
// in the queue: every assertion is about this test's own posts.

// stubCollab is the collab server's flush endpoint.
type stubCollab struct {
	server  *httptest.Server
	fail    atomic.Bool
	delay   time.Duration
	mu      sync.Mutex
	flushes map[string]int
}

func newStubCollab(t *testing.T, delay time.Duration) *stubCollab {
	t.Helper()
	stub := &stubCollab{delay: delay, flushes: map[string]int{}}
	stub.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if stub.delay > 0 {
			time.Sleep(stub.delay)
		}
		if stub.fail.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		doc := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/internal/documents/"), "/flush")
		stub.mu.Lock()
		stub.flushes[doc]++
		stub.mu.Unlock()
		_, _ = w.Write([]byte(`{"flushed":true}`))
	}))
	t.Cleanup(stub.server.Close)
	return stub
}

func (stub *stubCollab) flushCount(postID int64) int {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	return stub.flushes[fmt.Sprintf("post-%d", postID)]
}

// scheduleTestDB opens the test database (or skips) and returns both the raw
// connection, for setting up states such as an expired lease, and a store.
func scheduleTestDB(t *testing.T) (*sql.DB, db.Store) {
	t.Helper()
	config, err := util.LoadConfig("..")
	if err != nil || config.DBSource == "" {
		t.Skip("no test database configured")
	}
	conn, err := sql.Open(config.DBDriver, config.DBSource)
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })
	if err := conn.Ping(); err != nil {
		t.Skipf("test database unreachable: %v", err)
	}
	return conn, db.NewStore(conn)
}

func scheduleUser(t *testing.T, store db.Store, role string) db.User {
	t.Helper()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:16]
	user, err := store.CreateUser(context.Background(), db.CreateUserParams{
		Username:       "sched" + suffix,
		FullName:       "Schedule Tester",
		Email:          "sched" + suffix + "@example.test",
		HashedPassword: "unused",
		Role:           role,
	})
	require.NoError(t, err)
	return user
}

// scheduleWord is a token no other post contains (letters only, one search token).
func scheduleWord() string {
	var b strings.Builder
	b.WriteString("zsch")
	for _, d := range fmt.Sprint(time.Now().UnixNano()) {
		b.WriteRune('a' + (d - '0'))
	}
	return b.String()
}

// scheduleDraft creates a draft owned and credited to owner, with word in its
// title and body.
func scheduleDraft(t *testing.T, store db.Store, owner db.User, word string) db.Post {
	t.Helper()
	slug := "sched-" + strings.ReplaceAll(uuid.NewString(), "-", "")
	body, err := json.Marshal(map[string]interface{}{
		"doc_version":  1,
		"blocks_order": []string{"b1"},
		"blocks": map[string]interface{}{
			"b1": map[string]interface{}{"id": "b1", "type": "paragraph", "version": 1, "attrs": map[string]interface{}{"text": "The body says " + word}},
		},
	})
	require.NoError(t, err)
	result, err := store.CreatePostTx(context.Background(), db.CreatePostTxParams{
		CreatePostsParams: db.CreatePostsParams{
			Title:       "Scheduled " + word,
			Description: "A post that publishes later " + word,
			UserID:      owner.ID,
			Username:    owner.Username,
			Url:         "https://example.test/" + slug,
			PostType:    "post",
			PostStatus:  "draft",
			Slug:        slug,
			BlockDoc:    body,
		},
		AuthorIDs: []int64{owner.ID},
	})
	require.NoError(t, err)
	return result.Post
}

// schedulePostAt schedules post at publishAt directly (the handler refuses a
// past time; a due post is one scheduled in the past).
func schedulePostAt(t *testing.T, store db.Store, post db.Post, by db.User, publishAt time.Time) db.Post {
	t.Helper()
	scheduled, err := store.SchedulePost(context.Background(), db.SchedulePostParams{
		ID:          post.ID,
		PublishAt:   publishAt,
		ScheduledBy: sql.NullInt64{Int64: by.ID, Valid: true},
	})
	require.NoError(t, err)
	return scheduled
}

func scheduleServer(t *testing.T, store db.Store, collab *stubCollab) *Server {
	t.Helper()
	return authFlowServer(t, store, func(config *util.Config) {
		config.CollabInternalURL = collab.server.URL
		config.CollabInternalSecret = testCollabInternalSecret
	})
}

func reloadPost(t *testing.T, store db.Store, id int64) db.Post {
	t.Helper()
	post, err := store.GetPost(context.Background(), id)
	require.NoError(t, err)
	return post
}

func versionCount(t *testing.T, conn *sql.DB, postID int64) int {
	t.Helper()
	var n int
	require.NoError(t, conn.QueryRow(`SELECT count(*) FROM post_versions WHERE post_id = $1`, postID).Scan(&n))
	return n
}

// claimFor claims due posts until it has postID's claim (other due posts in the
// shared queue are claimed too and published by a later round).
func claimFor(t *testing.T, store db.Store, postID int64) db.ClaimDueScheduledPostsRow {
	t.Helper()
	claims, err := store.ClaimDueScheduledPosts(context.Background(), db.ClaimDueScheduledPostsParams{
		LeaseSeconds: scheduledPublishLease.Seconds(),
		MaxPosts:     10000,
	})
	require.NoError(t, err)
	for _, claim := range claims {
		if claim.ID == postID {
			return claim
		}
	}
	t.Fatalf("post %d was not claimed", postID)
	return db.ClaimDueScheduledPostsRow{}
}

// TestScheduledPublishPublishesDuePostsOnly: a due post is flushed and
// published once, with a version credited to whoever scheduled it, and its
// schedule cleared. A post scheduled later and a draft are left alone.
func TestScheduledPublishPublishesDuePostsOnly(t *testing.T) {
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	collab := newStubCollab(t, 0)
	server := scheduleServer(t, store, collab)

	due := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(-time.Minute))
	later := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(time.Hour))
	draft := scheduleDraft(t, store, editor, scheduleWord())

	require.GreaterOrEqual(t, server.publishDueScheduledPosts(context.Background()), 1)

	got := reloadPost(t, store, due.ID)
	require.Equal(t, postStatusPublished, got.PostStatus)
	require.False(t, got.PublishAt.Valid)
	require.False(t, got.PublishScheduledBy.Valid)
	require.False(t, got.PublishNextAttemptAt.Valid)
	require.Zero(t, got.PublishAttempts)
	require.True(t, got.PublishedBlockDoc.Valid)
	require.Equal(t, 1, versionCount(t, conn, due.ID))
	require.Equal(t, 1, collab.flushCount(due.ID))
	var createdBy sql.NullInt64
	require.NoError(t, conn.QueryRow(`SELECT created_by FROM post_versions WHERE post_id = $1`, due.ID).Scan(&createdBy))
	require.Equal(t, editor.ID, createdBy.Int64)
	// #324: "published" by whoever scheduled it, marked as scheduled.
	var actor sql.NullInt64
	var payload string
	require.NoError(t, conn.QueryRow(`SELECT actor_id, payload::text FROM activity
		WHERE object_type = 'post' AND object_id = $1 AND verb = 'published'`, due.ID).Scan(&actor, &payload))
	require.Equal(t, editor.ID, actor.Int64)
	require.JSONEq(t, `{"version_no": 1, "scheduled": true}`, payload)

	got = reloadPost(t, store, later.ID)
	require.Equal(t, postStatusScheduled, got.PostStatus)
	require.Zero(t, got.PublishAttempts)
	require.Zero(t, versionCount(t, conn, later.ID))
	require.Zero(t, collab.flushCount(later.ID))

	require.Equal(t, "draft", reloadPost(t, store, draft.ID).PostStatus)
	require.Zero(t, versionCount(t, conn, draft.ID))

	// A second round finds nothing more of these to do.
	server.publishDueScheduledPosts(context.Background())
	require.Equal(t, 1, versionCount(t, conn, due.ID))
	require.Equal(t, 1, collab.flushCount(due.ID))
}

// TestScheduledPublishTwoReplicasPublishOnce: two API processes (own servers,
// own connection pools) run their rounds at the same moment against the same
// due posts. SKIP LOCKED and the claim keep them apart: every post is flushed
// once, published once and has one version.
func TestScheduledPublishTwoReplicasPublishOnce(t *testing.T) {
	conn, store := scheduleTestDB(t)
	_, otherStore := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	// A slow flush widens the window in which both replicas are mid-round.
	collab := newStubCollab(t, 25*time.Millisecond)
	replicas := []*Server{scheduleServer(t, store, collab), scheduleServer(t, otherStore, collab)}

	var posts []db.Post
	for i := 0; i < 8; i++ {
		posts = append(posts, schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(-time.Minute)))
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	for _, replica := range replicas {
		wg.Add(1)
		go func(server *Server) {
			defer wg.Done()
			<-start
			server.publishDueScheduledPosts(context.Background())
		}(replica)
	}
	close(start)
	wg.Wait()

	for _, post := range posts {
		got := reloadPost(t, store, post.ID)
		require.Equal(t, postStatusPublished, got.PostStatus, "post %d", post.ID)
		require.Equal(t, 1, versionCount(t, conn, post.ID), "post %d", post.ID)
		require.Equal(t, 1, collab.flushCount(post.ID), "post %d", post.ID)
	}
}

// TestScheduledPublishClaimIsFenced: a publish only goes ahead while the post
// is still scheduled under its claim. A reschedule, a cancel, a publish by hand
// and a second claim after the lease ran out all make an older claim publish
// nothing.
func TestScheduledPublishClaimIsFenced(t *testing.T) {
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	ctx := context.Background()
	publish := func(claim db.ClaimDueScheduledPostsRow) error {
		_, err := store.PublishScheduledPostTx(ctx, db.PublishScheduledPostTxParams{
			PostID: claim.ID, Claim: claim.Claim.Time, ContentMedia: publishedContentMedia,
		})
		return err
	}

	t.Run("Rescheduled", func(t *testing.T) {
		post := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(-time.Minute))
		claim := claimFor(t, store, post.ID)
		schedulePostAt(t, store, post, editor, time.Now().Add(-time.Minute))
		require.ErrorIs(t, publish(claim), db.ErrScheduleChanged)
		require.Equal(t, postStatusScheduled, reloadPost(t, store, post.ID).PostStatus)
		require.Zero(t, versionCount(t, conn, post.ID))
	})

	t.Run("Cancelled", func(t *testing.T) {
		post := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(-time.Minute))
		claim := claimFor(t, store, post.ID)
		_, err := store.CancelPostSchedule(ctx, post.ID)
		require.NoError(t, err)
		require.ErrorIs(t, publish(claim), db.ErrScheduleChanged)
		got := reloadPost(t, store, post.ID)
		require.Equal(t, "draft", got.PostStatus)
		require.False(t, got.PublishAt.Valid)
		require.Zero(t, versionCount(t, conn, post.ID))
	})

	t.Run("PublishedByHand", func(t *testing.T) {
		post := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(-time.Minute))
		claim := claimFor(t, store, post.ID)
		_, err := store.PublishPostTx(ctx, db.PublishPostTxParams{PostID: post.ID, ContentMedia: publishedContentMedia})
		require.NoError(t, err)
		got := reloadPost(t, store, post.ID)
		require.Equal(t, postStatusPublished, got.PostStatus)
		require.False(t, got.PublishAt.Valid, "publishing by hand ends the schedule")
		require.ErrorIs(t, publish(claim), db.ErrScheduleChanged)
		require.Equal(t, 1, versionCount(t, conn, post.ID))
	})

	t.Run("LeaseExpired", func(t *testing.T) {
		post := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(-time.Minute))
		stale := claimFor(t, store, post.ID)
		// The replica holding the claim stalled past its lease; another claims it.
		_, err := conn.Exec(`UPDATE posts SET publish_next_attempt_at = now() - interval '1 second' WHERE id = $1`, post.ID)
		require.NoError(t, err)
		fresh := claimFor(t, store, post.ID)
		require.Equal(t, stale.PublishAttempts+1, fresh.PublishAttempts)

		require.ErrorIs(t, publish(stale), db.ErrScheduleChanged)
		require.NoError(t, publish(fresh))
		require.ErrorIs(t, publish(fresh), db.ErrScheduleChanged, "a claim publishes once")
		require.Equal(t, 1, versionCount(t, conn, post.ID))
	})
}

// TestScheduledPublishFlushFailureRetries: when the collab server can't flush,
// nothing is published, the failure is recorded on the post (and shown by GET
// /posts/:id) and the post is retried after the backoff, not before. Once the
// flush works it publishes and the failure is gone.
func TestScheduledPublishFlushFailureRetries(t *testing.T) {
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	collab := newStubCollab(t, 0)
	collab.fail.Store(true)
	server := scheduleServer(t, store, collab)
	post := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(-time.Minute))

	server.publishDueScheduledPosts(context.Background())
	got := reloadPost(t, store, post.ID)
	require.Equal(t, postStatusScheduled, got.PostStatus)
	require.Zero(t, versionCount(t, conn, post.ID))
	require.Equal(t, int32(1), got.PublishAttempts)
	require.True(t, got.PublishFailedAt.Valid)
	require.Equal(t, scheduledPublishCollabFlushFailed, got.PublishError.String)
	require.WithinDuration(t, time.Now().Add(scheduledPublishBackoff[0]), got.PublishNextAttemptAt.Time, 10*time.Second)

	// The editor reads it from the post (signed in: post reads need a content role, #393).
	request := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/v1/posts/%d", post.ID), nil)
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, editor.ID, editor.Username, time.Minute)
	recorder := flowServe(server, request)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var body struct {
		Post PostResponse `json:"post"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.NotNil(t, body.Post.PublishAt)
	require.NotNil(t, body.Post.ScheduleFailure)
	require.Equal(t, scheduledPublishCollabFlushFailed, body.Post.ScheduleFailure.Reason)
	require.Equal(t, int32(1), body.Post.ScheduleFailure.Attempts)

	// Within the backoff the next round leaves it alone, even with the collab server back.
	collab.fail.Store(false)
	server.publishDueScheduledPosts(context.Background())
	require.Equal(t, postStatusScheduled, reloadPost(t, store, post.ID).PostStatus)
	require.Zero(t, collab.flushCount(post.ID))

	// Once the backoff is over it publishes.
	_, err := conn.Exec(`UPDATE posts SET publish_next_attempt_at = now() - interval '1 second' WHERE id = $1`, post.ID)
	require.NoError(t, err)
	server.publishDueScheduledPosts(context.Background())
	got = reloadPost(t, store, post.ID)
	require.Equal(t, postStatusPublished, got.PostStatus)
	require.False(t, got.PublishFailedAt.Valid)
	require.False(t, got.PublishError.Valid)
	require.Equal(t, 1, versionCount(t, conn, post.ID))
	require.Nil(t, scheduleFailure(got))
}

// TestRunScheduledPublishingStopsOnShutdown: the loop runs on its interval
// (short here) and returns promptly once its context is cancelled.
func TestRunScheduledPublishingStopsOnShutdown(t *testing.T) {
	_, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	collab := newStubCollab(t, 0)
	server := scheduleServer(t, store, collab)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		server.RunScheduledPublishing(ctx, 20*time.Millisecond)
	}()

	// Scheduled while the loop is already running: a later tick publishes it.
	post := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, time.Now().Add(-time.Second))
	require.Eventually(t, func() bool {
		return reloadPost(t, store, post.ID).PostStatus == postStatusPublished
	}, 10*time.Second, 20*time.Millisecond)

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the scheduler did not stop after its context was cancelled")
	}

	// Off: returns at once.
	off := make(chan struct{})
	go func() {
		defer close(off)
		server.RunScheduledPublishing(context.Background(), 0)
	}()
	select {
	case <-off:
	case <-time.After(time.Second):
		t.Fatal("an interval of 0 should turn the scheduler off")
	}
}

// scheduleRequest sends an authenticated request as user.
func scheduleRequest(t *testing.T, server *Server, user db.User, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
	return flowServe(server, request)
}

// TestScheduleRoutesRescheduleAndCancel: the editor's Schedule, Reschedule and
// Cancel schedule through the real routes and database, and who may use them.
func TestScheduleRoutesRescheduleAndCancel(t *testing.T) {
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	contributor := scheduleUser(t, store, RoleContributor)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	post := scheduleDraft(t, store, editor, scheduleWord())
	path := fmt.Sprintf("/api/v1/posts/%d/schedule", post.ID)

	first := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	recorder := scheduleRequest(t, server, editor, http.MethodPut, path, `{"publish_at":"`+first.Format(time.RFC3339)+`"}`)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	got := reloadPost(t, store, post.ID)
	require.Equal(t, postStatusScheduled, got.PostStatus)
	require.True(t, first.Equal(got.PublishAt.Time))
	require.Equal(t, editor.ID, got.PublishScheduledBy.Int64)

	// Contributors can't schedule, reschedule or cancel, even their own posts.
	own := scheduleDraft(t, store, contributor, scheduleWord())
	ownPath := fmt.Sprintf("/api/v1/posts/%d/schedule", own.ID)
	require.Equal(t, http.StatusForbidden, scheduleRequest(t, server, contributor, http.MethodPut, ownPath, `{"publish_at":"`+first.Format(time.RFC3339)+`"}`).Code)
	require.Equal(t, http.StatusForbidden, scheduleRequest(t, server, contributor, http.MethodPut, path, `{"publish_at":"`+first.Format(time.RFC3339)+`"}`).Code)
	require.Equal(t, http.StatusForbidden, scheduleRequest(t, server, contributor, http.MethodDelete, path, "").Code)
	require.Equal(t, "draft", reloadPost(t, store, own.ID).PostStatus)
	require.Equal(t, postStatusScheduled, reloadPost(t, store, post.ID).PostStatus)

	// Reschedule: a new time, and an earlier failure is forgotten.
	_, err := conn.Exec(`UPDATE posts SET publish_failed_at = now(), publish_error = 'collab_flush_failed', publish_attempts = 3 WHERE id = $1`, post.ID)
	require.NoError(t, err)
	second := first.Add(24 * time.Hour)
	recorder = scheduleRequest(t, server, editor, http.MethodPut, path, `{"publish_at":"`+second.Format(time.RFC3339)+`"}`)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	got = reloadPost(t, store, post.ID)
	require.True(t, second.Equal(got.PublishAt.Time))
	require.False(t, got.PublishFailedAt.Valid)
	require.Zero(t, got.PublishAttempts)

	// A past time is refused and changes nothing.
	recorder = scheduleRequest(t, server, editor, http.MethodPut, path, `{"publish_at":"`+time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)+`"}`)
	require.Equal(t, http.StatusBadRequest, recorder.Code)
	require.True(t, second.Equal(reloadPost(t, store, post.ID).PublishAt.Time))

	// Cancel: back to draft, the time cleared. Twice is a conflict.
	recorder = scheduleRequest(t, server, editor, http.MethodDelete, path, "")
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	got = reloadPost(t, store, post.ID)
	require.Equal(t, "draft", got.PostStatus)
	require.False(t, got.PublishAt.Valid)
	require.False(t, got.PublishScheduledBy.Valid)
	require.Equal(t, http.StatusConflict, scheduleRequest(t, server, editor, http.MethodDelete, path, "").Code)

	// A published post can't be scheduled here (an update's schedule is #335).
	_, err = store.PublishPostTx(context.Background(), db.PublishPostTxParams{PostID: post.ID})
	require.NoError(t, err)
	recorder = scheduleRequest(t, server, editor, http.MethodPut, path, `{"publish_at":"`+second.Format(time.RFC3339)+`"}`)
	require.Equal(t, http.StatusConflict, recorder.Code)
	require.Contains(t, recorder.Body.String(), `"post_status":"published"`)

	// Setting another status through PUT /posts/:id ends a schedule without
	// tripping the publish_at constraint.
	other := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, second)
	recorder = scheduleRequest(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d", other.ID), `{"post_status":"archived"}`)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	got = reloadPost(t, store, other.ID)
	require.Equal(t, "archived", got.PostStatus)
	require.False(t, got.PublishAt.Valid)

	// The handler lets "scheduled" through unchanged; if the scheduler published the
	// post between its read and the write, the status stays (no constraint error).
	raced := schedulePostAt(t, store, scheduleDraft(t, store, editor, scheduleWord()), editor, second)
	_, err = store.PublishPostTx(context.Background(), db.PublishPostTxParams{PostID: raced.ID})
	require.NoError(t, err)
	updated, err := store.UpdatePost(context.Background(), db.UpdatePostParams{
		ID: raced.ID, Title: "Renamed", Description: raced.Description, UserID: raced.UserID, Username: raced.Username,
		Url: raced.Url, PostType: raced.PostType, PostStatus: postStatusScheduled, PostParent: raced.PostParent, MenuOrder: raced.MenuOrder,
	})
	require.NoError(t, err)
	require.Equal(t, postStatusPublished, updated.PostStatus)
	require.Equal(t, "Renamed", updated.Title)
}

// TestScheduledPostsAreNotPublic: until it publishes, a scheduled post is on no
// public endpoint (the post page, its blocks, lists and pages, search, author
// pages, adjacent/related). After the scheduler publishes it, the same reads
// show it, so the checks would catch a leak.
func TestScheduledPostsAreNotPublic(t *testing.T) {
	_, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	author := scheduleUser(t, store, RoleContributor)
	collab := newStubCollab(t, 0)
	server := scheduleServer(t, store, collab)
	word := scheduleWord()
	post := schedulePostAt(t, store, scheduleDraft(t, store, author, word), editor, time.Now().Add(time.Hour))

	get := func(path string) *httptest.ResponseRecorder {
		return flowServe(server, httptest.NewRequest(http.MethodGet, path, nil))
	}
	notFound := []string{
		fmt.Sprintf("/public/posts/%d", post.ID),
		"/public/posts/slug/" + post.Slug,
		fmt.Sprintf("/public/posts/%d/blocks", post.ID),
		"/public/authors/" + author.Username,
		"/public/authors/" + author.Username + "/posts",
	}
	absent := []string{
		"/public/posts?type=post&limit=100",
		"/public/posts/type/post",
		"/public/authors",
		fmt.Sprintf("/public/posts/%d/authors", post.ID),
		fmt.Sprintf("/public/posts/%d/adjacent", post.ID),
		fmt.Sprintf("/public/posts/%d/related", post.ID),
	}
	for _, path := range notFound {
		require.Equal(t, http.StatusNotFound, get(path).Code, path)
	}
	for _, path := range absent {
		recorder := get(path)
		require.NotContains(t, recorder.Body.String(), word, path)
		require.NotContains(t, recorder.Body.String(), author.Username, path)
	}
	// Search echoes the query, so look at its results.
	searchResults := func() string {
		var body struct {
			Results json.RawMessage `json:"results"`
		}
		recorder := get("/public/search?q=" + word)
		require.Equal(t, http.StatusOK, recorder.Code)
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		return string(body.Results)
	}
	require.NotContains(t, searchResults(), word)

	// Due now; the scheduler publishes it, and the same reads show it.
	schedulePostAt(t, store, post, editor, time.Now().Add(-time.Second))
	server.publishDueScheduledPosts(context.Background())
	require.Equal(t, postStatusPublished, reloadPost(t, store, post.ID).PostStatus)
	for _, path := range notFound {
		require.Equal(t, http.StatusOK, get(path).Code, path)
	}
	for _, path := range []string{"/public/posts?type=post&limit=100", "/public/posts/type/post"} {
		require.Contains(t, get(path).Body.String(), word, path)
	}
	require.Contains(t, searchResults(), word)
}
