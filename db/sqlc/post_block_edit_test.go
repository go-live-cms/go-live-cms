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

// blockEditsOf reads a post's post_block_edits as block id -> row.
func blockEditsOf(t *testing.T, postID int64) map[string]ListPostBlockEditsRow {
	t.Helper()
	rows, err := testQueries.ListPostBlockEdits(context.Background(), postID)
	require.NoError(t, err)
	out := make(map[string]ListPostBlockEditsRow, len(rows))
	for _, row := range rows {
		out[row.BlockID] = row
	}
	return out
}

// Per-block attribution (#328) is written by the collab store in its own
// transaction, only with block_doc: upserted for the changed blocks, pruned to the
// blocks the new doc has, untouched by a state-only store, unknown users as NULL.
func TestStorePostCollabTxBlockEdits(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	ana := createTestUser(t)
	kenji := createTestUser(t)
	epoch := uuid.New()
	at := time.Date(2026, 11, 6, 10, 0, 0, 123_000_000, time.UTC)
	revision := post.BlockRevision

	store := func(doc string, ids []string, edits []PostBlockEditInput) {
		t.Helper()
		result, err := testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
			PostID:       post.ID,
			State:        []byte{1},
			Epoch:        epoch,
			BlockDoc:     json.RawMessage(doc),
			BaseRevision: sql.NullInt64{Int64: revision, Valid: true},
			BlockIDs:     ids,
			BlockEdits:   edits,
		})
		require.NoError(t, err)
		revision = result.BlockRevision
	}

	store(`{"doc_version":1,"blocks_order":["blk-a","blk-b"],"blocks":{"blk-a":{"type":"paragraph"},"blk-b":{"type":"paragraph"}}}`,
		[]string{"blk-a", "blk-b"},
		[]PostBlockEditInput{{BlockID: "blk-a", UserID: ana.ID, EditedAt: at}, {BlockID: "blk-b", UserID: kenji.ID, EditedAt: at.Add(time.Second)}})
	edits := blockEditsOf(t, post.ID)
	require.Len(t, edits, 2)
	require.Equal(t, sql.NullInt64{Int64: ana.ID, Valid: true}, edits["blk-a"].UserID)
	require.Equal(t, ana.Username, edits["blk-a"].Username.String)
	require.True(t, at.Equal(edits["blk-a"].EditedAt), "edited_at %v, want %v", edits["blk-a"].EditedAt, at)
	require.Equal(t, kenji.ID, edits["blk-b"].UserID.Int64)

	// The next store changes blk-b only (Ana now), deletes blk-a and adds blk-c by a
	// user that doesn't exist: blk-a's row goes, blk-c's user is NULL.
	later := at.Add(time.Minute)
	store(`{"doc_version":1,"blocks_order":["blk-b","blk-c"],"blocks":{"blk-b":{"type":"paragraph"},"blk-c":{"type":"paragraph"}}}`,
		[]string{"blk-b", "blk-c"},
		[]PostBlockEditInput{{BlockID: "blk-b", UserID: ana.ID, EditedAt: later}, {BlockID: "blk-c", UserID: -7, EditedAt: later}})
	edits = blockEditsOf(t, post.ID)
	require.Len(t, edits, 2)
	require.NotContains(t, edits, "blk-a")
	require.Equal(t, ana.ID, edits["blk-b"].UserID.Int64)
	require.True(t, later.Equal(edits["blk-b"].EditedAt))
	require.False(t, edits["blk-c"].UserID.Valid)
	require.False(t, edits["blk-c"].Username.Valid)

	// A store with no attribution keeps the rows of blocks still in the doc.
	store(`{"doc_version":1,"blocks_order":["blk-b","blk-c"],"blocks":{"blk-b":{"type":"paragraph","text":"x"},"blk-c":{"type":"paragraph"}}}`,
		[]string{"blk-b", "blk-c"}, nil)
	require.Equal(t, edits, blockEditsOf(t, post.ID))

	// A state-only store writes and deletes nothing, whatever it carries.
	_, err := testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:       post.ID,
		State:        []byte{2},
		Epoch:        epoch,
		BaseRevision: sql.NullInt64{Int64: revision, Valid: true},
		BlockIDs:     []string{},
		BlockEdits:   []PostBlockEditInput{{BlockID: "blk-b", UserID: kenji.ID, EditedAt: later.Add(time.Hour)}},
	})
	require.NoError(t, err)
	require.Equal(t, edits, blockEditsOf(t, post.ID))

	// An empty doc (everything deleted) prunes every row.
	store(`{"doc_version":1,"blocks_order":[],"blocks":{}}`, nil, nil)
	require.Empty(t, blockEditsOf(t, post.ID))
}

// A failing store writes no attribution: the rows come back as they were.
func TestStorePostCollabTxBlockEditsRollBack(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	ana := createTestUser(t)
	at := time.Date(2026, 11, 6, 10, 0, 0, 0, time.UTC)
	_, err := testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:     post.ID,
		State:      []byte{1},
		Epoch:      uuid.New(),
		BlockDoc:   json.RawMessage(`{"doc_version":1,"blocks_order":["blk-a"],"blocks":{"blk-a":{"type":"paragraph"}}}`),
		BlockIDs:   []string{"blk-a"},
		BlockEdits: []PostBlockEditInput{{BlockID: "blk-a", UserID: ana.ID, EditedAt: at}},
	})
	require.NoError(t, err)
	before := blockEditsOf(t, post.ID)
	require.Len(t, before, 1)

	constraint := fmt.Sprintf("test_reject_post_%d", post.ID)
	_, err = testQueries.db.ExecContext(ctx, fmt.Sprintf(
		`ALTER TABLE post_ydoc_state ADD CONSTRAINT %s CHECK (post_id <> %d) NOT VALID`, constraint, post.ID))
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = testQueries.db.ExecContext(context.Background(),
			fmt.Sprintf(`ALTER TABLE post_ydoc_state DROP CONSTRAINT IF EXISTS %s`, constraint))
	})

	_, err = testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:     post.ID,
		State:      []byte{2},
		Epoch:      uuid.New(),
		BlockDoc:   json.RawMessage(`{"doc_version":1,"blocks_order":["blk-b"],"blocks":{"blk-b":{"type":"paragraph"}}}`),
		BlockIDs:   []string{"blk-b"},
		BlockEdits: []PostBlockEditInput{{BlockID: "blk-b", UserID: ana.ID, EditedAt: at.Add(time.Minute)}},
	})
	require.Error(t, err)
	require.Equal(t, before, blockEditsOf(t, post.ID))
}

// A removed member's rows stay, without a user (ON DELETE SET NULL).
func TestPostBlockEditsUserDeleted(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	gone := createTestUser(t)
	_, err := testStore.StorePostCollabTx(ctx, StorePostCollabTxParams{
		PostID:     post.ID,
		State:      []byte{1},
		Epoch:      uuid.New(),
		BlockDoc:   json.RawMessage(`{"doc_version":1,"blocks_order":["blk-a"],"blocks":{"blk-a":{"type":"paragraph"}}}`),
		BlockIDs:   []string{"blk-a"},
		BlockEdits: []PostBlockEditInput{{BlockID: "blk-a", UserID: gone.ID, EditedAt: time.Now()}},
	})
	require.NoError(t, err)
	_, err = testQueries.db.ExecContext(ctx, `DELETE FROM users WHERE id = $1`, gone.ID)
	require.NoError(t, err)

	edits := blockEditsOf(t, post.ID)
	require.Contains(t, edits, "blk-a")
	require.False(t, edits["blk-a"].UserID.Valid)
}
