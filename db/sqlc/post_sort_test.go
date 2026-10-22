package db

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// sortFixture is one post created for the ordering tests, with the values the
// sort columns are compared on.
type sortFixture struct {
	id        int64
	title     string
	menuOrder int32
	createdAt time.Time
	changedAt time.Time
}

// createSortFixtures inserts posts of a unique post type, owned by a fresh
// user, with deliberate ties on every sort column so the id tiebreaker is
// exercised. Timestamps are set directly because CreatePosts uses now().
func createSortFixtures(t *testing.T) (string, User, []sortFixture) {
	user := createTestUser(t)
	postType := fmt.Sprintf("sorttest-%d", time.Now().UnixNano())
	base := time.Date(2024, 1, 1, 12, 0, 0, 0, time.UTC)

	specs := []struct {
		title     string
		menuOrder int32
		created   time.Duration
		changed   time.Duration
	}{
		{"Bravo", 2, 0, 3 * time.Hour},
		{"Alpha", 1, time.Hour, time.Hour},
		{"Bravo", 2, time.Hour, 2 * time.Hour},
		{"Charlie", 0, 2 * time.Hour, time.Hour},
		{"Delta", 1, 0, 0},
	}

	fixtures := make([]sortFixture, 0, len(specs))
	for i, s := range specs {
		slug := fmt.Sprintf("%s-%d", postType, i)
		post, err := testQueries.CreatePosts(context.Background(), CreatePostsParams{
			Title:       s.title,
			Description: "sort fixture",
			UserID:      user.ID,
			Username:    user.Username,
			Url:         "https://example.com/" + slug,
			PostType:    postType,
			PostStatus:  "draft",
			MenuOrder:   s.menuOrder,
			Slug:        slug,
			BlockDoc:    json.RawMessage(`{}`),
		})
		require.NoError(t, err)

		created, changed := base.Add(s.created), base.Add(s.changed)
		_, err = testQueries.db.ExecContext(context.Background(),
			`UPDATE posts SET created_at = $1, changed_at = $2 WHERE id = $3`, created, changed, post.ID)
		require.NoError(t, err)

		fixtures = append(fixtures, sortFixture{post.ID, s.title, s.menuOrder, created, changed})
	}
	return postType, user, fixtures
}

// expectedOrder sorts fixtures the way the list queries should: by column in
// direction, then by id in the same direction.
func expectedOrder(fixtures []sortFixture, column, direction string) []int64 {
	sorted := append([]sortFixture(nil), fixtures...)
	cmp := func(a, b sortFixture) int {
		switch column {
		case "created_at":
			return a.createdAt.Compare(b.createdAt)
		case "changed_at":
			return a.changedAt.Compare(b.changedAt)
		case "title":
			// Capitalized ASCII titles sort the same under C and en_US collations.
			return strings.Compare(a.title, b.title)
		case "menu_order":
			return int(a.menuOrder) - int(b.menuOrder)
		}
		return 0
	}
	sort.SliceStable(sorted, func(i, j int) bool {
		c := cmp(sorted[i], sorted[j])
		if c == 0 {
			c = int(sorted[i].id - sorted[j].id)
		}
		if direction == "desc" {
			return c > 0
		}
		return c < 0
	})

	ids := make([]int64, len(sorted))
	for i, f := range sorted {
		ids[i] = f.id
	}
	return ids
}

func TestListPostsOrdering(t *testing.T) {
	postType, user, fixtures := createSortFixtures(t)
	ctx := context.Background()

	for _, column := range []string{"created_at", "changed_at", "title", "menu_order", "id"} {
		for _, direction := range []string{"asc", "desc"} {
			want := expectedOrder(fixtures, column, direction)

			t.Run(column+"_"+direction, func(t *testing.T) {
				rows, err := testQueries.ListPosts(ctx, ListPostsParams{
					PostType: postType, UserID: user.ID,
					SortColumn: column, SortDirection: direction, LimitCount: 10,
				})
				require.NoError(t, err)
				got := make([]int64, len(rows))
				for i, r := range rows {
					got[i] = r.ID
				}
				require.Equal(t, want, got, "ListPosts")

				byType, err := testQueries.ListPostsByType(ctx, ListPostsByTypeParams{
					PostType: postType, UserID: int64(0),
					SortColumn: column, SortDirection: direction, LimitCount: 10,
				})
				require.NoError(t, err)
				got = make([]int64, len(byType))
				for i, r := range byType {
					got[i] = r.ID
				}
				require.Equal(t, want, got, "ListPostsByType")

				withMeta, err := testQueries.ListPostsWithMeta(ctx, ListPostsWithMetaParams{
					PostType: postType, UserID: int64(0),
					SortColumn: column, SortDirection: direction, LimitCount: 10,
				})
				require.NoError(t, err)
				got = make([]int64, len(withMeta))
				for i, r := range withMeta {
					got[i] = r.ID
				}
				require.Equal(t, want, got, "ListPostsWithMeta")

				byTypeMeta, err := testQueries.ListPostsByTypeWithMeta(ctx, ListPostsByTypeWithMetaParams{
					PostType: postType, UserID: int64(0),
					SortColumn: column, SortDirection: direction, LimitCount: 10,
				})
				require.NoError(t, err)
				got = make([]int64, len(byTypeMeta))
				for i, r := range byTypeMeta {
					got[i] = r.ID
				}
				require.Equal(t, want, got, "ListPostsByTypeWithMeta")

				allMeta, err := testQueries.ListPostsWithAllMeta(ctx, ListPostsWithAllMetaParams{
					PostType: postType, UserID: int64(0),
					SortColumn: column, SortDirection: direction, LimitCount: 10,
				})
				require.NoError(t, err)
				got = make([]int64, len(allMeta))
				for i, r := range allMeta {
					got[i] = r.ID
				}
				require.Equal(t, want, got, "ListPostsWithAllMeta")

				byTypeAllMeta, err := testQueries.ListPostsByTypeWithAllMeta(ctx, ListPostsByTypeWithAllMetaParams{
					PostType: postType, UserID: int64(0),
					SortColumn: column, SortDirection: direction, LimitCount: 10,
				})
				require.NoError(t, err)
				got = make([]int64, len(byTypeAllMeta))
				for i, r := range byTypeAllMeta {
					got[i] = r.ID
				}
				require.Equal(t, want, got, "ListPostsByTypeWithAllMeta")
			})
		}
	}
}

// TestListPostsOrderingPagination checks that the id tiebreaker makes pages
// disjoint and complete even when every row ties on the sort column.
func TestListPostsOrderingPagination(t *testing.T) {
	postType, user, fixtures := createSortFixtures(t)
	ctx := context.Background()

	_, err := testQueries.db.ExecContext(ctx,
		`UPDATE posts SET created_at = $1 WHERE post_type = $2`, time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC), postType)
	require.NoError(t, err)

	for _, direction := range []string{"asc", "desc"} {
		var seen []int64
		for offset := int32(0); offset < int32(len(fixtures)); offset += 2 {
			rows, err := testQueries.ListPosts(ctx, ListPostsParams{
				PostType: postType, UserID: user.ID,
				SortColumn: "created_at", SortDirection: direction,
				OffsetCount: offset, LimitCount: 2,
			})
			require.NoError(t, err)
			for _, r := range rows {
				seen = append(seen, r.ID)
			}
		}

		want := make([]int64, len(fixtures))
		for i, f := range fixtures {
			want[i] = f.id
		}
		sort.Slice(want, func(i, j int) bool {
			if direction == "desc" {
				return want[i] > want[j]
			}
			return want[i] < want[j]
		})
		require.Equal(t, want, seen, direction)
	}
}

// TestListPostsWithMetaValues checks the per-row meta subquery (#131): a post
// with meta gets its key/value object, one without gets {}.
func TestListPostsWithMetaValues(t *testing.T) {
	postType, _, fixtures := createSortFixtures(t)
	ctx := context.Background()

	withMetaID := fixtures[0].id
	_, err := testQueries.db.ExecContext(ctx,
		`INSERT INTO post_meta (post_id, meta_key, meta_value) VALUES ($1, 'seo_title', 'Hello'), ($1, 'featured', 'yes')`, withMetaID)
	require.NoError(t, err)

	decode := func(raw interface{}) map[string]string {
		b, ok := raw.([]byte)
		require.True(t, ok, "meta should be jsonb bytes, got %T", raw)
		var m map[string]string
		require.NoError(t, json.Unmarshal(b, &m))
		return m
	}
	wantMeta := func(id int64) map[string]string {
		if id == withMetaID {
			return map[string]string{"seo_title": "Hello", "featured": "yes"}
		}
		return map[string]string{}
	}

	rows, err := testQueries.ListPostsByTypeWithMeta(ctx, ListPostsByTypeWithMetaParams{
		PostType: postType, UserID: int64(0), SortColumn: "id", SortDirection: "asc", LimitCount: 10,
	})
	require.NoError(t, err)
	require.Len(t, rows, len(fixtures))
	for _, r := range rows {
		require.Equal(t, wantMeta(r.ID), decode(r.Meta), "post %d", r.ID)
	}

	allRows, err := testQueries.ListPostsByTypeWithAllMeta(ctx, ListPostsByTypeWithAllMetaParams{
		PostType: postType, UserID: int64(0), SortColumn: "id", SortDirection: "asc", LimitCount: 10,
	})
	require.NoError(t, err)
	require.Len(t, allRows, len(fixtures))
	for _, r := range allRows {
		require.Equal(t, wantMeta(r.ID), decode(r.PostMeta), "post %d", r.ID)
		require.NotEmpty(t, r.AuthorMeta)
	}
}
