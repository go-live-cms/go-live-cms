package devModeUtil

import (
	"encoding/json"
	"errors"
	"testing"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/golang/mock/gomock"
	"github.com/lib/pq"
	"github.com/stretchr/testify/require"
)

func TestSeedSlug(t *testing.T) {
	cases := map[string]string{
		"Getting Started with Go Programming":   "getting-started-with-go-programming",
		"CSS Grid vs Flexbox: When to Use What": "css-grid-vs-flexbox-when-to-use-what",
		"  About   Us!  ":                       "about-us",
	}
	for in, want := range cases {
		require.Equal(t, want, seedSlug(in))
	}
}

func TestGenerateDummyBlockDoc(t *testing.T) {
	var doc struct {
		DocVersion  int                               `json:"doc_version"`
		BlocksOrder []string                          `json:"blocks_order"`
		Blocks      map[string]map[string]interface{} `json:"blocks"`
	}
	require.NoError(t, json.Unmarshal(generateDummyBlockDoc("My Title"), &doc))
	require.Equal(t, 1, doc.DocVersion)
	require.NotEmpty(t, doc.BlocksOrder)
	require.Len(t, doc.Blocks, len(doc.BlocksOrder))

	seen := map[string]bool{}
	for _, id := range doc.BlocksOrder {
		require.False(t, seen[id], "duplicate block id %s", id)
		seen[id] = true
		block, ok := doc.Blocks[id]
		require.True(t, ok, "block %s missing", id)
		require.Equal(t, id, block["id"])
		require.GreaterOrEqual(t, len(id), 10)
		require.EqualValues(t, 1, block["version"])
		attrs := block["attrs"].(map[string]interface{})
		require.NotEmpty(t, attrs["text"])
	}
	require.Equal(t, "heading", doc.Blocks[doc.BlocksOrder[0]]["type"])
}

func TestCreateSeedPostRetriesOnSlugConflict(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	store := mockdb.NewMockStore(ctrl)

	slugErr := &pq.Error{Code: "23505", Constraint: "idx_posts_slug"}
	var slugs []string
	store.EXPECT().CreatePosts(gomock.Any(), gomock.Any()).Times(2).
		DoAndReturn(func(_ interface{}, p db.CreatePostsParams) (db.Post, error) {
			slugs = append(slugs, p.Slug)
			if len(slugs) == 1 {
				return db.Post{}, slugErr
			}
			return db.Post{ID: 7}, nil
		})
	store.EXPECT().SetPublishedVersionOnPost(gomock.Any(), gomock.Any()).Times(1).Return(nil)

	post, err := createSeedPost(store, db.CreatePostsParams{Slug: "contact", BlockDoc: generateDummyBlockDoc("Contact")})
	require.NoError(t, err)
	require.EqualValues(t, 7, post.ID)
	require.Equal(t, []string{"contact", "contact-2"}, slugs)
}

func TestCreateSeedPostDoesNotRetryOtherErrors(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	store := mockdb.NewMockStore(ctrl)

	store.EXPECT().CreatePosts(gomock.Any(), gomock.Any()).Times(1).Return(db.Post{}, errors.New("boom"))

	_, err := createSeedPost(store, db.CreatePostsParams{Slug: "x"})
	require.Error(t, err)
}
