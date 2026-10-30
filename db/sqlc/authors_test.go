package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// createAuthorPostType registers a post type with the given visibility.
func createAuthorPostType(t *testing.T, public, active bool) string {
	name := fmt.Sprintf("authortest_%d", time.Now().UnixNano())
	_, err := testQueries.CreatePostType(context.Background(), CreatePostTypeParams{
		Name:     name,
		Label:    "Author test",
		Public:   public,
		Supports: json.RawMessage(`["title"]`),
		IsActive: active,
	})
	require.NoError(t, err)
	return name
}

// createCreditedPost creates a post of postType owned by owner and credits
// authors on it, in order.
func createCreditedPost(t *testing.T, postType, status string, owner User, authors ...User) Post {
	slug := fmt.Sprintf("author-%d", time.Now().UnixNano())
	post, err := testQueries.CreatePosts(context.Background(), CreatePostsParams{
		Title:       "Author fixture " + slug,
		Description: "author fixture",
		UserID:      owner.ID,
		Username:    owner.Username,
		Url:         "https://example.com/" + slug,
		PostType:    postType,
		PostStatus:  status,
		Slug:        slug,
		BlockDoc:    json.RawMessage(`{}`),
	})
	require.NoError(t, err)
	for i, a := range authors {
		_, err := testQueries.CreateUserPost(context.Background(), CreateUserPostParams{PostID: post.ID, UserID: a.ID, Order: int32(i)})
		require.NoError(t, err)
	}
	return post
}

func TestGetPublicAuthorCountsOnlyPublishedPublicPosts(t *testing.T) {
	ctx := context.Background()
	public := createAuthorPostType(t, true, true)
	private := createAuthorPostType(t, false, true)
	inactive := createAuthorPostType(t, true, false)

	owner := createTestUser(t)
	draftsOnly := createTestUser(t)
	uncredited := createTestUser(t)
	hidden := createTestUser(t)
	author := createTestUser(t)

	// Owning a published post isn't being credited on it.
	createCreditedPost(t, public, "published", uncredited, owner)
	createCreditedPost(t, public, "draft", owner, draftsOnly)
	createCreditedPost(t, public, "archived", owner, draftsOnly)
	createCreditedPost(t, private, "published", owner, hidden)
	createCreditedPost(t, inactive, "published", owner, hidden)
	createCreditedPost(t, public, "published", owner, author, owner)
	createCreditedPost(t, public, "published", owner, owner, author)
	createCreditedPost(t, public, "draft", owner, author)

	for _, tc := range []struct {
		user User
		want int64
	}{
		{draftsOnly, 0},
		{uncredited, 0},
		{hidden, 0},
		{author, 2},
	} {
		row, err := testQueries.GetPublicAuthor(ctx, tc.user.Username)
		require.NoError(t, err)
		require.Equal(t, tc.want, row.PostCount, tc.user.Username)
		require.Equal(t, tc.user.ID, row.ID)
	}

	_, err := testQueries.GetPublicAuthor(ctx, "nobody-"+fmt.Sprint(time.Now().UnixNano()))
	require.ErrorIs(t, err, sql.ErrNoRows)
}

func TestListPublishedPostsByAuthor(t *testing.T) {
	ctx := context.Background()
	public := createAuthorPostType(t, true, true)
	private := createAuthorPostType(t, false, true)
	owner, author := createTestUser(t), createTestUser(t)

	older := createCreditedPost(t, public, "published", owner, author)
	newer := createCreditedPost(t, public, "published", owner, owner, author)
	createCreditedPost(t, public, "draft", owner, author)
	createCreditedPost(t, private, "published", owner, author)
	createCreditedPost(t, public, "published", owner, owner)
	_, err := testQueries.db.ExecContext(ctx, `UPDATE posts SET created_at = now() - interval '1 day' WHERE id = $1`, older.ID)
	require.NoError(t, err)

	rows, err := testQueries.ListPublishedPostsByAuthor(ctx, ListPublishedPostsByAuthorParams{UserID: author.ID, LimitCount: 10})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.Equal(t, newer.ID, rows[0].ID)
	require.Equal(t, older.ID, rows[1].ID)

	// The byline comes along in credit order, public fields only.
	var byline []map[string]any
	require.NoError(t, json.Unmarshal(rows[0].Authors, &byline))
	require.Len(t, byline, 2)
	require.Equal(t, owner.Username, byline[0]["username"])
	require.Equal(t, author.Username, byline[1]["username"])
	require.NotContains(t, string(rows[0].Authors), "email")

	page, err := testQueries.ListPublishedPostsByAuthor(ctx, ListPublishedPostsByAuthorParams{UserID: author.ID, LimitCount: 1, OffsetCount: 1})
	require.NoError(t, err)
	require.Len(t, page, 1)
	require.Equal(t, older.ID, page[0].ID)
}

func TestListPostAuthorProfiles(t *testing.T) {
	ctx := context.Background()
	public := createAuthorPostType(t, true, true)
	owner, a, b := createTestUser(t), createTestUser(t), createTestUser(t)

	published := createCreditedPost(t, public, "published", owner, b, a)
	rows, err := testQueries.ListPostAuthorProfiles(ctx, published.ID)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.Equal(t, b.Username, rows[0].Username)
	require.Equal(t, a.Username, rows[1].Username)

	// A draft's authors aren't public.
	draft := createCreditedPost(t, public, "draft", owner, a)
	rows, err = testQueries.ListPostAuthorProfiles(ctx, draft.ID)
	require.NoError(t, err)
	require.Empty(t, rows)
}

func TestListPublicAuthors(t *testing.T) {
	ctx := context.Background()
	public := createAuthorPostType(t, true, true)
	owner, author, draftsOnly := createTestUser(t), createTestUser(t), createTestUser(t)
	createCreditedPost(t, public, "published", owner, author)
	createCreditedPost(t, public, "draft", owner, draftsOnly)

	rows, err := testQueries.ListPublicAuthors(ctx, ListPublicAuthorsParams{LimitCount: 100000})
	require.NoError(t, err)
	names := map[string]time.Time{}
	for _, r := range rows {
		names[r.Username] = r.LastModified
	}
	require.Contains(t, names, author.Username)
	require.False(t, names[author.Username].IsZero())
	require.NotContains(t, names, draftsOnly.Username)
	require.NotContains(t, names, owner.Username)
}

// UpdateUser leaves bio/website alone when they're NULL and the CHECKs back
// the API's limits.
func TestUpdateUserBioWebsite(t *testing.T) {
	ctx := context.Background()
	user := createTestUser(t)
	params := UpdateUserParams{
		ID:                user.ID,
		Username:          user.Username,
		FullName:          user.FullName,
		Email:             user.Email,
		HashedPassword:    user.HashedPassword,
		PasswordChangedAt: user.PasswordChangedAt,
		Role:              user.Role,
	}

	set := params
	set.Bio = sql.NullString{String: "Hello", Valid: true}
	set.Website = sql.NullString{String: "https://example.com", Valid: true}
	updated, err := testQueries.UpdateUser(ctx, set)
	require.NoError(t, err)
	require.Equal(t, "Hello", updated.Bio)
	require.Equal(t, "https://example.com", updated.Website)

	updated, err = testQueries.UpdateUser(ctx, params)
	require.NoError(t, err)
	require.Equal(t, "Hello", updated.Bio)
	require.Equal(t, "https://example.com", updated.Website)

	tooLong := params
	tooLong.Bio = sql.NullString{String: strings.Repeat("a", 301), Valid: true}
	_, err = testQueries.UpdateUser(ctx, tooLong)
	require.Error(t, err)
}
