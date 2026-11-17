package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Reader comments' storage (#522, 000061) against the test database (skipped without
// one): the post's lifecycle, tombstones, first_published_at, the snapshot rule, the
// retention job, PUT /posts/:id/discussion, the settings and the post type's Comments
// field. The database is shared across runs, so every assertion is about this test's
// own rows; the retention job runs over everyone's, which is what it does in production.

type discussionFixture struct {
	conn   *sql.DB
	store  db.Store
	server *Server
	editor db.User
}

func newDiscussionFixture(t *testing.T) discussionFixture {
	t.Helper()
	conn, store := scheduleTestDB(t)
	editor := scheduleUser(t, store, RoleEditor)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	return discussionFixture{conn: conn, store: store, server: server, editor: editor}
}

func (f discussionFixture) publishedPost(t *testing.T) db.Post {
	t.Helper()
	return publishForTest(t, f.store, scheduleDraft(t, f.store, f.editor, scheduleWord()), f.editor)
}

func (f discussionFixture) commenter(t *testing.T) db.Commenter {
	t.Helper()
	email := "Reader." + strings.ReplaceAll(uuid.NewString(), "-", "")[:12] + "@Example.test"
	commenter, err := f.store.UpsertCommenter(context.Background(), db.UpsertCommenterParams{
		Email: email, EmailLower: strings.ToLower(email), DisplayName: "Ana Reader",
	})
	require.NoError(t, err)
	return commenter
}

// comment inserts a reader comment; reply is the comment it answers (nil: top level).
func (f discussionFixture) comment(t *testing.T, post db.Post, commenter db.Commenter, reply *db.ReaderComment, status string) db.ReaderComment {
	t.Helper()
	params := db.CreateReaderCommentParams{
		PostID:        post.ID,
		CommenterID:   sql.NullInt64{Int64: commenter.ID, Valid: true},
		DisplayName:   commenter.DisplayName,
		Body:          "A comment " + uuid.NewString(),
		Status:        status,
		NotifyReplies: true,
		NetworkHash:   []byte("0123456789abcdef0123456789abcdef"),
	}
	if reply != nil {
		params.ParentID = sql.NullInt64{Int64: reply.ID, Valid: true}
		root := reply.ID
		if reply.RootID.Valid {
			root = reply.RootID.Int64
		}
		params.RootID = sql.NullInt64{Int64: root, Valid: true}
	}
	if status == db.ReaderCommentApproved {
		params.ApprovedAt = sql.NullTime{Time: time.Now(), Valid: true}
	}
	if status == db.ReaderCommentUnconfirmed {
		params.ConfirmTokenHash = []byte(uuid.NewString())
	}
	comment, err := f.store.CreateReaderComment(context.Background(), params)
	require.NoError(t, err)
	return comment
}

// age moves a comment's created_at (and moderated_at, when set) back by d.
func (f discussionFixture) age(t *testing.T, id int64, d time.Duration) {
	t.Helper()
	_, err := f.conn.Exec(`UPDATE reader_comments SET created_at = now() - $2::interval,
		moderated_at = CASE WHEN moderated_at IS NULL THEN NULL ELSE now() - $2::interval END WHERE id = $1`,
		id, fmt.Sprintf("%d seconds", int64(d.Seconds())))
	require.NoError(t, err)
}

func (f discussionFixture) exists(t *testing.T, id int64) bool {
	t.Helper()
	_, err := f.store.GetReaderComment(context.Background(), id)
	if err == sql.ErrNoRows {
		return false
	}
	require.NoError(t, err)
	return true
}

func (f discussionFixture) reload(t *testing.T, id int64) db.ReaderComment {
	t.Helper()
	comment, err := f.store.GetReaderComment(context.Background(), id)
	require.NoError(t, err)
	return comment
}

func (f discussionFixture) maintain(t *testing.T) discussionMaintenanceResult {
	t.Helper()
	result, err := f.server.runDiscussionMaintenance(context.Background(), time.Now())
	require.NoError(t, err)
	return result
}

func requireTombstone(t *testing.T, c db.ReaderComment) {
	t.Helper()
	require.True(t, c.RemovedAt.Valid, "a tombstone")
	require.Equal(t, db.ReaderCommentApproved, c.Status)
	require.Empty(t, c.Body)
	require.Empty(t, c.DisplayName)
	require.False(t, c.CommenterID.Valid)
	require.False(t, c.AuthorUserID.Valid)
	require.Nil(t, c.NetworkHash)
	require.False(t, c.NotifyReplies)
}

// Deleting a post deletes its comments (every status, replies too) and keeps its
// commenters, who may have comments elsewhere.
func TestReaderCommentsGoWithTheirPost(t *testing.T) {
	f := newDiscussionFixture(t)
	ctx := context.Background()
	post, other := f.publishedPost(t), f.publishedPost(t)
	commenter := f.commenter(t)

	root := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
	reply := f.comment(t, post, commenter, &root, db.ReaderCommentApproved)
	held := f.comment(t, post, commenter, nil, db.ReaderCommentPending)
	elsewhere := f.comment(t, other, commenter, nil, db.ReaderCommentApproved)

	_, err := f.store.TrashPost(ctx, post.ID)
	require.NoError(t, err)
	require.NoError(t, f.store.DeleteTrashedPostTx(ctx, post.ID))

	for _, id := range []int64{root.ID, reply.ID, held.ID} {
		require.False(t, f.exists(t, id), "comment %d went with its post", id)
	}
	require.True(t, f.exists(t, elsewhere.ID))
	_, err = f.store.GetCommenter(ctx, commenter.ID)
	require.NoError(t, err, "the commenter stays")
}

// Trashing a post and restoring it leaves its comments exactly as they were (6.5): the
// trash hides the thread, it doesn't touch it.
func TestReaderCommentsSurvivePostTrash(t *testing.T) {
	f := newDiscussionFixture(t)
	ctx := context.Background()
	post := f.publishedPost(t)
	commenter := f.commenter(t)
	comments := []db.ReaderComment{
		f.comment(t, post, commenter, nil, db.ReaderCommentApproved),
		f.comment(t, post, commenter, nil, db.ReaderCommentPending),
		f.comment(t, post, commenter, nil, db.ReaderCommentSpam),
	}
	comments = append(comments, f.comment(t, post, commenter, &comments[0], db.ReaderCommentApproved))

	_, err := f.store.TrashPost(ctx, post.ID)
	require.NoError(t, err)
	for _, c := range comments {
		require.Equal(t, c, f.reload(t, c.ID), "unchanged in the trash")
	}
	restored, err := f.store.RestorePostFromTrash(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, postStatusPublished, restored.PostStatus)
	for _, c := range comments {
		require.Equal(t, c, f.reload(t, c.ID), "unchanged after the restore")
	}
}

// Trashing a root with approved replies keeps the replies (the thread read renders the
// root as a placeholder); deleting it makes a tombstone; deleting one without approved
// replies deletes it and its thread's unapproved rows; restoring the trashed root
// brings its text back.
func TestReaderCommentRootWithRepliesKeepsThem(t *testing.T) {
	f := newDiscussionFixture(t)
	ctx := context.Background()
	post := f.publishedPost(t)
	commenter := f.commenter(t)

	t.Run("trash", func(t *testing.T) {
		root := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
		reply := f.comment(t, post, commenter, &root, db.ReaderCommentApproved)
		trashed, err := f.store.TrashReaderComment(ctx, db.TrashReaderCommentParams{ID: root.ID, ModeratedBy: sql.NullInt64{Int64: f.editor.ID, Valid: true}})
		require.NoError(t, err)
		require.Equal(t, db.ReaderCommentTrash, trashed.Status)
		require.Equal(t, db.ReaderCommentApproved, trashed.TrashedFrom.String)
		require.Equal(t, reply, f.reload(t, reply.ID), "the reply is untouched")

		back, err := f.store.RestoreReaderComment(ctx, db.RestoreReaderCommentParams{ID: root.ID})
		require.NoError(t, err)
		require.Equal(t, db.ReaderCommentApproved, back.Status)
		require.Equal(t, root.Body, back.Body, "restoring brings the text back")
		require.False(t, back.TrashedFrom.Valid)
	})

	t.Run("delete a root with approved replies: tombstone", func(t *testing.T) {
		root := f.comment(t, post, commenter, nil, db.ReaderCommentSpam)
		reply := f.comment(t, post, commenter, &root, db.ReaderCommentApproved)
		replyToReply := f.comment(t, post, commenter, &reply, db.ReaderCommentApproved)

		result, err := f.store.DeleteReaderCommentTx(ctx, root.ID)
		require.NoError(t, err)
		require.True(t, result.Tombstoned)
		requireTombstone(t, f.reload(t, root.ID))
		require.Equal(t, reply, f.reload(t, reply.ID))
		require.Equal(t, replyToReply, f.reload(t, replyToReply.ID))

		// A reply answered by an approved reply becomes a tombstone too, keeping its place.
		result, err = f.store.DeleteReaderCommentTx(ctx, reply.ID)
		require.NoError(t, err)
		require.True(t, result.Tombstoned)
		requireTombstone(t, f.reload(t, reply.ID))
		require.Equal(t, replyToReply.ParentID, f.reload(t, replyToReply.ID).ParentID)
	})

	t.Run("delete a root without approved replies: gone with its thread", func(t *testing.T) {
		root := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
		pending := f.comment(t, post, commenter, &root, db.ReaderCommentPending)
		result, err := f.store.DeleteReaderCommentTx(ctx, root.ID)
		require.NoError(t, err)
		require.False(t, result.Tombstoned)
		require.Equal(t, root.ID, result.Comment.ID)
		require.False(t, f.exists(t, root.ID))
		require.False(t, f.exists(t, pending.ID), "its thread's unapproved rows go with it")
	})

	t.Run("delete a reply: its parent link is cleared on its own replies", func(t *testing.T) {
		root := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
		reply := f.comment(t, post, commenter, &root, db.ReaderCommentApproved)
		pendingAnswer := f.comment(t, post, commenter, &reply, db.ReaderCommentPending)
		result, err := f.store.DeleteReaderCommentTx(ctx, reply.ID)
		require.NoError(t, err)
		require.False(t, result.Tombstoned, "no approved row answers it")
		require.False(t, f.exists(t, reply.ID))
		kept := f.reload(t, pendingAnswer.ID)
		require.False(t, kept.ParentID.Valid)
		require.Equal(t, root.ID, kept.RootID.Int64, "still in its thread")
		require.True(t, f.exists(t, root.ID))
	})

	t.Run("no such comment", func(t *testing.T) {
		_, err := f.store.DeleteReaderCommentTx(ctx, -1)
		require.ErrorIs(t, err, sql.ErrNoRows)
	})
}

// The table refuses what the design forbids.
func TestReaderCommentConstraints(t *testing.T) {
	f := newDiscussionFixture(t)
	post := f.publishedPost(t)
	commenter := f.commenter(t)
	root := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
	for name, statement := range map[string]string{
		"a commenter and a member":   `UPDATE reader_comments SET author_user_id = $2 WHERE id = $1`,
		"trash without trashed_from": `UPDATE reader_comments SET status = 'trash' WHERE id = $1 AND $2::bigint > 0`,
		"an unknown status":          `UPDATE reader_comments SET status = 'hidden' WHERE id = $1 AND $2::bigint > 0`,
		"a blank body":               `UPDATE reader_comments SET body = '   ' WHERE id = $1 AND $2::bigint > 0`,
		"a tombstone with its name":  `UPDATE reader_comments SET removed_at = now(), body = '' WHERE id = $1 AND $2::bigint > 0`,
		"a reply without its root":   `UPDATE reader_comments SET parent_id = $1 WHERE id = $1 AND $2::bigint > 0`,
		"a token once confirmed":     `UPDATE reader_comments SET confirm_token_hash = 'x' WHERE id = $1 AND $2::bigint > 0`,
		"a body over 4000":           `UPDATE reader_comments SET body = repeat('x', 4001) WHERE id = $1 AND $2::bigint > 0`,
	} {
		_, err := f.conn.Exec(statement, root.ID, f.editor.ID)
		require.Error(t, err, name)
	}
	_, err := f.conn.Exec(`INSERT INTO commenters (email, email_lower, display_name) VALUES ($1, $1, 'Dup')`, commenter.EmailLower)
	require.Error(t, err, "one row per address")
}

// first_published_at is set by the first publish, once: unpublishing, publishing again,
// an Update, the trash and a restore keep it, and no writer can move it.
func TestFirstPublishedAtIsSetOnce(t *testing.T) {
	f := newDiscussionFixture(t)
	ctx := context.Background()
	draft := scheduleDraft(t, f.store, f.editor, scheduleWord())
	require.False(t, draft.FirstPublishedAt.Valid, "a draft was never published")

	published := publishForTest(t, f.store, draft, f.editor)
	require.True(t, published.FirstPublishedAt.Valid)
	first := published.FirstPublishedAt.Time
	require.WithinDuration(t, time.Now(), first, time.Minute)

	keeps := func(step string) {
		t.Helper()
		post := reloadPost(t, f.store, draft.ID)
		require.True(t, post.FirstPublishedAt.Valid, step)
		require.True(t, first.Equal(post.FirstPublishedAt.Time), "%s: %s, want %s", step, post.FirstPublishedAt.Time, first)
	}
	time.Sleep(10 * time.Millisecond)
	_, err := f.store.UnpublishPost(ctx, draft.ID)
	require.NoError(t, err)
	keeps("unpublished")
	publishForTest(t, f.store, reloadPost(t, f.store, draft.ID), f.editor)
	keeps("published again")
	publishForTest(t, f.store, reloadPost(t, f.store, draft.ID), f.editor)
	keeps("an Update")
	_, err = f.store.TrashPost(ctx, draft.ID)
	require.NoError(t, err)
	keeps("trashed")
	_, err = f.store.RestorePostFromTrash(ctx, draft.ID)
	require.NoError(t, err)
	keeps("restored")

	_, err = f.conn.Exec(`UPDATE posts SET first_published_at = now() + interval '1 day' WHERE id = $1`, draft.ID)
	require.NoError(t, err)
	keeps("a direct write")
	_, err = f.conn.Exec(`UPDATE posts SET first_published_at = NULL WHERE id = $1`, draft.ID)
	require.NoError(t, err)
	keeps("a direct NULL")
}

// posts.discussion is outside the publish snapshot (12.3): changing it on a published
// post leaves "changes not published" false and the published settings as they were.
func TestPostDiscussionIsNotInTheSnapshot(t *testing.T) {
	f := newDiscussionFixture(t)
	ctx := context.Background()
	post := f.publishedPost(t)
	changed, err := f.store.GetPostHasUnpublishedChanges(ctx, post.ID)
	require.NoError(t, err)
	require.False(t, changed)

	var settingsHasDiscussion bool
	require.NoError(t, f.conn.QueryRow(`SELECT golive_post_settings($1) ? 'discussion'`, post.ID).Scan(&settingsHasDiscussion))
	require.False(t, settingsHasDiscussion, "golive_post_settings() doesn't hold it")

	for _, choice := range []string{postDiscussionClosed, postDiscussionOff, postDiscussionOpen, postDiscussionDefault} {
		updated, err := f.store.UpdatePostDiscussion(ctx, db.UpdatePostDiscussionParams{ID: post.ID, Discussion: choice})
		require.NoError(t, err)
		require.Equal(t, choice, updated.Discussion)
		require.True(t, post.ChangedAt.Equal(updated.ChangedAt), "not an edit: changed_at stays")
		changed, err := f.store.GetPostHasUnpublishedChanges(ctx, post.ID)
		require.NoError(t, err)
		require.False(t, changed, "discussion %s: no changes not published", choice)
		state, err := f.store.GetPostSettingsState(ctx, post.ID)
		require.NoError(t, err)
		require.False(t, state.HasUnpublishedChanges)
	}
	_, err = f.conn.Exec(`UPDATE posts SET discussion = 'maybe' WHERE id = $1`, post.ID)
	require.Error(t, err, "the CHECK refuses other values")
}

// Each retention rule (6.6, decision 13).
func TestDiscussionMaintenanceRetention(t *testing.T) {
	f := newDiscussionFixture(t)
	ctx := context.Background()
	post := f.publishedPost(t)
	commenter := f.commenter(t)

	t.Run("unconfirmed at 47 and 49 hours", func(t *testing.T) {
		young := f.comment(t, post, commenter, nil, db.ReaderCommentUnconfirmed)
		old := f.comment(t, post, commenter, nil, db.ReaderCommentUnconfirmed)
		f.age(t, young.ID, 47*time.Hour)
		f.age(t, old.ID, 49*time.Hour)
		f.maintain(t)
		require.True(t, f.exists(t, young.ID), "47 hours: kept")
		require.False(t, f.exists(t, old.ID), "49 hours: deleted")
	})

	t.Run("spam and trash at 29 and 31 days, pending at 89 and 91", func(t *testing.T) {
		cases := []struct {
			status string
			age    time.Duration
			kept   bool
		}{
			{db.ReaderCommentSpam, 29 * 24 * time.Hour, true},
			{db.ReaderCommentSpam, 31 * 24 * time.Hour, false},
			{db.ReaderCommentPending, 89 * 24 * time.Hour, true},
			{db.ReaderCommentPending, 91 * 24 * time.Hour, false},
			{db.ReaderCommentApproved, 3650 * 24 * time.Hour, true},
		}
		ids := make([]int64, len(cases))
		for i, c := range cases {
			ids[i] = f.comment(t, post, commenter, nil, c.status).ID
			f.age(t, ids[i], c.age)
		}
		// Trash counts from when it was trashed, not written.
		oldTrash := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
		_, err := f.store.TrashReaderComment(ctx, db.TrashReaderCommentParams{ID: oldTrash.ID})
		require.NoError(t, err)
		f.age(t, oldTrash.ID, 31*24*time.Hour)
		recentTrash := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
		f.age(t, recentTrash.ID, 400*24*time.Hour)
		_, err = f.store.TrashReaderComment(ctx, db.TrashReaderCommentParams{ID: recentTrash.ID})
		require.NoError(t, err)

		f.maintain(t)
		for i, c := range cases {
			require.Equal(t, c.kept, f.exists(t, ids[i]), "%s at %s", c.status, c.age)
		}
		require.False(t, f.exists(t, oldTrash.ID), "trashed 31 days ago: deleted")
		require.True(t, f.exists(t, recentTrash.ID), "an old comment trashed now: kept")
	})

	t.Run("an expired root with approved replies becomes a tombstone", func(t *testing.T) {
		root := f.comment(t, post, commenter, nil, db.ReaderCommentSpam)
		reply := f.comment(t, post, commenter, &root, db.ReaderCommentApproved)
		f.age(t, root.ID, 31*24*time.Hour)
		f.maintain(t)
		requireTombstone(t, f.reload(t, root.ID))
		require.Equal(t, reply, f.reload(t, reply.ID), "the reply is untouched")
	})

	t.Run("a tombstone losing its last reply", func(t *testing.T) {
		root := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
		first := f.comment(t, post, commenter, &root, db.ReaderCommentApproved)
		second := f.comment(t, post, commenter, &root, db.ReaderCommentApproved)
		result, err := f.store.DeleteReaderCommentTx(ctx, root.ID)
		require.NoError(t, err)
		require.True(t, result.Tombstoned)

		_, err = f.store.DeleteReaderCommentTx(ctx, first.ID)
		require.NoError(t, err)
		f.maintain(t)
		require.True(t, f.exists(t, root.ID), "one reply left: the tombstone stays")

		_, err = f.store.DeleteReaderCommentTx(ctx, second.ID)
		require.NoError(t, err)
		f.maintain(t)
		require.False(t, f.exists(t, root.ID), "no reply left: the tombstone goes")
	})

	t.Run("a chain of tombstones goes in one run", func(t *testing.T) {
		root := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
		reply := f.comment(t, post, commenter, &root, db.ReaderCommentApproved)
		answer := f.comment(t, post, commenter, &reply, db.ReaderCommentApproved)
		for _, id := range []int64{root.ID, reply.ID} {
			result, err := f.store.DeleteReaderCommentTx(ctx, id)
			require.NoError(t, err)
			require.True(t, result.Tombstoned)
		}
		_, err := f.store.DeleteReaderCommentTx(ctx, answer.ID)
		require.NoError(t, err)
		f.maintain(t)
		require.False(t, f.exists(t, reply.ID))
		require.False(t, f.exists(t, root.ID))
	})

	t.Run("a network hash at 29 and 31 days", func(t *testing.T) {
		recent := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
		old := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
		f.age(t, recent.ID, 29*24*time.Hour)
		f.age(t, old.ID, 31*24*time.Hour)
		f.maintain(t)
		require.NotNil(t, f.reload(t, recent.ID).NetworkHash, "29 days: kept")
		cleared := f.reload(t, old.ID)
		require.Nil(t, cleared.NetworkHash, "31 days: cleared")
		require.Equal(t, old.Body, cleared.Body, "the comment itself stays")
	})

	t.Run("expired browser keys", func(t *testing.T) {
		live, err := f.store.CreateCommenterKey(ctx, db.CreateCommenterKeyParams{KeyHash: discussionTestHash(), CommenterID: commenter.ID, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		expired, err := f.store.CreateCommenterKey(ctx, db.CreateCommenterKeyParams{KeyHash: discussionTestHash(), CommenterID: commenter.ID, ExpiresAt: time.Now().Add(-time.Hour)})
		require.NoError(t, err)
		f.maintain(t)
		var n int
		require.NoError(t, f.conn.QueryRow(`SELECT count(*) FROM commenter_keys WHERE key_hash = $1`, live.KeyHash).Scan(&n))
		require.Equal(t, 1, n)
		require.NoError(t, f.conn.QueryRow(`SELECT count(*) FROM commenter_keys WHERE key_hash = $1`, expired.KeyHash).Scan(&n))
		require.Equal(t, 0, n)
	})

	t.Run("commenters with no comments", func(t *testing.T) {
		stale := func(t *testing.T) db.Commenter {
			c := f.commenter(t)
			_, err := f.conn.Exec(`UPDATE commenters SET last_seen_at = now() - interval '31 days' WHERE id = $1`, c.ID)
			require.NoError(t, err)
			return c
		}
		gone := stale(t)
		blocked := stale(t)
		_, err := f.store.SetCommenterBlocked(ctx, db.SetCommenterBlockedParams{ID: blocked.ID, Blocked: true})
		require.NoError(t, err)
		spammed := stale(t)
		_, err = f.conn.Exec(`UPDATE commenters SET last_spam_at = now() - interval '60 days' WHERE id = $1`, spammed.ID)
		require.NoError(t, err)
		spammedLongAgo := stale(t)
		_, err = f.conn.Exec(`UPDATE commenters SET last_spam_at = now() - interval '91 days' WHERE id = $1`, spammedLongAgo.ID)
		require.NoError(t, err)
		withKey := stale(t)
		_, err = f.store.CreateCommenterKey(ctx, db.CreateCommenterKeyParams{KeyHash: discussionTestHash(), CommenterID: withKey.ID, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		withComment := stale(t)
		f.comment(t, post, withComment, nil, db.ReaderCommentApproved)
		recent := f.commenter(t)

		f.maintain(t)
		present := func(c db.Commenter) bool {
			_, err := f.store.GetCommenter(ctx, c.ID)
			if err == sql.ErrNoRows {
				return false
			}
			require.NoError(t, err)
			return true
		}
		require.False(t, present(gone), "no comments, no keys, 31 days: deleted")
		require.True(t, present(blocked), "a blocked commenter with no comments is kept")
		require.True(t, present(spammed), "marked spam 60 days ago: kept")
		require.False(t, present(spammedLongAgo), "marked spam 91 days ago: deleted")
		require.True(t, present(withKey), "a browser key: kept")
		require.True(t, present(withComment), "a comment: kept")
		require.True(t, present(recent), "seen recently: kept")
	})

	t.Run("the loop runs, and stops with its context", func(t *testing.T) {
		old := f.comment(t, post, commenter, nil, db.ReaderCommentUnconfirmed)
		f.age(t, old.ID, 49*time.Hour)
		loopCtx, cancel := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() {
			defer close(done)
			f.server.RunDiscussionMaintenance(loopCtx, time.Hour)
		}()
		require.Eventually(t, func() bool { return !f.exists(t, old.ID) }, 10*time.Second, 50*time.Millisecond)
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("the loop didn't stop")
		}
		// Off: returns at once.
		f.server.RunDiscussionMaintenance(ctx, 0)
	})
}

func discussionTestHash() []byte {
	sum := make([]byte, 32)
	copy(sum, strings.ReplaceAll(uuid.NewString(), "-", ""))
	return sum
}

// 000061 gave Posts the Comments field and not Pages.
func TestPostTypesCommentsMigration(t *testing.T) {
	f := newDiscussionFixture(t)
	ctx := context.Background()
	postType, err := f.store.GetPostType(ctx, "post")
	require.NoError(t, err)
	require.Contains(t, toPostTypeResponse(postType).Supports, postTypeSupportsComments)
	pageType, err := f.store.GetPostType(ctx, "page")
	require.NoError(t, err)
	require.NotContains(t, toPostTypeResponse(pageType).Supports, postTypeSupportsComments)
}

// PUT /post-types/:name on a built-in type changes the Comments field and nothing else.
func TestBuiltInPostTypeCommentsField(t *testing.T) {
	f := newDiscussionFixture(t)
	ctx := context.Background()
	admin := scheduleUser(t, f.store, RoleAdmin)
	before, err := f.store.GetPostType(ctx, "page")
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := f.store.SetPostTypeComments(ctx, db.SetPostTypeCommentsParams{Name: "page", Enabled: false})
		require.NoError(t, err)
	})
	supports := toPostTypeResponse(before).Supports

	on := append(append([]string{}, supports...), postTypeSupportsComments)
	recorder := trashCall(t, f.server, &admin, http.MethodPut, "/api/v1/post-types/page", map[string]any{"supports": on})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	after, err := f.store.GetPostType(ctx, "page")
	require.NoError(t, err)
	require.Equal(t, on, toPostTypeResponse(after).Supports)
	require.Equal(t, before.Label, after.Label)

	recorder = trashCall(t, f.server, &admin, http.MethodPut, "/api/v1/post-types/page", map[string]any{"supports": supports})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	after, err = f.store.GetPostType(ctx, "page")
	require.NoError(t, err)
	require.Equal(t, supports, toPostTypeResponse(after).Supports, "off again, the others in their order")

	for name, body := range map[string]map[string]any{
		"another field of supports": {"supports": append(append([]string{}, supports...), "custom_fields")},
		"a field dropped":           {"supports": []string{postTypeSupportsComments}},
		"the label":                 {"supports": on, "label": "Pages!"},
		"public":                    {"supports": on, "public": false},
		"nothing about comments":    {"label": "Pages"},
	} {
		recorder := trashCall(t, f.server, &admin, http.MethodPut, "/api/v1/post-types/page", body)
		require.Equal(t, http.StatusConflict, recorder.Code, "%s: %s", name, recorder.Body.String())
	}
	unchanged, err := f.store.GetPostType(ctx, "page")
	require.NoError(t, err)
	require.Equal(t, after, unchanged)

	editor := scheduleUser(t, f.store, RoleEditor)
	recorder = trashCall(t, f.server, &editor, http.MethodPut, "/api/v1/post-types/page", map[string]any{"supports": on})
	require.Equal(t, http.StatusForbidden, recorder.Code, "admins only")
}

// PUT /posts/:id/discussion: canEditPostDetails, live at once, recorded, and answering
// what the choice means now.
func TestUpdatePostDiscussionRoute(t *testing.T) {
	f := newDiscussionFixture(t)
	ctx := context.Background()
	post := f.publishedPost(t)
	path := fmt.Sprintf("/api/v1/posts/%d/discussion", post.ID)

	recorder := trashCall(t, f.server, &f.editor, http.MethodPut, path, map[string]any{"discussion": "closed"})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var body PostDiscussionResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.Equal(t, post.ID, body.PostID)
	require.Equal(t, "closed", body.Discussion)
	require.Contains(t, []string{discussionStateClosed, discussionStateOff}, body.State, "off while the site switch is off")
	require.Equal(t, "closed", reloadPost(t, f.store, post.ID).Discussion)

	var payload json.RawMessage
	require.NoError(t, f.conn.QueryRow(`SELECT payload FROM activity WHERE verb = $1 AND object_id = $2 ORDER BY id DESC LIMIT 1`,
		db.ActivityPostDiscussionChanged, post.ID).Scan(&payload))
	require.JSONEq(t, `{"from":"default","to":"closed"}`, string(payload))

	// The same choice again records nothing more.
	recorder = trashCall(t, f.server, &f.editor, http.MethodPut, path, map[string]any{"discussion": "closed"})
	require.Equal(t, http.StatusOK, recorder.Code)
	var n int
	require.NoError(t, f.conn.QueryRow(`SELECT count(*) FROM activity WHERE verb = $1 AND object_id = $2`, db.ActivityPostDiscussionChanged, post.ID).Scan(&n))
	require.Equal(t, 1, n)

	recorder = trashCall(t, f.server, &f.editor, http.MethodPut, path, map[string]any{"discussion": "maybe"})
	require.Equal(t, http.StatusBadRequest, recorder.Code)
	recorder = trashCall(t, f.server, &f.editor, http.MethodPut, path, map[string]any{})
	require.Equal(t, http.StatusBadRequest, recorder.Code)
	recorder = trashCall(t, f.server, nil, http.MethodPut, path, map[string]any{"discussion": "open"})
	require.Equal(t, http.StatusUnauthorized, recorder.Code)

	// A contributor may not change a published post's details, even their own.
	contributor := scheduleUser(t, f.store, RoleContributor)
	own := publishForTest(t, f.store, scheduleDraft(t, f.store, contributor, scheduleWord()), f.editor)
	recorder = trashCall(t, f.server, &contributor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/discussion", own.ID), map[string]any{"discussion": "off"})
	require.Equal(t, http.StatusForbidden, recorder.Code, recorder.Body.String())
	// Their draft, yes.
	draft := scheduleDraft(t, f.store, contributor, scheduleWord())
	recorder = trashCall(t, f.server, &contributor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/discussion", draft.ID), map[string]any{"discussion": "off"})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

	// Not in the trash.
	_, err := f.store.TrashPost(ctx, post.ID)
	require.NoError(t, err)
	recorder = trashCall(t, f.server, &f.editor, http.MethodPut, path, map[string]any{"discussion": "open"})
	require.Equal(t, http.StatusConflict, recorder.Code, recorder.Body.String())

	recorder = trashCall(t, f.server, &f.editor, http.MethodPut, "/api/v1/posts/999999999999/discussion", map[string]any{"discussion": "open"})
	require.Equal(t, http.StatusNotFound, recorder.Code, recorder.Body.String())
	recorder = trashCall(t, f.server, &f.editor, http.MethodPut, "/api/v1/posts/x/discussion", map[string]any{"discussion": "open"})
	require.Equal(t, http.StatusBadRequest, recorder.Code)
}

// The response applies the rule with the site's settings, the type and the clock.
func TestPostDiscussionSettingFromRows(t *testing.T) {
	f := newDiscussionFixture(t)
	ctx := context.Background()
	admin := scheduleUser(t, f.store, RoleAdmin)
	restoreDiscussionSettings(t, f)
	post := f.publishedPost(t)

	recorder := trashCall(t, f.server, &admin, http.MethodPut, "/api/v1/settings", map[string]any{
		"comments_enabled": true, "comments_close_after_days": 7,
	})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	setting, err := f.server.postDiscussionSetting(ctx, reloadPost(t, f.store, post.ID))
	require.NoError(t, err)
	require.Equal(t, discussionStateOpen, setting.State)
	require.NotNil(t, setting.ClosesAt)
	require.WithinDuration(t, time.Now().Add(7*24*time.Hour), *setting.ClosesAt, time.Minute)

	// A post first published 8 days ago (an importer may write the date before the first
	// publish; the trigger then keeps it).
	older := scheduleDraft(t, f.store, f.editor, scheduleWord())
	_, err = f.conn.Exec(`UPDATE posts SET first_published_at = now() - interval '8 days' WHERE id = $1`, older.ID)
	require.NoError(t, err)
	post = publishForTest(t, f.store, older, f.editor)
	require.WithinDuration(t, time.Now().Add(-8*24*time.Hour), post.FirstPublishedAt.Time, time.Minute)
	recorder = trashCall(t, f.server, &admin, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/discussion", post.ID), map[string]any{"discussion": "default"})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var body PostDiscussionResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.Equal(t, discussionStateClosed, body.State, "past its close date")
	recorder = trashCall(t, f.server, &admin, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d/discussion", post.ID), map[string]any{"discussion": "open"})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.Equal(t, discussionStateOpen, body.State, "an explicit Open ignores the timer")
	require.Nil(t, body.ClosesAt)
}

// restoreDiscussionSettings puts Settings › Discussion back as the test found it.
func restoreDiscussionSettings(t *testing.T, f discussionFixture) {
	t.Helper()
	before, err := f.store.GetSettings(context.Background())
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := f.store.UpdateSettings(context.Background(), db.UpdateSettingsParams{
			CommentsEnabled:        sql.NullBool{Bool: before.CommentsEnabled, Valid: true},
			CommentsModeration:     sql.NullString{String: before.CommentsModeration, Valid: true},
			CommentsMaxLinks:       sql.NullInt32{Int32: before.CommentsMaxLinks, Valid: true},
			CommentsHoldWords:      append([]string{}, before.CommentsHoldWords...),
			CommentsSpamWords:      append([]string{}, before.CommentsSpamWords...),
			CommentsCloseAfterDays: sql.NullInt32{Int32: before.CommentsCloseAfterDays, Valid: true},
			CommentsThreading:      sql.NullString{String: before.CommentsThreading, Valid: true},
			CommentsOrder:          sql.NullString{String: before.CommentsOrder, Valid: true},
			CommentsPerPage:        sql.NullInt32{Int32: before.CommentsPerPage, Valid: true},
			CommentsNotice:         sql.NullString{String: before.CommentsNotice, Valid: true},
			SetCommentsPrivacyPage: true,
			CommentsPrivacyPageID:  before.CommentsPrivacyPageID,
		})
		require.NoError(t, err)
	})
}

// Settings › Discussion in GET/PUT /settings: defaults, validation, the privacy page,
// and the word lists only for admins.
func TestDiscussionSettings(t *testing.T) {
	f := newDiscussionFixture(t)
	admin := scheduleUser(t, f.store, RoleAdmin)
	restoreDiscussionSettings(t, f)

	recorder := trashCall(t, f.server, &admin, http.MethodPut, "/api/v1/settings", map[string]any{
		"comments_moderation":       "all",
		"comments_max_links":        0,
		"comments_hold_words":       []string{" casino", "Casino", "", "free money"},
		"comments_spam_words":       []string{"viagra"},
		"comments_close_after_days": 0,
		"comments_threading":        "flat",
		"comments_order":            "newest",
		"comments_per_page":         10,
		"comments_notice":           "  Be kind.  ",
	})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var saved map[string]any
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &saved))
	require.Equal(t, "all", saved["comments_moderation"])
	require.EqualValues(t, 0, saved["comments_max_links"])
	require.Equal(t, []any{"casino", "free money"}, saved["comments_hold_words"])
	require.Equal(t, []any{"viagra"}, saved["comments_spam_words"])
	require.Equal(t, "flat", saved["comments_threading"])
	require.Equal(t, "newest", saved["comments_order"])
	require.EqualValues(t, 10, saved["comments_per_page"])
	require.Equal(t, "Be kind.", saved["comments_notice"])

	var fields json.RawMessage
	require.NoError(t, f.conn.QueryRow(`SELECT payload->'fields' FROM activity WHERE verb = 'settings_updated' AND actor_id = $1 ORDER BY id DESC LIMIT 1`, admin.ID).Scan(&fields))
	require.Contains(t, string(fields), "comments_hold_words", "settings_updated names the fields")
	require.NotContains(t, string(fields), "casino", "never the values")

	// Public: the display settings and the notice, never the word lists.
	recorder = trashCall(t, f.server, nil, http.MethodGet, "/api/v1/settings", nil)
	require.Equal(t, http.StatusOK, recorder.Code)
	var public map[string]any
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &public))
	require.Contains(t, public, "comments_enabled")
	require.Equal(t, "Be kind.", public["comments_notice"])
	require.NotContains(t, public, "comments_hold_words")
	require.NotContains(t, public, "comments_spam_words")
	require.NotContains(t, recorder.Body.String(), "casino")
	for _, caller := range []db.User{f.editor, scheduleUser(t, f.store, RoleContributor)} {
		recorder = trashCall(t, f.server, &caller, http.MethodGet, "/api/v1/settings", nil)
		require.Equal(t, http.StatusOK, recorder.Code)
		require.NotContains(t, recorder.Body.String(), "casino", "%s: not for them either", caller.Role)
	}
	recorder = trashCall(t, f.server, &admin, http.MethodGet, "/api/v1/settings", nil)
	require.Equal(t, http.StatusOK, recorder.Code)
	require.Contains(t, recorder.Body.String(), `"comments_hold_words":["casino","free money"]`)

	// [] clears a list.
	recorder = trashCall(t, f.server, &admin, http.MethodPut, "/api/v1/settings", map[string]any{"comments_hold_words": []string{}})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), `"comments_hold_words":[]`)
	require.Contains(t, recorder.Body.String(), `"comments_spam_words":["viagra"]`, "absent keeps")

	for name, body := range map[string]map[string]any{
		"moderation":         {"comments_moderation": "some"},
		"max links over 10":  {"comments_max_links": 11},
		"max links negative": {"comments_max_links": -1},
		"close over 3650":    {"comments_close_after_days": 3651},
		"per page under 10":  {"comments_per_page": 9},
		"per page zero":      {"comments_per_page": 0},
		"per page over 100":  {"comments_per_page": 101},
		"threading":          {"comments_threading": "nested"},
		"order":              {"comments_order": "best"},
		"notice too long":    {"comments_notice": strings.Repeat("x", 401)},
		"notice two lines":   {"comments_notice": "one\ntwo"},
		"a word too long":    {"comments_spam_words": []string{strings.Repeat("x", 65)}},
		"privacy not a page": {"comments_privacy_page_id": "x"},
		"privacy a post":     {"comments_privacy_page_id": f.publishedPost(t).ID},
		"privacy missing":    {"comments_privacy_page_id": 999999999999},
	} {
		recorder := trashCall(t, f.server, &admin, http.MethodPut, "/api/v1/settings", body)
		require.Equal(t, http.StatusBadRequest, recorder.Code, "%s: %s", name, recorder.Body.String())
	}

	// A published page as the privacy page, then none.
	page := scheduleDraft(t, f.store, admin, scheduleWord())
	_, err := f.conn.Exec(`UPDATE posts SET post_type = 'page' WHERE id = $1`, page.ID)
	require.NoError(t, err)
	page = publishForTest(t, f.store, reloadPost(t, f.store, page.ID), admin)
	recorder = trashCall(t, f.server, &admin, http.MethodPut, "/api/v1/settings", map[string]any{"comments_privacy_page_id": page.ID})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), fmt.Sprintf(`"comments_privacy_page_id":%d`, page.ID))
	recorder = trashCall(t, f.server, &admin, http.MethodPut, "/api/v1/settings", map[string]any{"comments_privacy_page_id": nil})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), `"comments_privacy_page_id":null`)

	recorder = trashCall(t, f.server, &f.editor, http.MethodPut, "/api/v1/settings", map[string]any{"comments_enabled": true})
	require.Equal(t, http.StatusForbidden, recorder.Code, "admins only")
}
