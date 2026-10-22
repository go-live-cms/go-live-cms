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
// resolved sort to the store, echo it in meta, and 400 on bad values.
func TestListPostsSortParams(t *testing.T) {
	postType := randomPostType("article")

	type expectation struct {
		column, direction string
	}

	testCases := []struct {
		name   string
		query  string
		want   *expectation // nil: expect 400
		errMsg string
	}{
		{name: "Default", query: "", want: &expectation{"created_at", "desc"}},
		{name: "ChangedAtAsc", query: "?sort=changed_at&order=asc", want: &expectation{"changed_at", "asc"}},
		{name: "TitleDefaultAsc", query: "?sort=title", want: &expectation{"title", "asc"}},
		{name: "TitleDesc", query: "?sort=title&order=desc", want: &expectation{"title", "desc"}},
		{name: "IDAsc", query: "?sort=id&order=asc", want: &expectation{"id", "asc"}},
		{name: "OrderOnly", query: "?order=asc", want: &expectation{"created_at", "asc"}},
		{name: "LegacyDateAsc", query: "?sort=date_asc", want: &expectation{"created_at", "asc"}},
		{name: "LegacyOverriddenByOrder", query: "?sort=title_asc&order=desc", want: &expectation{"title", "desc"}},
		{name: "InvalidSort", query: "?sort=type_asc", errMsg: "invalid sort parameter"},
		{name: "InvalidSortInjection", query: "?sort=title%3BDROP%20TABLE%20posts", errMsg: "invalid sort parameter"},
		{name: "InvalidOrder", query: "?sort=title&order=sideways", errMsg: "invalid order parameter"},
	}

	checkResponse := func(t *testing.T, recorder *httptest.ResponseRecorder, want *expectation, errMsg string) {
		var body struct {
			Error string `json:"error"`
			Meta  struct {
				Sort  string `json:"sort"`
				Order string `json:"order"`
			} `json:"meta"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		if want == nil {
			require.Equal(t, http.StatusBadRequest, recorder.Code)
			require.Equal(t, errMsg, body.Error)
			return
		}
		require.Equal(t, http.StatusOK, recorder.Code)
		require.Equal(t, want.column, body.Meta.Sort)
		require.Equal(t, want.direction, body.Meta.Order)
	}

	run := func(t *testing.T, url string, buildStubs func(store *mockdb.MockStore), want *expectation, errMsg string) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		buildStubs(store)

		server := newTestServer(t, store)
		recorder := httptest.NewRecorder()
		request, err := http.NewRequest(http.MethodGet, url, nil)
		require.NoError(t, err)
		server.router.ServeHTTP(recorder, request)
		checkResponse(t, recorder, want, errMsg)
	}

	for _, tc := range testCases {
		t.Run("List/"+tc.name, func(t *testing.T) {
			run(t, "/api/v1/posts"+tc.query, func(store *mockdb.MockStore) {
				if tc.want == nil {
					store.EXPECT().CountFilteredPosts(gomock.Any(), gomock.Any()).Times(0)
					store.EXPECT().ListPosts(gomock.Any(), gomock.Any()).Times(0)
					return
				}
				store.EXPECT().CountFilteredPosts(gomock.Any(), gomock.Any()).Times(1).Return(int64(0), nil)
				store.EXPECT().
					ListPosts(gomock.Any(), db.ListPostsParams{
						UserID:        int64(0),
						SortColumn:    tc.want.column,
						SortDirection: tc.want.direction,
						LimitCount:    10,
					}).
					Times(1).
					Return([]db.ListPostsRow{}, nil)
			}, tc.want, tc.errMsg)
		})

		t.Run("ListWithMeta/"+tc.name, func(t *testing.T) {
			run(t, "/api/v1/posts"+appendQuery(tc.query, "with_meta=true&meta_level=all"), func(store *mockdb.MockStore) {
				if tc.want == nil {
					store.EXPECT().ListPostsWithAllMeta(gomock.Any(), gomock.Any()).Times(0)
					return
				}
				store.EXPECT().CountFilteredPosts(gomock.Any(), gomock.Any()).Times(1).Return(int64(0), nil)
				store.EXPECT().
					ListPostsWithAllMeta(gomock.Any(), db.ListPostsWithAllMetaParams{
						UserID:        int64(0),
						SortColumn:    tc.want.column,
						SortDirection: tc.want.direction,
						LimitCount:    10,
					}).
					Times(1).
					Return([]db.ListPostsWithAllMetaRow{}, nil)
			}, tc.want, tc.errMsg)
		})

		t.Run("ByType/"+tc.name, func(t *testing.T) {
			run(t, "/api/v1/posts/type/"+postType.Name+tc.query, func(store *mockdb.MockStore) {
				if tc.want == nil {
					store.EXPECT().GetPostType(gomock.Any(), gomock.Any()).Times(0)
					store.EXPECT().ListPostsByType(gomock.Any(), gomock.Any()).Times(0)
					return
				}
				store.EXPECT().GetPostType(gomock.Any(), postType.Name).Times(1).Return(postType, nil)
				store.EXPECT().
					ListPostsByType(gomock.Any(), db.ListPostsByTypeParams{
						PostType:      postType.Name,
						UserID:        int64(0),
						SortColumn:    tc.want.column,
						SortDirection: tc.want.direction,
						LimitCount:    10,
					}).
					Times(1).
					Return([]db.Post{}, nil)
				store.EXPECT().CountPostsByType(gomock.Any(), postType.Name).Times(1).Return(int64(0), nil)
			}, tc.want, tc.errMsg)
		})

		t.Run("ByTypeWithMeta/"+tc.name, func(t *testing.T) {
			run(t, "/api/v1/posts/type/"+postType.Name+appendQuery(tc.query, "with_meta=true"), func(store *mockdb.MockStore) {
				if tc.want == nil {
					store.EXPECT().ListPostsByTypeWithMeta(gomock.Any(), gomock.Any()).Times(0)
					return
				}
				store.EXPECT().GetPostType(gomock.Any(), postType.Name).Times(1).Return(postType, nil)
				store.EXPECT().
					ListPostsByTypeWithMeta(gomock.Any(), db.ListPostsByTypeWithMetaParams{
						PostType:      postType.Name,
						UserID:        int64(0),
						SortColumn:    tc.want.column,
						SortDirection: tc.want.direction,
						LimitCount:    10,
					}).
					Times(1).
					Return([]db.ListPostsByTypeWithMetaRow{}, nil)
				store.EXPECT().CountPostsByType(gomock.Any(), postType.Name).Times(1).Return(int64(0), nil)
			}, tc.want, tc.errMsg)
		})
	}
}

// appendQuery adds extra to a query string that may be empty or start with "?".
func appendQuery(query, extra string) string {
	if query == "" {
		return "?" + extra
	}
	return query + "&" + extra
}
