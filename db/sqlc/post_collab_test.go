package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// collabDocWithImages is a Block Spec v1 doc with one image block per media id.
func collabDocWithImages(mediaIDs ...int64) json.RawMessage {
	order := []string{}
	blocks := map[string]any{}
	for i, id := range mediaIDs {
		blockID := fmt.Sprintf("img-%d", i)
		order = append(order, blockID)
		blocks[blockID] = map[string]any{"type": "image", "attrs": map[string]any{"mediaId": id}}
	}
	doc, _ := json.Marshal(map[string]any{"doc_version": 1, "blocks_order": order, "blocks": blocks})
	return doc
}

// contentMediaOrder returns the post's media links as media id -> order.
func contentMediaOrder(t *testing.T, postID int64) map[int64]int32 {
	t.Helper()
	rows, err := testQueries.GetMediaByPostWithOrder(context.Background(), postID)
	require.NoError(t, err)
	links := map[int64]int32{}
	for _, row := range rows {
		links[row.ID] = row.MediaOrder
	}
	return links
}

// TestStorePostCollabTx covers the collab server's store (#280): block_doc
// and the Yjs state commit together, the revision counts up, and the state
// is recorded against the revision it produced.
func TestStorePostCollabTx(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	editor := createTestUser(t)

	// No state yet: the load returns the working copy only.
	loaded, err := testQueries.GetPostCollab(ctx, post.ID)
	require.NoError(t, err)
	require.Nil(t, loaded.YdocState)
	require.False(t, loaded.YdocEpoch.Valid)
	require.False(t, loaded.YdocBlockRevision.Valid)
	startRevision := loaded.BlockRevision

	epoch := uuid.New()
	doc := json.RawMessage(`{"doc_version":1,"blocks_order":["a"],"blocks":{"a":{"type":"paragraph"}}}`)
	result, err := testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:       post.ID,
		State:        []byte{1, 2, 3},
		Epoch:        epoch,
		BlockDoc:     doc,
		BaseRevision: sql.NullInt64{Int64: startRevision, Valid: true},
		LastEditorID: sql.NullInt64{Int64: editor.ID, Valid: true},
	})
	require.NoError(t, err)
	require.Equal(t, startRevision+1, result.BlockRevision)

	loaded, err = testQueries.GetPostCollab(ctx, post.ID)
	require.NoError(t, err)
	require.JSONEq(t, string(doc), string(loaded.BlockDoc))
	require.Equal(t, startRevision+1, loaded.BlockRevision)
	require.Equal(t, []byte{1, 2, 3}, loaded.YdocState)
	require.Equal(t, epoch, loaded.YdocEpoch.UUID)
	require.Equal(t, loaded.BlockRevision, loaded.YdocBlockRevision.Int64)

	// State only (the server's derived doc failed validation): block_doc and
	// the revision stay, the state is replaced and still matches.
	result, err = testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:       post.ID,
		State:        []byte{4, 5},
		Epoch:        epoch,
		BaseRevision: sql.NullInt64{Int64: startRevision + 1, Valid: true},
	})
	require.NoError(t, err)
	require.Equal(t, startRevision+1, result.BlockRevision)
	loaded, err = testQueries.GetPostCollab(ctx, post.ID)
	require.NoError(t, err)
	require.JSONEq(t, string(doc), string(loaded.BlockDoc))
	require.Equal(t, []byte{4, 5}, loaded.YdocState)
	require.Equal(t, loaded.BlockRevision, loaded.YdocBlockRevision.Int64)

	// A write around the collab server (the REST autosave) bumps the post's
	// revision past the state's: the load can tell the state is stale.
	_, err = testQueries.UpdatePostBlocksIfRevisionMatches(ctx, UpdatePostBlocksIfRevisionMatchesParams{
		ID: post.ID, BlockDoc: doc, BlockRevision: loaded.BlockRevision,
	})
	require.NoError(t, err)
	loaded, err = testQueries.GetPostCollab(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, startRevision+2, loaded.BlockRevision)
	require.Equal(t, startRevision+1, loaded.YdocBlockRevision.Int64)

	// ...and a store based on the old revision is refused, writing nothing.
	_, err = testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:       post.ID,
		State:        []byte{9},
		Epoch:        uuid.New(),
		BlockDoc:     json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`),
		BaseRevision: sql.NullInt64{Int64: startRevision + 1, Valid: true},
	})
	require.ErrorIs(t, err, ErrCollabRevisionConflict)
	after, err := testQueries.GetPostCollab(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, loaded, after)

	// The same for a state-only store: the old state must not be re-stamped
	// with the new revision, or the next load would apply it.
	_, err = testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:       post.ID,
		State:        []byte{9},
		Epoch:        epoch,
		BaseRevision: sql.NullInt64{Int64: startRevision + 1, Valid: true},
	})
	require.ErrorIs(t, err, ErrCollabRevisionConflict)
	_, err = testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{PostID: post.ID, State: []byte{9}, Epoch: epoch})
	require.ErrorIs(t, err, ErrCollabBaseRevisionRequired)
	after, err = testQueries.GetPostCollab(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, loaded, after)
}

// A statement failing after block_doc was written (here the state upsert,
// refused by a constraint that only matches this post) rolls the block_doc
// write and revision bump back too.
func TestStorePostCollabTxRollsBack(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	before, err := testQueries.GetPostCollab(ctx, post.ID)
	require.NoError(t, err)
	changedBefore := postChangedAt(t, post.ID)

	constraint := fmt.Sprintf("test_reject_post_%d", post.ID)
	_, err = testQueries.db.ExecContext(ctx, fmt.Sprintf(
		`ALTER TABLE post_ydoc_state ADD CONSTRAINT %s CHECK (post_id <> %d) NOT VALID`, constraint, post.ID))
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = testQueries.db.ExecContext(context.Background(),
			fmt.Sprintf(`ALTER TABLE post_ydoc_state DROP CONSTRAINT IF EXISTS %s`, constraint))
	})

	_, err = testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:   post.ID,
		State:    []byte{1},
		Epoch:    uuid.New(),
		BlockDoc: json.RawMessage(`{"doc_version":1,"blocks_order":["x"],"blocks":{"x":{"type":"paragraph"}}}`),
	})
	require.Error(t, err)

	after, err := testQueries.GetPostCollab(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, before, after)
	require.True(t, postChangedAt(t, post.ID).Equal(changedBefore), "a rolled-back store moved changed_at")
}

// setPostChangedAt backdates the post's changed_at so a test can tell
// whether a write moved it.
func setPostChangedAt(t *testing.T, postID int64, at time.Time) {
	t.Helper()
	_, err := testQueries.db.ExecContext(context.Background(), `UPDATE posts SET changed_at = $2 WHERE id = $1`, postID, at)
	require.NoError(t, err)
}

func postChangedAt(t *testing.T, postID int64) time.Time {
	t.Helper()
	post, err := testQueries.GetPost(context.Background(), postID)
	require.NoError(t, err)
	return post.ChangedAt
}

// dbNow is the database clock, which now() in the queries reads, so tests
// don't depend on the test process's clock agreeing with it.
func dbNow(t *testing.T) time.Time {
	t.Helper()
	var now time.Time
	require.NoError(t, testQueries.db.QueryRowContext(context.Background(), `SELECT now()`).Scan(&now))
	return now
}

// A store with block_doc is an edit, so it updates changed_at (admin "last
// modified", the changed sort, sitemap lastmod). A state-only store or a
// refused one isn't and leaves it alone (#307).
func TestStorePostCollabTxChangedAt(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	past := time.Date(2000, 1, 2, 3, 4, 5, 0, time.UTC)
	setPostChangedAt(t, post.ID, past)
	doc := json.RawMessage(`{"doc_version":1,"blocks_order":["a"],"blocks":{"a":{"type":"paragraph"}}}`)

	epoch := uuid.New()
	_, err := testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:       post.ID,
		State:        []byte{1},
		Epoch:        epoch,
		BaseRevision: sql.NullInt64{Int64: post.BlockRevision, Valid: true},
	})
	require.NoError(t, err)
	require.True(t, postChangedAt(t, post.ID).Equal(past), "a state-only store moved changed_at")

	_, err = testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:       post.ID,
		State:        []byte{2},
		Epoch:        epoch,
		BlockDoc:     doc,
		BaseRevision: sql.NullInt64{Int64: post.BlockRevision - 1, Valid: true},
	})
	require.ErrorIs(t, err, ErrCollabRevisionConflict)
	require.True(t, postChangedAt(t, post.ID).Equal(past), "a refused store moved changed_at")

	before := dbNow(t)
	_, err = testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:       post.ID,
		State:        []byte{3},
		Epoch:        epoch,
		BlockDoc:     doc,
		BaseRevision: sql.NullInt64{Int64: post.BlockRevision, Valid: true},
	})
	require.NoError(t, err)
	require.False(t, postChangedAt(t, post.ID).Before(before), "a store with block_doc didn't move changed_at")
}

// The REST blocks save (y-websocket, until P5) updates changed_at itself,
// not only through the title update the handler may run after it (#307).
func TestUpdatePostBlocksIfRevisionMatchesChangedAt(t *testing.T) {
	post := createPostWithTransaction(t).Post
	setPostChangedAt(t, post.ID, time.Date(2000, 1, 2, 3, 4, 5, 0, time.UTC))

	before := dbNow(t)
	_, err := testQueries.UpdatePostBlocksIfRevisionMatches(context.Background(), UpdatePostBlocksIfRevisionMatchesParams{
		ID:            post.ID,
		BlockDoc:      json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`),
		BlockRevision: post.BlockRevision,
	})
	require.NoError(t, err)
	require.False(t, postChangedAt(t, post.ID).Before(before))
}

func TestStorePostCollabTxMissingPost(t *testing.T) {
	_, err := testStore.StorePostCollabTx(context.Background(), StorePostCollabTxParams{
		PostID:       -1,
		State:        []byte{1},
		Epoch:        uuid.New(),
		BaseRevision: sql.NullInt64{Int64: 1, Valid: true},
	})
	require.ErrorIs(t, err, sql.ErrNoRows)
}

// A last editor that doesn't exist (deleted meanwhile) is stored as NULL
// instead of failing the store on the foreign key.
func TestStorePostCollabTxUnknownLastEditor(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	_, err := testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:       post.ID,
		State:        []byte{1},
		Epoch:        uuid.New(),
		BaseRevision: sql.NullInt64{Int64: post.BlockRevision, Valid: true},
		LastEditorID: sql.NullInt64{Int64: -5, Valid: true},
	})
	require.NoError(t, err)

	var lastEditor sql.NullInt64
	require.NoError(t, testStore.ExecTx(ctx, func(q *Queries) error {
		return q.db.QueryRowContext(ctx, `SELECT last_editor_id FROM post_ydoc_state WHERE post_id = $1`, post.ID).Scan(&lastEditor)
	}))
	require.False(t, lastEditor.Valid)
}

// The store syncs the content image links like PUT /blocks does, but skips
// media ids without a row and never touches the featured image (order 0).
func TestStorePostCollabTxSyncsContentMedia(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	// createPostWithTransaction makes published posts.
	_, err := testQueries.db.ExecContext(ctx, `UPDATE posts SET post_status = 'draft' WHERE id = $1`, post.ID)
	require.NoError(t, err)
	_, featured := createTestMedia(t)
	_, kept := createTestMedia(t)
	_, removed := createTestMedia(t)
	_, added := createTestMedia(t)

	for mediaID, order := range map[int64]int32{featured.ID: 0, kept.ID: 1, removed.ID: 2} {
		_, err := testQueries.CreatePostMedia(ctx, CreatePostMediaParams{PostID: post.ID, MediaID: mediaID, Order: order})
		require.NoError(t, err)
	}

	const missingMediaID = int64(-77)
	_, err = testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:   post.ID,
		State:    []byte{1},
		Epoch:    uuid.New(),
		BlockDoc: collabDocWithImages(added.ID, missingMediaID, kept.ID, featured.ID, added.ID),
		// added.ID twice: one link, at its first position.
		MediaIDs: []int64{added.ID, missingMediaID, kept.ID, featured.ID, added.ID},
	})
	require.NoError(t, err)

	require.Equal(t, map[int64]int32{
		featured.ID: 0, // still the featured image
		added.ID:    1,
		kept.ID:     3, // document position; the missing id keeps its slot
	}, contentMediaOrder(t, post.ID))
}

// Media links are live fields (#135): a published post's links follow the
// published doc (publish syncs them), not the working copy.
func TestStorePostCollabTxPublishedPostKeepsMedia(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	_, linked := createTestMedia(t)
	_, other := createTestMedia(t)
	_, err := testQueries.CreatePostMedia(ctx, CreatePostMediaParams{PostID: post.ID, MediaID: linked.ID, Order: 1})
	require.NoError(t, err)
	publishPost(t, post.ID, post.UserID, "")

	_, err = testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:   post.ID,
		State:    []byte{1},
		Epoch:    uuid.New(),
		BlockDoc: collabDocWithImages(other.ID),
		MediaIDs: []int64{other.ID},
	})
	require.NoError(t, err)
	require.Equal(t, map[int64]int32{linked.ID: 1}, contentMediaOrder(t, post.ID))
}

// The state row goes with its post.
func TestPostYdocStateCascadesOnPostDelete(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	_, err := testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID: post.ID, State: []byte{1}, Epoch: uuid.New(),
		BaseRevision: sql.NullInt64{Int64: post.BlockRevision, Valid: true},
	})
	require.NoError(t, err)

	require.NoError(t, testStore.DeletePostTx(ctx, post.ID))

	var n int
	require.NoError(t, testStore.ExecTx(ctx, func(q *Queries) error {
		return q.db.QueryRowContext(ctx, `SELECT count(*) FROM post_ydoc_state WHERE post_id = $1`, post.ID).Scan(&n)
	}))
	require.Zero(t, n)
}
