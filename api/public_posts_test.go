package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

func publicPostType(name string) db.PostType {
	return db.PostType{Name: name, Label: "Posts", Public: true, IsActive: true}
}

func perPageSetting(n int32) db.Setting {
	return db.Setting{PostsPerPage: sql.NullInt32{Int32: n, Valid: true}}
}

func listRows(n int) []db.ListPostsWithMetaRow {
	rows := make([]db.ListPostsWithMetaRow, n)
	for i := range rows {
		rows[i] = db.ListPostsWithMetaRow{ID: int64(i + 1), Title: "Post", PostType: "post", PostStatus: "published", Authors: json.RawMessage(`[]`)}
	}
	return rows
}

func TestGetPublicPostsByType(t *testing.T) {
	countParams := db.CountFilteredPostsParams{PostType: "post", PostStatus: "published", UserID: int64(0)}
	listParams := func(offset, limit int32) db.ListPostsWithMetaParams {
		return db.ListPostsWithMetaParams{
			PostType: "post", PostStatus: "published", UserID: int64(0),
			SortColumn: "created_at", SortDirection: "desc",
			OffsetCount: offset, LimitCount: limit,
		}
	}

	testCases := []struct {
		name       string
		url        string
		expect     func(store *mockdb.MockStore)
		wantStatus int
		wantPage   pageInfo
		wantCount  int
	}{
		{
			name: "FirstPage",
			url:  "/public/posts/type/post",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostType("post"), nil)
				store.EXPECT().CountFilteredPosts(gomock.Any(), countParams).Return(int64(45), nil)
				store.EXPECT().ListPostsWithMeta(gomock.Any(), listParams(0, 10)).Return(listRows(10), nil)
			},
			wantStatus: http.StatusOK,
			wantPage:   pageInfo{Page: 1, PerPage: 10, Total: 45, TotalPages: 5},
			wantCount:  10,
		},
		{
			name: "LastPartialPage",
			url:  "/public/posts/type/post?page=5",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostType("post"), nil)
				store.EXPECT().CountFilteredPosts(gomock.Any(), countParams).Return(int64(45), nil)
				store.EXPECT().ListPostsWithMeta(gomock.Any(), listParams(40, 10)).Return(listRows(5), nil)
			},
			wantStatus: http.StatusOK,
			wantPage:   pageInfo{Page: 5, PerPage: 10, Total: 45, TotalPages: 5},
			wantCount:  5,
		},
		{
			name: "PageSizeFromSettings",
			url:  "/public/posts/type/post?page=2",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(3), nil)
				store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostType("post"), nil)
				store.EXPECT().CountFilteredPosts(gomock.Any(), countParams).Return(int64(7), nil)
				store.EXPECT().ListPostsWithMeta(gomock.Any(), listParams(3, 3)).Return(listRows(3), nil)
			},
			wantStatus: http.StatusOK,
			wantPage:   pageInfo{Page: 2, PerPage: 3, Total: 7, TotalPages: 3},
			wantCount:  3,
		},
		{
			name: "DefaultPageSizeWithoutSetting",
			url:  "/public/posts/type/post",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, sql.ErrNoRows)
				store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostType("post"), nil)
				store.EXPECT().CountFilteredPosts(gomock.Any(), countParams).Return(int64(0), nil)
				store.EXPECT().ListPostsWithMeta(gomock.Any(), listParams(0, 10)).Return(nil, nil)
			},
			wantStatus: http.StatusOK,
			wantPage:   pageInfo{Page: 1, PerPage: 10, Total: 0, TotalPages: 0},
		},
		{
			name: "PastTheEnd",
			url:  "/public/posts/type/post?page=6",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostType("post"), nil)
				store.EXPECT().CountFilteredPosts(gomock.Any(), countParams).Return(int64(45), nil)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name: "SecondPageOfEmptyList",
			url:  "/public/posts/type/post?page=2",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostType("post"), nil)
				store.EXPECT().CountFilteredPosts(gomock.Any(), countParams).Return(int64(0), nil)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name: "OffsetPastInt32",
			url:  "/public/posts/type/post?page=2147483647",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "PageZero",
			url:        "/public/posts/type/post?page=0",
			expect:     func(store *mockdb.MockStore) {},
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "PageNotANumber",
			url:        "/public/posts/type/post?page=two",
			expect:     func(store *mockdb.MockStore) {},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "UnknownType",
			url:  "/public/posts/type/nope",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPostType(gomock.Any(), "nope").Return(db.PostType{}, sql.ErrNoRows)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name: "PrivateType",
			url:  "/public/posts/type/internal",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				pt := publicPostType("internal")
				pt.Public = false
				store.EXPECT().GetPostType(gomock.Any(), "internal").Return(pt, nil)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name: "InactiveType",
			url:  "/public/posts/type/old",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				pt := publicPostType("old")
				pt.IsActive = false
				store.EXPECT().GetPostType(gomock.Any(), "old").Return(pt, nil)
			},
			wantStatus: http.StatusNotFound,
		},
		{
			name: "SettingsError",
			url:  "/public/posts/type/post",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, errors.New("db down"))
			},
			wantStatus: http.StatusInternalServerError,
		},
		{
			name: "PostTypeError",
			url:  "/public/posts/type/post",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPostType(gomock.Any(), "post").Return(db.PostType{}, errors.New("db down"))
			},
			wantStatus: http.StatusInternalServerError,
		},
		{
			name: "CountError",
			url:  "/public/posts/type/post",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostType("post"), nil)
				store.EXPECT().CountFilteredPosts(gomock.Any(), countParams).Return(int64(0), errors.New("db down"))
			},
			wantStatus: http.StatusInternalServerError,
		},
		{
			name: "ListError",
			url:  "/public/posts/type/post",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().GetSettings(gomock.Any()).Return(perPageSetting(10), nil)
				store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicPostType("post"), nil)
				store.EXPECT().CountFilteredPosts(gomock.Any(), countParams).Return(int64(3), nil)
				store.EXPECT().ListPostsWithMeta(gomock.Any(), gomock.Any()).Return(nil, errors.New("db down"))
			},
			wantStatus: http.StatusInternalServerError,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			tc.expect(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()
			request, err := http.NewRequest(http.MethodGet, tc.url, nil)
			require.NoError(t, err)
			server.router.ServeHTTP(recorder, request)

			require.Equal(t, tc.wantStatus, recorder.Code, recorder.Body.String())
			if tc.wantStatus != http.StatusOK {
				return
			}
			var body struct {
				Posts      []PostWithMetaResponse `json:"posts"`
				Pagination pageInfo               `json:"pagination"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
			require.Equal(t, tc.wantPage, body.Pagination)
			require.Len(t, body.Posts, tc.wantCount)
		})
	}
}

func TestPageInfo(t *testing.T) {
	for _, tc := range []struct {
		page, perPage int32
		total         int64
		wantPages     int64
		outOfRange    bool
	}{
		{1, 10, 0, 0, false}, // an empty list still has its first page
		{2, 10, 0, 0, true},
		{1, 10, 10, 1, false},
		{2, 10, 10, 1, true},
		{2, 10, 11, 2, false},
		{3, 10, 11, 2, true},
		{4, 1, 4, 4, false},
	} {
		info := newPageInfo(pageRequest{Page: tc.page, PerPage: tc.perPage}, tc.total)
		require.Equal(t, tc.wantPages, info.TotalPages, "%+v", tc)
		require.Equal(t, tc.outOfRange, info.outOfRange(), "%+v", tc)
	}
	require.Equal(t, int32(40), pageRequest{Page: 5, PerPage: 10}.offset())
}
