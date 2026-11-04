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

// "Changes not published" (#326): the flag on the lists and the detail, the
// list's filter and the tab's count. The SQL that computes the flag is tested
// against the database in db/sqlc/post_unpublished_changes_test.go.

// serveGet GETs url as testReader (an editor: post reads need a content role, #393).
func serveGet(t *testing.T, store *mockdb.MockStore, url string) *httptest.ResponseRecorder {
	t.Helper()
	server := newTestServer(t, store)
	recorder := httptest.NewRecorder()
	request, err := http.NewRequest(http.MethodGet, url, nil)
	require.NoError(t, err)
	signInAs(t, server, store, request, testReader)
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func TestListPostsUnpublishedChanges(t *testing.T) {
	t.Run("FlagOnRows", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().CountFilteredPosts(gomock.Any(), gomock.Any()).Return(int64(2), nil)
		store.EXPECT().ListPostsWithMeta(gomock.Any(), gomock.Any()).Return([]db.ListPostsWithMetaRow{
			{ID: 1, PostStatus: "published", HasUnpublishedChanges: true},
			{ID: 2, PostStatus: "published"},
		}, nil)
		recorder := serveGet(t, store, "/api/v1/posts?with_meta=true")
		require.Equal(t, http.StatusOK, recorder.Code)
		var body struct {
			Posts []map[string]any `json:"posts"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		require.Len(t, body.Posts, 2)
		require.Equal(t, true, body.Posts[0]["has_unpublished_changes"])
		// Omitted when false.
		require.NotContains(t, body.Posts[1], "has_unpublished_changes")
	})

	// The "Changes not published" tab: the filter reaches the count and the list,
	// whichever meta level asks for it.
	for _, tc := range []struct {
		name   string
		url    string
		expect func(store *mockdb.MockStore)
	}{
		{"Plain", "/api/v1/posts?status=published&unpublished_changes=true", func(store *mockdb.MockStore) {
			store.EXPECT().ListPosts(gomock.Any(), gomock.Any()).DoAndReturn(func(_ any, arg db.ListPostsParams) ([]db.ListPostsRow, error) {
				require.True(t, arg.UnpublishedChanges)
				return []db.ListPostsRow{{ID: 1, PostStatus: "published", HasUnpublishedChanges: true}}, nil
			})
		}},
		{"WithMeta", "/api/v1/posts?status=published&unpublished_changes=true&with_meta=true", func(store *mockdb.MockStore) {
			store.EXPECT().ListPostsWithMeta(gomock.Any(), gomock.Any()).DoAndReturn(func(_ any, arg db.ListPostsWithMetaParams) ([]db.ListPostsWithMetaRow, error) {
				require.True(t, arg.UnpublishedChanges)
				return []db.ListPostsWithMetaRow{{ID: 1, PostStatus: "published", HasUnpublishedChanges: true}}, nil
			})
		}},
		{"AllMeta", "/api/v1/posts?status=published&unpublished_changes=true&with_meta=true&meta_level=all", func(store *mockdb.MockStore) {
			store.EXPECT().ListPostsWithAllMeta(gomock.Any(), gomock.Any()).DoAndReturn(func(_ any, arg db.ListPostsWithAllMetaParams) ([]db.ListPostsWithAllMetaRow, error) {
				require.True(t, arg.UnpublishedChanges)
				return []db.ListPostsWithAllMetaRow{{ID: 1, PostStatus: "published", HasUnpublishedChanges: true}}, nil
			})
		}},
	} {
		t.Run("Filter"+tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			store.EXPECT().
				CountFilteredPosts(gomock.Any(), db.CountFilteredPostsParams{PostStatus: "published", UnpublishedChanges: true}).
				Return(int64(1), nil)
			tc.expect(store)
			recorder := serveGet(t, store, tc.url)
			require.Equal(t, http.StatusOK, recorder.Code)
			var body struct {
				Posts []map[string]any `json:"posts"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
			require.Len(t, body.Posts, 1)
			require.Equal(t, true, body.Posts[0]["has_unpublished_changes"])
		})
	}

	// /posts/type/:type takes the same filter, and its count follows it.
	t.Run("FilterByType", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPostType(gomock.Any(), "page").Return(db.PostType{Name: "page"}, nil)
		store.EXPECT().ListPostsWithMeta(gomock.Any(), gomock.Any()).DoAndReturn(func(_ any, arg db.ListPostsWithMetaParams) ([]db.ListPostsWithMetaRow, error) {
			require.True(t, arg.UnpublishedChanges)
			require.True(t, arg.WithUnpublishedChanges)
			return []db.ListPostsWithMetaRow{{ID: 3, PostStatus: "published", HasUnpublishedChanges: true}}, nil
		})
		store.EXPECT().
			CountPostsByTypeFiltered(gomock.Any(), db.CountPostsByTypeFilteredParams{PostType: "page", PostStatus: "published", UnpublishedChanges: true}).
			Return(int64(1), nil)
		recorder := serveGet(t, store, "/api/v1/posts/type/page?status=published&unpublished_changes=true&with_meta=true")
		require.Equal(t, http.StatusOK, recorder.Code)
		require.Contains(t, recorder.Body.String(), `"has_unpublished_changes":true`)
	})

	t.Run("InvalidFilterByType", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPostType(gomock.Any(), gomock.Any()).Times(0)
		require.Equal(t, http.StatusBadRequest, serveGet(t, store, "/api/v1/posts/type/page?unpublished_changes=maybe").Code)
	})

	t.Run("InvalidFilter", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().CountFilteredPosts(gomock.Any(), gomock.Any()).Times(0)
		require.Equal(t, http.StatusBadRequest, serveGet(t, store, "/api/v1/posts?unpublished_changes=maybe").Code)
	})
}

func TestPostCountsUnpublishedChanges(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	store.EXPECT().
		CountPostsByStatus(gomock.Any(), db.CountPostsByStatusParams{PostType: "post"}).
		Return([]db.CountPostsByStatusRow{
			{PostStatus: "draft", Total: 3},
			{PostStatus: "published", Total: 7, UnpublishedChanges: 2},
		}, nil)
	recorder := serveGet(t, store, "/api/v1/posts/counts?type=post")
	require.Equal(t, http.StatusOK, recorder.Code)
	require.JSONEq(t, `{"counts": {"draft": 3, "published": 7}, "total": 10, "unpublished_changes": 2}`, recorder.Body.String())
}

func TestGetPostUnpublishedChanges(t *testing.T) {
	published := db.Post{ID: 7, Slug: "live", PostStatus: "published"}

	for _, tc := range []struct {
		name   string
		url    string
		expect func(store *mockdb.MockStore)
		want   any
	}{
		{"ByID", "/api/v1/posts/7", func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(published, nil)
			store.EXPECT().GetPostHasUnpublishedChanges(gomock.Any(), int64(7)).Return(true, nil)
		}, true},
		{"BySlug", "/api/v1/posts/slug/live", func(store *mockdb.MockStore) {
			store.EXPECT().GetPostBySlug(gomock.Any(), "live").Return(published, nil)
			store.EXPECT().GetPostHasUnpublishedChanges(gomock.Any(), int64(7)).Return(true, nil)
		}, true},
		{"UpToDate", "/api/v1/posts/7", func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(published, nil)
			store.EXPECT().GetPostHasUnpublishedChanges(gomock.Any(), int64(7)).Return(false, nil)
		}, nil},
		// Only a published post can have them: no lookup for a draft.
		{"Draft", "/api/v1/posts/7", func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(db.Post{ID: 7, PostStatus: "draft"}, nil)
			store.EXPECT().GetPostHasUnpublishedChanges(gomock.Any(), gomock.Any()).Times(0)
		}, nil},
		// The flag is a hint: a failed lookup leaves it out, the post still loads.
		{"LookupFails", "/api/v1/posts/7", func(store *mockdb.MockStore) {
			store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(published, nil)
			store.EXPECT().GetPostHasUnpublishedChanges(gomock.Any(), int64(7)).Return(false, errors.New("db down"))
		}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			tc.expect(store)
			recorder := serveGet(t, store, tc.url)
			require.Equal(t, http.StatusOK, recorder.Code)
			var body struct {
				Post map[string]any `json:"post"`
			}
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
			require.Equal(t, tc.want, body.Post["has_unpublished_changes"])
		})
	}
}

// The public lists share the admin list's row (#358's presenter); the working
// copy's state never reaches the site.
func TestPublicPostResponseHidesUnpublishedChanges(t *testing.T) {
	row := db.ListPostsWithMetaRow{ID: 1, PostStatus: "published", HasUnpublishedChanges: true}
	require.True(t, toPostWithMetaResponse(row).HasUnpublishedChanges)
	resp := toPublicPostWithMetaResponse(row)
	require.False(t, resp.HasUnpublishedChanges)
	raw, err := json.Marshal(resp)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "has_unpublished_changes")
}

func TestParseUnpublishedChangesFilter(t *testing.T) {
	for value, want := range map[string]bool{"": false, "true": true, "1": true, "false": false, "0": false} {
		got, err := parseUnpublishedChangesFilter(value)
		require.NoError(t, err, value)
		require.Equal(t, want, got, value)
	}
	_, err := parseUnpublishedChangesFilter("yes please")
	require.Error(t, err)
}
