package db

import (
	"context"
	"database/sql"
	"encoding/json"
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
			Slug:        slug,
			BlockDoc:    json.RawMessage(`{}`),
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
	require.Equal(t, arg.Description, result.Post.Description)
	require.Equal(t, arg.UserID, result.Post.UserID)
	require.Equal(t, arg.Username, result.Post.Username)
	require.Equal(t, arg.Url, result.Post.Url)
	require.Equal(t, arg.PostType, result.Post.PostType)
	require.Equal(t, arg.PostStatus, result.Post.PostStatus)
	require.Equal(t, arg.PostParent, result.Post.PostParent)
	require.Equal(t, arg.MenuOrder, result.Post.MenuOrder)

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
			Slug:        slug,
			BlockDoc:    json.RawMessage(`{}`),
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

	require.Equal(t, "post", result.Post.PostType)
	require.Equal(t, "published", result.Post.PostStatus)
	require.False(t, result.Post.PostParent.Valid)
	require.Equal(t, int32(0), result.Post.MenuOrder)

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
		PostType:    "",
		PostStatus:  "",
		UserID:      int64(0),
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

	arg := UpdatePostParams{
		Title:       newTitle,
		Description: result.Post.Description,
		UserID:      result.Post.UserID,
		Username:    result.Post.Username,
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
	require.Equal(t, result.Post.ID, updatedPost.ID)

	result2 := createPostWithTransaction(t)
	arg2 := UpdatePostParams{
		Title:       result2.Post.Title,
		Description: "",
		UserID:      result2.Post.UserID,
		Username:    result2.Post.Username,
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
			Slug:        slug,
			BlockDoc:    json.RawMessage(`{}`),
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

	require.Equal(t, "post", result.Post.PostType)
	require.Equal(t, "published", result.Post.PostStatus)
	require.False(t, result.Post.PostParent.Valid)
	require.Equal(t, int32(0), result.Post.MenuOrder)

	postMedia, err := testQueries.GetMediaByPost(context.Background(), result.Post.ID)
	require.NoError(t, err)
	require.Len(t, postMedia, 2)

	mediaIDs := make([]int64, len(postMedia))
	for i, media := range postMedia {
		mediaIDs[i] = media.ID
	}
	require.ElementsMatch(t, []int64{media1.ID, media2.ID}, mediaIDs)
}

func TestCreatePostWithType(t *testing.T) {
	user := createTestUser(t)

	title := gofakeit.Sentence(3)
	slug := strings.ToLower(strings.ReplaceAll(title, " ", "-"))

	arg := CreatePostTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       title,
			Slug:        slug,
			BlockDoc:    json.RawMessage(`{}`),
			Description: gofakeit.Sentence(10),
			UserID:      user.ID,
			Username:    user.Username,
			Url:         fmt.Sprintf("https://example.com/pages/%s", slug),
			PostType:    "page",
			PostStatus:  "draft",
			PostParent:  sql.NullInt64{},
			MenuOrder:   5,
		},
		AuthorIDs: []int64{user.ID},
	}

	result, err := testStore.CreatePostTx(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, result.Post)

	require.Equal(t, "page", result.Post.PostType)
	require.Equal(t, "draft", result.Post.PostStatus)
	require.Equal(t, int32(5), result.Post.MenuOrder)
}

func TestCreateHierarchicalPosts(t *testing.T) {
	user := createTestUser(t)

	parentTitle := gofakeit.Sentence(3)
	parentSlug := strings.ToLower(strings.ReplaceAll(parentTitle, " ", "-"))

	parentArg := CreatePostTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       parentTitle,
			Slug:        parentSlug,
			BlockDoc:    json.RawMessage(`{}`),
			Description: gofakeit.Sentence(10),
			UserID:      user.ID,
			Username:    user.Username,
			Url:         fmt.Sprintf("https://example.com/pages/%s", parentSlug),
			PostType:    "page",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{},
			MenuOrder:   0,
		},
		AuthorIDs: []int64{user.ID},
	}

	parentResult, err := testStore.CreatePostTx(context.Background(), parentArg)
	require.NoError(t, err)
	require.NotEmpty(t, parentResult.Post)

	childTitle := gofakeit.Sentence(3)
	childSlug := strings.ToLower(strings.ReplaceAll(childTitle, " ", "-"))

	childArg := CreatePostTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       childTitle,
			Slug:        childSlug,
			BlockDoc:    json.RawMessage(`{}`),
			Description: gofakeit.Sentence(10),
			UserID:      user.ID,
			Username:    user.Username,
			Url:         fmt.Sprintf("https://example.com/pages/%s/%s", parentSlug, childSlug),
			PostType:    "page",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{Int64: parentResult.Post.ID, Valid: true},
			MenuOrder:   1,
		},
		AuthorIDs: []int64{user.ID},
	}

	childResult, err := testStore.CreatePostTx(context.Background(), childArg)
	require.NoError(t, err)
	require.NotEmpty(t, childResult.Post)

	require.Equal(t, parentResult.Post.ID, childResult.Post.PostParent.Int64)
	require.True(t, childResult.Post.PostParent.Valid)

	children, err := testQueries.GetPostChildren(context.Background(), sql.NullInt64{Int64: parentResult.Post.ID, Valid: true})
	require.NoError(t, err)
	require.Len(t, children, 1)
	require.Equal(t, childResult.Post.ID, children[0].ID)
	require.Equal(t, childResult.Post.Title, children[0].Title)
}

func TestListPostsByType(t *testing.T) {
	user := createTestUser(t)

	for i := 0; i < 3; i++ {
		title := gofakeit.Sentence(3)
		slug := strings.ToLower(strings.ReplaceAll(title, " ", "-"))

		arg := CreatePostTxParams{
			CreatePostsParams: CreatePostsParams{
				Title:       title,
				Slug:        slug,
				BlockDoc:    json.RawMessage(`{}`),
				Description: gofakeit.Sentence(10),
				UserID:      user.ID,
				Username:    user.Username,
				Url:         fmt.Sprintf("https://example.com/posts/%s-%d", slug, i),
				PostType:    "post",
				PostStatus:  "published",
				PostParent:  sql.NullInt64{},
				MenuOrder:   0,
			},
			AuthorIDs: []int64{user.ID},
		}
		_, err := testStore.CreatePostTx(context.Background(), arg)
		require.NoError(t, err)
	}

	for i := 0; i < 2; i++ {
		title := gofakeit.Sentence(3)
		slug := strings.ToLower(strings.ReplaceAll(title, " ", "-"))

		arg := CreatePostTxParams{
			CreatePostsParams: CreatePostsParams{
				Title:       title,
				Slug:        slug,
				BlockDoc:    json.RawMessage(`{}`),
				Description: gofakeit.Sentence(10),
				UserID:      user.ID,
				Username:    user.Username,
				Url:         fmt.Sprintf("https://example.com/pages/%s-%d", slug, i),
				PostType:    "page",
				PostStatus:  "published",
				PostParent:  sql.NullInt64{},
				MenuOrder:   int32(i),
			},
			AuthorIDs: []int64{user.ID},
		}
		_, err := testStore.CreatePostTx(context.Background(), arg)
		require.NoError(t, err)
	}

	posts, err := testQueries.ListPostsByType(context.Background(), ListPostsByTypeParams{
		PostType:    "post",
		PostStatus:  "",
		UserID:      int64(0),
		SortBy:      "",
		OffsetCount: 0,
		LimitCount:  10,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(posts), 3)

	for _, post := range posts {
		require.Equal(t, "post", post.PostType)
	}

	pages, err := testQueries.ListPostsByType(context.Background(), ListPostsByTypeParams{
		PostType:    "page",
		PostStatus:  "",
		UserID:      int64(0),
		SortBy:      "",
		OffsetCount: 0,
		LimitCount:  10,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(pages), 2)

	for _, page := range pages {
		require.Equal(t, "page", page.PostType)
	}
}

func TestListPostsWithSorting(t *testing.T) {
	user := createTestUser(t)

	titles := []string{"Alpha Post", "Beta Post", "Charlie Post"}
	for i, title := range titles {
		slug := strings.ToLower(strings.ReplaceAll(title, " ", "-"))

		arg := CreatePostTxParams{
			CreatePostsParams: CreatePostsParams{
				Title:       title,
				Slug:        slug,
				BlockDoc:    json.RawMessage(`{}`),
				Description: gofakeit.Sentence(10),
				UserID:      user.ID,
				Username:    user.Username,
				Url:         fmt.Sprintf("https://example.com/posts/%s", slug),
				PostType:    "post",
				PostStatus:  "published",
				PostParent:  sql.NullInt64{},
				MenuOrder:   int32(len(titles) - i),
			},
			AuthorIDs: []int64{user.ID},
		}
		_, err := testStore.CreatePostTx(context.Background(), arg)
		require.NoError(t, err)
	}

	posts, err := testQueries.ListPosts(context.Background(), ListPostsParams{
		PostType:    "",
		PostStatus:  "",
		UserID:      int64(0),
		SortBy:      "title_asc",
		OffsetCount: 0,
		LimitCount:  10,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(posts), 3)

	postsByMenu, err := testQueries.ListPosts(context.Background(), ListPostsParams{
		PostType:    "",
		PostStatus:  "",
		UserID:      int64(0),
		SortBy:      "menu_order_asc",
		OffsetCount: 0,
		LimitCount:  10,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(postsByMenu), 3)
}

func TestGetPostWithMeta(t *testing.T) {
	result := createPostWithTransaction(t)

	postWithMeta, err := testQueries.GetPostWithMeta(context.Background(), result.Post.ID)
	require.NoError(t, err)
	require.NotEmpty(t, postWithMeta)
	require.Equal(t, result.Post.ID, postWithMeta.ID)
	require.Equal(t, result.Post.Title, postWithMeta.Title)
	require.NotNil(t, postWithMeta.Meta)
}

func TestCountPosts(t *testing.T) {
	user := createTestUser(t)

	for i := 0; i < 5; i++ {
		title := gofakeit.Sentence(3)
		slug := strings.ToLower(strings.ReplaceAll(title, " ", "-"))

		postType := "post"
		if i%2 == 0 {
			postType = "page"
		}

		arg := CreatePostTxParams{
			CreatePostsParams: CreatePostsParams{
				Title:       title,
				Slug:        slug,
				BlockDoc:    json.RawMessage(`{}`),
				Description: gofakeit.Sentence(10),
				UserID:      user.ID,
				Username:    user.Username,
				Url:         fmt.Sprintf("https://example.com/%s/%s-%d", postType, slug, i),
				PostType:    postType,
				PostStatus:  "published",
				PostParent:  sql.NullInt64{},
				MenuOrder:   0,
			},
			AuthorIDs: []int64{user.ID},
		}
		_, err := testStore.CreatePostTx(context.Background(), arg)
		require.NoError(t, err)
	}

	totalCount, err := testQueries.CountTotalPosts(context.Background())
	require.NoError(t, err)
	require.GreaterOrEqual(t, totalCount, int64(5))

	postCount, err := testQueries.CountPostsByType(context.Background(), "post")
	require.NoError(t, err)
	require.GreaterOrEqual(t, postCount, int64(2))

	pageCount, err := testQueries.CountPostsByType(context.Background(), "page")
	require.NoError(t, err)
	require.GreaterOrEqual(t, pageCount, int64(3))
}

func TestUpdatePostWithNewFields(t *testing.T) {
	result := createPostWithTransaction(t)

	arg := UpdatePostParams{
		Title:       "Updated Title",
		Description: "Updated Description",
		UserID:      result.Post.UserID,
		Username:    result.Post.Username,
		Url:         result.Post.Url,
		PostType:    "page",
		PostStatus:  "draft",
		PostParent:  sql.NullInt64{},
		MenuOrder:   int32(10),
		ID:          result.Post.ID,
	}

	updatedPost, err := testQueries.UpdatePost(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, updatedPost)
	require.Equal(t, "Updated Title", updatedPost.Title)
	require.Equal(t, "page", updatedPost.PostType)
	require.Equal(t, "draft", updatedPost.PostStatus)
	require.Equal(t, int32(10), updatedPost.MenuOrder)
	require.True(t, updatedPost.ChangedAt.After(result.Post.CreatedAt))
}

func TestListPostsWithMeta(t *testing.T) {
	user := createTestUser(t)

	for i := 0; i < 3; i++ {
		title := gofakeit.Sentence(3)
		slug := strings.ToLower(strings.ReplaceAll(title, " ", "-"))

		postType := "post"
		if i == 0 {
			postType = "page"
		}

		arg := CreatePostTxParams{
			CreatePostsParams: CreatePostsParams{
				Title:       title,
				Slug:        slug,
				BlockDoc:    json.RawMessage(`{}`),
				Description: gofakeit.Sentence(10),
				UserID:      user.ID,
				Username:    user.Username,
				Url:         fmt.Sprintf("https://example.com/%s/%s-%d", postType, slug, i),
				PostType:    postType,
				PostStatus:  "published",
				PostParent:  sql.NullInt64{},
				MenuOrder:   int32(i),
			},
			AuthorIDs: []int64{user.ID},
		}
		_, err := testStore.CreatePostTx(context.Background(), arg)
		require.NoError(t, err)
	}

	postsWithMeta, err := testQueries.ListPostsWithMeta(context.Background(), ListPostsWithMetaParams{
		PostType:    "",
		PostStatus:  "",
		UserID:      int64(0),
		SortBy:      "menu_order_asc",
		OffsetCount: 0,
		LimitCount:  10,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(postsWithMeta), 3)

	for _, post := range postsWithMeta {
		require.NotNil(t, post.Meta)
		require.NotZero(t, post.ID)
		require.NotEmpty(t, post.Title)
	}

	pagesWithMeta, err := testQueries.ListPostsByTypeWithMeta(context.Background(), ListPostsByTypeWithMetaParams{
		PostType:    "page",
		PostStatus:  "",
		UserID:      int64(0),
		SortBy:      "",
		OffsetCount: 0,
		LimitCount:  10,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(pagesWithMeta), 1)

	for _, page := range pagesWithMeta {
		require.Equal(t, "page", page.PostType)
		require.NotNil(t, page.Meta)
	}
}

func TestListPostsByStatus(t *testing.T) {
	user := createTestUser(t)

	statuses := []string{"published", "draft", "published", "draft"}
	for i, status := range statuses {
		title := gofakeit.Sentence(3)
		slug := strings.ToLower(strings.ReplaceAll(title, " ", "-"))

		arg := CreatePostTxParams{
			CreatePostsParams: CreatePostsParams{
				Title:       title,
				Slug:        slug,
				BlockDoc:    json.RawMessage(`{}`),
				Description: gofakeit.Sentence(10),
				UserID:      user.ID,
				Username:    user.Username,
				Url:         fmt.Sprintf("https://example.com/posts/%s-%d", slug, i),
				PostType:    "post",
				PostStatus:  status,
				PostParent:  sql.NullInt64{},
				MenuOrder:   0,
			},
			AuthorIDs: []int64{user.ID},
		}
		_, err := testStore.CreatePostTx(context.Background(), arg)
		require.NoError(t, err)
	}

	publishedPosts, err := testQueries.ListPosts(context.Background(), ListPostsParams{
		PostType:    "",
		PostStatus:  "published",
		UserID:      int64(0),
		SortBy:      "",
		OffsetCount: 0,
		LimitCount:  10,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(publishedPosts), 2)

	for _, post := range publishedPosts {
		require.Equal(t, "published", post.PostStatus)
	}

	draftPosts, err := testQueries.ListPosts(context.Background(), ListPostsParams{
		PostType:    "",
		PostStatus:  "draft",
		UserID:      int64(0),
		SortBy:      "",
		OffsetCount: 0,
		LimitCount:  10,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(draftPosts), 2)

	for _, post := range draftPosts {
		require.Equal(t, "draft", post.PostStatus)
	}

	publishedPostsOfTypePost, err := testQueries.ListPosts(context.Background(), ListPostsParams{
		PostType:    "post",
		PostStatus:  "published",
		UserID:      int64(0),
		SortBy:      "",
		OffsetCount: 0,
		LimitCount:  10,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(publishedPostsOfTypePost), 2)

	for _, post := range publishedPostsOfTypePost {
		require.Equal(t, "post", post.PostType)
		require.Equal(t, "published", post.PostStatus)
	}
}
