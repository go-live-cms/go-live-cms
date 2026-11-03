package db

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"
)

// "Changes not published" (#326): a published post whose working copy (body or
// settings) differs from what the site shows. Every reader of the flag must agree:
// the lists (and their filter), the counts, the detail lookup and the editor's
// settings state.

// unpublishedChanges reads the flag for the fixture's post from every query that
// has it, requires them to agree and returns it. The fixture's owner is a fresh
// user, so their counts and lists hold only this post.
func unpublishedChanges(t *testing.T, f settingsFixture) bool {
	t.Helper()
	ctx := context.Background()

	detail, err := testQueries.GetPostHasUnpublishedChanges(ctx, f.post.ID)
	require.NoError(t, err)

	state, err := testQueries.GetPostSettingsState(ctx, f.post.ID)
	require.NoError(t, err)
	require.Equal(t, detail, state.HasUnpublishedChanges, "settings state")
	require.Equal(t, detail, state.Changed || state.BlocksChanged, "settings state halves")

	list, err := testQueries.ListPosts(ctx, ListPostsParams{UserID: f.post.UserID, LimitCount: 10})
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, detail, list[0].HasUnpublishedChanges, "ListPosts")

	withMeta, err := testQueries.ListPostsWithMeta(ctx, ListPostsWithMetaParams{UserID: f.post.UserID, LimitCount: 10})
	require.NoError(t, err)
	require.Len(t, withMeta, 1)
	require.Equal(t, detail, withMeta[0].HasUnpublishedChanges, "ListPostsWithMeta")

	allMeta, err := testQueries.ListPostsWithAllMeta(ctx, ListPostsWithAllMetaParams{UserID: f.post.UserID, LimitCount: 10})
	require.NoError(t, err)
	require.Len(t, allMeta, 1)
	require.Equal(t, detail, allMeta[0].HasUnpublishedChanges, "ListPostsWithAllMeta")

	// The "Changes not published" tab: the filter keeps the post exactly when flagged.
	filtered, err := testQueries.ListPostsWithMeta(ctx, ListPostsWithMetaParams{UserID: f.post.UserID, UnpublishedChanges: true, LimitCount: 10})
	require.NoError(t, err)
	require.Equal(t, detail, len(filtered) == 1, "filtered list")
	plain, err := testQueries.ListPosts(ctx, ListPostsParams{UserID: f.post.UserID, UnpublishedChanges: true, LimitCount: 10})
	require.NoError(t, err)
	require.Equal(t, detail, len(plain) == 1, "filtered ListPosts")
	total, err := testQueries.CountFilteredPosts(ctx, CountFilteredPostsParams{UserID: f.post.UserID, UnpublishedChanges: true})
	require.NoError(t, err)
	require.Equal(t, detail, total == 1, "filtered count")

	counts, err := testQueries.CountPostsByStatus(ctx, CountPostsByStatusParams{UserID: f.post.UserID})
	require.NoError(t, err)
	require.Len(t, counts, 1)
	require.Equal(t, int64(1), counts[0].Total)
	require.Equal(t, detail, counts[0].UnpublishedChanges == 1, "counts")
	return detail
}

// storeBody writes the post's working body the way the collab server's store does.
func storeBody(t *testing.T, postID int64, doc json.RawMessage) {
	t.Helper()
	_, err := testStore.StorePostCollabTx(context.Background(), StorePostCollabTxParams{
		PostID:   postID,
		State:    []byte{1},
		Epoch:    uuid.New(),
		BlockDoc: doc,
	})
	require.NoError(t, err)
}

func setTitle(t *testing.T, postID int64, title string) {
	t.Helper()
	_, err := testQueries.db.ExecContext(context.Background(), `UPDATE posts SET title = $2 WHERE id = $1`, postID, title)
	require.NoError(t, err)
}

func publish(t *testing.T, postID int64) {
	t.Helper()
	_, err := testStore.PublishPostTx(context.Background(), PublishPostTxParams{PostID: postID})
	require.NoError(t, err)
}

func TestUnpublishedChangesBlockEdits(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)
	require.False(t, unpublishedChanges(t, f), "a draft has nothing published")

	publish(t, f.post.ID)
	require.False(t, unpublishedChanges(t, f), "just published")

	storeBody(t, f.post.ID, searchDoc("body", "a new paragraph"))
	require.True(t, unpublishedChanges(t, f), "edited after the publish")
	state, err := testQueries.GetPostSettingsState(ctx, f.post.ID)
	require.NoError(t, err)
	require.True(t, state.BlocksChanged)
	require.False(t, state.Changed, "only the body changed")

	// Undone before anyone published: the working copy is the published one again.
	storeBody(t, f.post.ID, searchDoc("body"))
	require.False(t, unpublishedChanges(t, f), "an edit undone is no change")

	storeBody(t, f.post.ID, searchDoc("body", "edited again"))
	require.True(t, unpublishedChanges(t, f))
	publish(t, f.post.ID)
	require.False(t, unpublishedChanges(t, f), "published again")

	storeBody(t, f.post.ID, searchDoc("edited after the second publish"))
	require.True(t, unpublishedChanges(t, f))
	_, err = testQueries.UnpublishPost(ctx, f.post.ID)
	require.NoError(t, err)
	require.False(t, unpublishedChanges(t, f), "a draft again: nothing is published")
}

func TestUnpublishedChangesSettingsEdits(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)
	publish(t, f.post.ID)
	require.False(t, unpublishedChanges(t, f), "just published")

	setTitle(t, f.post.ID, "A new title")
	require.True(t, unpublishedChanges(t, f), "title edited after the publish")
	state, err := testQueries.GetPostSettingsState(ctx, f.post.ID)
	require.NoError(t, err)
	require.True(t, state.Changed)
	require.False(t, state.BlocksChanged, "only the settings changed")

	setTitle(t, f.post.ID, "Original title")
	require.False(t, unpublishedChanges(t, f), "the title is the published one again")

	// A term link and the featured image count too.
	require.NoError(t, testQueries.RemovePostFromTaxonomyTerm(ctx, RemovePostFromTaxonomyTermParams{PostID: f.post.ID, TaxonomyTermID: f.terms[0].ID}))
	require.True(t, unpublishedChanges(t, f), "a term removed")
	publish(t, f.post.ID)
	require.False(t, unpublishedChanges(t, f), "published again")

	_, other := createTestMedia(t)
	setFeaturedImageMeta(t, f.post.ID, other)
	require.True(t, unpublishedChanges(t, f), "featured image replaced")
	publish(t, f.post.ID)
	require.False(t, unpublishedChanges(t, f), "published again")

	// The slug isn't in the snapshot: it changes at once and is never pending.
	_, err = testQueries.UpdatePostSlug(ctx, UpdatePostSlugParams{ID: f.post.ID, Slug: f.post.Slug + "-renamed"})
	require.NoError(t, err)
	require.False(t, unpublishedChanges(t, f), "a slug change is live already")

	setTitle(t, f.post.ID, "Edited before unpublishing")
	require.True(t, unpublishedChanges(t, f))
	_, err = testQueries.UnpublishPost(ctx, f.post.ID)
	require.NoError(t, err)
	require.False(t, unpublishedChanges(t, f), "a draft again: nothing is published")
}

// Archiving keeps the published snapshot (PUT /posts/:id only changes the
// status), but an archived post isn't on the site, so it has no pending update.
func TestUnpublishedChangesOnlyForPublishedPosts(t *testing.T) {
	f := createSettingsFixture(t)
	publish(t, f.post.ID)
	storeBody(t, f.post.ID, searchDoc("edited"))
	require.True(t, unpublishedChanges(t, f))

	_, err := testQueries.db.ExecContext(context.Background(), `UPDATE posts SET post_status = 'archived' WHERE id = $1`, f.post.ID)
	require.NoError(t, err)
	require.False(t, unpublishedChanges(t, f), "archived")
}

// The admin search shares the list's filter (#145's box on the tab).
func TestSearchUnpublishedChangesFilter(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)
	publish(t, f.post.ID)
	search := func() int {
		params := SearchPostsWithMetaParams{Query: "Original", UserID: f.post.UserID, UnpublishedChanges: true, LimitCount: 10}
		rows, err := testQueries.SearchPostsWithMeta(ctx, params)
		require.NoError(t, err)
		total, err := testQueries.CountSearchPosts(ctx, CountSearchPostsParams{Query: params.Query, UserID: params.UserID, UnpublishedChanges: true})
		require.NoError(t, err)
		require.Equal(t, int64(len(rows)), total)
		for _, row := range rows {
			require.True(t, row.HasUnpublishedChanges)
		}
		return len(rows)
	}
	require.Equal(t, 0, search())
	storeBody(t, f.post.ID, searchDoc("body", "more"))
	require.Equal(t, 1, search())
}

// A post created as published (POST /posts with post_status) gets an empty
// published body: until someone publishes its working copy, that copy isn't live.
func TestUnpublishedChangesCreatedAsPublished(t *testing.T) {
	ctx := context.Background()
	f := createSettingsFixture(t)
	require.NoError(t, testQueries.SetPublishedVersionOnPost(ctx, SetPublishedVersionOnPostParams{
		ID:                f.post.ID,
		PublishedBlockDoc: pqtype.NullRawMessage{RawMessage: json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`), Valid: true},
	}))
	require.True(t, unpublishedChanges(t, f), "the body isn't the published one")
	publish(t, f.post.ID)
	require.False(t, unpublishedChanges(t, f))
}
