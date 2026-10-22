package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"

	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"
)

// publishPost runs the publish handler's statements (api.publishPost):
// snapshot the working copy as the next version, then point the post at it.
func publishPost(t *testing.T, postID, userID int64, label string) InsertPostVersionRow {
	t.Helper()
	ctx := context.Background()

	current, err := testQueries.GetPostBlocks(ctx, postID)
	require.NoError(t, err)
	next, err := testQueries.GetNextVersionNoForPost(ctx, postID)
	require.NoError(t, err)

	version, err := testQueries.InsertPostVersion(ctx, InsertPostVersionParams{
		PostID:    postID,
		VersionNo: next,
		Label:     sql.NullString{String: label, Valid: label != ""},
		BlockDoc:  current.Content,
		CreatedBy: sql.NullInt64{Int64: userID, Valid: true},
	})
	require.NoError(t, err)

	require.NoError(t, testQueries.SetPublishedVersionOnPost(ctx, SetPublishedVersionOnPostParams{
		ID:                 postID,
		PublishedVersionID: sql.NullInt64{Int64: version.ID, Valid: true},
		PublishedBlockDoc:  pqtype.NullRawMessage{RawMessage: current.Content, Valid: true},
	}))
	return version
}

// TestPublishCreatesVersionsAndSnapshot covers the publish flow end to end:
// version numbers count up per post, the published snapshot is frozen at
// publish time, and later edits only touch the working copy (block_doc and
// published_block_doc must stay independent).
func TestPublishCreatesVersionsAndSnapshot(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post
	other := createPostWithTransaction(t).Post

	writeBlocks := func(doc json.RawMessage) {
		current, err := testQueries.GetPostBlocks(ctx, post.ID)
		require.NoError(t, err)
		_, err = testQueries.UpdatePostBlocksIfRevisionMatches(ctx, UpdatePostBlocksIfRevisionMatchesParams{
			ID: post.ID, BlockDoc: doc, BlockRevision: current.Revision,
		})
		require.NoError(t, err)
	}

	next, err := testQueries.GetNextVersionNoForPost(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, int32(1), next)

	// Never published: no snapshot yet.
	_, err = testQueries.GetLatestPublishedVersion(ctx, post.ID)
	require.ErrorIs(t, err, sql.ErrNoRows)

	docV1 := json.RawMessage(`{"version":1,"blocks":[{"id":"a","type":"paragraph","data":{"text":"first"}}]}`)
	writeBlocks(docV1)

	v1 := publishPost(t, post.ID, post.UserID, "launch")
	require.Equal(t, int32(1), v1.VersionNo)

	docV2 := json.RawMessage(`{"version":1,"blocks":[{"id":"a","type":"paragraph","data":{"text":"second"}}]}`)
	writeBlocks(docV2)

	// Editing after publishing leaves the published snapshot alone.
	published, err := testQueries.GetPublishedPostBlocks(ctx, post.ID)
	require.NoError(t, err)
	require.True(t, published.Content.Valid)
	require.JSONEq(t, string(docV1), string(published.Content.RawMessage))
	// Publishing makes the post public, whatever status it was created with (#136).
	require.Equal(t, "published", published.PostStatus)

	v2 := publishPost(t, post.ID, post.UserID, "")
	require.Equal(t, int32(2), v2.VersionNo)

	latest, err := testQueries.GetLatestPublishedVersion(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, v2.ID, latest.ID)
	require.JSONEq(t, string(docV2), string(latest.BlockDoc))
	require.Equal(t, "published", latest.Status)
	require.False(t, latest.Label.Valid)
	require.Equal(t, post.UserID, latest.CreatedBy.Int64)

	versions, err := testQueries.GetPostVersions(ctx, post.ID)
	require.NoError(t, err)
	require.Len(t, versions, 2)
	require.Equal(t, int32(2), versions[0].VersionNo.Int32, "newest first")
	require.Equal(t, v2.ID, versions[0].PublishedVersionID.Int64, "post columns ride along")
	require.Equal(t, "launch", versions[1].Label.String)

	gotPost, err := testQueries.GetPost(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, v2.ID, gotPost.PublishedVersionID.Int64)

	// Version numbers are per post.
	next, err = testQueries.GetNextVersionNoForPost(ctx, other.ID)
	require.NoError(t, err)
	require.Equal(t, int32(1), next)

	// (post_id, version_no) is unique: a racing publish that computed the
	// same next number must fail rather than create a duplicate version.
	_, err = testQueries.InsertPostVersion(ctx, InsertPostVersionParams{
		PostID:    post.ID,
		VersionNo: 2,
		BlockDoc:  docV2,
	})
	require.Error(t, err)

	// One version by number, scoped to its post (#136).
	got, err := testQueries.GetPostVersion(ctx, GetPostVersionParams{PostID: post.ID, VersionNo: 1})
	require.NoError(t, err)
	require.Equal(t, v1.ID, got.ID)
	require.JSONEq(t, string(docV1), string(got.BlockDoc))
	require.Equal(t, "launch", got.Label.String)
	require.True(t, got.CreatedByUsername.Valid)
	_, err = testQueries.GetPostVersion(ctx, GetPostVersionParams{PostID: other.ID, VersionNo: 1})
	require.ErrorIs(t, err, sql.ErrNoRows)
}

// TestUnpublishKeepsHistory covers #136's unpublish: back to draft with the public
// snapshot dropped, while the working copy and every version survive.
func TestUnpublishKeepsHistory(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post

	doc := json.RawMessage(`{"doc_version":1,"blocks_order":["a"],"blocks":{"a":{"id":"a","type":"paragraph","attrs":{"text":"live"}}}}`)
	current, err := testQueries.GetPostBlocks(ctx, post.ID)
	require.NoError(t, err)
	_, err = testQueries.UpdatePostBlocksIfRevisionMatches(ctx, UpdatePostBlocksIfRevisionMatchesParams{
		ID: post.ID, BlockDoc: doc, BlockRevision: current.Revision,
	})
	require.NoError(t, err)
	v1 := publishPost(t, post.ID, post.UserID, "")

	unpublished, err := testQueries.UnpublishPost(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, "draft", unpublished.PostStatus)
	require.False(t, unpublished.PublishedVersionID.Valid)
	require.False(t, unpublished.PublishedBlockDoc.Valid)

	published, err := testQueries.GetPublishedPostBlocks(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, "draft", published.PostStatus)
	require.False(t, published.Content.Valid)

	working, err := testQueries.GetPostBlocks(ctx, post.ID)
	require.NoError(t, err)
	require.JSONEq(t, string(doc), string(working.Content))

	versions, err := testQueries.GetPostVersions(ctx, post.ID)
	require.NoError(t, err)
	require.Len(t, versions, 1)
	require.Equal(t, v1.ID, versions[0].VersionID.Int64)
	require.Equal(t, "draft", versions[0].PostStatus)
	require.False(t, versions[0].PublishedVersionID.Valid)

	// A post without versions yields one placeholder row; a missing post none.
	fresh := createPostWithTransaction(t).Post
	placeholder, err := testQueries.GetPostVersions(ctx, fresh.ID)
	require.NoError(t, err)
	require.Len(t, placeholder, 1)
	require.False(t, placeholder[0].VersionID.Valid)
	missing, err := testQueries.GetPostVersions(ctx, -1)
	require.NoError(t, err)
	require.Empty(t, missing)

	// Republishing continues the numbering and makes the post public again.
	v2 := publishPost(t, post.ID, post.UserID, "")
	require.Equal(t, int32(2), v2.VersionNo)
	again, err := testQueries.GetPost(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, "published", again.PostStatus)
	require.Equal(t, v2.ID, again.PublishedVersionID.Int64)

	_, err = testQueries.UnpublishPost(ctx, -1)
	require.ErrorIs(t, err, sql.ErrNoRows)
}

// TestBlockRevisionGuard covers the optimistic-concurrency check that keeps a
// stale editor tab from overwriting newer blocks.
func TestBlockRevisionGuard(t *testing.T) {
	ctx := context.Background()
	post := createPostWithTransaction(t).Post

	start, err := testQueries.GetPostBlocks(ctx, post.ID)
	require.NoError(t, err)

	first := json.RawMessage(`{"version":1,"blocks":[{"id":"x","type":"paragraph","data":{"text":"mine"}}]}`)
	row, err := testQueries.UpdatePostBlocksIfRevisionMatches(ctx, UpdatePostBlocksIfRevisionMatchesParams{
		ID: post.ID, BlockDoc: first, BlockRevision: start.Revision,
	})
	require.NoError(t, err)
	require.Equal(t, start.Revision+1, row.Revision)
	require.JSONEq(t, string(first), string(row.Content))

	// A writer still holding the old revision is refused and changes nothing.
	stale := json.RawMessage(`{"version":1,"blocks":[]}`)
	_, err = testQueries.UpdatePostBlocksIfRevisionMatches(ctx, UpdatePostBlocksIfRevisionMatchesParams{
		ID: post.ID, BlockDoc: stale, BlockRevision: start.Revision,
	})
	require.ErrorIs(t, err, sql.ErrNoRows)

	current, err := testQueries.GetPostBlocks(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, start.Revision+1, current.Revision)
	require.JSONEq(t, string(first), string(current.Content))

	// A missing post looks the same as a revision conflict to this query.
	_, err = testQueries.UpdatePostBlocksIfRevisionMatches(ctx, UpdatePostBlocksIfRevisionMatchesParams{
		ID: -1, BlockDoc: stale, BlockRevision: start.Revision,
	})
	require.ErrorIs(t, err, sql.ErrNoRows)
}
