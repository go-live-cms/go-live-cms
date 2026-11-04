package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The activity log and Home's feeds (#324), mostly through the real router
// against the test database (skipped without one): each write path records its
// event, who sees which event, Continue editing, Needs attention and retention.

type flowEvent struct {
	Verb    string
	Actor   sql.NullInt64
	Payload string
}

// objectEvents is an object's history, oldest first, read straight from the table.
func objectEvents(t *testing.T, conn *sql.DB, objectType string, objectID int64) []flowEvent {
	t.Helper()
	rows, err := conn.Query(`SELECT verb, actor_id, payload::text FROM activity
		WHERE object_type = $1 AND object_id = $2 ORDER BY id`, objectType, objectID)
	require.NoError(t, err)
	defer rows.Close()
	events := []flowEvent{}
	for rows.Next() {
		var e flowEvent
		require.NoError(t, rows.Scan(&e.Verb, &e.Actor, &e.Payload))
		events = append(events, e)
	}
	require.NoError(t, rows.Err())
	return events
}

func eventVerbs(events []flowEvent) []string {
	verbs := make([]string, len(events))
	for i, e := range events {
		verbs[i] = e.Verb
	}
	return verbs
}

// as sends a JSON request as caller.
func as(t *testing.T, server *Server, caller db.User, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	return doJSON(t, server, method, path, body, func(r *http.Request) {
		addAuthorization(t, r, server.tokenMaker, authorizationTypeBearer, caller.ID, caller.Username, time.Minute)
	})
}

func requireStatus(t *testing.T, recorder *httptest.ResponseRecorder, status int) {
	t.Helper()
	require.Equal(t, status, recorder.Code, recorder.Body.String())
}

func decodeID(t *testing.T, recorder *httptest.ResponseRecorder, key string) int64 {
	t.Helper()
	var rsp map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	var object struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(rsp[key], &object), recorder.Body.String())
	require.NotZero(t, object.ID, recorder.Body.String())
	return object.ID
}

// TestActivityRecordedOnPostWritePaths: create, update (throttled), schedule,
// cancel, publish, restore a version, unpublish, duplicate and delete each
// record one event, by the member who did it, with no title in the payload.
func TestActivityRecordedOnPostWritePaths(t *testing.T) {
	conn, store := scheduleTestDB(t)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	owner := scheduleUser(t, store, RoleContributor)
	editor := scheduleUser(t, store, RoleEditor)
	word := scheduleWord()

	created := as(t, server, owner, http.MethodPost, "/api/v1/posts", gin.H{
		"title": "Activity " + word, "url": "https://example.test/" + word, "author_ids": []int64{owner.ID},
	})
	requireStatus(t, created, http.StatusCreated)
	id := decodeID(t, created, "post")
	path := fmt.Sprintf("/api/v1/posts/%d", id)

	requireStatus(t, as(t, server, owner, http.MethodPut, path, gin.H{"title": "Renamed " + word}), http.StatusOK)
	requireStatus(t, as(t, server, owner, http.MethodPut, path, gin.H{"title": "Again " + word}), http.StatusOK)
	publishAt := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	requireStatus(t, as(t, server, editor, http.MethodPut, path+"/schedule", gin.H{"publish_at": publishAt.Format(time.RFC3339)}), http.StatusOK)
	requireStatus(t, as(t, server, editor, http.MethodDelete, path+"/schedule", nil), http.StatusOK)
	requireStatus(t, as(t, server, editor, http.MethodPost, path+"/publish", nil), http.StatusOK)
	requireStatus(t, as(t, server, editor, http.MethodPost, path+"/versions/1/restore-settings", nil), http.StatusOK)
	requireStatus(t, as(t, server, editor, http.MethodPost, path+"/unpublish", nil), http.StatusOK)
	// A status set through PUT is its own event, whatever was saved just before.
	requireStatus(t, as(t, server, editor, http.MethodPut, path, gin.H{"title": "Editor's " + word}), http.StatusOK)
	requireStatus(t, as(t, server, editor, http.MethodPut, path, gin.H{"post_status": "archived"}), http.StatusOK)
	duplicated := as(t, server, owner, http.MethodPost, path+"/duplicate", nil)
	requireStatus(t, duplicated, http.StatusCreated)
	copyID := decodeID(t, duplicated, "post")
	requireStatus(t, as(t, server, owner, http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d", copyID), nil), http.StatusOK)

	events := objectEvents(t, conn, db.ActivityObjectPost, id)
	require.Equal(t, []string{"created", "updated", "scheduled", "unscheduled", "published", "version_restored", "unpublished", "updated", "status_changed"}, eventVerbs(events))
	actors := []int64{owner.ID, owner.ID, editor.ID, editor.ID, editor.ID, editor.ID, editor.ID, editor.ID, editor.ID}
	for i, e := range events {
		require.Equal(t, actors[i], e.Actor.Int64, e.Verb)
		require.NotContains(t, e.Payload, word, "no titles in the log")
	}
	require.JSONEq(t, `{"post_type":"post"}`, events[0].Payload)
	require.JSONEq(t, `{}`, events[1].Payload)
	require.JSONEq(t, fmt.Sprintf(`{"publish_at":%q}`, publishAt.Format(time.RFC3339)), events[2].Payload)
	require.JSONEq(t, `{"version_no":1}`, events[4].Payload)
	require.JSONEq(t, `{"version_no":1}`, events[5].Payload)
	require.JSONEq(t, `{"post_status":"archived","previous_post_status":"draft"}`, events[8].Payload)

	copyEvents := objectEvents(t, conn, db.ActivityObjectPost, copyID)
	require.Equal(t, []string{"created", "deleted"}, eventVerbs(copyEvents))
	require.JSONEq(t, fmt.Sprintf(`{"post_type":"post","source_id":%d}`, id), copyEvents[0].Payload)
}

// TestActivityRecordedOnMemberAndSettingsPaths: invitations, role changes (both
// routes), removal and settings record their events with ids and roles, never
// the email or the values; a removed member's own events stay, without them.
func TestActivityRecordedOnMemberAndSettingsPaths(t *testing.T) {
	conn, store := scheduleTestDB(t)
	server := authFlowServer(t, store, nil)
	admin := scheduleUser(t, store, RoleAdmin)
	member := scheduleUser(t, store, RoleContributor)
	ctx := context.Background()
	marker := time.Now().UnixNano()
	_, err := store.CreateActivity(ctx, db.CreateActivityParams{
		ActorID: sql.NullInt64{Int64: member.ID, Valid: true}, Verb: db.ActivityCreated,
		ObjectType: db.ActivityObjectPost, ObjectID: marker, Payload: json.RawMessage(`{}`),
	})
	require.NoError(t, err)

	email := strings.ReplaceAll(uuid.NewString(), "-", "") + "@example.test"
	invited := as(t, server, admin, http.MethodPost, "/api/v1/invitations", gin.H{"email": email, "role": RoleContributor})
	requireStatus(t, invited, http.StatusCreated)
	invitationID := decodeID(t, invited, "invitation")
	requireStatus(t, as(t, server, admin, http.MethodDelete, fmt.Sprintf("/api/v1/invitations/%d", invitationID), nil), http.StatusOK)

	userPath := fmt.Sprintf("/api/v1/users/%d", member.ID)
	requireStatus(t, as(t, server, admin, http.MethodPut, userPath+"/role", gin.H{"role": RoleEditor}), http.StatusOK)
	// The role it already has: nothing changed, no event.
	requireStatus(t, as(t, server, admin, http.MethodPut, userPath+"/role", gin.H{"role": RoleEditor}), http.StatusOK)
	requireStatus(t, as(t, server, admin, http.MethodPut, userPath, gin.H{"role": RoleContributor}), http.StatusOK)

	added := "added" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	createdUser := as(t, server, admin, http.MethodPost, "/api/v1/users", gin.H{
		"username": added, "email": added + "@example.test", "full_name": "Added Member",
		"password": "correct horse battery staple", "role": RoleContributor,
	})
	requireStatus(t, createdUser, http.StatusCreated)
	addedID := decodeID(t, createdUser, "user")
	addedEvents := objectEvents(t, conn, db.ActivityObjectUser, addedID)
	require.Equal(t, []string{"created"}, eventVerbs(addedEvents))
	require.JSONEq(t, `{"role":"contributor"}`, addedEvents[0].Payload)
	require.Equal(t, admin.ID, addedEvents[0].Actor.Int64)

	settings, err := store.GetSettings(ctx)
	require.NoError(t, err)
	// The value it already has: the shared test database's settings stay as they are.
	requireStatus(t, as(t, server, admin, http.MethodPut, "/api/v1/settings", gin.H{"post_url_structure": settings.PostUrlStructure}), http.StatusOK)

	requireStatus(t, as(t, server, admin, http.MethodDelete, userPath, gin.H{"transfer_to_id": admin.ID}), http.StatusOK)

	invitation := objectEvents(t, conn, db.ActivityObjectInvitation, invitationID)
	require.Equal(t, []string{"invited", "invitation_revoked"}, eventVerbs(invitation))
	require.JSONEq(t, `{"role":"contributor"}`, invitation[0].Payload)
	require.NotContains(t, invitation[0].Payload, "example.test")

	user := objectEvents(t, conn, db.ActivityObjectUser, member.ID)
	require.Equal(t, []string{"role_changed", "role_changed", "removed"}, eventVerbs(user))
	require.JSONEq(t, `{"role":"editor","previous_role":"contributor"}`, user[0].Payload)
	require.JSONEq(t, `{"role":"contributor","previous_role":"editor"}`, user[1].Payload)
	require.JSONEq(t, fmt.Sprintf(`{"transfer_to_id":%d,"posts_reassigned":0}`, admin.ID), user[2].Payload)
	for _, e := range append(invitation, user...) {
		require.Equal(t, admin.ID, e.Actor.Int64, e.Verb)
	}

	var payload string
	require.NoError(t, conn.QueryRow(`SELECT payload::text FROM activity
		WHERE object_type = 'settings' AND verb = 'settings_updated' AND actor_id = $1`, admin.ID).Scan(&payload))
	require.JSONEq(t, `{"fields":["post_url_structure"]}`, payload)

	own := objectEvents(t, conn, db.ActivityObjectPost, marker)
	require.Len(t, own, 1)
	require.False(t, own[0].Actor.Valid, "the removed member's event stays, without its actor")
}

type activityPage struct {
	Activity   []ActivityResponse `json:"activity"`
	NextBefore *int64             `json:"next_before"`
}

func getActivity(t *testing.T, server *Server, caller db.User, query string) activityPage {
	t.Helper()
	recorder := as(t, server, caller, http.MethodGet, "/api/v1/activity"+query, nil)
	requireStatus(t, recorder, http.StatusOK)
	var page activityPage
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &page))
	return page
}

// TestActivityFeedVisibility: contributors see their own posts' events and
// published posts' events, never someone else's draft or media; editors see
// every post and media event; member and settings events are admins'.
func TestActivityFeedVisibility(t *testing.T) {
	_, store := scheduleTestDB(t)
	server := authFlowServer(t, store, nil)
	owner := scheduleUser(t, store, RoleContributor)
	other := scheduleUser(t, store, RoleContributor)
	editor := scheduleUser(t, store, RoleEditor)
	admin := scheduleUser(t, store, RoleAdmin)
	ctx := context.Background()
	word := scheduleWord()

	draft := postReadPost(t, store, owner, "draft", "Draft "+word, "draft-"+word)
	published := postReadPost(t, store, owner, "published", "Live "+word, "live-"+word)
	media, err := store.CreateMedia(ctx, db.CreateMediaParams{
		Name: "pic " + word, MediaPath: "/tmp/" + word + ".png", UserID: owner.ID, MimeType: "image/png",
	})
	require.NoError(t, err)

	record := func(actor db.User, verb, objectType string, objectID int64) int64 {
		event, err := store.CreateActivity(ctx, db.CreateActivityParams{
			ActorID: sql.NullInt64{Int64: actor.ID, Valid: true}, Verb: verb,
			ObjectType: objectType, ObjectID: objectID, Payload: json.RawMessage(`{}`),
		})
		require.NoError(t, err)
		return event.ID
	}
	first := record(owner, db.ActivityCreated, db.ActivityObjectPost, draft.ID)
	record(owner, db.ActivityUpdated, db.ActivityObjectPost, draft.ID)
	record(editor, db.ActivityPublished, db.ActivityObjectPost, published.ID)
	record(owner, db.ActivityUploaded, db.ActivityObjectMedia, media.ID)
	record(admin, db.ActivityRoleChanged, db.ActivityObjectUser, other.ID)
	settingsEvent := record(admin, db.ActivitySettingsUpdated, db.ActivityObjectSettings, -word2ID(word))

	mine := map[string]bool{
		fmt.Sprintf("post:%d", draft.ID): true, fmt.Sprintf("post:%d", published.ID): true,
		fmt.Sprintf("media:%d", media.ID): true, fmt.Sprintf("user:%d", other.ID): true,
		fmt.Sprintf("settings:%d", -word2ID(word)): true,
	}
	// seen pages back through caller's feed to the fixture's first event and
	// lists the fixture's events it shows, newest first.
	// (Other packages' tests may write events meanwhile, hence the filter.)
	events := func(caller db.User) []ActivityResponse {
		t.Helper()
		out := []ActivityResponse{}
		query := "?limit=50"
		for range 40 {
			page := getActivity(t, server, caller, query)
			for _, e := range page.Activity {
				if e.ID >= first && mine[fmt.Sprintf("%s:%d", e.ObjectType, e.ObjectID)] {
					out = append(out, e)
				}
			}
			if page.NextBefore == nil || *page.NextBefore < first {
				return out
			}
			query = fmt.Sprintf("?limit=50&before=%d", *page.NextBefore)
		}
		t.Fatal("feed paging did not reach the fixture")
		return nil
	}
	seen := func(caller db.User) []string {
		out := []string{}
		for _, e := range events(caller) {
			out = append(out, e.Verb+" "+e.ObjectType)
		}
		return out
	}

	require.Equal(t, []string{"published post"}, seen(other))
	require.Equal(t, []string{"uploaded media", "published post", "updated post", "created post"}, seen(owner))
	require.Equal(t, []string{"uploaded media", "published post", "updated post", "created post"}, seen(editor))
	adminEvents := events(admin)
	require.Equal(t, []string{"settings_updated settings", "role_changed user", "uploaded media", "published post", "updated post", "created post"}, seen(admin))
	require.Equal(t, settingsEvent, adminEvents[0].ID)
	// Media and member objects carry their current names.
	require.Equal(t, other.Username, adminEvents[1].User.Username)
	require.Equal(t, "pic "+word, adminEvents[2].Media.Name)
	require.Equal(t, owner.Username, adminEvents[2].Actor.Username)

	// One post's history, with the names joined now.
	page := getActivity(t, server, other, fmt.Sprintf("?post_id=%d", published.ID))
	require.Len(t, page.Activity, 1)
	got := page.Activity[0]
	require.Equal(t, "Live "+word, got.Post.Title)
	require.Equal(t, "published", got.Post.PostStatus)
	require.Equal(t, editor.Username, got.Actor.Username)
	require.Nil(t, page.NextBefore)
	require.Empty(t, getActivity(t, server, other, fmt.Sprintf("?post_id=%d", draft.ID)).Activity)

	// Paging by id.
	page = getActivity(t, server, owner, fmt.Sprintf("?post_id=%d&limit=1", draft.ID))
	require.Len(t, page.Activity, 1)
	require.Equal(t, db.ActivityUpdated, page.Activity[0].Verb)
	require.NotNil(t, page.NextBefore)
	page = getActivity(t, server, owner, fmt.Sprintf("?post_id=%d&limit=1&before=%d", draft.ID, *page.NextBefore))
	require.Equal(t, db.ActivityCreated, page.Activity[0].Verb)
	require.Nil(t, page.NextBefore)

	for _, bad := range []string{"?limit=0", "?limit=x", "?before=-1", "?post_id=abc"} {
		requireStatus(t, as(t, server, owner, http.MethodGet, "/api/v1/activity"+bad, nil), http.StatusBadRequest)
	}
	requireStatus(t, doJSON(t, server, http.MethodGet, "/api/v1/activity", nil, nil), http.StatusUnauthorized)
}

// word2ID turns a scheduleWord into a number, for an object id no other test uses.
func word2ID(word string) int64 {
	var n int64
	for _, r := range word {
		n = (n*31 + int64(r)) % 1_000_000_000_000
	}
	return n + 1
}

// TestContinueEditing: the caller's own recent work, newest first, from their
// events and from being the collab server's last editor; posts they can't read
// any more are left out.
func TestContinueEditing(t *testing.T) {
	conn, store := scheduleTestDB(t)
	server := authFlowServer(t, store, nil)
	owner := scheduleUser(t, store, RoleContributor)
	other := scheduleUser(t, store, RoleContributor)
	editor := scheduleUser(t, store, RoleEditor)
	ctx := context.Background()
	word := scheduleWord()

	older := postReadPost(t, store, owner, "draft", "Older "+word, "older-"+word)
	newer := postReadPost(t, store, owner, "draft", "Newer "+word, "newer-"+word)
	live := postReadPost(t, store, owner, "draft", "Live "+word, "live-"+word)
	othersDraft := postReadPost(t, store, other, "draft", "Theirs "+word, "theirs-"+word)
	othersPublished := postReadPost(t, store, other, "published", "Shared "+word, "shared-"+word)

	_, err := conn.Exec(`INSERT INTO activity (actor_id, verb, object_type, object_id, created_at)
		VALUES ($1, 'updated', 'post', $2, now() - interval '2 hours')`, owner.ID, older.ID)
	require.NoError(t, err)
	record := func(actor db.User, verb string, post db.Post) {
		_, err := store.CreateActivity(ctx, db.CreateActivityParams{
			ActorID: sql.NullInt64{Int64: actor.ID, Valid: true}, Verb: verb,
			ObjectType: db.ActivityObjectPost, ObjectID: post.ID, Payload: json.RawMessage(`{}`),
		})
		require.NoError(t, err)
	}
	record(owner, db.ActivityCreated, newer)
	record(owner, db.ActivityUpdated, othersDraft) // can't read it now
	record(owner, db.ActivityUpdated, othersPublished)
	record(owner, db.ActivityPublished, older) // not "worked on"
	// A post owner only opened: the collab server's state-only store names them as
	// its last editor, but there is no edit event, so it isn't "worked on".
	opened := postReadPost(t, store, owner, "draft", "Opened "+word, "opened-"+word)
	_, err = store.StorePostCollabTx(ctx, db.StorePostCollabTxParams{
		PostID: opened.ID, State: []byte{1}, Epoch: uuid.New(),
		BaseRevision: sql.NullInt64{Int64: opened.BlockRevision, Valid: true},
		LastEditorID: sql.NullInt64{Int64: owner.ID, Valid: true},
	})
	require.NoError(t, err)
	// The collab server's last store, by owner: an "edited" event, and changed_at
	// as the exact time.
	_, err = store.StorePostCollabTx(ctx, db.StorePostCollabTxParams{
		PostID: live.ID, State: []byte{1}, Epoch: uuid.New(),
		BlockDoc:           json.RawMessage(`{"doc_version":1,"blocks_order":["a"],"blocks":{"a":{"type":"paragraph"}}}`),
		LastEditorID:       sql.NullInt64{Int64: owner.ID, Valid: true},
		EditActivityWindow: activityEditWindow,
	})
	require.NoError(t, err)

	list := func(caller db.User, query string) []ContinueEditingPost {
		t.Helper()
		recorder := as(t, server, caller, http.MethodGet, "/api/v1/home/continue-editing"+query, nil)
		requireStatus(t, recorder, http.StatusOK)
		var rsp struct {
			Posts []ContinueEditingPost `json:"posts"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
		return rsp.Posts
	}
	ids := func(posts []ContinueEditingPost) []int64 {
		out := make([]int64, len(posts))
		for i, p := range posts {
			out[i] = p.ID
		}
		return out
	}

	got := list(owner, "")
	require.Equal(t, []int64{live.ID, othersPublished.ID, newer.ID, older.ID}, ids(got))
	require.Equal(t, "Live "+word, got[0].Title)
	require.Equal(t, "published", got[1].PostStatus)
	require.WithinDuration(t, time.Now().Add(-2*time.Hour), got[3].EditedAt, 5*time.Minute)
	require.Equal(t, []int64{live.ID, othersPublished.ID}, ids(list(owner, "?limit=2")))

	// An editor may read every post, so their own work on someone's draft shows.
	record(editor, db.ActivityUpdated, othersDraft)
	require.Equal(t, []int64{othersDraft.ID}, ids(list(editor, "")))
	require.Empty(t, list(other, ""), "other's posts were edited by others, not by them")

	requireStatus(t, as(t, server, owner, http.MethodGet, "/api/v1/home/continue-editing?limit=0", nil), http.StatusBadRequest)
}

// TestNeedsAttention: failed scheduled publishes (a contributor's own), and for
// editors the published posts with unpublished changes and the missing alt text
// count; the review requests slot is empty.
func TestNeedsAttention(t *testing.T) {
	conn, store := scheduleTestDB(t)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	owner := scheduleUser(t, store, RoleContributor)
	other := scheduleUser(t, store, RoleContributor)
	editor := scheduleUser(t, store, RoleEditor)
	ctx := context.Background()
	word := scheduleWord()

	failed := schedulePostAt(t, store, scheduleDraft(t, store, owner, word), editor, time.Now().Add(time.Hour))
	_, err := conn.Exec(`UPDATE posts SET publish_failed_at = now(), publish_error = 'collab_flush_failed', publish_attempts = 2 WHERE id = $1`, failed.ID)
	require.NoError(t, err)

	changed := scheduleDraft(t, store, editor, word+"b")
	requireStatus(t, as(t, server, editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", changed.ID), nil), http.StatusOK)
	_, err = store.StorePostCollabTx(ctx, db.StorePostCollabTxParams{
		PostID: changed.ID, State: []byte{1}, Epoch: uuid.New(),
		BlockDoc:     json.RawMessage(`{"doc_version":1,"blocks_order":["n"],"blocks":{"n":{"type":"paragraph"}}}`),
		LastEditorID: sql.NullInt64{Int64: editor.ID, Valid: true},
	})
	require.NoError(t, err)

	_, err = store.CreateMedia(ctx, db.CreateMediaParams{Name: "no alt " + word, MediaPath: "/tmp/" + word + ".png", UserID: owner.ID, MimeType: "image/png"})
	require.NoError(t, err)

	get := func(caller db.User) (NeedsAttentionResponse, string) {
		t.Helper()
		recorder := as(t, server, caller, http.MethodGet, "/api/v1/home/needs-attention", nil)
		requireStatus(t, recorder, http.StatusOK)
		var rsp NeedsAttentionResponse
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
		return rsp, recorder.Body.String()
	}
	hasPost := func(posts []FailedSchedule, id int64) *FailedSchedule {
		for i := range posts {
			if posts[i].ID == id {
				return &posts[i]
			}
		}
		return nil
	}

	mine, body := get(owner)
	item := hasPost(mine.FailedSchedules.Posts, failed.ID)
	require.NotNil(t, item, body)
	require.Equal(t, "collab_flush_failed", item.Reason)
	require.EqualValues(t, 2, item.Attempts)
	require.NotNil(t, item.FailedAt)
	require.GreaterOrEqual(t, mine.FailedSchedules.Total, int64(1))
	require.Nil(t, mine.UnpublishedChanges)
	require.Nil(t, mine.MissingAlt)
	require.Contains(t, body, `"review_requests":[]`)
	require.Contains(t, body, `"unpublished_changes":null`)

	theirs, _ := get(other)
	require.Nil(t, hasPost(theirs.FailedSchedules.Posts, failed.ID))

	editors, body := get(editor)
	require.NotNil(t, hasPost(editors.FailedSchedules.Posts, failed.ID), body)
	require.NotNil(t, editors.UnpublishedChanges, body)
	var found *UnpublishedChangesPost
	for i, p := range editors.UnpublishedChanges.Posts {
		if p.ID == changed.ID {
			found = &editors.UnpublishedChanges.Posts[i]
		}
	}
	require.NotNil(t, found, body)
	require.Equal(t, editor.ID, found.LastEditor.ID)
	require.GreaterOrEqual(t, editors.UnpublishedChanges.Total, int64(1))
	require.NotNil(t, editors.MissingAlt)
	require.GreaterOrEqual(t, editors.MissingAlt.MediaCount, int64(1))
}

// TestPruneActivity: retention removes events older than the cutoff and keeps
// the rest; RunActivityRetention is off at 0 and stops with its context.
func TestPruneActivity(t *testing.T) {
	conn, store := scheduleTestDB(t)
	server := authFlowServer(t, store, nil)
	ctx := context.Background()
	objectID := time.Now().UnixNano()
	_, err := conn.Exec(`INSERT INTO activity (verb, object_type, object_id, created_at)
		VALUES ('created', 'post', $1, now() - interval '200 days')`, objectID)
	require.NoError(t, err)
	_, err = store.CreateActivity(ctx, db.CreateActivityParams{Verb: db.ActivityPublished, ObjectType: db.ActivityObjectPost, ObjectID: objectID, Payload: json.RawMessage(`{}`)})
	require.NoError(t, err)

	deleted, err := server.pruneActivity(ctx, time.Now().Add(-90*24*time.Hour))
	require.NoError(t, err)
	require.GreaterOrEqual(t, deleted, int64(1))
	require.Equal(t, []string{"published"}, eventVerbs(objectEvents(t, conn, db.ActivityObjectPost, objectID)))

	server.RunActivityRetention(ctx, 0) // returns at once
	stopped, cancel := context.WithCancel(ctx)
	cancel()
	done := make(chan struct{})
	go func() {
		server.RunActivityRetention(stopped, 90*24*time.Hour)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("RunActivityRetention did not stop with its context")
	}
}

type failingActivity struct{}

func (failingActivity) CreateActivity(context.Context, db.CreateActivityParams) (db.Activity, error) {
	return db.Activity{}, errors.New("db down")
}

func (failingActivity) CreateActivityThrottled(context.Context, db.CreateActivityThrottledParams) (int64, error) {
	return 0, errors.New("db down")
}

// TestActivityFailureKeepsTheChange: the change stands when its event can't be
// written; the failure is logged by verb and ids only.
func TestActivityFailureKeepsTheChange(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)
	server.activity = failingActivity{}
	var logs bytes.Buffer
	server.logger = slog.New(slog.NewJSONHandler(&logs, nil))

	store.EXPECT().UnpublishPost(gomock.Any(), int64(5)).Return(db.Post{ID: 5, Title: "Secret title", PostStatus: "draft"}, nil)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/posts/5/unpublish", nil)
	signInAs(t, server, store, request, testReader)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	requireStatus(t, recorder, http.StatusOK)

	require.Contains(t, logs.String(), `"msg":"activity_record_failed"`)
	require.Contains(t, logs.String(), `"verb":"unpublished"`)
	require.NotContains(t, logs.String(), "Secret title")
}

// TestUpdatePostRecordsThrottledEvent: PUT /posts/:id is a throttled "updated"
// by the caller (the settings panel saves as you type).
func TestUpdatePostRecordsThrottledEvent(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)
	post := db.Post{ID: 8, Title: "Before", UserID: testReader.ID, PostType: "post", PostStatus: "draft", Slug: "before"}
	store.EXPECT().GetPost(gomock.Any(), post.ID).Return(post, nil)
	store.EXPECT().UpdatePost(gomock.Any(), gomock.Any()).Return(post, nil)

	recorder := doJSON(t, server, http.MethodPut, "/api/v1/posts/8", gin.H{"title": "After"}, func(r *http.Request) {
		signInAs(t, server, store, r, testReader)
	})
	requireStatus(t, recorder, http.StatusOK)

	rec := activityOf(t, server)
	require.Equal(t, []string{"updated post:8~"}, rec.verbs())
	require.Equal(t, testReader.ID, rec.throttled[0].ActorID)
	require.Equal(t, activityEditWindow.Seconds(), rec.throttled[0].WindowSeconds)
}

// TestActivityRoutesNeedAContentRole: like every admin read (#393).
func TestActivityRoutesNeedAContentRole(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	server := newTestServer(t, store)
	for _, path := range []string{"/api/v1/activity", "/api/v1/home/continue-editing", "/api/v1/home/needs-attention"} {
		requireStatus(t, doJSON(t, server, http.MethodGet, path, nil, nil), http.StatusUnauthorized)
	}
}
