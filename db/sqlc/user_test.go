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

	"github.com/brianvoe/gofakeit/v6"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

var userCounter int64 = 0

func createTestUser(t *testing.T) User {
	userCounter++
	gofakeit.Seed(userCounter)

	timestamp := time.Now().UnixNano() + userCounter

	username := fmt.Sprintf("%s_%d", gofakeit.Username(), timestamp)
	email := fmt.Sprintf("%d_%s", timestamp, gofakeit.Email())
	fullName := gofakeit.Name()
	hashedPassword := gofakeit.Password(true, true, true, true, false, 32)
	role := "contributor"

	if username == "" || strings.TrimSpace(username) == "" {
		username = fmt.Sprintf("testuser_%d", timestamp)
	}
	if email == "" || strings.TrimSpace(email) == "" {
		email = fmt.Sprintf("test_%d@example.com", timestamp)
	}
	if fullName == "" || strings.TrimSpace(fullName) == "" {
		fullName = fmt.Sprintf("Test User %d", userCounter)
	}
	if hashedPassword == "" || strings.TrimSpace(hashedPassword) == "" {
		hashedPassword = fmt.Sprintf("hashedpassword_%d", timestamp)
	}

	arg := CreateUserParams{
		Username:       username,
		Email:          email,
		FullName:       fullName,
		HashedPassword: hashedPassword,
		Role:           role,
	}

	user, err := testQueries.CreateUser(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, user)
	require.Equal(t, arg.Username, user.Username)
	require.Equal(t, arg.Email, user.Email)
	require.Equal(t, arg.FullName, user.FullName)
	require.Equal(t, arg.HashedPassword, user.HashedPassword)
	require.Equal(t, arg.Role, user.Role)

	return user
}

func createTestUserWithPosts(t *testing.T) (User, CreatePostTxResult) {
	user := createTestUser(t)

	title := gofakeit.Sentence(3)
	timestamp := time.Now().UnixNano()
	slug := fmt.Sprintf("%s-%d", strings.ToLower(strings.ReplaceAll(title, " ", "-")), timestamp)

	postArg := CreatePostTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       title,
			Slug:        slug,
			BlockDoc:    json.RawMessage(`{}`),
			Description: gofakeit.Sentence(10),
			UserID:      user.ID,
			Username:    user.Username,
			Url:         fmt.Sprintf("https://example.com/posts/%s-%d", slug, timestamp),
			PostType:    "post",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{},
			MenuOrder:   0,
		},
		AuthorIDs: []int64{user.ID},
	}

	post, err := testStore.CreatePostTx(context.Background(), postArg)
	require.NoError(t, err)

	return user, post
}

func TestCreateUser(t *testing.T) {
	user := createTestUser(t)
	require.NotEmpty(t, user)
}

func TestGuardLastAdmin(t *testing.T) {
	ctx := context.Background()
	errRollback := errors.New("rollback")
	contributor := createTestUser(t)

	// Everything runs in one transaction that is always rolled back, so
	// demoting the shared DB's existing admins never leaks to other tests.
	// Assertions happen outside the closure: a require failure inside it
	// would Goexit with the transaction (and its row locks) still open.
	var soleAdminErr, nonAdminErr, twoAdminsErr error
	err := testStore.ExecTx(ctx, func(q *Queries) error {
		if _, err := q.db.ExecContext(ctx, `UPDATE users SET role = 'editor' WHERE lower(role) = 'admin'`); err != nil {
			return err
		}

		// Mixed-case stored role: the column side of the match must be
		// case-insensitive too, or this admin would go uncounted.
		suffix := time.Now().UnixNano()
		admin, err := q.CreateUser(ctx, CreateUserParams{
			Username:       fmt.Sprintf("sole_admin_%d", suffix),
			Email:          fmt.Sprintf("sole_admin_%d@example.com", suffix),
			FullName:       "Sole Admin",
			HashedPassword: "hashed",
			Role:           "Admin",
		})
		if err != nil {
			return err
		}

		soleAdminErr = guardLastAdmin(ctx, q, admin.ID)
		nonAdminErr = guardLastAdmin(ctx, q, contributor.ID)

		if _, err := q.CreateUser(ctx, CreateUserParams{
			Username:       fmt.Sprintf("second_admin_%d", suffix),
			Email:          fmt.Sprintf("second_admin_%d@example.com", suffix),
			FullName:       "Second Admin",
			HashedPassword: "hashed",
			Role:           "admin",
		}); err != nil {
			return err
		}
		twoAdminsErr = guardLastAdmin(ctx, q, admin.ID)

		return errRollback
	})
	require.ErrorIs(t, err, errRollback)

	require.ErrorIs(t, soleAdminErr, ErrLastAdmin)
	require.NoError(t, nonAdminErr)
	require.NoError(t, twoAdminsErr)
}

func TestGetUser(t *testing.T) {
	user1 := createTestUser(t)
	user2, err := testQueries.GetUser(context.Background(), user1.ID)
	require.NoError(t, err)
	require.NotEmpty(t, user2)
	require.Equal(t, user1.ID, user2.ID)
	require.Equal(t, user1.Username, user2.Username)
	require.Equal(t, user1.Email, user2.Email)
	require.Equal(t, user1.FullName, user2.FullName)
	require.Equal(t, user1.HashedPassword, user2.HashedPassword)
	require.Equal(t, user1.Role, user2.Role)
}

func TestGetUserByEmail(t *testing.T) {
	user1 := createTestUser(t)
	user2, err := testQueries.GetUserByEmail(context.Background(), user1.Email)
	require.NoError(t, err)
	require.NotEmpty(t, user2)
	require.Equal(t, user1.ID, user2.ID)
	require.Equal(t, user1.Username, user2.Username)
	require.Equal(t, user1.Email, user2.Email)
	require.Equal(t, user1.FullName, user2.FullName)
	require.Equal(t, user1.HashedPassword, user2.HashedPassword)
	require.Equal(t, user1.Role, user2.Role)
}

func TestGetUserByUsername(t *testing.T) {
	user1 := createTestUser(t)
	user2, err := testQueries.GetUserByUsername(context.Background(), user1.Username)
	require.NoError(t, err)
	require.NotEmpty(t, user2)
	require.Equal(t, user1.ID, user2.ID)
	require.Equal(t, user1.Username, user2.Username)
	require.Equal(t, user1.Email, user2.Email)
	require.Equal(t, user1.FullName, user2.FullName)
	require.Equal(t, user1.HashedPassword, user2.HashedPassword)
	require.Equal(t, user1.Role, user2.Role)
}

func TestListUsers(t *testing.T) {
	for range 10 {
		createTestUser(t)
	}

	arg := ListUsersParams{
		SortBy:      "",
		OffsetCount: 5,
		LimitCount:  5,
	}
	users, err := testQueries.ListUsers(context.Background(), arg)
	require.NoError(t, err)
	require.Len(t, users, 5)

	for i, user := range users {
		t.Logf("User %d: ID=%d, Username='%s', Email='%s', FullName='%s', Role='%s'",
			i, user.ID, user.Username, user.Email, user.FullName, user.Role)

		require.NotEmpty(t, user, "User struct should not be empty")
		require.NotZero(t, user.ID, "User ID should not be zero")
		require.NotZero(t, user.CreatedAt, "User CreatedAt should not be zero")
		require.NotEmpty(t, user.Username, "Username should not be empty")
		require.NotEmpty(t, user.Email, "Email should not be empty")
		require.NotEmpty(t, user.FullName, "FullName should not be empty")
		require.NotEmpty(t, user.HashedPassword, "HashedPassword should not be empty")
		require.NotEmpty(t, user.Role, "Role should not be empty")
	}
}

func TestUpdateUser(t *testing.T) {
	user1 := createTestUser(t)
	require.NotEmpty(t, user1)

	newUsername := fmt.Sprintf("%s_%d", gofakeit.Username(), time.Now().UnixNano())
	newEmail := fmt.Sprintf("%d_%s", time.Now().UnixNano(), gofakeit.Email())

	arg := UpdateUserParams{
		ID:             user1.ID,
		Username:       newUsername,
		FullName:       gofakeit.Name(),
		Email:          newEmail,
		HashedPassword: gofakeit.Password(true, true, true, true, false, 32),
		Role:           "admin",
	}
	user2, err := testQueries.UpdateUser(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, user2)
	require.Equal(t, arg.ID, user2.ID)
	require.Equal(t, arg.Username, user2.Username)
	require.Equal(t, arg.FullName, user2.FullName)
	require.Equal(t, arg.Email, user2.Email)
	require.Equal(t, arg.HashedPassword, user2.HashedPassword)
	require.Equal(t, arg.Role, user2.Role)
}

func TestDeleteUserWithTransferTx(t *testing.T) {
	user, post := createTestUserWithPosts(t)

	adminUser := createTestUser(t)

	err := testStore.DeleteUserWithTransferTx(context.Background(), DeleteUserWithTransferTxParams{
		UserID:       user.ID,
		TransferToID: adminUser.ID,
	})
	require.NoError(t, err)

	deletedUser, err := testQueries.GetUser(context.Background(), user.ID)
	require.Error(t, err)
	require.EqualError(t, err, "sql: no rows in result set")
	require.Empty(t, deletedUser)

	existingPost, err := testQueries.GetPost(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.NotEmpty(t, existingPost)
	require.Equal(t, adminUser.ID, existingPost.UserID)
	require.Equal(t, adminUser.Username, existingPost.Username)
}

func TestDeleteUserTx_NuclearOption(t *testing.T) {
	user, post := createTestUserWithPosts(t)

	err := testStore.DeleteUserTx(context.Background(), user.ID)
	require.NoError(t, err)

	deletedUser, err := testQueries.GetUser(context.Background(), user.ID)
	require.Error(t, err)
	require.Empty(t, deletedUser)

	deletedPost, err := testQueries.GetPost(context.Background(), post.Post.ID)
	require.Error(t, err)
	require.Empty(t, deletedPost)
}

func TestDeleteUser_WithoutTransaction_ShouldFail(t *testing.T) {
	user, _ := createTestUserWithPosts(t)

	gofakeit.Seed(0)
	mediaArg := CreateMediaParams{
		Name:             gofakeit.Word(),
		Description:      gofakeit.Sentence(10),
		Alt:              gofakeit.Sentence(5),
		MediaPath:        fmt.Sprintf("/uploads/media/%s.jpg", gofakeit.UUID()),
		UserID:           user.ID,
		FileSize:         int64(gofakeit.Number(1000, 100000)),
		MimeType:         "image/jpeg",
		Width:            int32(gofakeit.Number(100, 1920)),
		Height:           int32(gofakeit.Number(100, 1080)),
		Duration:         0,
		OriginalFilename: fmt.Sprintf("%s.jpg", gofakeit.UUID()),
	}

	_, err := testQueries.CreateMedia(context.Background(), mediaArg)
	require.NoError(t, err)

	err = testQueries.DeleteUser(context.Background(), user.ID)
	require.Error(t, err)
	require.Contains(t, err.Error(), "foreign key constraint")
}

func TestUpdateUserTx(t *testing.T) {
	user := createTestUser(t)

	newUsername := fmt.Sprintf("updated_%s_%d", gofakeit.Username(), time.Now().UnixNano())
	newEmail := fmt.Sprintf("updated_%d_%s", time.Now().UnixNano(), gofakeit.Email())

	arg := UpdateUserTxParams{
		UpdateUserParams: UpdateUserParams{
			ID:             user.ID,
			Username:       newUsername,
			FullName:       gofakeit.Name(),
			Email:          newEmail,
			HashedPassword: gofakeit.Password(true, true, true, true, false, 32),
			Role:           "admin",
		},
		CheckUniqueness: true,
	}

	result, err := testStore.UpdateUserTx(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, result.User)
	require.Equal(t, arg.Username, result.User.Username)
	require.Equal(t, arg.Email, result.User.Email)
	require.Equal(t, arg.Role, result.User.Role)
}

func TestUpdateUserTx_PasswordChanged(t *testing.T) {
	user := createTestUser(t)
	other := createTestUser(t)

	newSession := func(owner User) Session {
		session, err := testQueries.CreateSession(context.Background(), CreateSessionParams{
			ID:               uuid.New(),
			UserID:           owner.ID,
			Username:         owner.Username,
			RefreshTokenHash: []byte(uuid.NewString()),
			UserAgent:        "test",
			ClientIp:         "127.0.0.1",
			ExpiresAt:        time.Now().Add(time.Hour),
		})
		require.NoError(t, err)
		return session
	}
	userSessions := []Session{newSession(user), newSession(user)}
	otherSession := newSession(other)

	updateArg := UpdateUserParams{
		ID:                user.ID,
		Username:          user.Username,
		FullName:          user.FullName,
		Email:             user.Email,
		HashedPassword:    "new-hash",
		Role:              user.Role,
		PasswordChangedAt: user.PasswordChangedAt,
	}

	// Without the flag, sessions are left alone.
	_, err := testStore.UpdateUserTx(context.Background(), UpdateUserTxParams{UpdateUserParams: updateArg})
	require.NoError(t, err)
	for _, s := range userSessions {
		got, err := testQueries.GetSession(context.Background(), s.ID)
		require.NoError(t, err)
		require.False(t, got.IsBlocked)
	}

	// The caller's PasswordChangedAt is ignored: the tx stamps it itself.
	updateArg.PasswordChangedAt = time.Now().Add(-time.Hour)
	before := time.Now()
	result, err := testStore.UpdateUserTx(context.Background(), UpdateUserTxParams{
		UpdateUserParams: updateArg,
		PasswordChanged:  true,
	})
	require.NoError(t, err)
	require.False(t, result.User.PasswordChangedAt.Before(before.Truncate(time.Microsecond)),
		"password_changed_at must be stamped inside the tx, not taken from the caller")

	for _, s := range userSessions {
		got, err := testQueries.GetSession(context.Background(), s.ID)
		require.NoError(t, err)
		require.True(t, got.IsBlocked, "user's session %s should be blocked", s.ID)

		// A blocked session's refresh token no longer resolves.
		_, err = testQueries.GetSessionByRefreshTokenHash(context.Background(), s.RefreshTokenHash)
		require.ErrorIs(t, err, sql.ErrNoRows)
	}

	got, err := testQueries.GetSession(context.Background(), otherSession.ID)
	require.NoError(t, err)
	require.False(t, got.IsBlocked, "another user's session must be untouched")
}

func TestUpdateUserTx_UniqueConstraintViolation(t *testing.T) {
	user1 := createTestUser(t)
	user2 := createTestUser(t)

	arg := UpdateUserTxParams{
		UpdateUserParams: UpdateUserParams{
			ID:       user2.ID,
			Username: user1.Username,
			Email:    user2.Email,
		},
		CheckUniqueness: true,
	}

	_, err := testStore.UpdateUserTx(context.Background(), arg)
	require.Error(t, err)
	require.Contains(t, err.Error(), "already exists")
}

// TestUpdateUserTx_PasswordChangedBlocksConcurrentRotation reproduces the
// refresh-vs-password-change race: a rotation-like transaction holding the
// user row FOR SHARE inserts a new session and commits only after the
// password change has started. The change must wait for it and then block
// that session too, and its password_changed_at must postdate the rotation.
func TestUpdateUserTx_PasswordChangedBlocksConcurrentRotation(t *testing.T) {
	user := createTestUser(t)
	ctx := context.Background()

	locked := make(chan struct{})
	release := make(chan struct{})
	rotationDone := make(chan error, 1)
	var rotated Session

	go func() {
		rotationDone <- testStore.ExecTx(ctx, func(q *Queries) error {
			if err := q.LockUserForShare(ctx, user.ID); err != nil {
				return err
			}
			var err error
			rotated, err = q.CreateSession(ctx, CreateSessionParams{
				ID:               uuid.New(),
				UserID:           user.ID,
				Username:         user.Username,
				RefreshTokenHash: []byte(uuid.NewString()),
				UserAgent:        "test",
				ClientIp:         "127.0.0.1",
				ExpiresAt:        time.Now().Add(time.Hour),
			})
			if err != nil {
				return err
			}
			close(locked)
			<-release
			return nil
		})
	}()

	<-locked

	changeDone := make(chan UpdateUserTxResult, 1)
	changeErr := make(chan error, 1)
	go func() {
		result, err := testStore.UpdateUserTx(ctx, UpdateUserTxParams{
			UpdateUserParams: UpdateUserParams{
				ID:                user.ID,
				Username:          user.Username,
				FullName:          user.FullName,
				Email:             user.Email,
				HashedPassword:    "new-hash",
				Role:              user.Role,
				PasswordChangedAt: user.PasswordChangedAt,
			},
			PasswordChanged: true,
		})
		changeErr <- err
		changeDone <- result
	}()

	// The password change must be stuck on the user-row lock.
	select {
	case err := <-changeErr:
		t.Fatalf("password change finished while the rotation held the user row (err=%v)", err)
	case <-time.After(300 * time.Millisecond):
	}

	releasedAt := time.Now()
	close(release)
	require.NoError(t, <-rotationDone)
	require.NoError(t, <-changeErr)
	result := <-changeDone

	got, err := testQueries.GetSession(ctx, rotated.ID)
	require.NoError(t, err)
	require.True(t, got.IsBlocked, "a session committed by a concurrent rotation must be blocked by the password change")
	require.True(t, result.User.PasswordChangedAt.After(releasedAt),
		"password_changed_at must be stamped after the rotation released the row")
}