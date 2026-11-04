package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// The activity log (#324, 000035) against the real database: the throttle, the
// collab store's "edited" event, append-only, and removed actors.

func activityVerbs(t *testing.T, objectType string, objectID int64) []string {
	t.Helper()
	rows, err := testQueries.ListActivity(context.Background(), ListActivityParams{
		ObjectType: sql.NullString{String: objectType, Valid: true},
		ObjectID:   sql.NullInt64{Int64: objectID, Valid: true},
		IsAdmin:    true,
		RowLimit:   100,
	})
	require.NoError(t, err)
	verbs := []string{}
	for i := len(rows) - 1; i >= 0; i-- { // oldest first
		verbs = append(verbs, rows[i].Verb)
	}
	return verbs
}

func TestCreateActivityThrottled(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	ana, marco := createTestUser(t), createTestUser(t)
	edited := func(actor User, window float64) int64 {
		n, err := testQueries.CreateActivityThrottled(ctx, CreateActivityThrottledParams{
			Verb: ActivityUpdated, ObjectType: ActivityObjectPost, ObjectID: post.ID,
			Payload: json.RawMessage(`{}`), ActorID: actor.ID, WindowSeconds: window,
		})
		require.NoError(t, err)
		return n
	}

	require.EqualValues(t, 1, edited(ana, 600))
	require.EqualValues(t, 0, edited(ana, 600), "a second one inside the window is dropped")
	require.EqualValues(t, 1, edited(marco, 600), "the window is per member")
	require.EqualValues(t, 1, edited(ana, 0), "past the window it records again")
	require.Equal(t, []string{"updated", "updated", "updated"}, activityVerbs(t, ActivityObjectPost, post.ID))

	// No member (removed meanwhile): nothing recorded, no foreign key error.
	n, err := testQueries.CreateActivityThrottled(ctx, CreateActivityThrottledParams{
		Verb: ActivityUpdated, ObjectType: ActivityObjectPost, ObjectID: post.ID,
		Payload: json.RawMessage(`{}`), ActorID: -1, WindowSeconds: 600,
	})
	require.NoError(t, err)
	require.Zero(t, n)
}

// TestStorePostCollabTxRecordsEdits: a store that writes block_doc records one
// "edited" per editor and window, in its transaction; a state-only store, a
// store without an editor and a store with the window off record none.
func TestStorePostCollabTxRecordsEdits(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	editor, other := createTestUser(t), createTestUser(t)
	doc := json.RawMessage(`{"doc_version":1,"blocks_order":["a"],"blocks":{"a":{"type":"paragraph"}}}`)
	epoch := uuid.New()

	store := func(blockDoc json.RawMessage, editorID int64, window time.Duration) {
		t.Helper()
		loaded, err := testQueries.GetPostCollab(ctx, post.ID)
		require.NoError(t, err)
		arg := StorePostCollabTxParams{
			PostID: post.ID, State: []byte{1}, Epoch: epoch, BlockDoc: blockDoc,
			BaseRevision:       sql.NullInt64{Int64: loaded.BlockRevision, Valid: true},
			EditActivityWindow: window,
		}
		if editorID != 0 {
			arg.LastEditorID = sql.NullInt64{Int64: editorID, Valid: true}
		}
		_, err = testStore.StorePostCollabTx(ctx, arg)
		require.NoError(t, err)
	}

	store(doc, editor.ID, 10*time.Minute)
	store(doc, editor.ID, 10*time.Minute) // same window: no second event
	store(nil, editor.ID, 10*time.Minute) // state only: not an edit
	store(doc, 0, 10*time.Minute)         // no editor
	store(doc, other.ID, 0)               // window off
	store(doc, other.ID, 10*time.Minute)

	rows, err := testQueries.ListActivity(ctx, ListActivityParams{
		ObjectType: sql.NullString{String: ActivityObjectPost, Valid: true},
		ObjectID:   sql.NullInt64{Int64: post.ID, Valid: true},
		IsAdmin:    true,
		RowLimit:   100,
	})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.Equal(t, other.ID, rows[0].ActorID.Int64)
	require.Equal(t, editor.ID, rows[1].ActorID.Int64)
	for _, row := range rows {
		require.Equal(t, ActivityEdited, row.Verb)
		require.JSONEq(t, `{}`, string(row.Payload))
	}
}

// TestActivityAppendOnly: rows can't be changed, except the actor going to NULL
// when the member is removed (the foreign key), which keeps the event.
func TestActivityAppendOnly(t *testing.T) {
	ctx := context.Background()
	actor := createTestUser(t)
	event, err := testQueries.CreateActivity(ctx, CreateActivityParams{
		ActorID: sql.NullInt64{Int64: actor.ID, Valid: true}, Verb: ActivityPublished,
		ObjectType: ActivityObjectPost, ObjectID: 42, Payload: json.RawMessage(`{"version_no":1}`),
	})
	require.NoError(t, err)
	require.Equal(t, actor.ID, event.ActorID.Int64)

	_, err = testQueries.db.ExecContext(ctx, `UPDATE activity SET verb = 'deleted' WHERE id = $1`, event.ID)
	require.ErrorContains(t, err, "append-only")
	_, err = testQueries.db.ExecContext(ctx, `UPDATE activity SET actor_id = NULL, payload = '{}' WHERE id = $1`, event.ID)
	require.ErrorContains(t, err, "append-only")

	require.NoError(t, testQueries.DeleteUser(ctx, actor.ID))
	var actorID sql.NullInt64
	var verb string
	require.NoError(t, testQueries.db.QueryRowContext(ctx, `SELECT actor_id, verb FROM activity WHERE id = $1`, event.ID).Scan(&actorID, &verb))
	require.False(t, actorID.Valid)
	require.Equal(t, ActivityPublished, verb)

	// An actor that is already gone is stored as NULL.
	gone, err := testQueries.CreateActivity(ctx, CreateActivityParams{
		ActorID: sql.NullInt64{Int64: actor.ID, Valid: true}, Verb: ActivityCreated,
		ObjectType: ActivityObjectPost, ObjectID: 42, Payload: json.RawMessage(`{}`),
	})
	require.NoError(t, err)
	require.False(t, gone.ActorID.Valid)
}

// TestActivityPayloadLimits: the table only takes a small JSON object and
// well-formed verbs.
func TestActivityPayloadLimits(t *testing.T) {
	ctx := context.Background()
	insert := func(verb string, payload string) error {
		_, err := testQueries.CreateActivity(ctx, CreateActivityParams{Verb: verb, ObjectType: ActivityObjectPost, ObjectID: 1, Payload: json.RawMessage(payload)})
		return err
	}
	require.Error(t, insert(ActivityCreated, `[1]`))
	require.Error(t, insert(ActivityCreated, `{"x":"`+stringOf('a', 1100)+`"}`))
	require.Error(t, insert("Created!", `{}`))
	require.NoError(t, insert(ActivityCreated, `{"post_type":"post"}`))
}

func stringOf(r byte, n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = r
	}
	return string(b)
}

// TestDeleteActivityBefore: the retention prune removes events older than the
// cutoff and keeps newer ones, a batch at a time.
func TestDeleteActivityBefore(t *testing.T) {
	ctx := context.Background()
	objectID := time.Now().UnixNano()
	for i := 0; i < 3; i++ {
		_, err := testQueries.db.ExecContext(ctx, `INSERT INTO activity (verb, object_type, object_id, created_at)
			VALUES ('created', 'post', $1, now() - interval '400 days')`, objectID)
		require.NoError(t, err)
	}
	_, err := testQueries.CreateActivity(ctx, CreateActivityParams{Verb: ActivityPublished, ObjectType: ActivityObjectPost, ObjectID: objectID, Payload: json.RawMessage(`{}`)})
	require.NoError(t, err)

	cutoff := time.Now().Add(-300 * 24 * time.Hour)
	n, err := testQueries.DeleteActivityBefore(ctx, DeleteActivityBeforeParams{Cutoff: cutoff, BatchSize: 2})
	require.NoError(t, err)
	require.EqualValues(t, 2, n, "one batch")
	_, err = testQueries.DeleteActivityBefore(ctx, DeleteActivityBeforeParams{Cutoff: cutoff, BatchSize: 1000})
	require.NoError(t, err)
	require.Equal(t, []string{ActivityPublished}, activityVerbs(t, ActivityObjectPost, objectID))
}
