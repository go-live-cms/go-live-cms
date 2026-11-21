package db

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// A commenter's erasure (#529, commenter_privacy_tx.go, docs/design/reader-comments.md
// 13.1) on a private database (isolatedStore): the rollback case adds a trigger, which
// must not reach the shared test database other packages use at the same time.

type erasureFixture struct {
	store *SQLStore
	post  Post
}

func newErasureFixture(t *testing.T) erasureFixture {
	t.Helper()
	store := isolatedStore(t)
	owner := createUserIn(t, store, "editor")
	slug := fmt.Sprintf("erasure-%d", time.Now().UnixNano())
	post, err := store.CreatePosts(context.Background(), CreatePostsParams{
		Title: "Erasure fixture", Description: "erasure", UserID: owner.ID, Username: owner.Username,
		Url: "https://example.com/" + slug, PostType: "post", PostStatus: "published", Slug: slug,
		BlockDoc: json.RawMessage(`{}`),
	})
	require.NoError(t, err)
	return erasureFixture{store: store, post: post}
}

func (f erasureFixture) commenter(t *testing.T, name string) Commenter {
	t.Helper()
	email := strings.ToLower(name) + "." + uuid.NewString()[:8] + "@example.test"
	commenter, err := f.store.UpsertCommenter(context.Background(), UpsertCommenterParams{Email: email, EmailLower: email, DisplayName: name})
	require.NoError(t, err)
	return commenter
}

// says stores a comment of commenter in status, answering parent when given.
func (f erasureFixture) says(t *testing.T, commenter Commenter, parent *ReaderComment, status string) ReaderComment {
	t.Helper()
	ctx := context.Background()
	params := CreateReaderCommentParams{
		PostID: f.post.ID, CommenterID: sql.NullInt64{Int64: commenter.ID, Valid: true},
		DisplayName: commenter.DisplayName, Body: "Text by " + commenter.DisplayName + " " + uuid.NewString(),
		Status: status, NotifyReplies: true,
	}
	if status == ReaderCommentTrash {
		params.Status = ReaderCommentPending
	}
	if params.Status == ReaderCommentApproved {
		params.ApprovedAt = sql.NullTime{Time: time.Now(), Valid: true}
	}
	if status == ReaderCommentUnconfirmed {
		params.ConfirmTokenHash = hash32()
	}
	if parent != nil {
		params.ParentID = sql.NullInt64{Int64: parent.ID, Valid: true}
		root := parent.ID
		if parent.RootID.Valid {
			root = parent.RootID.Int64
		}
		params.RootID = sql.NullInt64{Int64: root, Valid: true}
	}
	comment, err := f.store.CreateReaderComment(ctx, params)
	require.NoError(t, err)
	if status == ReaderCommentTrash {
		comment, err = f.store.TrashReaderComment(ctx, TrashReaderCommentParams{ID: comment.ID})
		require.NoError(t, err)
	}
	return comment
}

func (f erasureFixture) exists(t *testing.T, id int64) bool {
	t.Helper()
	_, err := f.store.GetReaderComment(context.Background(), id)
	if err == sql.ErrNoRows {
		return false
	}
	require.NoError(t, err)
	return true
}

func (f erasureFixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, f.store.db.QueryRow(query, args...).Scan(&n))
	return n
}

// Erase leaves a tombstone exactly where someone else's approved reply answers one of the
// commenter's comments, and deletes everything else of theirs: every status, their own
// replies, their keys, links, unsubscribe tokens and outbox rows, and the comment ids in
// other recipients' outbox rows.
func TestEraseCommenterTx(t *testing.T) {
	ctx := context.Background()
	f := newErasureFixture(t)
	ana := f.commenter(t, "Ana")
	bea := f.commenter(t, "Bea")

	answered := f.says(t, ana, nil, ReaderCommentApproved) // Bea's approved reply: a tombstone
	beaReply := f.says(t, bea, &answered, ReaderCommentApproved)
	alone := f.says(t, ana, nil, ReaderCommentApproved)
	ownThread := f.says(t, ana, nil, ReaderCommentApproved) // only Ana answers it: deleted
	ownReply := f.says(t, ana, &ownThread, ReaderCommentApproved)
	beaRoot := f.says(t, bea, nil, ReaderCommentApproved)
	onBea := f.says(t, ana, &beaRoot, ReaderCommentApproved)
	waiting := f.says(t, ana, nil, ReaderCommentPending)
	spam := f.says(t, ana, nil, ReaderCommentSpam)
	trashed := f.says(t, ana, nil, ReaderCommentTrash)
	unconfirmed := f.says(t, ana, nil, ReaderCommentUnconfirmed)
	anaIDs := []int64{answered.ID, alone.ID, ownThread.ID, ownReply.ID, onBea.ID, waiting.ID, spam.ID, trashed.ID, unconfirmed.ID}

	_, err := f.store.CreateCommenterKey(ctx, CreateCommenterKeyParams{KeyHash: hash32(), CommenterID: ana.ID, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	_, err = f.store.CreateCommenterDataToken(ctx, CreateCommenterDataTokenParams{TokenHash: hash32(), CommenterID: ana.ID, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	_, err = f.store.db.Exec(`INSERT INTO reader_comment_unsubscribe_tokens (token_hash, comment_id) VALUES ($1, $2), ($3, $4)`,
		hash32(), answered.ID, hash32(), alone.ID)
	require.NoError(t, err)
	member := createUserIn(t, f.store, "editor")
	var replyMail, mixedMail, anaOnlyMail, moderationMail int64
	require.NoError(t, f.store.db.QueryRow(`INSERT INTO discussion_mail (kind, commenter_id, answered_id, post_id, comment_ids, due_at)
		VALUES ('reply', $1, $2, $3, ARRAY[$4::bigint], now()) RETURNING id`, ana.ID, answered.ID, f.post.ID, beaReply.ID).Scan(&replyMail))
	require.NoError(t, f.store.db.QueryRow(`INSERT INTO discussion_mail (kind, user_id, post_id, comment_ids, due_at, done_at, outcome)
		VALUES ('author', $1, $2, ARRAY[$3::bigint, $4::bigint], now(), now(), 'sent') RETURNING id`, member.ID, f.post.ID, alone.ID, beaRoot.ID).Scan(&mixedMail))
	require.NoError(t, f.store.db.QueryRow(`INSERT INTO discussion_mail (kind, user_id, post_id, comment_ids, due_at)
		VALUES ('author', $1, $2, ARRAY[$3::bigint, $4::bigint], now() + interval '1 hour') RETURNING id`, createUserIn(t, f.store, "editor").ID, f.post.ID, alone.ID, onBea.ID).Scan(&anaOnlyMail))
	require.NoError(t, f.store.db.QueryRow(`INSERT INTO discussion_mail (kind, user_id, comment_ids, due_at, done_at, outcome)
		VALUES ('moderation', $1, ARRAY[$2::bigint], now(), now(), 'sent') RETURNING id`, member.ID, waiting.ID).Scan(&moderationMail))

	result, err := f.store.EraseCommenterTx(ctx, ana.ID)
	require.NoError(t, err)
	require.Equal(t, len(anaIDs), result.Comments)
	require.Equal(t, 1, result.Tombstoned)
	require.True(t, result.Shown)
	require.Equal(t, []int64{f.post.ID}, result.PostIDs)
	require.Equal(t, int64(1), result.MailRowsDeleted, "the author row naming only Ana's comments, not yet sent")

	// The tombstone, exactly where Bea's approved reply is.
	tomb, err := f.store.GetReaderComment(ctx, answered.ID)
	require.NoError(t, err)
	require.True(t, tomb.RemovedAt.Valid)
	require.Empty(t, tomb.Body)
	require.Empty(t, tomb.DisplayName)
	require.False(t, tomb.CommenterID.Valid)
	require.False(t, tomb.NotifyReplies)
	for _, id := range anaIDs[1:] {
		require.False(t, f.exists(t, id), "comment %d is deleted", id)
	}
	require.True(t, f.exists(t, beaReply.ID))
	require.True(t, f.exists(t, beaRoot.ID))
	require.Zero(t, f.count(t, `SELECT count(*) FROM reader_comments WHERE removed_at IS NOT NULL AND post_id = $1 AND id <> $2`, f.post.ID, answered.ID),
		"no other tombstone: Ana's own reply doesn't keep her comment")

	// Everything about the address.
	_, err = f.store.GetCommenter(ctx, ana.ID)
	require.ErrorIs(t, err, sql.ErrNoRows)
	require.Zero(t, f.count(t, `SELECT count(*) FROM commenter_keys WHERE commenter_id = $1`, ana.ID))
	require.Zero(t, f.count(t, `SELECT count(*) FROM commenter_data_tokens WHERE commenter_id = $1`, ana.ID))
	require.Zero(t, f.count(t, `SELECT count(*) FROM reader_comment_unsubscribe_tokens WHERE comment_id = ANY ($1::bigint[])`, int64Array(anaIDs)))
	require.Zero(t, f.count(t, `SELECT count(*) FROM discussion_mail WHERE commenter_id = $1 OR id = $2 OR id = $3`, ana.ID, replyMail, anaOnlyMail))
	require.Zero(t, f.count(t, `SELECT count(*) FROM discussion_mail WHERE comment_ids && $1::bigint[]`, int64Array(anaIDs)),
		"no outbox row names an erased comment")
	var mixed string
	require.NoError(t, f.store.db.QueryRow(`SELECT array_to_string(comment_ids, ',') FROM discussion_mail WHERE id = $1`, mixedMail).Scan(&mixed))
	require.Equal(t, fmt.Sprint(beaRoot.ID), mixed, "another commenter's comment stays in the sent row")
	require.Equal(t, 1, f.count(t, `SELECT count(*) FROM discussion_mail WHERE id = $1 AND cardinality(comment_ids) = 0`, moderationMail),
		"a moderation row is the queue's record: kept, emptied")

	// Bea is untouched.
	_, err = f.store.GetCommenter(ctx, bea.ID)
	require.NoError(t, err)

	// Twice: nothing to erase.
	_, err = f.store.EraseCommenterTx(ctx, ana.ID)
	require.ErrorIs(t, err, sql.ErrNoRows)
}

// One transaction: when its last step fails, nothing of the erasure is left done.
func TestEraseCommenterTxRollsBack(t *testing.T) {
	ctx := context.Background()
	f := newErasureFixture(t)
	ana := f.commenter(t, "Ana")
	bea := f.commenter(t, "Bea")
	answered := f.says(t, ana, nil, ReaderCommentApproved)
	f.says(t, bea, &answered, ReaderCommentApproved)
	alone := f.says(t, ana, nil, ReaderCommentPending)
	_, err := f.store.CreateCommenterKey(ctx, CreateCommenterKeyParams{KeyHash: hash32(), CommenterID: ana.ID, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)

	_, err = f.store.db.Exec(`CREATE FUNCTION refuse_commenter_delete() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'refused for the test'; END; $$;
		CREATE TRIGGER refuse_commenter_delete BEFORE DELETE ON commenters FOR EACH ROW EXECUTE PROCEDURE refuse_commenter_delete();`)
	require.NoError(t, err)

	_, err = f.store.EraseCommenterTx(ctx, ana.ID)
	require.ErrorContains(t, err, "refused for the test")
	got, err := f.store.GetReaderComment(ctx, answered.ID)
	require.NoError(t, err)
	require.False(t, got.RemovedAt.Valid, "no tombstone")
	require.Equal(t, ana.ID, got.CommenterID.Int64)
	require.True(t, f.exists(t, alone.ID))
	require.Equal(t, 1, f.count(t, `SELECT count(*) FROM commenter_keys WHERE commenter_id = $1`, ana.ID))
}

// A reader's Delete takes only their own comment, a tombstone when it has approved replies.
func TestDeleteCommenterReaderCommentTx(t *testing.T) {
	ctx := context.Background()
	f := newErasureFixture(t)
	ana := f.commenter(t, "Ana")
	bea := f.commenter(t, "Bea")
	answered := f.says(t, ana, nil, ReaderCommentApproved)
	beaReply := f.says(t, bea, &answered, ReaderCommentApproved)
	pending := f.says(t, ana, nil, ReaderCommentPending)

	_, err := f.store.DeleteCommenterReaderCommentTx(ctx, ana.ID, beaReply.ID)
	require.ErrorIs(t, err, ErrReaderCommentNotTheCommenters)
	require.True(t, f.exists(t, beaReply.ID))
	_, err = f.store.DeleteCommenterReaderCommentTx(ctx, ana.ID, -1)
	require.ErrorIs(t, err, sql.ErrNoRows)

	removed, err := f.store.DeleteCommenterReaderCommentTx(ctx, ana.ID, answered.ID)
	require.NoError(t, err)
	require.True(t, removed.Tombstoned)
	require.Equal(t, ReaderCommentApproved, removed.Status)
	removed, err = f.store.DeleteCommenterReaderCommentTx(ctx, ana.ID, pending.ID)
	require.NoError(t, err)
	require.False(t, removed.Tombstoned)
	require.False(t, f.exists(t, pending.ID))
	// The tombstone isn't Ana's any more.
	_, err = f.store.DeleteCommenterReaderCommentTx(ctx, ana.ID, answered.ID)
	require.ErrorIs(t, err, ErrReaderCommentNotTheCommenters)
}

// hash32 is a random 32-byte value, the size of a stored SHA-256.
func hash32() []byte {
	sum := sha256.Sum256([]byte(uuid.NewString()))
	return sum[:]
}

func int64Array(ids []int64) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = fmt.Sprint(id)
	}
	return "{" + strings.Join(parts, ",") + "}"
}
