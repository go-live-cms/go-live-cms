package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Byline authors (#319): SetPostAuthorsTx, the snapshot (published byline,
// restore), the author pages and removal (RemoveUserTx).

// bylineIDs is the post's working byline, in order.
func bylineIDs(t *testing.T, postID int64) []int64 {
	t.Helper()
	rows, err := testQueries.ListPostBylineAuthors(context.Background(), postID)
	require.NoError(t, err)
	ids := make([]int64, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	return ids
}

// publishedBylineIDs is the post's published byline: the snapshot's author_ids
// and post_published_authors, which the trigger must keep equal.
func publishedBylineIDs(t *testing.T, postID int64) []int64 {
	t.Helper()
	ctx := context.Background()
	post, err := testQueries.GetPost(ctx, postID)
	require.NoError(t, err)
	var snapshot struct {
		AuthorIDs []int64 `json:"author_ids"`
	}
	if post.PublishedSettings.Valid {
		require.NoError(t, json.Unmarshal(post.PublishedSettings.RawMessage, &snapshot))
	}
	rows, err := testQueries.db.QueryContext(ctx,
		`SELECT user_id FROM post_published_authors WHERE post_id = $1 ORDER BY position`, postID)
	require.NoError(t, err)
	defer rows.Close()
	table := []int64{}
	for rows.Next() {
		var id int64
		require.NoError(t, rows.Scan(&id))
		table = append(table, id)
	}
	require.NoError(t, rows.Err())
	if snapshot.AuthorIDs == nil {
		snapshot.AuthorIDs = []int64{}
	}
	require.Equal(t, snapshot.AuthorIDs, table, "post_published_authors follows published_settings.author_ids")
	return table
}

// createBylinePost creates a draft of a public post type owned by owner,
// credited to authors (the owner when none are given).
func createBylinePost(t *testing.T, owner User, authors ...User) Post {
	t.Helper()
	if len(authors) == 0 {
		authors = []User{owner}
	}
	return createCreditedPost(t, createAuthorPostType(t, true, true), "draft", owner, authors...)
}

func publishBylinePost(t *testing.T, postID int64) {
	t.Helper()
	_, err := testStore.PublishPostTx(context.Background(), PublishPostTxParams{PostID: postID})
	require.NoError(t, err)
}

func settingsChanged(t *testing.T, postID int64) bool {
	t.Helper()
	state, err := testQueries.GetPostSettingsState(context.Background(), postID)
	require.NoError(t, err)
	return state.Changed
}

func TestSetPostAuthorsTxSetsAndReorders(t *testing.T) {
	ctx := context.Background()
	owner, ana, bo := createTestUser(t), createTestUser(t), createTestUser(t)
	post := createBylinePost(t, owner)
	require.Equal(t, []int64{owner.ID}, bylineIDs(t, post.ID), "the default byline is the owner")

	result, err := testStore.SetPostAuthorsTx(ctx, SetPostAuthorsTxParams{PostID: post.ID, AuthorIDs: []int64{ana.ID, owner.ID, bo.ID}})
	require.NoError(t, err)
	require.Equal(t, []int64{ana.ID, owner.ID, bo.ID}, bylineIDs(t, post.ID))
	require.Equal(t, owner.ID, result.Post.UserID, "a byline edit never changes the owner")
	require.True(t, result.Post.ChangedAt.After(post.ChangedAt))
	require.Len(t, result.Authors, 3)
	require.Equal(t, ana.ID, result.Authors[0].ID, "the written byline comes back, in order")

	// Reorder, and leave the owner out (a ghost-written post).
	_, err = testStore.SetPostAuthorsTx(ctx, SetPostAuthorsTxParams{PostID: post.ID, AuthorIDs: []int64{bo.ID, ana.ID}})
	require.NoError(t, err)
	require.Equal(t, []int64{bo.ID, ana.ID}, bylineIDs(t, post.ID))
	stored, err := testQueries.GetPost(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, owner.ID, stored.UserID)

	t.Run("unknown user", func(t *testing.T) {
		_, err := testStore.SetPostAuthorsTx(ctx, SetPostAuthorsTxParams{PostID: post.ID, AuthorIDs: []int64{ana.ID, 1 << 60}})
		require.ErrorIs(t, err, ErrUnknownAuthor)
		require.Equal(t, []int64{bo.ID, ana.ID}, bylineIDs(t, post.ID), "nothing written")
	})
	t.Run("changed since it was loaded", func(t *testing.T) {
		// The caller edited [ana, bo]; the byline is [bo, ana] now.
		result, err := testStore.SetPostAuthorsTx(ctx, SetPostAuthorsTxParams{
			PostID: post.ID, AuthorIDs: []int64{ana.ID}, BaseAuthorIDs: []int64{ana.ID, bo.ID},
		})
		require.ErrorIs(t, err, ErrBylineChanged)
		require.Len(t, result.Current, 2)
		require.Equal(t, []int64{bo.ID, ana.ID}, []int64{result.Current[0].ID, result.Current[1].ID})
		require.Equal(t, []int64{bo.ID, ana.ID}, bylineIDs(t, post.ID), "nothing written")

		_, err = testStore.SetPostAuthorsTx(ctx, SetPostAuthorsTxParams{
			PostID: post.ID, AuthorIDs: []int64{ana.ID, bo.ID}, BaseAuthorIDs: []int64{bo.ID, ana.ID},
		})
		require.NoError(t, err, "the current byline as the base saves")
		require.Equal(t, []int64{ana.ID, bo.ID}, bylineIDs(t, post.ID))
		_, err = testStore.SetPostAuthorsTx(ctx, SetPostAuthorsTxParams{PostID: post.ID, AuthorIDs: []int64{bo.ID, ana.ID}})
		require.NoError(t, err)
	})
	t.Run("missing post", func(t *testing.T) {
		_, err := testStore.SetPostAuthorsTx(ctx, SetPostAuthorsTxParams{PostID: 1 << 60, AuthorIDs: []int64{ana.ID}})
		require.True(t, errors.Is(err, sql.ErrNoRows), "got %v", err)
	})
}

// On a published post a byline edit waits for Update (#358): the site, its
// author pages and "Written by" keep the published byline, and #326's flag
// reports the pending change.
func TestBylineEditWaitsForUpdate(t *testing.T) {
	ctx := context.Background()
	owner, ana := createTestUser(t), createTestUser(t)
	post := createBylinePost(t, owner)
	publishBylinePost(t, post.ID)
	require.Equal(t, []int64{owner.ID}, publishedBylineIDs(t, post.ID))
	require.False(t, settingsChanged(t, post.ID))

	_, err := testStore.SetPostAuthorsTx(ctx, SetPostAuthorsTxParams{PostID: post.ID, AuthorIDs: []int64{ana.ID, owner.ID}})
	require.NoError(t, err)

	require.Equal(t, []int64{owner.ID}, publishedBylineIDs(t, post.ID), "the site keeps the published byline")
	require.True(t, settingsChanged(t, post.ID), "the byline edit is a pending settings change")
	changes, err := testQueries.GetPostHasUnpublishedChanges(ctx, post.ID)
	require.NoError(t, err)
	require.True(t, changes)

	anaPage, err := testQueries.GetPublicAuthor(ctx, ana.Username)
	require.NoError(t, err)
	require.Zero(t, anaPage.PostCount, "credited only in the working byline: no author page")
	cards, err := testQueries.ListPostAuthorProfiles(ctx, post.ID)
	require.NoError(t, err)
	require.Len(t, cards, 1)
	require.Equal(t, owner.ID, cards[0].ID)

	publishBylinePost(t, post.ID)
	require.Equal(t, []int64{ana.ID, owner.ID}, publishedBylineIDs(t, post.ID))
	require.False(t, settingsChanged(t, post.ID))
	anaPage, err = testQueries.GetPublicAuthor(ctx, ana.Username)
	require.NoError(t, err)
	require.Equal(t, int64(1), anaPage.PostCount)
	cards, err = testQueries.ListPostAuthorProfiles(ctx, post.ID)
	require.NoError(t, err)
	require.Equal(t, []int64{ana.ID, owner.ID}, []int64{cards[0].ID, cards[1].ID}, "in byline order")

	// Dropping someone from the working byline keeps their page until Update.
	_, err = testStore.SetPostAuthorsTx(ctx, SetPostAuthorsTxParams{PostID: post.ID, AuthorIDs: []int64{owner.ID}})
	require.NoError(t, err)
	anaPage, err = testQueries.GetPublicAuthor(ctx, ana.Username)
	require.NoError(t, err)
	require.Equal(t, int64(1), anaPage.PostCount)
	posts, err := testQueries.ListPublishedPostsByAuthor(ctx, ListPublishedPostsByAuthorParams{UserID: ana.ID, LimitCount: 10})
	require.NoError(t, err)
	require.Len(t, posts, 1)
	require.Contains(t, string(posts[0].Authors), ana.Username, "the list shows the published byline")

	// Unpublishing takes the published byline down with the snapshot.
	_, err = testQueries.UnpublishPost(ctx, post.ID)
	require.NoError(t, err)
	require.Empty(t, publishedBylineIDs(t, post.ID))
}

// The public lists' authors column is the published byline; the admin's is the
// working one.
func TestListPostsWithMetaBylines(t *testing.T) {
	ctx := context.Background()
	owner, ana := createTestUser(t), createTestUser(t)
	postType := createAuthorPostType(t, true, true)
	post := createCreditedPost(t, postType, "draft", owner, owner)
	publishBylinePost(t, post.ID)
	_, err := testStore.SetPostAuthorsTx(ctx, SetPostAuthorsTxParams{PostID: post.ID, AuthorIDs: []int64{ana.ID}})
	require.NoError(t, err)

	authors := func(published bool) string {
		rows, err := testQueries.ListPostsWithMeta(ctx, ListPostsWithMetaParams{
			PostType: postType, PostStatus: "published", SortColumn: "created_at", SortDirection: "desc",
			LimitCount: 10, PublishedByline: published,
		})
		require.NoError(t, err)
		require.Len(t, rows, 1)
		return string(rows[0].Authors)
	}
	require.Contains(t, authors(false), ana.Username)
	require.NotContains(t, authors(false), owner.Username)
	require.Contains(t, authors(true), owner.Username)
	require.NotContains(t, authors(true), ana.Username)
}

// Restoring a version's settings brings its byline back into the working copy,
// skipping users removed since; a version with no byline keeps the current one.
func TestRestorePostSettingsTxRestoresByline(t *testing.T) {
	ctx := context.Background()
	owner, ana, gone := createTestUser(t), createTestUser(t), createTestUser(t)
	post := createBylinePost(t, owner, ana, gone, owner)
	publishBylinePost(t, post.ID)
	version, err := testQueries.GetPostVersion(ctx, GetPostVersionParams{PostID: post.ID, VersionNo: 1})
	require.NoError(t, err)
	var snapshot struct {
		Title     string  `json:"title"`
		AuthorIDs []int64 `json:"author_ids"`
	}
	require.NoError(t, json.Unmarshal(version.Settings.RawMessage, &snapshot))
	require.Equal(t, []int64{ana.ID, gone.ID, owner.ID}, snapshot.AuthorIDs, "the version records the byline")

	_, err = testStore.SetPostAuthorsTx(ctx, SetPostAuthorsTxParams{PostID: post.ID, AuthorIDs: []int64{owner.ID}})
	require.NoError(t, err)
	_, err = testQueries.db.ExecContext(ctx, `DELETE FROM users WHERE id = $1`, gone.ID)
	require.NoError(t, err)

	restore := func(ids []int64) {
		_, err := testStore.RestorePostSettingsTx(ctx, RestorePostSettingsTxParams{PostID: post.ID, Settings: RestoredPostSettings{
			Title: snapshot.Title, AuthorIDs: ids, ThumbnailURL: func(Medium) string { return "" },
		}})
		require.NoError(t, err)
	}
	restore(snapshot.AuthorIDs)
	require.Equal(t, []int64{ana.ID, owner.ID}, bylineIDs(t, post.ID), "the removed user is skipped")
	// Deleted outside RemoveUserTx, the snapshot still names them, but nothing
	// public does: post_published_authors cascades.
	cards, err := testQueries.ListPostAuthorProfiles(ctx, post.ID)
	require.NoError(t, err)
	require.Len(t, cards, 2)
	require.Equal(t, []int64{ana.ID, owner.ID}, []int64{cards[0].ID, cards[1].ID})

	_, err = testStore.SetPostAuthorsTx(ctx, SetPostAuthorsTxParams{PostID: post.ID, AuthorIDs: []int64{owner.ID}})
	require.NoError(t, err)
	restore(nil)
	require.Equal(t, []int64{owner.ID}, bylineIDs(t, post.ID), "no byline recorded: the working one stays")
	restore([]int64{gone.ID})
	require.Equal(t, []int64{owner.ID}, bylineIDs(t, post.ID), "nobody left to credit: the working one stays")
}

// Removing a member (#333): on the posts they owned the recipient takes their
// place, elsewhere their credit goes, and an empty byline credits the owner, in
// the working and published bylines alike, so no post gains a pending change.
func TestRemoveUserTxBylines(t *testing.T) {
	ctx := context.Background()
	member := createTestUserWithRole(t, "contributor")
	recipient := createTestUserWithRole(t, "editor")
	other, ana := createTestUser(t), createTestUser(t)

	owned := createBylinePost(t, member, ana, member)               // member's place → recipient
	ownedCredited := createBylinePost(t, member, member, recipient) // recipient already credited
	othersPost := createBylinePost(t, other, member, ana)           // credit dropped
	soleCredit := createBylinePost(t, other, member)                // empty → the owner
	draftOnly := createBylinePost(t, other, member)                 // unpublished: working only
	for _, p := range []Post{owned, ownedCredited, othersPost, soleCredit} {
		publishBylinePost(t, p.ID)
	}

	_, err := testStore.RemoveUserTx(ctx, RemoveUserTxParams{UserID: member.ID, ReassignTo: recipient.ID})
	require.NoError(t, err)

	for _, tc := range []struct {
		name string
		post Post
		want []int64
	}{
		{"owned", owned, []int64{ana.ID, recipient.ID}},
		{"owned, recipient credited", ownedCredited, []int64{recipient.ID}},
		{"someone else's", othersPost, []int64{ana.ID}},
		{"sole credit", soleCredit, []int64{other.ID}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, bylineIDs(t, tc.post.ID))
			require.Equal(t, tc.want, publishedBylineIDs(t, tc.post.ID))
			require.False(t, settingsChanged(t, tc.post.ID), "no pending change from the removal")
		})
	}
	require.Equal(t, []int64{other.ID}, bylineIDs(t, draftOnly.ID))
	require.Empty(t, publishedBylineIDs(t, draftOnly.ID))
}

func TestListAuthorCandidates(t *testing.T) {
	ctx := context.Background()
	marker := fmt.Sprintf("cand%d", time.Now().UnixNano())
	named := func(role string) User {
		u := createTestUserWithRole(t, role)
		updated, err := testQueries.db.ExecContext(ctx, `UPDATE users SET full_name = $2 WHERE id = $1`, u.ID, marker+" "+role)
		require.NoError(t, err)
		n, _ := updated.RowsAffected()
		require.Equal(t, int64(1), n)
		return u
	}
	editor := named("editor")
	contributor := named("contributor")
	reader := named("user")

	roles := []string{"admin", "editor", "contributor"}
	rows, err := testQueries.ListAuthorCandidates(ctx, ListAuthorCandidatesParams{Roles: roles, Pattern: "%" + marker + "%", LimitCount: 20})
	require.NoError(t, err)
	ids := map[int64]bool{}
	for _, r := range rows {
		ids[r.ID] = true
		require.True(t, strings.HasPrefix(r.FullName, marker))
	}
	require.True(t, ids[editor.ID])
	require.True(t, ids[contributor.ID])
	require.False(t, ids[reader.ID], "only content roles can be credited")

	rows, err = testQueries.ListAuthorCandidates(ctx, ListAuthorCandidatesParams{Roles: roles, Pattern: "", LimitCount: 1})
	require.NoError(t, err)
	require.Len(t, rows, 1)
}
