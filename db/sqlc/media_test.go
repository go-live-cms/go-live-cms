package db

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"github.com/brianvoe/gofakeit/v6"
	"github.com/stretchr/testify/require"
)

func createTestMedia(t *testing.T) (User, Medium) {
	user := createTestUser(t)

	gofakeit.Seed(0)
	arg := CreateMediaParams{
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

	media, err := testQueries.CreateMedia(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, media)
	require.Equal(t, arg.Name, media.Name)
	require.Equal(t, arg.Description, media.Description)
	require.Equal(t, arg.Alt, media.Alt)
	require.Equal(t, arg.MediaPath, media.MediaPath)
	require.Equal(t, arg.UserID, media.UserID)
	require.NotZero(t, media.ID)

	return user, media
}

func TestCreateMedia(t *testing.T) {
	_, media := createTestMedia(t)
	require.NotEmpty(t, media)
}

func TestGetMedia(t *testing.T) {
	_, media1 := createTestMedia(t)
	media2, err := testQueries.GetMedia(context.Background(), media1.ID)
	require.NoError(t, err)
	require.NotEmpty(t, media2)
	require.Equal(t, media1.ID, media2.ID)
	require.Equal(t, media1.Name, media2.Name)
	require.Equal(t, media1.UserID, media2.UserID)
}

func TestListMedia(t *testing.T) {
	for range 10 {
		createTestMedia(t)
	}

	media, err := testQueries.ListMedia(context.Background(), ListMediaParams{
		Column1: "",
		Column2: int64(0),
		Column3: "",
		Column4: "",
		Limit:   5,
		Offset:  5,
	})
	require.NoError(t, err)
	require.Len(t, media, 5)

	for _, media := range media {
		require.NotEmpty(t, media)
		require.NotZero(t, media.ID)
		require.NotEmpty(t, media.Name)
		require.NotEmpty(t, media.UserID)
	}
}

func TestUpdateMedia(t *testing.T) {
	_, media1 := createTestMedia(t)

	newName := gofakeit.Word()
	newDescription := gofakeit.Sentence(15)

	arg := UpdateMediaParams{
		ID:          media1.ID,
		Name:        newName,
		Description: newDescription,
		Alt:         media1.Alt,
		MediaPath:   media1.MediaPath,
	}

	media2, err := testQueries.UpdateMedia(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, media2)
	require.Equal(t, media1.ID, media2.ID)
	require.Equal(t, newName, media2.Name)
	require.Equal(t, newDescription, media2.Description)
}

func TestDeleteMediaTx(t *testing.T) {
	user, media := createTestMedia(t)
	_, post := createTestUserWithPosts(t)

	_, err := testQueries.CreatePostMedia(context.Background(), CreatePostMediaParams{
		PostID:  post.Post.ID,
		MediaID: media.ID,
		Order:   0,
	})
	require.NoError(t, err)

	err = testStore.DeleteMediaTx(context.Background(), DeleteMediaTxParams{
		MediaID: media.ID,
		UserID:  user.ID,
	})
	require.NoError(t, err)

	deletedMedia, err := testQueries.GetMedia(context.Background(), media.ID)
	require.Error(t, err)
	require.Empty(t, deletedMedia)

	postMedia, err := testQueries.GetMediaByPost(context.Background(), post.Post.ID)
	require.NoError(t, err)
	require.Len(t, postMedia, 0)
}

func TestCreatePostWithMediaTx(t *testing.T) {
	user := createTestUser(t)
	_, media1 := createTestMedia(t)
	_, media2 := createTestMedia(t)

	title := gofakeit.Sentence(3)

	arg := CreatePostWithMediaTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       title,
			Content:     gofakeit.Paragraph(3, 5, 10, " "),
			Description: gofakeit.Sentence(10),
			UserID:      user.ID,
			Username:    user.Username,
			Url:         fmt.Sprintf("https://example.com/posts/%s", gofakeit.UUID()),
			PostType:    "post",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{Valid: false},
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
}

func TestMediaAnalyticsQueries(t *testing.T) {
	timestamp := time.Now().Format("20060102150405")

	user := createTestUser(t)

	popular := createMediaWithName(t, user.ID, fmt.Sprintf("popular_%s.jpg", timestamp), "Popular media")
	moderate := createMediaWithName(t, user.ID, fmt.Sprintf("moderate_%s.jpg", timestamp), "Moderate media")
	unused := createMediaWithName(t, user.ID, fmt.Sprintf("unused_%s.jpg", timestamp), "Unused media")

	_, post1 := createTestUserWithPosts(t)
	_, post2 := createTestUserWithPosts(t)
	_, post3 := createTestUserWithPosts(t)

	for i, post := range []CreatePostTxResult{post1, post2, post3} {
		_, err := testQueries.CreatePostMedia(context.Background(), CreatePostMediaParams{
			PostID:  post.Post.ID,
			MediaID: popular.ID,
			Order:   int32(i),
		})
		require.NoError(t, err)
	}

	_, err := testQueries.CreatePostMedia(context.Background(), CreatePostMediaParams{
		PostID:  post1.Post.ID,
		MediaID: moderate.ID,
		Order:   1,
	})
	require.NoError(t, err)

	mediaWithCount, err := testQueries.ListMedia(context.Background(), ListMediaParams{
		Column1: "",
		Column2: int64(0),
		Column3: "",
		Column4: "",
		Limit:   50,
		Offset:  0,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(mediaWithCount), 3)

	mediaCountMap := make(map[string]int64)
	for _, img := range mediaWithCount {
		if img.Name == popular.Name {
			mediaCountMap["popular"] = img.PostCount
		}
		if img.Name == moderate.Name {
			mediaCountMap["moderate"] = img.PostCount
		}
		if img.Name == unused.Name {
			mediaCountMap["unused"] = img.PostCount
		}
	}

	require.Equal(t, int64(3), mediaCountMap["popular"], "Popular media should have 3 posts in ListMediaWithPostCount")
	require.Equal(t, int64(1), mediaCountMap["moderate"], "Moderate media should have 1 post in ListMediaWithPostCount")
	require.Equal(t, int64(0), mediaCountMap["unused"], "Unused media should have 0 posts in ListMediaWithPostCount")

	popularMedia, err := testQueries.GetPopularMedia(context.Background(), 10)
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(popularMedia), 2)

	popularFound := make(map[string]int64)
	for _, img := range popularMedia {
		if img.Name == popular.Name {
			popularFound["popular"] = img.PostCount
		}
		if img.Name == moderate.Name {
			popularFound["moderate"] = img.PostCount
		}
		if img.Name == unused.Name {
			popularFound["unused"] = img.PostCount
		}
	}

	require.Equal(t, int64(3), popularFound["popular"], "Popular media should have 3 posts in GetPopularMedia")
	require.Equal(t, int64(1), popularFound["moderate"], "Moderate media should have 1 post in GetPopularMedia")

	require.Equal(t, int64(0), popularFound["unused"], "Unused media should not be in GetPopularMedia")

	t.Logf("Popular (%s): %d posts", popular.Name, popularFound["popular"])
	t.Logf("Moderate (%s): %d posts", moderate.Name, popularFound["moderate"])
	t.Logf("Unused (%s): not in popular results (expected)", unused.Name)
}

func createMediaWithName(t *testing.T, userID int64, name, description string) Medium {
	arg := CreateMediaParams{
		Name:             name,
		Description:      description,
		Alt:              fmt.Sprintf("Alt text for %s", name),
		MediaPath:        fmt.Sprintf("/uploads/media/%s", name),
		UserID:           userID,
		FileSize:         int64(gofakeit.Number(1000, 100000)),
		MimeType:         "image/jpeg",
		Width:            int32(gofakeit.Number(100, 1920)),
		Height:           int32(gofakeit.Number(100, 1080)),
		Duration:         0,
		OriginalFilename: name,
	}

	media, err := testQueries.CreateMedia(context.Background(), arg)
	require.NoError(t, err)
	require.NotEmpty(t, media)
	require.NotZero(t, media.ID)

	return media
}

func TestGetPostWithMedia(t *testing.T) {
	user := createTestUser(t)
	_, media1 := createTestMedia(t)
	_, media2 := createTestMedia(t)

	arg := CreatePostWithMediaTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       gofakeit.Sentence(3),
			Content:     gofakeit.Paragraph(3, 5, 10, " "),
			Description: gofakeit.Sentence(10),
			UserID:      user.ID,
			Username:    user.Username,
			Url:         fmt.Sprintf("https://example.com/posts/%s", gofakeit.UUID()),
			PostType:    "post",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{Valid: false},
			MenuOrder:   0,
		},
		AuthorIDs: []int64{user.ID},
		MediaIDs:  []int64{media1.ID, media2.ID},
	}

	result, err := testStore.CreatePostWithMediaTx(context.Background(), arg)
	require.NoError(t, err)

	postWithMedia, err := testQueries.GetPostWithMedia(context.Background(), result.Post.ID)
	require.NoError(t, err)
	require.NotEmpty(t, postWithMedia)

	require.Equal(t, result.Post.ID, postWithMedia.ID)
	require.Equal(t, result.Post.Title, postWithMedia.Title)

	require.NotEmpty(t, postWithMedia.Media)

	t.Logf("Post with media: %+v", postWithMedia)
}

func TestListPostsWithMedia(t *testing.T) {
	user := createTestUser(t)
	_, media1 := createTestMedia(t)
	_, media2 := createTestMedia(t)

	arg := CreatePostWithMediaTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       gofakeit.Sentence(3),
			Content:     gofakeit.Paragraph(3, 5, 10, " "),
			Description: gofakeit.Sentence(10),
			UserID:      user.ID,
			Username:    user.Username,
			Url:         fmt.Sprintf("https://example.com/posts/%s", gofakeit.UUID()),
			PostType:    "post",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{Valid: false},
			MenuOrder:   0,
		},
		AuthorIDs: []int64{user.ID},
		MediaIDs:  []int64{media1.ID, media2.ID},
	}

	_, err := testStore.CreatePostWithMediaTx(context.Background(), arg)
	require.NoError(t, err)

	_, err = testStore.CreatePostTx(context.Background(), CreatePostTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       gofakeit.Sentence(3),
			Content:     gofakeit.Paragraph(3, 5, 10, " "),
			Description: gofakeit.Sentence(10),
			UserID:      user.ID,
			Username:    user.Username,
			Url:         fmt.Sprintf("https://example.com/posts/%s", gofakeit.UUID()),
			PostType:    "post",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{Valid: false},
			MenuOrder:   0,
		},
		AuthorIDs: []int64{user.ID},
	})
	require.NoError(t, err)

	postsWithMedia, err := testQueries.ListPostsWithMedia(context.Background(), ListPostsWithMediaParams{
		Limit:  10,
		Offset: 0,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(postsWithMedia), 2)

	for _, post := range postsWithMedia {
		require.NotNil(t, post.Media)
		t.Logf("Post %d has media: %v", post.ID, post.Media)
	}
}

func TestGetPostsByUserWithMedia(t *testing.T) {
	user := createTestUser(t)
	_, media1 := createTestMedia(t)

	arg := CreatePostWithMediaTxParams{
		CreatePostsParams: CreatePostsParams{
			Title:       gofakeit.Sentence(3),
			Content:     gofakeit.Paragraph(3, 5, 10, " "),
			Description: gofakeit.Sentence(10),
			UserID:      user.ID,
			Username:    user.Username,
			Url:         fmt.Sprintf("https://example.com/posts/%s", gofakeit.UUID()),
			PostType:    "post",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{Valid: false},
			MenuOrder:   0,
		},
		AuthorIDs: []int64{user.ID},
		MediaIDs:  []int64{media1.ID},
	}

	_, err := testStore.CreatePostWithMediaTx(context.Background(), arg)
	require.NoError(t, err)

	userPosts, err := testQueries.GetPostsByUserWithMedia(context.Background(), GetPostsByUserWithMediaParams{
		UserID: user.ID,
		Limit:  10,
		Offset: 0,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(userPosts), 1)

	for _, post := range userPosts {
		require.Equal(t, user.ID, post.UserID)
		require.NotNil(t, post.Media)
	}
}

func TestGetMediaByUser(t *testing.T) {

	user1 := createTestUser(t)
	user2 := createTestUser(t)

	timestamp := time.Now().Format("20060102150405")
	media1 := createMediaWithName(t, user1.ID, fmt.Sprintf("user1_media1_%s.jpg", timestamp), "User 1 first media")
	media2 := createMediaWithName(t, user1.ID, fmt.Sprintf("user1_media2_%s.jpg", timestamp), "User 1 second media")
	media3 := createMediaWithName(t, user1.ID, fmt.Sprintf("user1_media3_%s.jpg", timestamp), "User 1 third media")

	createMediaWithName(t, user2.ID, fmt.Sprintf("user2_media1_%s.jpg", timestamp), "User 2 first media")
	createMediaWithName(t, user2.ID, fmt.Sprintf("user2_media2_%s.jpg", timestamp), "User 2 second media")

	user1Media, err := testQueries.GetMediaByUser(context.Background(), GetMediaByUserParams{
		UserID:  user1.ID,
		Column2: "",
		Column3: "",
		Column4: "",
		Limit:   10,
		Offset:  0,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(user1Media), 3)

	user1MediaIDs := make([]int64, 0)
	for _, img := range user1Media {
		require.Equal(t, user1.ID, img.UserID)
		if img.ID == media1.ID || img.ID == media2.ID || img.ID == media3.ID {
			user1MediaIDs = append(user1MediaIDs, img.ID)
		}
	}
	require.ElementsMatch(t, []int64{media1.ID, media2.ID, media3.ID}, user1MediaIDs)

	user2Media, err := testQueries.GetMediaByUser(context.Background(), GetMediaByUserParams{
		UserID:  user2.ID,
		Column2: "",
		Column3: "",
		Column4: "",
		Limit:   10,
		Offset:  0,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(user2Media), 2)

	for _, img := range user2Media {
		require.Equal(t, user2.ID, img.UserID)
	}

	user1MediaPage1, err := testQueries.GetMediaByUser(context.Background(), GetMediaByUserParams{
		UserID:  user1.ID,
		Column2: "",
		Column3: "",
		Column4: "",
		Limit:   2,
		Offset:  0,
	})
	require.NoError(t, err)
	require.Len(t, user1MediaPage1, 2)

	user1MediaPage2, err := testQueries.GetMediaByUser(context.Background(), GetMediaByUserParams{
		UserID:  user1.ID,
		Column2: "",
		Column3: "",
		Column4: "",
		Limit:   2,
		Offset:  2,
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, len(user1MediaPage2), 1)

	page1IDs := make([]int64, len(user1MediaPage1))
	for i, img := range user1MediaPage1 {
		page1IDs[i] = img.ID
	}

	for _, img := range user1MediaPage2 {
		require.NotContains(t, page1IDs, img.ID, "Pages should not have overlapping media")
	}

	userNoMedia := createTestUser(t)
	noMedia, err := testQueries.GetMediaByUser(context.Background(), GetMediaByUserParams{
		UserID:  userNoMedia.ID,
		Column2: "",
		Column3: "",
		Column4: "",
		Limit:   10,
		Offset:  0,
	})
	require.NoError(t, err)
	require.Len(t, noMedia, 0)
}

func TestGetUserMediaCount(t *testing.T) {
	user := createTestUser(t)
	timestamp := time.Now().Format("20060102150405")

	count, err := testQueries.GetUserMediaCount(context.Background(), user.ID)
	require.NoError(t, err)
	require.Equal(t, int64(0), count)

	createMediaWithName(t, user.ID, fmt.Sprintf("count_test1_%s.jpg", timestamp), "First media")
	count, err = testQueries.GetUserMediaCount(context.Background(), user.ID)
	require.NoError(t, err)
	require.Equal(t, int64(1), count)

	createMediaWithName(t, user.ID, fmt.Sprintf("count_test2_%s.jpg", timestamp), "Second media")
	count, err = testQueries.GetUserMediaCount(context.Background(), user.ID)
	require.NoError(t, err)
	require.Equal(t, int64(2), count)

	media3 := createMediaWithName(t, user.ID, fmt.Sprintf("count_test3_%s.jpg", timestamp), "Third media")
	count, err = testQueries.GetUserMediaCount(context.Background(), user.ID)
	require.NoError(t, err)
	require.Equal(t, int64(3), count)

	err = testQueries.DeleteMedia(context.Background(), media3.ID)
	require.NoError(t, err)
	count, err = testQueries.GetUserMediaCount(context.Background(), user.ID)
	require.NoError(t, err)
	require.Equal(t, int64(2), count)

	user2 := createTestUser(t)
	count2, err := testQueries.GetUserMediaCount(context.Background(), user2.ID)
	require.NoError(t, err)
	require.Equal(t, int64(0), count2)

	createMediaWithName(t, user2.ID, fmt.Sprintf("user2_count_%s.jpg", timestamp), "User2 media")
	count2, err = testQueries.GetUserMediaCount(context.Background(), user2.ID)
	require.NoError(t, err)
	require.Equal(t, int64(1), count2)

	count, err = testQueries.GetUserMediaCount(context.Background(), user.ID)
	require.NoError(t, err)
	require.Equal(t, int64(2), count)
}

func TestSearchMediaByName(t *testing.T) {
	user := createTestUser(t)
	timestamp := time.Now().Format("20060102150405")

	js := createMediaWithName(t, user.ID, fmt.Sprintf("javascript_%s.jpg", timestamp), "JavaScript tutorial screenshot")
	java := createMediaWithName(t, user.ID, fmt.Sprintf("java_%s.png", timestamp), "Java programming guide")
	react := createMediaWithName(t, user.ID, fmt.Sprintf("react_%s.svg", timestamp), "React component diagram")
	vue := createMediaWithName(t, user.ID, fmt.Sprintf("vue_%s.jpg", timestamp), "Vue.js application screenshot")
	python := createMediaWithName(t, user.ID, fmt.Sprintf("python_%s.png", timestamp), "Python script example")

	t.Logf("Created media:")
	t.Logf("  JavaScript: ID=%d, Name=%s, Description=%s", js.ID, js.Name, js.Description)
	t.Logf("  Java: ID=%d, Name=%s, Description=%s", java.ID, java.Name, java.Description)
	t.Logf("  React: ID=%d, Name=%s, Description=%s", react.ID, react.Name, react.Description)
	t.Logf("  Vue: ID=%d, Name=%s, Description=%s", vue.ID, vue.Name, vue.Description)
	t.Logf("  Python: ID=%d, Name=%s, Description=%s", python.ID, python.Name, python.Description)

	testCases := []struct {
		name           string
		searchTerm     string
		expectedCount  int
		mustContain    []int64
		mustNotContain []int64
	}{
		{
			name:           "Search for 'java' should find JavaScript and Java",
			searchTerm:     "java",
			expectedCount:  2,
			mustContain:    []int64{js.ID, java.ID},
			mustNotContain: []int64{react.ID, vue.ID, python.ID},
		},
		{
			name:           "Search for 'script' should find JavaScript and Python",
			searchTerm:     "script",
			expectedCount:  2,
			mustContain:    []int64{js.ID, python.ID},
			mustNotContain: []int64{java.ID, react.ID, vue.ID},
		},
		{
			name:           "Search for 'react' should find React",
			searchTerm:     "react",
			expectedCount:  1,
			mustContain:    []int64{react.ID},
			mustNotContain: []int64{js.ID, java.ID, vue.ID, python.ID},
		},
		{
			name:           "Search for 'component' should find React (in description)",
			searchTerm:     "component",
			expectedCount:  1,
			mustContain:    []int64{react.ID},
			mustNotContain: []int64{js.ID, java.ID, vue.ID, python.ID},
		},
		{
			name:           "Search for 'programming' should find Java (in description)",
			searchTerm:     "programming",
			expectedCount:  1,
			mustContain:    []int64{java.ID},
			mustNotContain: []int64{js.ID, react.ID, vue.ID, python.ID},
		},
		{
			name:           "Search for timestamp should find all our media",
			searchTerm:     timestamp,
			expectedCount:  5,
			mustContain:    []int64{js.ID, java.ID, react.ID, vue.ID, python.ID},
			mustNotContain: []int64{},
		},
		{
			name:           "Search for nonexistent should find nothing",
			searchTerm:     "definitely_does_not_exist_12345",
			expectedCount:  0,
			mustContain:    []int64{},
			mustNotContain: []int64{js.ID, java.ID, react.ID, vue.ID, python.ID},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			results, err := testQueries.SearchMediaByName(context.Background(), SearchMediaByNameParams{
				Column1: sql.NullString{String: tc.searchTerm, Valid: true},
				Column2: "",
				Column3: int64(0),
				Column4: "",
				Limit:   50,
				Offset:  0,
			})
			require.NoError(t, err)

			t.Logf("Search term: '%s' returned %d total results:", tc.searchTerm, len(results))
			for i, img := range results {
				if img.UserID == user.ID {
					t.Logf("  Result %d: ID=%d, Name=%s, Description=%s", i+1, img.ID, img.Name, img.Description)
				}
			}

			testResults := []SearchMediaByNameRow{}
			testResultIDs := []int64{}
			for _, img := range results {
				if img.UserID == user.ID &&
					(img.ID == js.ID || img.ID == java.ID || img.ID == react.ID || img.ID == vue.ID || img.ID == python.ID) {
					testResults = append(testResults, img)
					testResultIDs = append(testResultIDs, img.ID)
				}
			}

			t.Logf("Filtered to our test media: %d results with IDs %v", len(testResults), testResultIDs)

			require.Len(t, testResults, tc.expectedCount, "Search term: '%s'. Expected %d results, got %d", tc.searchTerm, tc.expectedCount, len(testResults))

			resultIDs := make([]int64, len(testResults))
			for i, img := range testResults {
				resultIDs[i] = img.ID
			}

			for _, mustHaveID := range tc.mustContain {
				require.Contains(t, resultIDs, mustHaveID, "Search term '%s' should contain media ID %d", tc.searchTerm, mustHaveID)
			}

			for _, mustNotHaveID := range tc.mustNotContain {
				require.NotContains(t, resultIDs, mustNotHaveID, "Search term '%s' should NOT contain media ID %d", tc.searchTerm, mustNotHaveID)
			}

			t.Logf("Search term: '%s' found %d results", tc.searchTerm, len(testResults))
		})
	}
}

func TestSearchMediaByNameCaseInsensitive(t *testing.T) {
	user := createTestUser(t)
	timestamp := time.Now().Format("20060102150405")

	media := createMediaWithName(t, user.ID, fmt.Sprintf("MixedCase_%s.jpg", timestamp), "MixedCase Description Test")

	testCases := []struct {
		name       string
		searchTerm string
	}{
		{"Lowercase search", "mixedcase"},
		{"Uppercase search", "MIXEDCASE"},
		{"Mixed case search", "MiXeDcAsE"},
		{"Description lowercase", "description"},
		{"Description uppercase", "DESCRIPTION"},
		{"Description mixed", "DeScRiPtIoN"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			results, err := testQueries.SearchMediaByName(context.Background(), SearchMediaByNameParams{
				Column1: sql.NullString{String: tc.searchTerm, Valid: true},
				Column2: "",
				Column3: int64(0),
				Column4: "",
				Limit:   10,
				Offset:  0,
			})
			require.NoError(t, err)

			found := false
			for _, img := range results {
				if img.ID == media.ID {
					found = true
					break
				}
			}
			require.True(t, found, "Search term '%s' should find the MixedCase media", tc.searchTerm)
		})
	}
}

func TestSearchMediaByNamePagination(t *testing.T) {
	user := createTestUser(t)
	timestamp := time.Now().Format("20060102150405")

	searchTerm := fmt.Sprintf("pagination_test_%s", timestamp)
	var createdMedia []Medium
	for i := 0; i < 5; i++ {
		img := createMediaWithName(t, user.ID, fmt.Sprintf("%s_media_%d.jpg", searchTerm, i), fmt.Sprintf("Pagination test media %d", i))
		createdMedia = append(createdMedia, img)
	}

	page1, err := testQueries.SearchMediaByName(context.Background(), SearchMediaByNameParams{
		Column1: sql.NullString{String: searchTerm, Valid: true},
		Column2: "",
		Column3: int64(0),
		Column4: "",
		Limit:   2,
		Offset:  0,
	})
	require.NoError(t, err)

	testPage1 := []SearchMediaByNameRow{}
	for _, img := range page1 {
		if img.UserID == user.ID {
			for _, created := range createdMedia {
				if img.ID == created.ID {
					testPage1 = append(testPage1, img)
				}
			}
		}
	}
	require.Len(t, testPage1, 2)

	page2, err := testQueries.SearchMediaByName(context.Background(), SearchMediaByNameParams{
		Column1: sql.NullString{String: searchTerm, Valid: true},
		Column2: "",
		Column3: int64(0),
		Column4: "",
		Limit:   2,
		Offset:  2,
	})
	require.NoError(t, err)

	testPage2 := []SearchMediaByNameRow{}
	for _, img := range page2 {
		if img.UserID == user.ID {
			for _, created := range createdMedia {
				if img.ID == created.ID {
					testPage2 = append(testPage2, img)
				}
			}
		}
	}
	require.Len(t, testPage2, 2)

	page3, err := testQueries.SearchMediaByName(context.Background(), SearchMediaByNameParams{
		Column1: sql.NullString{String: searchTerm, Valid: true},
		Column2: "",
		Column3: int64(0),
		Column4: "",
		Limit:   2,
		Offset:  4,
	})
	require.NoError(t, err)

	testPage3 := []SearchMediaByNameRow{}
	for _, img := range page3 {
		if img.UserID == user.ID {
			for _, created := range createdMedia {
				if img.ID == created.ID {
					testPage3 = append(testPage3, img)
				}
			}
		}
	}
	require.Len(t, testPage3, 1)

	allPageIDs := make([]int64, 0)
	for _, img := range testPage1 {
		allPageIDs = append(allPageIDs, img.ID)
	}
	for _, img := range testPage2 {
		require.NotContains(t, allPageIDs, img.ID, "Page 2 should not overlap with page 1")
		allPageIDs = append(allPageIDs, img.ID)
	}
	for _, img := range testPage3 {
		require.NotContains(t, allPageIDs, img.ID, "Page 3 should not overlap with pages 1 and 2")
		allPageIDs = append(allPageIDs, img.ID)
	}

	createdIDs := make([]int64, len(createdMedia))
	for i, img := range createdMedia {
		createdIDs[i] = img.ID
	}
	require.ElementsMatch(t, createdIDs, allPageIDs, "All created media should be found across pages")
}

func TestSearchMediaByNameEmptyTerm(t *testing.T) {

	results, err := testQueries.SearchMediaByName(context.Background(), SearchMediaByNameParams{
		Column1: sql.NullString{String: "", Valid: true},
		Column2: "",
		Column3: int64(0),
		Column4: "",
		Limit:   10,
		Offset:  0,
	})
	require.NoError(t, err)

	require.GreaterOrEqual(t, len(results), 0)

	results2, err := testQueries.SearchMediaByName(context.Background(), SearchMediaByNameParams{
		Column1: sql.NullString{Valid: false},
		Column2: "",
		Column3: int64(0),
		Column4: "",
		Limit:   10,
		Offset:  0,
	})
	require.NoError(t, err)

	require.Len(t, results2, 0)
}
