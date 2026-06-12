package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/brianvoe/gofakeit/v6"
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
