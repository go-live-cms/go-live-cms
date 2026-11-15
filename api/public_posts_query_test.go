package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The query loop's filters on GET /public/posts/type/:type (#489, public_posts_query.go): each
// one reaches the store as the published-terms, published-byline or sort parameter, the page
// size is capped at 24, and anything the route doesn't know is a 400 that reads nothing.

func TestPublicPostsQueryFilters(t *testing.T) {
	serve := func(t *testing.T, store *mockdb.MockStore, url string) *httptest.ResponseRecorder {
		t.Helper()
		server := newTestServer(t, store)
		recorder := httptest.NewRecorder()
		request, err := http.NewRequest(http.MethodGet, url, nil)
		require.NoError(t, err)
		server.router.ServeHTTP(recorder, request)
		return recorder
	}

	t.Run("every filter reaches the count and the page, the settings aren't read", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostType("post"), nil)
		store.EXPECT().CountFilteredPosts(gomock.Any(), db.CountFilteredPostsParams{
			PostType: "post", PostStatus: "published", PublishedTermIds: []int64{5, 3}, PublishedAuthorID: 9,
		}).Return(int64(7), nil)
		store.EXPECT().ListPostsWithMeta(gomock.Any(), db.ListPostsWithMetaParams{
			PostType: "post", PostStatus: "published",
			SortColumn: "published_title", SortDirection: "asc",
			PublishedTermIds: []int64{5, 3}, PublishedAuthorID: 9,
			OffsetCount: 3, LimitCount: 3, PublishedByline: true,
		}).Return(listRows(3), nil)

		recorder := serve(t, store, "/public/posts/type/post?page=2&per_page=3&order_by=title&order=asc&terms=5,3,5&author_id=9")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var body struct {
			Pagination pageInfo `json:"pagination"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		require.Equal(t, pageInfo{Page: 2, PerPage: 3, Total: 7, TotalPages: 3}, body.Pagination)
	})

	t.Run("per_page is capped at 24, and date newest first is the default order", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostType("post"), nil)
		store.EXPECT().CountFilteredPosts(gomock.Any(), db.CountFilteredPostsParams{PostType: "post", PostStatus: "published"}).Return(int64(30), nil)
		store.EXPECT().ListPostsWithMeta(gomock.Any(), db.ListPostsWithMetaParams{
			PostType: "post", PostStatus: "published", SortColumn: "created_at", SortDirection: "desc",
			LimitCount: 24, PublishedByline: true,
		}).Return(listRows(24), nil)

		recorder := serve(t, store, "/public/posts/type/post?per_page=500&order_by=date&order=desc")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Contains(t, recorder.Body.String(), `"per_page":24`)
	})

	for _, url := range []string{
		"/public/posts/type/post?per_page=0",
		"/public/posts/type/post?per_page=three",
		"/public/posts/type/post?per_page=-2",
		"/public/posts/type/post?order_by=post_status",
		"/public/posts/type/post?order_by=created_at",
		"/public/posts/type/post?order=up",
		"/public/posts/type/post?terms=",
		"/public/posts/type/post?terms=1,x",
		"/public/posts/type/post?terms=0",
		"/public/posts/type/post?terms=1,2,3,4,5,6,7,8,9,10,11",
		"/public/posts/type/post?author_id=0",
		"/public/posts/type/post?author_id=ana",
	} {
		t.Run("refused without a read: "+url, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			recorder := serve(t, store, url)
			require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
		})
	}
}

func TestParseTermIDList(t *testing.T) {
	ids, err := parseTermIDList(" 4, 2,4 ,9")
	require.NoError(t, err)
	require.Equal(t, []int64{4, 2, 9}, ids)
	// Ten distinct ids is the most; repeats don't count against it.
	ids, err = parseTermIDList("1,2,3,4,5,6,7,8,9,10,10")
	require.NoError(t, err)
	require.Len(t, ids, 10)
}

// #185: a query loop's read is cached like any /public list, keyed on every filter, so one
// query's posts are never served for another's.
func TestPublicCacheKeysOnEveryQueryFilter(t *testing.T) {
	key := func(target string) string {
		return publicCacheKeySuffix(httptest.NewRequest(http.MethodGet, target, nil))
	}
	base := "/public/posts/type/post?per_page=3"
	for _, other := range []string{
		"/public/posts/type/post?per_page=4",
		"/public/posts/type/page?per_page=3",
		base + "&page=2",
		base + "&order_by=title",
		base + "&order=asc",
		base + "&terms=3",
		base + "&terms=3,4",
		base + "&author_id=9",
	} {
		require.NotEqual(t, key(base), key(other), other)
	}

	store := mockdb.NewMockStore(gomock.NewController(t))
	store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostType("post"), nil).Times(2)
	store.EXPECT().CountFilteredPosts(gomock.Any(), gomock.Any()).Return(int64(1), nil).Times(2)
	store.EXPECT().ListPostsWithMeta(gomock.Any(), gomock.Any()).Return(listRows(1), nil).Times(2)
	server := newTestServer(t, store)
	mr := withMiniredis(t, server)

	require.Equal(t, "MISS", cacheGet(t, server, base+"&author_id=9").Header().Get(publicCacheHeader))
	require.Equal(t, "HIT", cacheGet(t, server, base+"&author_id=9").Header().Get(publicCacheHeader))
	require.Equal(t, "MISS", cacheGet(t, server, base+"&author_id=10").Header().Get(publicCacheHeader))
	require.Equal(t, 2, publicCacheEntries(mr))
}
