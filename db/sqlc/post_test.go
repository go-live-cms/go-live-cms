package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"

	"github.com/brianvoe/gofakeit/v6"
	"github.com/stretchr/testify/require"
)

func createPostWithTransaction(t *testing.T) CreatePostTxResult {
	gofakeit.Seed(0)
	user := createTestUser(t)

	title := gofakeit.Sentence(3)
	slug := strings.ToLower(strings.ReplaceAll(title, " ", "-"))

	arg := CreatePostTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       title,
			Content:     gofakeit.Paragraph(3, 5, 10, " "),
			Description: gofakeit.Sentence(10),
			UserID:      user.ID,
			Username:    user.Username,
			Url:         fmt.Sprintf("https://example.com/posts/%s", slug),
			PostType:    "post",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{},
			MenuOrder:   0,
		},
		AuthorIDs: []int64{user.ID},
	}

	result, err := testStore.CreatePostTx(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, result.Post)
	require.NotEmpty(t, result.UserPosts)

	require.Equal(t, arg.Title, result.Post.Title)
	require.Equal(t, arg.Content, result.Post.Content)
	require.Equal(t, arg.Description, result.Post.Description)
	require.Equal(t, arg.UserID, result.Post.UserID)
	require.Equal(t, arg.Username, result.Post.Username)
	require.Equal(t, arg.Url, result.Post.Url)

	require.NotZero(t, result.Post.ID)
	require.NotZero(t, result.Post.CreatedAt)

	require.Len(t, result.UserPosts, 1)
	require.Equal(t, result.Post.ID, result.UserPosts[0].PostID)
	require.Equal(t, user.ID, result.UserPosts[0].UserID)

	return result
}

func TestCreatePostTx(t *testing.T) {
	result := createPostWithTransaction(t)
	require.NotEmpty(t, result)
}

func TestCreatePostTxWithMultipleAuthors(t *testing.T) {
	gofakeit.Seed(0)
	user1 := createTestUser(t)

	gofakeit.Seed(1)
	user2 := createTestUser(t)

	title := gofakeit.Sentence(3)
	slug := strings.ToLower(strings.ReplaceAll(title, " ", "-"))

	arg := CreatePostTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       title,
			Content:     gofakeit.Paragraph(3, 5, 10, " "),
			Description: gofakeit.Sentence(10),
			UserID:      user1.ID,
			Username:    user1.Username,
			Url:         fmt.Sprintf("https://example.com/posts/%s", slug),
			PostType:    "post",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{},
			MenuOrder:   0,
		},
		AuthorIDs: []int64{user1.ID, user2.ID},
	}

	result, err := testStore.CreatePostTx(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, result.Post)
	require.Len(t, result.UserPosts, 2)

	authorIDs := make([]int64, len(result.UserPosts))
	for i, up := range result.UserPosts {
		authorIDs[i] = up.UserID
	}
	require.ElementsMatch(t, []int64{user1.ID, user2.ID}, authorIDs)
}

func TestDeletePostTx(t *testing.T) {
	result := createPostWithTransaction(t)

	err := testStore.DeletePostTx(context.Background(), result.Post.ID)
	require.NoError(t, err)

	post, err := testQueries.GetPost(context.Background(), result.Post.ID)
	require.Error(t, err)
	require.EqualError(t, err, "sql: no rows in result set")
	require.Empty(t, post)
}

func TestListPosts(t *testing.T) {
	gofakeit.Seed(0)

	for range 10 {
		createPostWithTransaction(t)
	}

	posts, err := testQueries.ListPosts(context.Background(), ListPostsParams{
		Column1:     "",
		Column2:     "",
		SortBy:      "",
		OffsetCount: 5,
		LimitCount:  5,
	})
	require.NoError(t, err)
	require.Len(t, posts, 5)
}

func TestUpdatePost(t *testing.T) {
	gofakeit.Seed(0)
	result := createPostWithTransaction(t)

	newTitle := gofakeit.Sentence(3)
	newContent := gofakeit.Paragraph(3, 5, 10, " ")

	arg := UpdatePostParams{
		Title:       newTitle,
		Description: result.Post.Description,
		UserID:      result.Post.UserID,
		Username:    result.Post.Username,
		Content:     newContent,
		Url:         result.Post.Url,
		PostType:    result.Post.PostType,
		PostStatus:  result.Post.PostStatus,
		PostParent:  result.Post.PostParent,
		MenuOrder:   result.Post.MenuOrder,
		ID:          result.Post.ID,
	}

	updatedPost, err := testQueries.UpdatePost(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, updatedPost)
	require.Equal(t, newTitle, updatedPost.Title)
	require.Equal(t, newContent, updatedPost.Content)
	require.Equal(t, result.Post.ID, updatedPost.ID)

	result2 := createPostWithTransaction(t)
	arg2 := UpdatePostParams{
		Title:       result2.Post.Title,
		Description: "",
		UserID:      result2.Post.UserID,
		Username:    result2.Post.Username,
		Content:     result2.Post.Content,
		Url:         result2.Post.Url,
		PostType:    result2.Post.PostType,
		PostStatus:  result2.Post.PostStatus,
		PostParent:  result2.Post.PostParent,
		MenuOrder:   result2.Post.MenuOrder,
		ID:          result2.Post.ID,
	}
	updatedPost2, err := testQueries.UpdatePost(context.Background(), arg2)
	require.NoError(t, err)
	require.NotEmpty(t, updatedPost2)
	require.Equal(t, result2.Post.Title, updatedPost2.Title)
	require.Equal(t, "", updatedPost2.Description)
}

func TestCreatePostWithMedia(t *testing.T) {
	user := createTestUser(t)

	_, media1 := createTestMedia(t)
	_, media2 := createTestMedia(t)

	title := gofakeit.Sentence(3)
	slug := strings.ToLower(strings.ReplaceAll(title, " ", "-"))

	arg := CreatePostWithMediaTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       title,
			Content:     gofakeit.Paragraph(3, 5, 10, " "),
			Description: gofakeit.Sentence(10),
			UserID:      user.ID,
			Username:    user.Username,
			Url:         fmt.Sprintf("https://example.com/posts/%s", slug),
			PostType:    "post",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{},
			MenuOrder:   0,
		},
		AuthorIDs: []int64{user.ID},
		MediaIDs:  []int64{media1.ID, media2.ID},
	}

	result, err := testStore.CreatePostWithMediaTx(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, result.Post)
	require.Len(t, result.UserPosts, 1)
	require.Len(t, result.PostMedia, 2)

	postMedia, err := testQueries.GetMediaByPost(context.Background(), result.Post.ID)
	require.NoError(t, err)
	require.Len(t, postMedia, 2)

	mediaIDs := make([]int64, len(postMedia))
	for i, media := range postMedia {
		mediaIDs[i] = media.ID
	}
	require.ElementsMatch(t, []int64{media1.ID, media2.ID}, mediaIDs)
}
