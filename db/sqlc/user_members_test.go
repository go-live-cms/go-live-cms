package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/brianvoe/gofakeit/v6"
	"github.com/stretchr/testify/require"
)

// The Users screen's transactions (#333): RemoveUserTx, ChangeUserRoleTx,
// ListMembers and the last-active throttle.

func createTestUserWithRole(t *testing.T, role string) User {
	t.Helper()
	user := createTestUser(t)
	if role == user.Role {
		return user
	}
	updated, err := testQueries.SetUserRole(context.Background(), SetUserRoleParams{ID: user.ID, Role: role})
	require.NoError(t, err)
	return updated
}

func createTestMediaFor(t *testing.T, user User) Medium {
	t.Helper()
	media, err := testQueries.CreateMedia(context.Background(), CreateMediaParams{
		Name:             gofakeit.Word(),
		MediaPath:        fmt.Sprintf("/uploads/media/%s.jpg", gofakeit.UUID()),
		UserID:           user.ID,
		FileSize:         1000,
		MimeType:         "image/jpeg",
		Width:            10,
		Height:           10,
		OriginalFilename: "x.jpg",
	})
	require.NoError(t, err)
	return media
}

func postBylineIDs(t *testing.T, postID int64) []int64 {
	t.Helper()
	rows, err := testStore.(*SQLStore).db.QueryContext(context.Background(),
		`SELECT user_id FROM user_posts WHERE post_id = $1 ORDER BY "order", user_id`, postID)
	require.NoError(t, err)
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		require.NoError(t, rows.Scan(&id))
		ids = append(ids, id)
	}
	require.NoError(t, rows.Err())
	return ids
}

// onlyAdmins demotes every other admin in the shared test DB to editor until the
// test ends (restored as "admin"), so ErrLastAdmin can be reached with committed
// transactions: the guard counts every admin. No other real-DB test needs one.
func onlyAdmins(t *testing.T, keep ...int64) {
	t.Helper()
	ctx := context.Background()
	rows, err := testStore.(*SQLStore).db.QueryContext(ctx,
		`UPDATE users SET role = 'editor' WHERE lower(role) = 'admin' AND NOT (id = ANY($1)) RETURNING id`,
		int64Array(keep))
	require.NoError(t, err)
	var demoted []int64
	for rows.Next() {
		var id int64
		require.NoError(t, rows.Scan(&id))
		demoted = append(demoted, id)
	}
	require.NoError(t, rows.Close())
	t.Cleanup(func() {
		_, err := testStore.(*SQLStore).db.ExecContext(context.Background(),
			`UPDATE users SET role = 'admin' WHERE id = ANY($1)`, int64Array(demoted))
		require.NoError(t, err)
	})
}

// int64Array formats ids as a Postgres bigint[] literal for the raw queries above.
func int64Array(ids []int64) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = fmt.Sprint(id)
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func TestRemoveUserTx(t *testing.T) {
	ctx := context.Background()
	member, owned := createTestUserWithPosts(t)
	recipient := createTestUser(t)
	other, othersPost := createTestUserWithPosts(t)

	// The member is credited on someone else's post too, uploaded an image, has
	// a session and published a revision of their post.
	_, err := testQueries.CreateUserPost(ctx, CreateUserPostParams{PostID: othersPost.Post.ID, UserID: member.ID, Order: 1})
	require.NoError(t, err)
	media := createTestMediaFor(t, member)
	session := createRandomSession(t, member)
	version, err := testQueries.InsertPostVersion(ctx, InsertPostVersionParams{
		PostID:    owned.Post.ID,
		VersionNo: 1,
		BlockDoc:  json.RawMessage(`{}`),
		CreatedBy: sql.NullInt64{Int64: member.ID, Valid: true},
	})
	require.NoError(t, err)

	result, err := testStore.RemoveUserTx(ctx, RemoveUserTxParams{UserID: member.ID, ReassignTo: recipient.ID})
	require.NoError(t, err)
	require.Equal(t, 1, result.PostsReassigned)

	_, err = testQueries.GetUser(ctx, member.ID)
	require.ErrorIs(t, err, sql.ErrNoRows)

	post, err := testQueries.GetPost(ctx, owned.Post.ID)
	require.NoError(t, err)
	require.Equal(t, recipient.ID, post.UserID)
	require.Equal(t, recipient.Username, post.Username)
	// Their byline on the moved post follows it; on the other post it's gone.
	require.Equal(t, []int64{recipient.ID}, postBylineIDs(t, owned.Post.ID))
	require.Equal(t, []int64{other.ID}, postBylineIDs(t, othersPost.Post.ID))

	movedMedia, err := testQueries.GetMedia(ctx, media.ID)
	require.NoError(t, err)
	require.Equal(t, recipient.ID, movedMedia.UserID)

	// Sessions deleted: every refresh token is dead.
	_, err = testQueries.GetSession(ctx, session.ID)
	require.ErrorIs(t, err, sql.ErrNoRows)

	// The revision stays, with no author (000030).
	var createdBy sql.NullInt64
	require.NoError(t, testStore.(*SQLStore).db.QueryRowContext(ctx,
		`SELECT created_by FROM post_versions WHERE id = $1`, version.ID).Scan(&createdBy))
	require.False(t, createdBy.Valid)
}

func TestRemoveUserTxRecipientAlreadyCredited(t *testing.T) {
	ctx := context.Background()
	member, owned := createTestUserWithPosts(t)
	recipient := createTestUser(t)
	_, err := testQueries.CreateUserPost(ctx, CreateUserPostParams{PostID: owned.Post.ID, UserID: recipient.ID, Order: 1})
	require.NoError(t, err)

	// One credit per (post, user): the member's is dropped, not duplicated.
	_, err = testStore.RemoveUserTx(ctx, RemoveUserTxParams{UserID: member.ID, ReassignTo: recipient.ID})
	require.NoError(t, err)
	require.Equal(t, []int64{recipient.ID}, postBylineIDs(t, owned.Post.ID))
}

func TestRemoveUserTxRefusals(t *testing.T) {
	ctx := context.Background()
	member, owned := createTestUserWithPosts(t)
	recipient := createTestUser(t)

	_, err := testStore.RemoveUserTx(ctx, RemoveUserTxParams{UserID: member.ID, ReassignTo: member.ID})
	require.ErrorIs(t, err, ErrReassignToRemovedUser)

	_, err = testStore.RemoveUserTx(ctx, RemoveUserTxParams{UserID: member.ID, ReassignTo: -1})
	require.ErrorIs(t, err, ErrReassignTargetNotFound)

	_, err = testStore.RemoveUserTx(ctx, RemoveUserTxParams{UserID: -1, ReassignTo: recipient.ID})
	require.ErrorIs(t, err, sql.ErrNoRows)

	// Nothing moved by the refused attempts.
	post, err := testQueries.GetPost(ctx, owned.Post.ID)
	require.NoError(t, err)
	require.Equal(t, member.ID, post.UserID)
}

func TestRemoveUserTxLastAdmin(t *testing.T) {
	ctx := context.Background()
	admin := createTestUserWithRole(t, "admin")
	recipient := createTestUser(t)
	onlyAdmins(t, admin.ID)

	_, err := testStore.RemoveUserTx(ctx, RemoveUserTxParams{UserID: admin.ID, ReassignTo: recipient.ID})
	require.ErrorIs(t, err, ErrLastAdmin)
	_, err = testQueries.GetUser(ctx, admin.ID)
	require.NoError(t, err)

	// With a second admin it goes through.
	createTestUserWithRole(t, "admin")
	_, err = testStore.RemoveUserTx(ctx, RemoveUserTxParams{UserID: admin.ID, ReassignTo: recipient.ID})
	require.NoError(t, err)
}

func TestChangeUserRoleTx(t *testing.T) {
	ctx := context.Background()
	user := createTestUser(t)

	promoted, err := testStore.ChangeUserRoleTx(ctx, SetUserRoleParams{ID: user.ID, Role: "editor"})
	require.NoError(t, err)
	require.Equal(t, "editor", promoted.Role)

	_, err = testStore.ChangeUserRoleTx(ctx, SetUserRoleParams{ID: -1, Role: "editor"})
	require.ErrorIs(t, err, sql.ErrNoRows)

	admin := createTestUserWithRole(t, "admin")
	onlyAdmins(t, admin.ID)
	_, err = testStore.ChangeUserRoleTx(ctx, SetUserRoleParams{ID: admin.ID, Role: "editor"})
	require.ErrorIs(t, err, ErrLastAdmin)
	// Keeping the last admin an admin is fine.
	_, err = testStore.ChangeUserRoleTx(ctx, SetUserRoleParams{ID: admin.ID, Role: "admin"})
	require.NoError(t, err)
}

// Two admins demote each other (or themselves) at the same time: the guard's
// row locks make one wait for the other's commit and re-read, so exactly one
// demotion goes through and an admin is left.
func TestChangeUserRoleTxConcurrentDemotions(t *testing.T) {
	ctx := context.Background()
	first := createTestUserWithRole(t, "admin")
	second := createTestUserWithRole(t, "admin")
	onlyAdmins(t, first.ID, second.ID)

	for round := 0; round < 5; round++ {
		var wg sync.WaitGroup
		errs := make([]error, 2)
		start := make(chan struct{})
		for i, id := range []int64{first.ID, second.ID} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				_, errs[i] = testStore.ChangeUserRoleTx(ctx, SetUserRoleParams{ID: id, Role: "editor"})
			}()
		}
		close(start)
		wg.Wait()

		failed := 0
		for _, err := range errs {
			if err != nil {
				require.ErrorIs(t, err, ErrLastAdmin)
				failed++
			}
		}
		require.Equal(t, 1, failed, "round %d: exactly one demotion must be refused", round)

		var admins int
		require.NoError(t, testStore.(*SQLStore).db.QueryRowContext(ctx,
			`SELECT count(*) FROM users WHERE lower(role) = 'admin'`).Scan(&admins))
		require.Equal(t, 1, admins)

		// Both admins again for the next round.
		for _, id := range []int64{first.ID, second.ID} {
			_, err := testQueries.SetUserRole(ctx, SetUserRoleParams{ID: id, Role: "admin"})
			require.NoError(t, err)
		}
	}
}

func TestListMembers(t *testing.T) {
	ctx := context.Background()
	marker := fmt.Sprintf("srch%d", time.Now().UnixNano())

	owner, _ := createTestUserWithPosts(t)
	_, err := testQueries.UpdateUser(ctx, UpdateUserParams{
		ID: owner.ID, Username: owner.Username, FullName: "Ana " + marker, Email: owner.Email,
		HashedPassword: owner.HashedPassword, PasswordChangedAt: owner.PasswordChangedAt, Role: owner.Role,
	})
	require.NoError(t, err)
	// A second post: posts owned counts every post of theirs.
	_, err = testQueries.CreatePosts(ctx, CreatePostsParams{
		Title: "second", Slug: marker + "-2", BlockDoc: json.RawMessage(`{}`), UserID: owner.ID,
		Username: owner.Username, Url: "https://example.com/" + marker, PostType: "post", PostStatus: "draft",
	})
	require.NoError(t, err)

	editor := createTestUserWithRole(t, "editor")
	_, err = testQueries.UpdateUser(ctx, UpdateUserParams{
		ID: editor.ID, Username: editor.Username, FullName: editor.FullName, Email: marker + "_x@example.com",
		HashedPassword: editor.HashedPassword, PasswordChangedAt: editor.PasswordChangedAt, Role: "editor",
	})
	require.NoError(t, err)

	list := func(pattern, role string) []ListMembersRow {
		rows, err := testQueries.ListMembers(ctx, ListMembersParams{
			Pattern: pattern, Role: role, SortBy: "id_asc", LimitCount: 50, OffsetCount: 0,
		})
		require.NoError(t, err)
		count, err := testQueries.CountMembers(ctx, CountMembersParams{Pattern: pattern, Role: role})
		require.NoError(t, err)
		require.EqualValues(t, len(rows), count)
		return rows
	}

	// By name (case-insensitive) and by email.
	rows := list("%"+strings.ToUpper(marker)+"%", "")
	require.Len(t, rows, 2)
	require.Equal(t, owner.ID, rows[0].User.ID)
	require.EqualValues(t, 2, rows[0].PostsOwned)
	require.Equal(t, editor.ID, rows[1].User.ID)
	require.EqualValues(t, 0, rows[1].PostsOwned)

	// The role filter narrows it.
	rows = list("%"+marker+"%", "EDITOR")
	require.Len(t, rows, 1)
	require.Equal(t, editor.ID, rows[0].User.ID)

	// By username.
	rows = list("%"+owner.Username+"%", "")
	require.Len(t, rows, 1)
	require.Equal(t, owner.ID, rows[0].User.ID)
}

func TestTouchUserLastActive(t *testing.T) {
	ctx := context.Background()
	user := createTestUser(t)
	require.False(t, user.LastActiveAt.Valid)

	touch := func() int64 {
		n, err := testQueries.TouchUserLastActive(ctx, TouchUserLastActiveParams{ID: user.ID, MinAgeSeconds: 300})
		require.NoError(t, err)
		return n
	}

	// Never active: stamped.
	require.EqualValues(t, 1, touch())
	first, err := testQueries.GetUser(ctx, user.ID)
	require.NoError(t, err)
	require.True(t, first.LastActiveAt.Valid)

	// Within the interval: no write.
	require.EqualValues(t, 0, touch())
	again, err := testQueries.GetUser(ctx, user.ID)
	require.NoError(t, err)
	require.True(t, first.LastActiveAt.Time.Equal(again.LastActiveAt.Time))

	// Older than the interval: stamped again.
	_, err = testStore.(*SQLStore).db.ExecContext(ctx,
		`UPDATE users SET last_active_at = now() - interval '10 minutes' WHERE id = $1`, user.ID)
	require.NoError(t, err)
	require.EqualValues(t, 1, touch())
	later, err := testQueries.GetUser(ctx, user.ID)
	require.NoError(t, err)
	require.True(t, later.LastActiveAt.Time.After(first.LastActiveAt.Time.Add(-time.Minute)))
}

// A request never waits for a transaction holding the user's row (a role change
// locks every admin): the stamp is skipped and a later request writes it.
func TestTouchUserLastActiveSkipsLockedRow(t *testing.T) {
	ctx := context.Background()
	user := createTestUser(t)

	tx, err := testStore.(*SQLStore).db.BeginTx(ctx, nil)
	require.NoError(t, err)
	_, err = tx.ExecContext(ctx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, user.ID)
	require.NoError(t, err)

	timeout, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	n, err := testQueries.TouchUserLastActive(timeout, TouchUserLastActiveParams{ID: user.ID, MinAgeSeconds: 300})
	require.NoError(t, err, "must not wait for the lock")
	require.EqualValues(t, 0, n)
	require.NoError(t, tx.Rollback())

	n, err = testQueries.TouchUserLastActive(ctx, TouchUserLastActiveParams{ID: user.ID, MinAgeSeconds: 300})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
}
