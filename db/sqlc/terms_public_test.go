package db

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// createPublicTaxonomy registers a taxonomy type with the given visibility.
func createPublicTaxonomy(t *testing.T, public, hierarchical bool) TaxonomyType {
	t.Helper()
	tt, err := testQueries.CreateTaxonomyType(context.Background(), CreateTaxonomyTypeParams{
		Name:         fmt.Sprintf("termtest_%d", time.Now().UnixNano()),
		Label:        "Term tests",
		Hierarchical: hierarchical,
		Public:       public,
		ShowUi:       true,
		ShowInMenu:   true,
	})
	require.NoError(t, err)
	return tt
}

func setCreatedAt(t *testing.T, post Post, ago time.Duration) {
	t.Helper()
	_, err := testQueries.db.ExecContext(context.Background(), `UPDATE posts SET created_at = $2 WHERE id = $1`, post.ID, time.Now().Add(-ago))
	require.NoError(t, err)
}

func TestGetPublicTerm(t *testing.T) {
	ctx := context.Background()
	public := createPublicTaxonomy(t, true, true)
	private := createPublicTaxonomy(t, false, true)
	term := createChildTerm(t, public.ID, "guides", nil, 0)
	hidden := createChildTerm(t, private.ID, "hidden", nil, 0)

	row, err := testQueries.GetPublicTerm(ctx, GetPublicTermParams{Taxonomy: public.Name, Slug: term.Slug})
	require.NoError(t, err)
	require.Equal(t, term.ID, row.ID)
	require.Equal(t, public.Name, row.TaxonomyName)
	require.Equal(t, public.Label, row.TaxonomyLabel)
	require.True(t, row.Hierarchical)

	// A non-public taxonomy's term, a slug under another taxonomy's URL and an
	// unknown slug all have no page.
	for _, arg := range []GetPublicTermParams{
		{Taxonomy: private.Name, Slug: hidden.Slug},
		{Taxonomy: public.Name, Slug: hidden.Slug},
		{Taxonomy: private.Name, Slug: term.Slug},
		{Taxonomy: public.Name, Slug: "nothing-" + fmt.Sprint(time.Now().UnixNano())},
	} {
		_, err := testQueries.GetPublicTerm(ctx, arg)
		require.ErrorIs(t, err, sql.ErrNoRows, "%+v", arg)
	}
}

// A parent's archive lists its children's and grandchildren's posts too, once
// each, newest first; drafts and posts of private or inactive types never.
func TestListPublishedPostsByTerm(t *testing.T) {
	ctx := context.Background()
	taxonomy := createPublicTaxonomy(t, true, true)
	publicType := createAuthorPostType(t, true, true)
	privateType := createAuthorPostType(t, false, true)
	inactiveType := createAuthorPostType(t, true, false)
	owner := createTestUser(t)

	parent := createChildTerm(t, taxonomy.ID, "parent", nil, 0)
	child := createChildTerm(t, taxonomy.ID, "child", &parent, 0)
	grandchild := createChildTerm(t, taxonomy.ID, "grandchild", &child, 0)
	sibling := createChildTerm(t, taxonomy.ID, "sibling", nil, 0)

	inParent := createCreditedPost(t, publicType, "published", owner, owner)
	inChild := createCreditedPost(t, publicType, "published", owner, owner)
	inGrandchild := createCreditedPost(t, publicType, "published", owner, owner)
	inBoth := createCreditedPost(t, publicType, "published", owner, owner)
	inSibling := createCreditedPost(t, publicType, "published", owner, owner)
	draft := createCreditedPost(t, publicType, "draft", owner, owner)
	archived := createCreditedPost(t, publicType, "archived", owner, owner)
	private := createCreditedPost(t, privateType, "published", owner, owner)
	inactive := createCreditedPost(t, inactiveType, "published", owner, owner)

	tagPost(t, inParent, parent)
	tagPost(t, inChild, child)
	tagPost(t, inGrandchild, grandchild)
	tagPost(t, inBoth, parent, child)
	tagPost(t, inSibling, sibling)
	tagPost(t, draft, parent)
	tagPost(t, archived, child)
	tagPost(t, private, parent)
	tagPost(t, inactive, child)

	setCreatedAt(t, inParent, 4*time.Hour)
	setCreatedAt(t, inChild, 3*time.Hour)
	setCreatedAt(t, inGrandchild, 2*time.Hour)
	setCreatedAt(t, inBoth, time.Hour)

	ids := func(term TaxonomyTerm, limit, offset int32) []int64 {
		rows, err := testQueries.ListPublishedPostsByTerm(ctx, ListPublishedPostsByTermParams{TermID: term.ID, LimitCount: limit, OffsetCount: offset})
		require.NoError(t, err)
		out := make([]int64, len(rows))
		for i, row := range rows {
			out[i] = row.ID
			require.Equal(t, "published", row.PostStatus)
		}
		return out
	}
	count := func(term TaxonomyTerm) int64 {
		n, err := testQueries.CountPublishedPostsByTerm(ctx, term.ID)
		require.NoError(t, err)
		return n
	}

	require.Equal(t, []int64{inBoth.ID, inGrandchild.ID, inChild.ID, inParent.ID}, ids(parent, 10, 0))
	require.Equal(t, int64(4), count(parent))
	require.Equal(t, []int64{inBoth.ID, inGrandchild.ID, inChild.ID}, ids(child, 10, 0))
	require.Equal(t, int64(3), count(child))
	require.Equal(t, []int64{inGrandchild.ID}, ids(grandchild, 10, 0))
	require.Equal(t, int64(1), count(grandchild))
	require.Equal(t, []int64{inSibling.ID}, ids(sibling, 10, 0))

	// Pages.
	require.Equal(t, []int64{inGrandchild.ID, inChild.ID}, ids(parent, 2, 1))
	require.Empty(t, ids(parent, 2, 4))

	// The byline comes along like ListPostsWithMeta's.
	rows, err := testQueries.ListPublishedPostsByTerm(ctx, ListPublishedPostsByTermParams{TermID: grandchild.ID, LimitCount: 1})
	require.NoError(t, err)
	require.Contains(t, string(rows[0].Authors), owner.Username)
	require.NotContains(t, string(rows[0].Authors), "email")

	empty := createChildTerm(t, taxonomy.ID, "empty", nil, 0)
	require.Empty(t, ids(empty, 10, 0))
	require.Equal(t, int64(0), count(empty))
}

// A parent cycle (the admin refuses one, but nothing in the schema does) still
// ends: UNION drops the repeated ids.
func TestListPublishedPostsByTermCycle(t *testing.T) {
	ctx := context.Background()
	taxonomy := createPublicTaxonomy(t, true, true)
	publicType := createAuthorPostType(t, true, true)
	owner := createTestUser(t)
	a := createChildTerm(t, taxonomy.ID, "cycle-a", nil, 0)
	b := createChildTerm(t, taxonomy.ID, "cycle-b", &a, 0)
	_, err := testQueries.db.ExecContext(ctx, `UPDATE taxonomy_terms SET parent_id = $2 WHERE id = $1`, a.ID, b.ID)
	require.NoError(t, err)
	post := createCreditedPost(t, publicType, "published", owner, owner)
	tagPost(t, post, b)

	n, err := testQueries.CountPublishedPostsByTerm(ctx, a.ID)
	require.NoError(t, err)
	require.Equal(t, int64(1), n)
}

func TestListPublicTerms(t *testing.T) {
	ctx := context.Background()
	taxonomy := createPublicTaxonomy(t, true, true)
	private := createPublicTaxonomy(t, false, false)
	publicType := createAuthorPostType(t, true, true)
	owner := createTestUser(t)

	parent := createChildTerm(t, taxonomy.ID, "sm-parent", nil, 0)
	child := createChildTerm(t, taxonomy.ID, "sm-child", &parent, 0)
	draftsOnly := createChildTerm(t, taxonomy.ID, "sm-drafts", nil, 0)
	empty := createChildTerm(t, taxonomy.ID, "sm-empty", nil, 0)
	hidden := createChildTerm(t, private.ID, "sm-hidden", nil, 0)

	published := createCreditedPost(t, publicType, "published", owner, owner)
	tagPost(t, published, child, hidden)
	draft := createCreditedPost(t, publicType, "draft", owner, owner)
	tagPost(t, draft, draftsOnly)

	rows, err := testQueries.ListPublicTerms(ctx, ListPublicTermsParams{LimitCount: 100000})
	require.NoError(t, err)
	got := map[string]ListPublicTermsRow{}
	for _, row := range rows {
		got[row.Slug] = row
	}
	// The parent has a page through its child's post.
	require.Contains(t, got, parent.Slug)
	require.Contains(t, got, child.Slug)
	require.Equal(t, taxonomy.Name, got[parent.Slug].TaxonomyName)
	require.False(t, got[parent.Slug].LastModified.IsZero())
	require.NotContains(t, got, draftsOnly.Slug)
	require.NotContains(t, got, empty.Slug)
	require.NotContains(t, got, hidden.Slug)
}
