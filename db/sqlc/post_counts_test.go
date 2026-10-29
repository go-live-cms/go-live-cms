package db

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// createStatusFixtures inserts posts of a unique post type with the given
// statuses, all owned by owner.
func createStatusFixtures(t *testing.T, postType string, owner User, statuses []string) []Post {
	posts := make([]Post, 0, len(statuses))
	for i, status := range statuses {
		slug := fmt.Sprintf("%s-%d-%d", postType, owner.ID, i)
		post, err := testQueries.CreatePosts(context.Background(), CreatePostsParams{
			Title:       fmt.Sprintf("Status fixture %d", i),
			Description: "status fixture",
			UserID:      owner.ID,
			Username:    owner.Username,
			Url:         "https://example.com/" + slug,
			PostType:    postType,
			PostStatus:  status,
			Slug:        slug,
			BlockDoc:    json.RawMessage(`{}`),
		})
		require.NoError(t, err)
		posts = append(posts, post)
	}
	return posts
}

func TestCountPostsByStatus(t *testing.T) {
	postType := fmt.Sprintf("counttest-%d", time.Now().UnixNano())
	owner, other := createTestUser(t), createTestUser(t)
	createStatusFixtures(t, postType, owner, []string{"draft", "draft", "published", "archived"})
	createStatusFixtures(t, postType+"-x", other, []string{"published"}) // another type: not counted
	createStatusFixtures(t, postType, other, []string{"published"})

	counts := func(userID int64) map[string]int64 {
		rows, err := testQueries.CountPostsByStatus(context.Background(), CountPostsByStatusParams{PostType: postType, UserID: userID})
		require.NoError(t, err)
		got := map[string]int64{}
		for _, r := range rows {
			got[r.PostStatus] = r.Total
		}
		return got
	}

	require.Equal(t, map[string]int64{"draft": 2, "published": 2, "archived": 1}, counts(0))
	require.Equal(t, map[string]int64{"draft": 2, "published": 1, "archived": 1}, counts(owner.ID))
	require.Equal(t, map[string]int64{"published": 1}, counts(other.ID))
}

// The status filter takes a comma list (#340), so the admin's "All" tab can
// leave archived posts out; list and count agree.
func TestListPostsStatusList(t *testing.T) {
	postType := fmt.Sprintf("statuslist-%d", time.Now().UnixNano())
	owner := createTestUser(t)
	createStatusFixtures(t, postType, owner, []string{"draft", "published", "archived"})

	for _, tc := range []struct {
		status string
		want   []string
	}{
		{"", []string{"archived", "draft", "published"}},
		{"draft", []string{"draft"}},
		{"draft,published", []string{"draft", "published"}},
		{"published,archived", []string{"archived", "published"}},
		{"bogus", nil},
	} {
		t.Run(tc.status, func(t *testing.T) {
			rows, err := testQueries.ListPostsWithMeta(context.Background(), ListPostsWithMetaParams{
				PostType: postType, PostStatus: tc.status, UserID: int64(0),
				SortColumn: "title", SortDirection: "asc", LimitCount: 10,
			})
			require.NoError(t, err)
			var got []string
			for _, r := range rows {
				got = append(got, r.PostStatus)
			}
			require.ElementsMatch(t, tc.want, got)

			total, err := testQueries.CountFilteredPosts(context.Background(), CountFilteredPostsParams{
				PostType: postType, PostStatus: tc.status, UserID: int64(0),
			})
			require.NoError(t, err)
			require.Equal(t, int64(len(tc.want)), total)
		})
	}
}

// ListPostsWithMeta returns every user_posts author in credit order (#340).
func TestListPostsWithMetaAuthors(t *testing.T) {
	postType := fmt.Sprintf("authors-%d", time.Now().UnixNano())
	owner, coauthor := createTestUser(t), createTestUser(t)
	posts := createStatusFixtures(t, postType, owner, []string{"draft", "draft"})

	// The second author is credited first.
	for _, link := range []CreateUserPostParams{
		{PostID: posts[0].ID, UserID: owner.ID, Order: 2},
		{PostID: posts[0].ID, UserID: coauthor.ID, Order: 1},
	} {
		_, err := testQueries.CreateUserPost(context.Background(), link)
		require.NoError(t, err)
	}

	rows, err := testQueries.ListPostsWithMeta(context.Background(), ListPostsWithMetaParams{
		PostType: postType, UserID: int64(0), SortColumn: "id", SortDirection: "asc", LimitCount: 10,
	})
	require.NoError(t, err)
	require.Len(t, rows, 2)

	type author struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
		FullName string `json:"full_name"`
	}
	var first, second []author
	require.NoError(t, json.Unmarshal(rows[0].Authors, &first))
	require.NoError(t, json.Unmarshal(rows[1].Authors, &second))
	require.Equal(t, []author{
		{coauthor.ID, coauthor.Username, coauthor.FullName},
		{owner.ID, owner.Username, owner.FullName},
	}, first)
	require.Empty(t, second) // no user_posts rows: [] rather than null
	require.NotNil(t, second)
	require.NotContains(t, string(rows[0].Authors), "email")
}
