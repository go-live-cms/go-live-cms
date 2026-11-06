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

// #331 (000047): one category per post, the default category, merges and redirects,
// against the real database.

func categoryType(t *testing.T) TaxonomyType {
	t.Helper()
	category, err := testQueries.GetTaxonomyType(context.Background(), CategoryTaxonomy)
	require.NoError(t, err)
	require.True(t, category.DefaultTermID.Valid, "000047 sets the default category")
	return category
}

func newTerm331(t *testing.T, taxonomy string) TaxonomyTerm {
	t.Helper()
	ty, err := testQueries.GetTaxonomyType(context.Background(), taxonomy)
	require.NoError(t, err)
	return createTestTaxonomyTerm(t, ty.ID)
}

// postCategoryIDs is a post's working categories (one, since 000047).
func postCategoryIDs(t *testing.T, postID int64) []int64 {
	t.Helper()
	terms, err := testQueries.GetPostTaxonomyTerms(context.Background(), postID)
	require.NoError(t, err)
	ids := []int64{}
	for _, term := range terms {
		if term.TaxonomyTypeName == CategoryTaxonomy {
			ids = append(ids, term.ID)
		}
	}
	return ids
}

func publishedSettingsTermIDs(t *testing.T, postID int64) []int64 {
	t.Helper()
	post, err := testQueries.GetPost(context.Background(), postID)
	require.NoError(t, err)
	require.True(t, post.PublishedSettings.Valid)
	var settings struct {
		TermIDs []int64 `json:"term_ids"`
	}
	require.NoError(t, json.Unmarshal(post.PublishedSettings.RawMessage, &settings))
	return settings.TermIDs
}

func TestDefaultCategoryAndOneCategoryPerPost(t *testing.T) {
	ctx := context.Background()
	category := categoryType(t)
	defaultID := category.DefaultTermID.Int64

	_, created := createTestUserWithPosts(t)
	post := created.Post
	require.Equal(t, []int64{defaultID}, postCategoryIDs(t, post.ID), "a new post starts in the default category")

	news := newTerm331(t, CategoryTaxonomy)
	guides := newTerm331(t, CategoryTaxonomy)
	tag := newTerm331(t, "tag")

	result, err := testStore.SetPostTermTx(ctx, SetPostTermTxParams{PostID: post.ID, TermID: news.ID})
	require.NoError(t, err)
	require.Equal(t, []int64{defaultID}, result.ReplacedTermIDs)
	require.Equal(t, []int64{news.ID}, postCategoryIDs(t, post.ID))

	result, err = testStore.SetPostTermTx(ctx, SetPostTermTxParams{PostID: post.ID, TermID: guides.ID})
	require.NoError(t, err)
	require.Equal(t, []int64{news.ID}, result.ReplacedTermIDs, "a category replaces the post's category")
	require.Equal(t, []int64{guides.ID}, postCategoryIDs(t, post.ID))

	// A tag leaves the category alone, and assigning again is a no-op.
	result, err = testStore.SetPostTermTx(ctx, SetPostTermTxParams{PostID: post.ID, TermID: tag.ID})
	require.NoError(t, err)
	require.Empty(t, result.ReplacedTermIDs)
	_, err = testStore.SetPostTermTx(ctx, SetPostTermTxParams{PostID: post.ID, TermID: guides.ID})
	require.NoError(t, err)
	require.Equal(t, []int64{guides.ID}, postCategoryIDs(t, post.ID))

	// Any other writer of a second category is refused (the trigger).
	_, err = testQueries.AddPostToTaxonomyTerm(ctx, AddPostToTaxonomyTermParams{PostID: post.ID, TaxonomyTermID: news.ID})
	require.Error(t, err)
	require.True(t, IsUniqueViolation(err), err)

	// Removing the category puts the default back; removing the default keeps it.
	restored, err := testStore.RemovePostTermTx(ctx, SetPostTermTxParams{PostID: post.ID, TermID: guides.ID})
	require.NoError(t, err)
	require.Equal(t, defaultID, restored)
	require.Equal(t, []int64{defaultID}, postCategoryIDs(t, post.ID))
	restored, err = testStore.RemovePostTermTx(ctx, SetPostTermTxParams{PostID: post.ID, TermID: defaultID})
	require.NoError(t, err)
	require.Equal(t, defaultID, restored)
	require.Equal(t, []int64{defaultID}, postCategoryIDs(t, post.ID))

	// Replacing the whole set without a category: the default; with one: that one.
	require.NoError(t, testStore.UpdatePostTaxonomyTermsTx(ctx, UpdatePostTaxonomyTermsTxParams{PostID: post.ID, TaxonomyTermIDs: []int64{tag.ID}}))
	require.Equal(t, []int64{defaultID}, postCategoryIDs(t, post.ID))
	require.NoError(t, testStore.UpdatePostTaxonomyTermsTx(ctx, UpdatePostTaxonomyTermsTxParams{PostID: post.ID, TaxonomyTermIDs: []int64{news.ID, tag.ID}}))
	require.Equal(t, []int64{news.ID}, postCategoryIDs(t, post.ID))

	count, err := testQueries.CountCategoryTerms(ctx, []int64{news.ID, guides.ID, tag.ID})
	require.NoError(t, err)
	require.EqualValues(t, 2, count)

	// Pages may have no category.
	page := createRelatedTestPost(t, createTestUser(t), "page", "draft", time.Now())
	added, err := testQueries.EnsureDefaultCategory(ctx, []int64{page.ID})
	require.NoError(t, err)
	require.Zero(t, added)
	require.Empty(t, postCategoryIDs(t, page.ID))
}

func TestRestoringOldSettingsKeepsOneCategory(t *testing.T) {
	ctx := context.Background()
	_, created := createTestUserWithPosts(t)
	a, b := newTerm331(t, CategoryTaxonomy), newTerm331(t, CategoryTaxonomy)
	tag := newTerm331(t, "tag")
	require.NoError(t, testQueries.RemoveAllPostTaxonomies(ctx, created.Post.ID))

	// A version from before #331 may name two categories: the lowest id stays.
	require.NoError(t, testQueries.AddExistingTermsToPost(ctx, AddExistingTermsToPostParams{
		PostID: created.Post.ID, TermIds: []int64{b.ID, a.ID, tag.ID},
	}))
	require.Equal(t, []int64{a.ID}, postCategoryIDs(t, created.Post.ID))
}

func TestDeleteCategoryMovesPostsToDefault(t *testing.T) {
	ctx := context.Background()
	category := categoryType(t)
	defaultID := category.DefaultTermID.Int64

	user, created := createTestUserWithPosts(t)
	gone := newTerm331(t, CategoryTaxonomy)
	_, err := testStore.SetPostTermTx(ctx, SetPostTermTxParams{PostID: created.Post.ID, TermID: gone.ID})
	require.NoError(t, err)
	_, err = testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: created.Post.ID, CreatedBy: nullID(user.ID)})
	require.NoError(t, err)
	require.Contains(t, publishedSettingsTermIDs(t, created.Post.ID), gone.ID)

	require.NoError(t, testStore.DeleteTaxonomyTermTx(ctx, gone.ID))
	require.Equal(t, []int64{defaultID}, postCategoryIDs(t, created.Post.ID))
	published := publishedSettingsTermIDs(t, created.Post.ID)
	require.Contains(t, published, defaultID, "the site shows the default category at once")
	require.NotContains(t, published, gone.ID)
	require.Contains(t, publishedTermIDs(t, created.Post.ID), defaultID)

	state, err := testQueries.GetPostSettingsState(ctx, created.Post.ID)
	require.NoError(t, err)
	require.False(t, state.HasUnpublishedChanges, "a taxonomy operation isn't a pending change")

	require.ErrorIs(t, testStore.DeleteTaxonomyTermTx(ctx, defaultID), ErrDefaultTerm)
	// The foreign key refuses it too.
	require.Error(t, testQueries.DeleteTaxonomyTerm(ctx, defaultID))
}

func TestMergeTaxonomyTermsTx(t *testing.T) {
	ctx := context.Background()
	user, first := createTestUserWithPosts(t)
	_, second := createTestUserWithPosts(t)
	photos, images, other := newTerm331(t, "tag"), newTerm331(t, "tag"), newTerm331(t, "tag")

	for _, link := range []SetPostTermTxParams{
		{PostID: first.Post.ID, TermID: photos.ID},
		{PostID: second.Post.ID, TermID: photos.ID},
		{PostID: second.Post.ID, TermID: images.ID}, // has both
	} {
		_, err := testStore.SetPostTermTx(ctx, link)
		require.NoError(t, err)
	}
	_, err := testStore.PublishPostTx(ctx, PublishPostTxParams{PostID: first.Post.ID, CreatedBy: nullID(user.ID)})
	require.NoError(t, err)

	suffix := time.Now().UnixNano()
	from, to := fmt.Sprintf("/tag/photos-%d", suffix), fmt.Sprintf("/tag/images-%d", suffix)
	result, err := testStore.MergeTaxonomyTermsTx(ctx, MergeTaxonomyTermsTxParams{
		TargetID:  images.ID,
		SourceIDs: []int64{photos.ID, photos.ID},
		Redirects: []*AddRedirectParams{{FromPath: from, ToPath: to, StatusCode: 301, Source: RedirectSourceMerge, CreatedBy: user.ID}},
	})
	require.NoError(t, err)
	require.Equal(t, []int64{photos.ID}, result.MergedIDs)
	require.EqualValues(t, 2, result.MovedPosts)
	require.Len(t, result.Redirects, 1)

	_, err = testQueries.GetTaxonomyTerm(ctx, photos.ID)
	require.Error(t, err, "the source is deleted")
	for _, postID := range []int64{first.Post.ID, second.Post.ID} {
		terms, err := testQueries.GetPostTaxonomyTerms(ctx, postID)
		require.NoError(t, err)
		ids := []int64{}
		for _, term := range terms {
			if term.TaxonomyTypeName == "tag" {
				ids = append(ids, term.ID)
			}
		}
		require.Equal(t, []int64{images.ID}, ids)
	}
	published := publishedSettingsTermIDs(t, first.Post.ID)
	require.Contains(t, published, images.ID)
	require.NotContains(t, published, photos.ID)
	state, err := testQueries.GetPostSettingsState(ctx, first.Post.ID)
	require.NoError(t, err)
	require.False(t, state.HasUnpublishedChanges)

	redirect, err := testQueries.GetRedirectByFromPath(ctx, from)
	require.NoError(t, err)
	require.Equal(t, to, redirect.ToPath)
	require.Equal(t, RedirectSourceMerge, redirect.Source)

	_, err = testStore.MergeTaxonomyTermsTx(ctx, MergeTaxonomyTermsTxParams{TargetID: images.ID, SourceIDs: []int64{images.ID}})
	require.ErrorIs(t, err, ErrMergeSource)
	_, err = testStore.MergeTaxonomyTermsTx(ctx, MergeTaxonomyTermsTxParams{TargetID: images.ID, SourceIDs: []int64{newTerm331(t, CategoryTaxonomy).ID}})
	require.ErrorIs(t, err, ErrMergeSource)
	category := categoryType(t)
	_, err = testStore.MergeTaxonomyTermsTx(ctx, MergeTaxonomyTermsTxParams{TargetID: newTerm331(t, CategoryTaxonomy).ID, SourceIDs: []int64{category.DefaultTermID.Int64}})
	require.ErrorIs(t, err, ErrDefaultTerm)
	_, err = testQueries.GetTaxonomyTerm(ctx, other.ID)
	require.NoError(t, err, "a failed merge changes nothing")
}

func TestRedirectChainsCollapse(t *testing.T) {
	ctx := context.Background()
	p := func(name string) string { return fmt.Sprintf("/r%d/%s", time.Now().UnixNano(), name) }
	a, b, c := p("a"), p("b"), p("c")
	target := func(from string) string {
		t.Helper()
		r, err := testQueries.GetRedirectByFromPath(ctx, from)
		require.NoError(t, err)
		return r.ToPath
	}
	gone := func(from string) {
		t.Helper()
		_, err := testQueries.GetRedirectByFromPath(ctx, from)
		require.Error(t, err)
	}
	add := func(from, to, source string) (Redirect, error) {
		return testStore.AddRedirectTx(ctx, AddRedirectParams{FromPath: from, ToPath: to, StatusCode: 301, Source: source})
	}

	// A post renamed a → b → c: one hop from each old URL.
	_, err := add(a, b, RedirectSourcePost)
	require.NoError(t, err)
	_, err = add(b, c, RedirectSourcePost)
	require.NoError(t, err)
	require.Equal(t, c, target(a))
	require.Equal(t, c, target(b))

	// Renamed back to a: a is live again, so nothing redirects from it, and no loop.
	_, err = add(c, a, RedirectSourcePost)
	require.NoError(t, err)
	gone(a)
	require.Equal(t, a, target(b))
	require.Equal(t, a, target(c))

	// Manual: to a path that redirects goes where it goes; a loop is refused.
	d := p("d")
	r, err := add(d, b, RedirectSourceManual)
	require.NoError(t, err)
	require.Equal(t, a, r.ToPath)
	_, err = add(a, d, RedirectSourceManual)
	require.ErrorIs(t, err, ErrRedirectLoop)
	_, err = add(d, "https://example.com/elsewhere", RedirectSourceManual)
	require.ErrorIs(t, err, ErrRedirectExists)

	// Manual a → d (a 302 elsewhere) would make d → a → ... : collapse keeps one hop.
	e := p("e")
	_, err = add(e, "https://example.com/x", RedirectSourceManual)
	require.NoError(t, err)
	_, err = add(a, e, RedirectSourceManual)
	require.NoError(t, err)
	require.Equal(t, "https://example.com/x", target(a))
	require.Equal(t, "https://example.com/x", target(b))
	require.Equal(t, "https://example.com/x", target(d))
}

func nullID(id int64) sql.NullInt64 { return sql.NullInt64{Int64: id, Valid: true} }
