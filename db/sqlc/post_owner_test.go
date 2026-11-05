package db

import (
	"context"
	"database/sql"
	"testing"

	"github.com/stretchr/testify/require"
)

// Post ownership (#353): TransferPostOwnerTx, and the reassignment it shares with
// a member's removal (RemoveUserTx, #333).

var ownerRoles = []string{"admin", "editor", "contributor"}

func postOwner(t *testing.T, postID int64) (int64, string) {
	t.Helper()
	post, err := testQueries.GetPost(context.Background(), postID)
	require.NoError(t, err)
	return post.UserID, post.Username
}

func TestTransferPostOwnerTxKeepsByline(t *testing.T) {
	ctx := context.Background()
	owner := createTestUserWithRole(t, "contributor")
	ana := createTestUserWithRole(t, "editor")
	bo := createTestUser(t)
	post := createBylinePost(t, owner, owner, bo)

	result, err := testStore.TransferPostOwnerTx(ctx, TransferPostOwnerTxParams{PostID: post.ID, ToID: ana.ID, OwnerRoles: ownerRoles})
	require.NoError(t, err)
	require.Equal(t, owner.ID, result.PreviousOwnerID)
	require.Equal(t, ana.ID, result.Owner.ID)
	require.Equal(t, ana.Username, result.Owner.Username)
	require.False(t, result.BylineChanged)
	require.Equal(t, ana.ID, result.Post.UserID)

	id, username := postOwner(t, post.ID)
	require.Equal(t, ana.ID, id, "the owner changed")
	require.Equal(t, ana.Username, username, "with the denormalized username")
	require.Equal(t, []int64{owner.ID, bo.ID}, bylineIDs(t, post.ID), "the byline is untouched: the old owner keeps their place")
	require.True(t, result.Post.ChangedAt.Equal(post.ChangedAt), "ownership isn't content: changed_at stays")
}

func TestTransferPostOwnerTxReplacesInByline(t *testing.T) {
	ctx := context.Background()
	owner := createTestUserWithRole(t, "contributor")
	ana := createTestUserWithRole(t, "contributor")
	bo := createTestUser(t)

	t.Run("in the old owner's place", func(t *testing.T) {
		post := createBylinePost(t, owner, bo, owner)
		result, err := testStore.TransferPostOwnerTx(ctx, TransferPostOwnerTxParams{PostID: post.ID, ToID: ana.ID, OwnerRoles: ownerRoles, ReplaceInByline: true})
		require.NoError(t, err)
		require.True(t, result.BylineChanged)
		require.Equal(t, []int64{bo.ID, ana.ID}, bylineIDs(t, post.ID), "same position")
		require.Len(t, result.Authors, 2)
		require.Equal(t, ana.ID, result.Authors[1].ID)
		require.True(t, result.Post.ChangedAt.After(post.ChangedAt), "a setting changed")
	})
	t.Run("new owner already credited", func(t *testing.T) {
		post := createBylinePost(t, owner, owner, ana, bo)
		_, err := testStore.TransferPostOwnerTx(ctx, TransferPostOwnerTxParams{PostID: post.ID, ToID: ana.ID, OwnerRoles: ownerRoles, ReplaceInByline: true})
		require.NoError(t, err)
		require.Equal(t, []int64{ana.ID, bo.ID}, bylineIDs(t, post.ID), "the old owner's credit goes, the new owner keeps theirs")
	})
	t.Run("old owner not credited", func(t *testing.T) {
		post := createBylinePost(t, owner, bo)
		result, err := testStore.TransferPostOwnerTx(ctx, TransferPostOwnerTxParams{PostID: post.ID, ToID: ana.ID, OwnerRoles: ownerRoles, ReplaceInByline: true})
		require.NoError(t, err)
		require.False(t, result.BylineChanged)
		require.Equal(t, []int64{bo.ID}, bylineIDs(t, post.ID), "nobody to replace")
	})
}

// On a published post the byline is a setting (#319): replacing the old owner
// changes the working byline only, and the site keeps the published one until Update.
func TestTransferPostOwnerTxPublishedBylineWaitsForUpdate(t *testing.T) {
	ctx := context.Background()
	owner := createTestUserWithRole(t, "contributor")
	ana := createTestUserWithRole(t, "editor")

	kept := createBylinePost(t, owner)
	publishBylinePost(t, kept.ID)
	_, err := testStore.TransferPostOwnerTx(ctx, TransferPostOwnerTxParams{PostID: kept.ID, ToID: ana.ID, OwnerRoles: ownerRoles})
	require.NoError(t, err)
	require.Equal(t, []int64{owner.ID}, publishedBylineIDs(t, kept.ID))
	require.False(t, settingsChanged(t, kept.ID), "an owner change alone is nothing to publish")

	replaced := createBylinePost(t, owner)
	publishBylinePost(t, replaced.ID)
	_, err = testStore.TransferPostOwnerTx(ctx, TransferPostOwnerTxParams{PostID: replaced.ID, ToID: ana.ID, OwnerRoles: ownerRoles, ReplaceInByline: true})
	require.NoError(t, err)
	require.Equal(t, []int64{ana.ID}, bylineIDs(t, replaced.ID))
	require.Equal(t, []int64{owner.ID}, publishedBylineIDs(t, replaced.ID), "the site shows the old byline until Update")
	require.True(t, settingsChanged(t, replaced.ID), "the byline change waits for Update")

	publishBylinePost(t, replaced.ID)
	require.Equal(t, []int64{ana.ID}, publishedBylineIDs(t, replaced.ID))
}

func TestTransferPostOwnerTxRefusals(t *testing.T) {
	ctx := context.Background()
	owner := createTestUserWithRole(t, "contributor")
	ana := createTestUserWithRole(t, "editor")
	post := createBylinePost(t, owner)

	unchanged := func(t *testing.T) {
		t.Helper()
		id, _ := postOwner(t, post.ID)
		require.Equal(t, owner.ID, id, "nothing written")
		require.Equal(t, []int64{owner.ID}, bylineIDs(t, post.ID))
	}

	t.Run("no such member", func(t *testing.T) {
		_, err := testStore.TransferPostOwnerTx(ctx, TransferPostOwnerTxParams{PostID: post.ID, ToID: 1 << 60, OwnerRoles: ownerRoles, ReplaceInByline: true})
		require.ErrorIs(t, err, ErrNewOwnerNotFound)
		unchanged(t)
	})
	t.Run("removed member", func(t *testing.T) {
		gone := createTestUserWithRole(t, "editor")
		_, err := testStore.RemoveUserTx(ctx, RemoveUserTxParams{UserID: gone.ID, ReassignTo: ana.ID})
		require.NoError(t, err)
		_, err = testStore.TransferPostOwnerTx(ctx, TransferPostOwnerTxParams{PostID: post.ID, ToID: gone.ID, OwnerRoles: ownerRoles})
		require.ErrorIs(t, err, ErrNewOwnerNotFound)
		unchanged(t)
	})
	t.Run("not an active member", func(t *testing.T) {
		reader := createTestUserWithRole(t, "user")
		_, err := testStore.TransferPostOwnerTx(ctx, TransferPostOwnerTxParams{PostID: post.ID, ToID: reader.ID, OwnerRoles: ownerRoles})
		require.ErrorIs(t, err, ErrNewOwnerInactive)
		unchanged(t)
	})
	t.Run("already the owner", func(t *testing.T) {
		_, err := testStore.TransferPostOwnerTx(ctx, TransferPostOwnerTxParams{PostID: post.ID, ToID: owner.ID, OwnerRoles: ownerRoles})
		require.ErrorIs(t, err, ErrAlreadyOwner)
		unchanged(t)
	})
	t.Run("no such post", func(t *testing.T) {
		_, err := testStore.TransferPostOwnerTx(ctx, TransferPostOwnerTxParams{PostID: 1 << 60, ToID: ana.ID, OwnerRoles: ownerRoles})
		require.ErrorIs(t, err, sql.ErrNoRows)
	})
	t.Run("in the trash", func(t *testing.T) {
		trashed := createBylinePost(t, owner)
		_, err := testQueries.TrashPost(ctx, trashed.ID)
		require.NoError(t, err)
		_, err = testStore.TransferPostOwnerTx(ctx, TransferPostOwnerTxParams{PostID: trashed.ID, ToID: ana.ID, OwnerRoles: ownerRoles})
		require.ErrorIs(t, err, ErrPostTrashed)
		id, _ := postOwner(t, trashed.ID)
		require.Equal(t, owner.ID, id)
	})
}

// A removal (#333) runs the transfer's reassignment (reassignPostOwner) on every
// post the member owns: the same owner and byline result as transferring each one
// with ReplaceInByline. Only the rest of a removal (credits elsewhere, the published
// bylines, media, the row) is its own.
func TestRemovalAndTransferShareTheReassignment(t *testing.T) {
	ctx := context.Background()
	recipient := createTestUserWithRole(t, "editor")
	bo := createTestUser(t)

	type setup struct{ inPlace, credited, uncredited Post }
	build := func(owner User) setup {
		return setup{
			inPlace:    createBylinePost(t, owner, bo, owner),
			credited:   createBylinePost(t, owner, owner, recipient, bo),
			uncredited: createBylinePost(t, owner, bo),
		}
	}

	transferred := createTestUserWithRole(t, "contributor")
	viaTransfer := build(transferred)
	for _, p := range []Post{viaTransfer.inPlace, viaTransfer.credited, viaTransfer.uncredited} {
		_, err := testStore.TransferPostOwnerTx(ctx, TransferPostOwnerTxParams{PostID: p.ID, ToID: recipient.ID, OwnerRoles: ownerRoles, ReplaceInByline: true})
		require.NoError(t, err)
	}

	removed := createTestUserWithRole(t, "contributor")
	viaRemoval := build(removed)
	result, err := testStore.RemoveUserTx(ctx, RemoveUserTxParams{UserID: removed.ID, ReassignTo: recipient.ID})
	require.NoError(t, err)
	require.Equal(t, 3, result.PostsReassigned)

	for _, pair := range [][2]Post{
		{viaTransfer.inPlace, viaRemoval.inPlace},
		{viaTransfer.credited, viaRemoval.credited},
		{viaTransfer.uncredited, viaRemoval.uncredited},
	} {
		tID, tUsername := postOwner(t, pair[0].ID)
		rID, rUsername := postOwner(t, pair[1].ID)
		require.Equal(t, recipient.ID, tID)
		require.Equal(t, tID, rID)
		require.Equal(t, tUsername, rUsername)
		require.Equal(t, bylineIDs(t, pair[0].ID), bylineIDs(t, pair[1].ID))
	}
	require.Equal(t, []int64{bo.ID, recipient.ID}, bylineIDs(t, viaRemoval.inPlace.ID), "the recipient takes the member's place")
}

// reassignPostOwner on its own: AllPosts moves only the posts From still owns, and
// PostIDs only those listed (and still From's).
func TestReassignPostOwnerScope(t *testing.T) {
	ctx := context.Background()
	from := createTestUserWithRole(t, "contributor")
	to := createTestUserWithRole(t, "editor")
	other := createTestUser(t)
	a, b := createBylinePost(t, from), createBylinePost(t, from)
	notTheirs := createBylinePost(t, other)

	err := testStore.ExecTx(ctx, func(q *Queries) error {
		moved, err := reassignPostOwner(ctx, q, postOwnerChange{FromID: from.ID, ToID: to.ID, ToUsername: to.Username, PostIDs: []int64{a.ID, notTheirs.ID}})
		require.NoError(t, err)
		require.Equal(t, []int64{a.ID}, moved, "only the listed posts From owns")
		return nil
	})
	require.NoError(t, err)
	id, _ := postOwner(t, b.ID)
	require.Equal(t, from.ID, id, "an unlisted post stays")
	id, _ = postOwner(t, notTheirs.ID)
	require.Equal(t, other.ID, id)

	err = testStore.ExecTx(ctx, func(q *Queries) error {
		moved, err := reassignPostOwner(ctx, q, postOwnerChange{FromID: from.ID, ToID: to.ID, ToUsername: to.Username, AllPosts: true})
		require.NoError(t, err)
		require.Equal(t, []int64{b.ID}, moved)
		return nil
	})
	require.NoError(t, err)
	require.Equal(t, []int64{from.ID}, bylineIDs(t, b.ID), "without ReplaceInByline the byline stays")
}
