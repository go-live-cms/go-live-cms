package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

func publishedPostForRelatedTest() db.Post {
	post := randomPost(randomUserForPosts())
	post.ID = 4242
	post.PostStatus = "published"
	return post
}

func serveRelated(t *testing.T, store *mockdb.MockStore, url string) *httptest.ResponseRecorder {
	server := newTestServer(t, store)
	recorder := httptest.NewRecorder()
	request, err := http.NewRequest(http.MethodGet, url, nil)
	require.NoError(t, err)
	server.router.ServeHTTP(recorder, request)
	return recorder
}

// The post lookup both routes share: 400, 404 (missing or not published), 500.
func TestRelatedRoutesPostLookup(t *testing.T) {
	draft := publishedPostForRelatedTest()
	draft.PostStatus = "draft"

	for _, path := range []string{"adjacent", "related"} {
		t.Run(path+"/invalid id", func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			rec := serveRelated(t, store, "/public/posts/abc/"+path)
			require.Equal(t, http.StatusBadRequest, rec.Code)
		})
		t.Run(path+"/missing", func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(db.Post{}, sql.ErrNoRows)
			rec := serveRelated(t, store, "/public/posts/7/"+path)
			require.Equal(t, http.StatusNotFound, rec.Code)
		})
		t.Run(path+"/draft", func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			store.EXPECT().GetPost(gomock.Any(), draft.ID).Return(draft, nil)
			rec := serveRelated(t, store, fmt.Sprintf("/public/posts/%d/%s", draft.ID, path))
			require.Equal(t, http.StatusNotFound, rec.Code)
		})
		t.Run(path+"/lookup error", func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(db.Post{}, sql.ErrConnDone)
			rec := serveRelated(t, store, "/public/posts/7/"+path)
			require.Equal(t, http.StatusInternalServerError, rec.Code)
		})
	}
}

func TestGetAdjacentPostsAPI(t *testing.T) {
	post := publishedPostForRelatedTest()
	older := db.ListAdjacentPostsRow{
		Direction: "previous", ID: 10, Title: "Older", PostType: "post", PostStatus: "published",
		CreatedAt: post.CreatedAt.Add(-time.Hour),
		Meta:      json.RawMessage(`{"_thumbnail_url":"/uploads/media/a.jpg"}`),
		Authors:   json.RawMessage(`[{"id":1,"username":"ana","full_name":"Ana Costa"}]`),
	}
	newer := db.ListAdjacentPostsRow{Direction: "next", ID: 11, Title: "Newer", PostType: "post", PostStatus: "published", Meta: json.RawMessage(`{}`), Authors: json.RawMessage(`[]`)}

	t.Run("both sides", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPost(gomock.Any(), post.ID).Return(post, nil)
		store.EXPECT().ListAdjacentPosts(gomock.Any(), db.ListAdjacentPostsParams{
			PostType: post.PostType, CreatedAt: post.CreatedAt, PostID: post.ID,
		}).Return([]db.ListAdjacentPostsRow{older, newer}, nil)

		rec := serveRelated(t, store, fmt.Sprintf("/public/posts/%d/adjacent", post.ID))
		require.Equal(t, http.StatusOK, rec.Code)
		var resp struct {
			Previous *PostWithMetaResponse `json:"previous"`
			Next     *PostWithMetaResponse `json:"next"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
		require.Equal(t, int64(10), resp.Previous.ID)
		require.Equal(t, "/uploads/media/a.jpg", resp.Previous.Meta["_thumbnail_url"])
		require.Equal(t, []PostAuthorResponse{{ID: 1, Username: "ana", FullName: "Ana Costa"}}, resp.Previous.Authors)
		require.Equal(t, int64(11), resp.Next.ID)
		require.Equal(t, []PostAuthorResponse{}, resp.Next.Authors)
	})

	t.Run("an edge is null", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPost(gomock.Any(), post.ID).Return(post, nil)
		store.EXPECT().ListAdjacentPosts(gomock.Any(), gomock.Any()).Return([]db.ListAdjacentPostsRow{newer}, nil)

		rec := serveRelated(t, store, fmt.Sprintf("/public/posts/%d/adjacent", post.ID))
		require.Equal(t, http.StatusOK, rec.Code)
		var resp map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
		require.Equal(t, "null", string(resp["previous"]))
		require.Contains(t, string(resp["next"]), `"id":11`)
	})

	t.Run("query error", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPost(gomock.Any(), post.ID).Return(post, nil)
		store.EXPECT().ListAdjacentPosts(gomock.Any(), gomock.Any()).Return(nil, sql.ErrConnDone)
		rec := serveRelated(t, store, fmt.Sprintf("/public/posts/%d/adjacent", post.ID))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}

func TestGetRelatedPostsAPI(t *testing.T) {
	post := publishedPostForRelatedTest()
	row := db.ListRelatedPostsRow{
		ID: 20, Title: "Related", PostType: "post", PostStatus: "published",
		SharedCategories: 1, SharedTags: 2, Meta: json.RawMessage(`{}`), Authors: json.RawMessage(`[]`),
	}

	cases := []struct {
		name  string
		query string
		want  db.ListRelatedPostsParams
	}{
		{"defaults", "", db.ListRelatedPostsParams{LimitCount: 3, WithFallback: true}},
		{"limit", "?limit=5", db.ListRelatedPostsParams{LimitCount: 5, WithFallback: true}},
		{"limit is capped", "?limit=500", db.ListRelatedPostsParams{LimitCount: relatedPostsMaxLimit, WithFallback: true}},
		{"taxonomy turns the fallback off", "?taxonomy=category", db.ListRelatedPostsParams{LimitCount: 3, Taxonomy: "category"}},
		{"taxonomy names are free text", "?taxonomy=Book%20Genre", db.ListRelatedPostsParams{LimitCount: 3, Taxonomy: "Book Genre"}},
		{"term_id turns the fallback off", "?term_id=9", db.ListRelatedPostsParams{LimitCount: 3, TermID: 9}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			want := tc.want
			want.PostType = post.PostType
			want.PostID = post.ID

			store := mockdb.NewMockStore(gomock.NewController(t))
			store.EXPECT().GetPost(gomock.Any(), post.ID).Return(post, nil)
			store.EXPECT().ListRelatedPosts(gomock.Any(), want).Return([]db.ListRelatedPostsRow{row}, nil)

			rec := serveRelated(t, store, fmt.Sprintf("/public/posts/%d/related%s", post.ID, tc.query))
			require.Equal(t, http.StatusOK, rec.Code)
			var resp struct {
				Posts []RelatedPostResponse `json:"posts"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &resp))
			require.Len(t, resp.Posts, 1)
			require.Equal(t, int64(20), resp.Posts[0].ID)
			require.EqualValues(t, 1, resp.Posts[0].SharedCategories)
			require.EqualValues(t, 2, resp.Posts[0].SharedTags)
		})
	}

	t.Run("empty is an empty list", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPost(gomock.Any(), post.ID).Return(post, nil)
		store.EXPECT().ListRelatedPosts(gomock.Any(), gomock.Any()).Return([]db.ListRelatedPostsRow{}, nil)
		rec := serveRelated(t, store, fmt.Sprintf("/public/posts/%d/related", post.ID))
		require.Equal(t, http.StatusOK, rec.Code)
		require.JSONEq(t, `{"posts":[]}`, rec.Body.String())
	})

	for _, bad := range []string{"?limit=0", "?limit=x", "?term_id=0", "?term_id=x", "?taxonomy=" + strings.Repeat("x", 101)} {
		t.Run("bad query "+bad, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			rec := serveRelated(t, store, fmt.Sprintf("/public/posts/%d/related%s", post.ID, bad))
			require.Equal(t, http.StatusBadRequest, rec.Code)
		})
	}

	t.Run("query error", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetPost(gomock.Any(), post.ID).Return(post, nil)
		store.EXPECT().ListRelatedPosts(gomock.Any(), gomock.Any()).Return(nil, sql.ErrConnDone)
		rec := serveRelated(t, store, fmt.Sprintf("/public/posts/%d/related", post.ID))
		require.Equal(t, http.StatusInternalServerError, rec.Code)
	})
}
