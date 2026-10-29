package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Older/newer and related posts (#351). Each test uses its own post type, so the
// other posts in the shared test DB never rank.

func relatedTestPostType() string {
	return fmt.Sprintf("rel_%d", time.Now().UnixNano())
}

// createRelatedTestPost creates a post of postType published (or not) at createdAt.
func createRelatedTestPost(t *testing.T, user User, postType, status string, createdAt time.Time) Post {
	ctx := context.Background()
	slug := fmt.Sprintf("rel-%d", time.Now().UnixNano())
	post, err := testQueries.CreatePosts(ctx, CreatePostsParams{
		Title:       slug,
		Slug:        slug,
		BlockDoc:    json.RawMessage(`{}`),
		Description: "related test",
		UserID:      user.ID,
		Username:    user.Username,
		Url:         "https://example.com/" + slug,
		PostType:    postType,
		PostStatus:  status,
		PostParent:  sql.NullInt64{},
	})
	require.NoError(t, err)
	_, err = testQueries.CreateUserPost(ctx, CreateUserPostParams{PostID: post.ID, UserID: user.ID, Order: 0})
	require.NoError(t, err)
	_, err = testQueries.db.ExecContext(ctx, `UPDATE posts SET created_at = $2 WHERE id = $1`, post.ID, createdAt)
	require.NoError(t, err)
	post.CreatedAt = createdAt
	return post
}

func tagPost(t *testing.T, post Post, terms ...TaxonomyTerm) {
	for _, term := range terms {
		_, err := testQueries.AddPostToTaxonomyTerm(context.Background(), AddPostToTaxonomyTermParams{
			PostID:         post.ID,
			TaxonomyTermID: term.ID,
		})
		require.NoError(t, err)
	}
}

func relatedTestTerm(t *testing.T, taxonomy string) TaxonomyTerm {
	ty, err := testQueries.GetTaxonomyType(context.Background(), taxonomy)
	require.NoError(t, err)
	return createTestTaxonomyTerm(t, ty.ID)
}

func adjacentByDirection(rows []ListAdjacentPostsRow) map[string]int64 {
	out := map[string]int64{}
	for _, r := range rows {
		out[r.Direction] = r.ID
	}
	return out
}

func relatedIDs(rows []ListRelatedPostsRow) []int64 {
	ids := make([]int64, len(rows))
	for i, r := range rows {
		ids[i] = r.ID
	}
	return ids
}

func TestListAdjacentPosts(t *testing.T) {
	ctx := context.Background()
	user := createTestUser(t)
	postType := relatedTestPostType()
	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

	first := createRelatedTestPost(t, user, postType, "published", base)
	// A draft between first and middle never counts.
	createRelatedTestPost(t, user, postType, "draft", base.Add(30*time.Minute))
	middle := createRelatedTestPost(t, user, postType, "published", base.Add(time.Hour))
	last := createRelatedTestPost(t, user, postType, "published", base.Add(2*time.Hour))
	// Another type at the same instant never counts either.
	createRelatedTestPost(t, user, relatedTestPostType(), "published", base.Add(90*time.Minute))

	adjacent := func(p Post) map[string]int64 {
		rows, err := testQueries.ListAdjacentPosts(ctx, ListAdjacentPostsParams{PostType: postType, CreatedAt: p.CreatedAt, PostID: p.ID})
		require.NoError(t, err)
		return adjacentByDirection(rows)
	}

	t.Run("middle has both", func(t *testing.T) {
		require.Equal(t, map[string]int64{"previous": first.ID, "next": last.ID}, adjacent(middle))
	})
	t.Run("first has no previous", func(t *testing.T) {
		require.Equal(t, map[string]int64{"next": middle.ID}, adjacent(first))
	})
	t.Run("last has no next", func(t *testing.T) {
		require.Equal(t, map[string]int64{"previous": middle.ID}, adjacent(last))
	})
	t.Run("rows carry meta and authors", func(t *testing.T) {
		rows, err := testQueries.ListAdjacentPosts(ctx, ListAdjacentPostsParams{PostType: postType, CreatedAt: middle.CreatedAt, PostID: middle.ID})
		require.NoError(t, err)
		require.Len(t, rows, 2)
		for _, r := range rows {
			require.JSONEq(t, `{}`, string(r.Meta))
			require.Contains(t, string(r.Authors), user.Username)
		}
	})
}

func TestListAdjacentPostsTies(t *testing.T) {
	ctx := context.Background()
	user := createTestUser(t)
	postType := relatedTestPostType()
	same := time.Date(2026, 4, 1, 9, 0, 0, 0, time.UTC)

	// Three posts in the same instant: id orders them, so each has one neighbour on
	// each side and walking previous/next visits every post once.
	a := createRelatedTestPost(t, user, postType, "published", same)
	b := createRelatedTestPost(t, user, postType, "published", same)
	c := createRelatedTestPost(t, user, postType, "published", same)
	require.Less(t, a.ID, b.ID)
	require.Less(t, b.ID, c.ID)

	for _, tc := range []struct {
		post Post
		want map[string]int64
	}{
		{a, map[string]int64{"next": b.ID}},
		{b, map[string]int64{"previous": a.ID, "next": c.ID}},
		{c, map[string]int64{"previous": b.ID}},
	} {
		rows, err := testQueries.ListAdjacentPosts(ctx, ListAdjacentPostsParams{PostType: postType, CreatedAt: tc.post.CreatedAt, PostID: tc.post.ID})
		require.NoError(t, err)
		require.Equal(t, tc.want, adjacentByDirection(rows), "post %d", tc.post.ID)
	}
}

func TestListRelatedPosts(t *testing.T) {
	ctx := context.Background()
	user := createTestUser(t)
	postType := relatedTestPostType()
	base := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	at := func(h int) time.Time { return base.Add(time.Duration(h) * time.Hour) }

	cat := relatedTestTerm(t, "category")
	otherCat := relatedTestTerm(t, "category")
	tag1 := relatedTestTerm(t, "tag")
	tag2 := relatedTestTerm(t, "tag")

	current := createRelatedTestPost(t, user, postType, "published", at(0))
	tagPost(t, current, cat, tag1, tag2)

	// Ranking: the category outweighs any number of tags; then more tags; then newest.
	catOnly := createRelatedTestPost(t, user, postType, "published", at(1))
	tagPost(t, catOnly, cat)
	catAndTag := createRelatedTestPost(t, user, postType, "published", at(2))
	tagPost(t, catAndTag, cat, tag1)
	twoTags := createRelatedTestPost(t, user, postType, "published", at(3))
	tagPost(t, twoTags, tag1, tag2, otherCat)
	oneTagOld := createRelatedTestPost(t, user, postType, "published", at(4))
	tagPost(t, oneTagOld, tag2)
	oneTagNew := createRelatedTestPost(t, user, postType, "published", at(5))
	tagPost(t, oneTagNew, tag1)
	// Shares everything but is a draft, and one of another type: never related.
	draft := createRelatedTestPost(t, user, postType, "draft", at(6))
	tagPost(t, draft, cat, tag1, tag2)
	otherType := createRelatedTestPost(t, user, relatedTestPostType(), "published", at(7))
	tagPost(t, otherType, cat, tag1, tag2)
	// Shares nothing: only ever a fallback.
	unrelated := createRelatedTestPost(t, user, postType, "published", at(8))
	tagPost(t, unrelated, otherCat)

	relatedIn := func(p Post, limit int32, taxonomy string, termID int64, fallback bool) []ListRelatedPostsRow {
		rows, err := testQueries.ListRelatedPosts(ctx, ListRelatedPostsParams{
			PostType: postType, PostID: p.ID, LimitCount: limit, Taxonomy: taxonomy, TermID: termID, WithFallback: fallback,
		})
		require.NoError(t, err)
		return rows
	}
	related := func(p Post, limit int32, taxonomy string, fallback bool) []ListRelatedPostsRow {
		return relatedIn(p, limit, taxonomy, 0, fallback)
	}

	t.Run("ranks categories, then tags, then newest", func(t *testing.T) {
		rows := related(current, 10, "", true)
		require.Equal(t, []int64{catAndTag.ID, catOnly.ID, twoTags.ID, oneTagNew.ID, oneTagOld.ID, unrelated.ID}, relatedIDs(rows))
		require.EqualValues(t, 1, rows[0].SharedCategories)
		require.EqualValues(t, 1, rows[0].SharedTags)
		require.EqualValues(t, 0, rows[2].SharedCategories)
		require.EqualValues(t, 2, rows[2].SharedTags)
		require.EqualValues(t, 0, rows[5].SharedCategories+rows[5].SharedTags)
	})

	t.Run("limit keeps the top ones", func(t *testing.T) {
		require.Equal(t, []int64{catAndTag.ID, catOnly.ID, twoTags.ID}, relatedIDs(related(current, 3, "", true)))
	})

	t.Run("excludes the current post, drafts and other types", func(t *testing.T) {
		ids := relatedIDs(related(current, 50, "", true))
		require.NotContains(t, ids, current.ID)
		require.NotContains(t, ids, draft.ID)
		require.NotContains(t, ids, otherType.ID)
	})

	t.Run("taxonomy=category counts only categories, without fallback", func(t *testing.T) {
		rows := related(current, 10, "category", false)
		require.Equal(t, []int64{catAndTag.ID, catOnly.ID}, relatedIDs(rows))
		for _, r := range rows {
			require.Zero(t, r.SharedTags)
		}
	})

	t.Run("term_id counts only that term", func(t *testing.T) {
		// current has one category; a second one shared only by twoTags must not
		// put twoTags in the first category's list.
		tagPost(t, current, otherCat)
		t.Cleanup(func() {
			require.NoError(t, testQueries.RemovePostFromTaxonomyTerm(ctx, RemovePostFromTaxonomyTermParams{PostID: current.ID, TaxonomyTermID: otherCat.ID}))
		})
		require.Equal(t, []int64{catAndTag.ID, catOnly.ID}, relatedIDs(relatedIn(current, 10, "", cat.ID, false)))
		require.Equal(t, []int64{unrelated.ID, twoTags.ID}, relatedIDs(relatedIn(current, 10, "", otherCat.ID, false)))
	})

	t.Run("falls back to the latest posts when nothing shares a term", func(t *testing.T) {
		loner := createRelatedTestPost(t, user, postType, "published", at(9))
		// Newest first, and the latest-N candidates exclude the post itself.
		require.Equal(t, []int64{unrelated.ID, oneTagNew.ID, oneTagOld.ID}, relatedIDs(related(loner, 3, "", true)))
		require.Empty(t, related(loner, 3, "", false))
	})

	t.Run("fallback fills in after the posts sharing a term", func(t *testing.T) {
		// unrelated shares only otherCat, which twoTags has too.
		rows := related(unrelated, 3, "", true)
		require.Equal(t, twoTags.ID, rows[0].ID)
		require.Len(t, rows, 3)
		require.NotContains(t, relatedIDs(rows), unrelated.ID)
	})
}
