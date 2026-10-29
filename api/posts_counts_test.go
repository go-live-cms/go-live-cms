package api

import (
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

func TestGetPostCounts(t *testing.T) {
	testCases := []struct {
		name       string
		url        string
		expect     func(store *mockdb.MockStore)
		wantStatus int
		wantCounts map[string]int64
		wantTotal  int64
	}{
		{
			name: "ByType",
			url:  "/api/v1/posts/counts?type=post",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().
					CountPostsByStatus(gomock.Any(), db.CountPostsByStatusParams{PostType: "post"}).
					Return([]db.CountPostsByStatusRow{{PostStatus: "draft", Total: 3}, {PostStatus: "published", Total: 7}}, nil)
			},
			wantStatus: http.StatusOK,
			wantCounts: map[string]int64{"draft": 3, "published": 7},
			wantTotal:  10,
		},
		{
			name: "ByOwner",
			url:  "/api/v1/posts/counts?type=page&user_id=42",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().
					CountPostsByStatus(gomock.Any(), db.CountPostsByStatusParams{PostType: "page", UserID: 42}).
					Return([]db.CountPostsByStatusRow{{PostStatus: "archived", Total: 1}}, nil)
			},
			wantStatus: http.StatusOK,
			wantCounts: map[string]int64{"archived": 1},
			wantTotal:  1,
		},
		{
			name: "NoPosts",
			url:  "/api/v1/posts/counts",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().CountPostsByStatus(gomock.Any(), db.CountPostsByStatusParams{}).Return([]db.CountPostsByStatusRow{}, nil)
			},
			wantStatus: http.StatusOK,
			wantCounts: map[string]int64{},
		},
		{
			name:       "InvalidUserID",
			url:        "/api/v1/posts/counts?user_id=abc",
			expect:     func(store *mockdb.MockStore) {},
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "StoreError",
			url:  "/api/v1/posts/counts",
			expect: func(store *mockdb.MockStore) {
				store.EXPECT().CountPostsByStatus(gomock.Any(), gomock.Any()).Return(nil, errors.New("boom"))
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

			require.Equal(t, tc.wantStatus, recorder.Code)
			if tc.wantStatus != http.StatusOK {
				return
			}
			var body struct {
				Counts map[string]int64 `json:"counts"`
				Total  int64            `json:"total"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
			require.Equal(t, tc.wantCounts, body.Counts)
			require.Equal(t, tc.wantTotal, body.Total)
		})
	}
}

// The list's status filter is passed through as given; the comma list is
// split in SQL (db/sqlc/post_counts_test.go).
func TestListPostsStatusListPassedThrough(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	store.EXPECT().
		CountFilteredPosts(gomock.Any(), db.CountFilteredPostsParams{PostType: "post", PostStatus: "draft,published", UserID: int64(0)}).
		Return(int64(2), nil)
	store.EXPECT().
		ListPostsWithMeta(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ any, arg db.ListPostsWithMetaParams) ([]db.ListPostsWithMetaRow, error) {
			require.Equal(t, "draft,published", arg.PostStatus)
			return []db.ListPostsWithMetaRow{}, nil
		})

	body, code := getJSON(t, store, "/api/v1/posts?type=post&status=draft,published&with_meta=true")
	require.Equal(t, http.StatusOK, code)
	require.Equal(t, int64(2), body.Meta.Total)
}

func TestToPostWithMetaResponseAuthors(t *testing.T) {
	row := db.ListPostsWithMetaRow{
		ID:      1,
		Authors: json.RawMessage(`[{"id":4,"username":"ana","full_name":"Ana Costa"},{"id":2,"username":"luan","full_name":"Luan"}]`),
	}
	require.Equal(t, []PostAuthorResponse{{4, "ana", "Ana Costa"}, {2, "luan", "Luan"}}, toPostWithMetaResponse(row).Authors)

	// Missing or broken: an empty list, never null in the JSON.
	for _, raw := range []json.RawMessage{nil, json.RawMessage(`null`), json.RawMessage(`not json`)} {
		authors := toPostWithMetaResponse(db.ListPostsWithMetaRow{Authors: raw}).Authors
		require.NotNil(t, authors)
		require.Empty(t, authors)
	}
}
