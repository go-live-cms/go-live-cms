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

func TestResolvePostSort(t *testing.T) {
	testCases := []struct {
		sort, order string
		want        postSort
		wantErr     error
	}{
		// Defaults
		{"", "", postSort{"created_at", "desc"}, nil},
		{"", "asc", postSort{"created_at", "asc"}, nil},
		// Columns with their default direction
		{"created_at", "", postSort{"created_at", "desc"}, nil},
		{"changed_at", "", postSort{"changed_at", "desc"}, nil},
		{"title", "", postSort{"title", "asc"}, nil},
		{"id", "", postSort{"id", "desc"}, nil},
		{"menu_order", "", postSort{"menu_order", "asc"}, nil},
		// Explicit order
		{"changed_at", "asc", postSort{"changed_at", "asc"}, nil},
		{"title", "desc", postSort{"title", "desc"}, nil},
		{"id", "asc", postSort{"id", "asc"}, nil},
		// Legacy combined values keep working
		{"date_asc", "", postSort{"created_at", "asc"}, nil},
		{"date_desc", "", postSort{"created_at", "desc"}, nil},
		{"title_desc", "", postSort{"title", "desc"}, nil},
		{"menu_order_desc", "", postSort{"menu_order", "desc"}, nil},
		{"id_asc", "", postSort{"id", "asc"}, nil},
		// An explicit order wins over the legacy suffix
		{"date_desc", "asc", postSort{"created_at", "asc"}, nil},
		// Rejected values
		{"type_asc", "", postSort{}, errInvalidPostSort},
		{"created_at_desc", "", postSort{}, errInvalidPostSort},
		{"date_sideways", "", postSort{}, errInvalidPostSort},
		{"_asc", "", postSort{}, errInvalidPostSort},
		{"title; DROP TABLE posts", "", postSort{}, errInvalidPostSort},
		{"Title", "", postSort{}, errInvalidPostSort},
		{"title", "up", postSort{}, errInvalidPostOrder},
		{"title", "DESC", postSort{}, errInvalidPostOrder},
		{"bogus", "bogus", postSort{}, errInvalidPostOrder},
	}

	for _, tc := range testCases {
		t.Run(tc.sort+"/"+tc.order, func(t *testing.T) {
			got, err := resolvePostSort(tc.sort, tc.order)
			if tc.wantErr != nil {
				require.ErrorIs(t, err, tc.wantErr)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.want, got)
		})
	}
}

// TestListPostsSortParams checks that /posts and /posts/type/:type pass the
// resolved sort to the store, echo it in meta, and 400 on bad values (the
// mock has no expectations then, so any store call fails the test).
func TestListPostsSortParams(t *testing.T) {
	postType := randomPostType("article")

	queries := []struct {
		name string
		url  func(query string) string
		// expect registers the store calls for a valid request.
		expect func(store *mockdb.MockStore, s postSort)
	}{
		{
			name: "List",
			url:  func(q string) string { return "/api/v1/posts" + q },
			expect: func(store *mockdb.MockStore, s postSort) {
				store.EXPECT().CountFilteredPosts(gomock.Any(), gomock.Any()).Return(int64(0), nil)
				store.EXPECT().
					ListPosts(gomock.Any(), db.ListPostsParams{
						UserID: int64(0), SortColumn: s.Column, SortDirection: s.Direction, LimitCount: 10,
					}).
					Return([]db.ListPostsRow{}, nil)
			},
		},
		{
			name: "ListWithAllMeta",
			url:  func(q string) string { return "/api/v1/posts" + appendQuery(q, "with_meta=true&meta_level=all") },
			expect: func(store *mockdb.MockStore, s postSort) {
				store.EXPECT().CountFilteredPosts(gomock.Any(), gomock.Any()).Return(int64(0), nil)
				store.EXPECT().
					ListPostsWithAllMeta(gomock.Any(), db.ListPostsWithAllMetaParams{
						UserID: int64(0), SortColumn: s.Column, SortDirection: s.Direction, LimitCount: 10,
					}).
					Return([]db.ListPostsWithAllMetaRow{}, nil)
			},
		},
		{
			name: "ByType",
			url:  func(q string) string { return "/api/v1/posts/type/" + postType.Name + q },
			expect: func(store *mockdb.MockStore, s postSort) {
				store.EXPECT().GetPostType(gomock.Any(), postType.Name).Return(postType, nil)
				store.EXPECT().
					ListPosts(gomock.Any(), db.ListPostsParams{
						PostType: postType.Name, UserID: int64(0), SortColumn: s.Column, SortDirection: s.Direction, LimitCount: 10,
					}).
					Return([]db.ListPostsRow{}, nil)
				store.EXPECT().CountPostsByTypeFiltered(gomock.Any(), gomock.Any()).Return(int64(0), nil)
			},
		},
		{
			name: "ByTypeWithMeta",
			url:  func(q string) string { return "/api/v1/posts/type/" + postType.Name + appendQuery(q, "with_meta=true") },
			expect: func(store *mockdb.MockStore, s postSort) {
				store.EXPECT().GetPostType(gomock.Any(), postType.Name).Return(postType, nil)
				store.EXPECT().
					ListPostsWithMeta(gomock.Any(), db.ListPostsWithMetaParams{
						PostType: postType.Name, UserID: int64(0), SortColumn: s.Column, SortDirection: s.Direction, LimitCount: 10,
					}).
					Return([]db.ListPostsWithMetaRow{}, nil)
				store.EXPECT().CountPostsByTypeFiltered(gomock.Any(), gomock.Any()).Return(int64(0), nil)
			},
		},
	}

	testCases := []struct {
		name   string
		query  string
		want   *postSort // nil: expect 400 with errMsg
		errMsg string
	}{
		{name: "Default", query: "", want: &postSort{"created_at", "desc"}},
		{name: "ChangedAtAsc", query: "?sort=changed_at&order=asc", want: &postSort{"changed_at", "asc"}},
		{name: "TitleDefaultAsc", query: "?sort=title", want: &postSort{"title", "asc"}},
		{name: "TitleDesc", query: "?sort=title&order=desc", want: &postSort{"title", "desc"}},
		{name: "IDAsc", query: "?sort=id&order=asc", want: &postSort{"id", "asc"}},
		{name: "OrderOnly", query: "?order=asc", want: &postSort{"created_at", "asc"}},
		{name: "LegacyDateAsc", query: "?sort=date_asc", want: &postSort{"created_at", "asc"}},
		{name: "LegacyOverriddenByOrder", query: "?sort=title_asc&order=desc", want: &postSort{"title", "desc"}},
		{name: "InvalidSort", query: "?sort=type_asc", errMsg: "invalid sort parameter"},
		{name: "InvalidSortInjection", query: "?sort=title%3BDROP%20TABLE%20posts", errMsg: "invalid sort parameter"},
		{name: "InvalidOrder", query: "?sort=title&order=sideways", errMsg: "invalid order parameter"},
	}

	for _, q := range queries {
		for _, tc := range testCases {
			t.Run(q.name+"/"+tc.name, func(t *testing.T) {
				store := mockdb.NewMockStore(gomock.NewController(t))
				if tc.want != nil {
					q.expect(store, *tc.want)
				}

				body, code := getJSON(t, store, q.url(tc.query))
				if tc.want == nil {
					require.Equal(t, http.StatusBadRequest, code)
					require.Equal(t, tc.errMsg, body.Error)
					return
				}
				require.Equal(t, http.StatusOK, code)
				require.Equal(t, tc.want.Column, body.Meta.Sort)
				require.Equal(t, tc.want.Direction, body.Meta.Order)
			})
		}
	}
}

// TestListPostsTotalMatchesFilters checks that meta.total is counted with the
// same filters as the list: user_id on /posts with a type, status on
// /posts/type/:type.
func TestListPostsTotalMatchesFilters(t *testing.T) {
	postType := randomPostType("article")

	t.Run("ListTypeAndAuthor", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().
			CountFilteredPosts(gomock.Any(), db.CountFilteredPostsParams{PostType: "post", UserID: int64(7)}).
			Return(int64(3), nil)
		store.EXPECT().ListPosts(gomock.Any(), gomock.Any()).Return([]db.ListPostsRow{}, nil)

		body, code := getJSON(t, store, "/api/v1/posts?type=post&user_id=7")
		require.Equal(t, http.StatusOK, code)
		require.Equal(t, int64(3), body.Meta.Total)
	})

	for _, withMeta := range []string{"false", "true"} {
		t.Run("ByTypeStatus/with_meta="+withMeta, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			store.EXPECT().GetPostType(gomock.Any(), postType.Name).Return(postType, nil)
			if withMeta == "true" {
				store.EXPECT().ListPostsWithMeta(gomock.Any(), gomock.Any()).Return([]db.ListPostsWithMetaRow{}, nil)
			} else {
				store.EXPECT().ListPosts(gomock.Any(), gomock.Any()).Return([]db.ListPostsRow{}, nil)
			}
			store.EXPECT().
				CountPostsByTypeFiltered(gomock.Any(), db.CountPostsByTypeFilteredParams{PostType: postType.Name, PostStatus: "published"}).
				Return(int64(5), nil)

			body, code := getJSON(t, store, "/api/v1/posts/type/"+postType.Name+"?status=published&with_meta="+withMeta)
			require.Equal(t, http.StatusOK, code)
			require.Equal(t, int64(5), body.Meta.Total)
		})
	}
}

type listPostsBody struct {
	Error string `json:"error"`
	Meta  struct {
		Sort  string `json:"sort"`
		Order string `json:"order"`
		Total int64  `json:"total"`
	} `json:"meta"`
}

// getJSON serves a GET through a test server backed by store.
func getJSON(t *testing.T, store *mockdb.MockStore, url string) (listPostsBody, int) {
	server := newTestServer(t, store)
	recorder := httptest.NewRecorder()
	request, err := http.NewRequest(http.MethodGet, url, nil)
	require.NoError(t, err)
	server.router.ServeHTTP(recorder, request)

	var body listPostsBody
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	return body, recorder.Code
}

// appendQuery adds extra to a query string that may be empty or start with "?".
func appendQuery(query, extra string) string {
	if query == "" {
		return "?" + extra
	}
	return query + "&" + extra
}
