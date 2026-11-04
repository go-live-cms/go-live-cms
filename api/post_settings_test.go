package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/golang/mock/gomock"
	"github.com/sqlc-dev/pqtype"
	"github.com/stretchr/testify/require"
)

// Post settings snapshots (#358): the public endpoints show a published post's
// published title, excerpt, featured image and terms, never the working ones.

const publishedSettingsJSON = `{"title": "Published title", "description": "Published excerpt",
	"featured_image": {"id": 5, "url": "/uploads/media/published.jpg"}, "term_ids": [3]}`

func publishedSettings(raw string) pqtype.NullRawMessage {
	return pqtype.NullRawMessage{RawMessage: json.RawMessage(raw), Valid: true}
}

// editedPublishedPost is a published post whose title and excerpt were edited
// after publishing: the row holds the working values, published_settings the
// published ones.
func editedPublishedPost() db.Post {
	return db.Post{
		ID:                7,
		Title:             "Working title",
		Description:       "Working excerpt",
		Slug:              "the-post",
		PostType:          "post",
		PostStatus:        "published",
		PublishedBlockDoc: pqtype.NullRawMessage{RawMessage: validBlockDoc(), Valid: true},
		PublishedSettings: publishedSettings(publishedSettingsJSON),
	}
}

func serveSettingsGET(t *testing.T, server *Server, url string) *httptest.ResponseRecorder {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, url, nil)
	require.NoError(t, err)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func TestApplyPublishedSettings(t *testing.T) {
	row := PostWithMetaResponse{
		Title:       "Working title",
		Description: "Working excerpt",
		Meta:        map[string]interface{}{"_thumbnail_id": "9", "_thumbnail_url": "/uploads/media/working.jpg", "other": "kept"},
	}

	unpublished := row
	unpublished.Meta = map[string]interface{}{"_thumbnail_url": "/w.jpg"}
	applyPublishedSettings(&unpublished, pqtype.NullRawMessage{})
	require.Equal(t, "Working title", unpublished.Title)
	require.Equal(t, "/w.jpg", unpublished.Meta["_thumbnail_url"])

	applyPublishedSettings(&row, publishedSettings(publishedSettingsJSON))
	require.Equal(t, "Published title", row.Title)
	require.Equal(t, "Published excerpt", row.Description)
	require.Equal(t, map[string]interface{}{"_thumbnail_id": "5", "_thumbnail_url": "/uploads/media/published.jpg", "other": "kept"}, row.Meta)

	// Published without a featured image: the working one doesn't show.
	noImage := PostWithMetaResponse{Meta: map[string]interface{}{"_thumbnail_url": "/w.jpg"}}
	applyPublishedSettings(&noImage, publishedSettings(`{"title": "T", "description": "D", "featured_image": null, "term_ids": []}`))
	require.Empty(t, noImage.Meta)

	// An unreadable snapshot leaves the row as it is.
	broken := PostWithMetaResponse{Title: "Working"}
	applyPublishedSettings(&broken, publishedSettings(`not json`))
	require.Equal(t, "Working", broken.Title)
}

func TestToPublicPostWithMetaResponse(t *testing.T) {
	resp := toPublicPostWithMetaResponse(db.ListPostsWithMetaRow{
		ID: 1, Title: "Working title", Description: "Working excerpt",
		Meta:              []byte(`{"_thumbnail_url": "/w.jpg"}`),
		PublishedSettings: publishedSettings(publishedSettingsJSON),
	})
	require.Equal(t, "Published title", resp.Title)
	require.Equal(t, "/uploads/media/published.jpg", resp.Meta["_thumbnail_url"])

	related := toRelatedPostResponse(db.ListRelatedPostsRow{
		Title: "Working title", Meta: json.RawMessage(`{}`), Authors: json.RawMessage(`[]`),
		PublishedSettings: publishedSettings(publishedSettingsJSON),
	})
	require.Equal(t, "Published title", related.Title)
	adjacent := toAdjacentPostResponse(db.ListAdjacentPostsRow{
		Title: "Working title", Meta: json.RawMessage(`{}`), Authors: json.RawMessage(`[]`),
		PublishedSettings: publishedSettings(publishedSettingsJSON),
	})
	require.Equal(t, "Published excerpt", adjacent.Description)
}

func TestGetPublicPost(t *testing.T) {
	publishedTerm := db.GetPublishedPostTaxonomyTermsRow{ID: 3, Name: "Guides", Slug: "guides", TaxonomyTypeName: "category", CreatedAt: time.Now()}

	t.Run("PublishedSettings", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetPost(gomock.Any(), int64(7)).Times(1).Return(editedPublishedPost(), nil)
		store.EXPECT().GetPublishedPostTaxonomyTerms(gomock.Any(), int64(7)).Times(1).Return([]db.GetPublishedPostTaxonomyTermsRow{publishedTerm}, nil)
		// The SEO image (#357): the published featured image's media row.
		store.EXPECT().GetMediaByIDs(gomock.Any(), []int64{5}).Times(1).Return(nil, nil)
		// The working featured image and terms are never read.
		store.EXPECT().GetPostMetaByKey(gomock.Any(), gomock.Any()).Times(0)
		store.EXPECT().GetPostTaxonomyTerms(gomock.Any(), gomock.Any()).Times(0)

		recorder := serveSettingsGET(t, newTestServer(t, store), "/public/posts/7")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var resp publicPostView
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
		require.Equal(t, "Published title", resp.Post.Title)
		require.Equal(t, "Published excerpt", resp.Post.Description)
		require.NotEmpty(t, resp.Post.PublishedBlocks)
		require.NotNil(t, resp.FeaturedImage)
		require.Equal(t, "/uploads/media/published.jpg", resp.FeaturedImage.URL)
		require.Equal(t, int64(5), *resp.FeaturedImage.ID)
		require.Len(t, resp.TaxonomyTerms, 1)
		require.Equal(t, "guides", resp.TaxonomyTerms[0].Slug)
	})

	t.Run("BySlug", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetPostBySlug(gomock.Any(), "the-post").Times(1).Return(editedPublishedPost(), nil)
		store.EXPECT().GetMediaByIDs(gomock.Any(), []int64{5}).Times(1).Return(nil, nil)
		store.EXPECT().GetPublishedPostTaxonomyTerms(gomock.Any(), int64(7)).Times(1).Return(nil, nil)

		recorder := serveSettingsGET(t, newTestServer(t, store), "/public/posts/slug/the-post")
		require.Equal(t, http.StatusOK, recorder.Code)
		var resp publicPostView
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
		require.Equal(t, "Published title", resp.Post.Title)
		require.NotNil(t, resp.TaxonomyTerms)
	})

	// Marked published through PUT /posts/:id (no snapshot of its body or settings):
	// it still has a page, with its live settings and no body, as before #358.
	t.Run("NoPublishedSettings", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		post := editedPublishedPost()
		post.PublishedSettings = pqtype.NullRawMessage{}
		post.PublishedBlockDoc = pqtype.NullRawMessage{}
		store.EXPECT().GetPost(gomock.Any(), int64(7)).Times(1).Return(post, nil)
		server := newTestServer(t, store)
		stored := filepath.Join(server.config.UploadPath, "live.jpg")
		store.EXPECT().GetPostMetaByKey(gomock.Any(), db.GetPostMetaByKeyParams{PostID: 7, MetaKey: "_thumbnail_url"}).Times(1).
			Return(db.PostMetum{MetaValue: sql.NullString{String: stored, Valid: true}}, nil)
		store.EXPECT().GetPostTaxonomyTerms(gomock.Any(), int64(7)).Times(1).
			Return([]db.GetPostTaxonomyTermsRow{db.GetPostTaxonomyTermsRow(publishedTerm)}, nil)

		recorder := serveSettingsGET(t, server, "/public/posts/7")
		require.Equal(t, http.StatusOK, recorder.Code)
		var resp publicPostView
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
		require.Equal(t, "Working title", resp.Post.Title)
		require.Equal(t, "/uploads/media/live.jpg", resp.FeaturedImage.URL)
		require.Empty(t, resp.Post.PublishedBlocks)
		require.Len(t, resp.TaxonomyTerms, 1)
	})

	for _, tc := range []struct {
		name string
		post func() (db.Post, error)
		want int
	}{
		{"Draft", func() (db.Post, error) { p := editedPublishedPost(); p.PostStatus = "draft"; return p, nil }, http.StatusNotFound},
		{"Missing", func() (db.Post, error) { return db.Post{}, sql.ErrNoRows }, http.StatusNotFound},
		{"DBError", func() (db.Post, error) { return db.Post{}, fmt.Errorf("db down") }, http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			post, err := tc.post()
			store.EXPECT().GetPost(gomock.Any(), int64(7)).Times(1).Return(post, err)
			store.EXPECT().GetPublishedPostTaxonomyTerms(gomock.Any(), gomock.Any()).Times(0)
			recorder := serveSettingsGET(t, newTestServer(t, store), "/public/posts/7")
			require.Equal(t, tc.want, recorder.Code)
		})
	}

	t.Run("TermsError", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetPost(gomock.Any(), int64(7)).Times(1).Return(editedPublishedPost(), nil)
		store.EXPECT().GetMediaByIDs(gomock.Any(), []int64{5}).Times(1).Return(nil, nil)
		store.EXPECT().GetPublishedPostTaxonomyTerms(gomock.Any(), int64(7)).Times(1).Return(nil, fmt.Errorf("db down"))
		recorder := serveSettingsGET(t, newTestServer(t, store), "/public/posts/7")
		require.Equal(t, http.StatusInternalServerError, recorder.Code)
	})

	t.Run("InvalidID", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		require.Equal(t, http.StatusBadRequest, serveSettingsGET(t, newTestServer(t, store), "/public/posts/abc").Code)
	})
}

func TestListPublicPosts(t *testing.T) {
	publicType := db.PostType{Name: "post", Public: true, IsActive: true}

	t.Run("PublishedTitles", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetPostType(gomock.Any(), "post").Times(1).Return(publicType, nil)
		store.EXPECT().CountFilteredPosts(gomock.Any(), db.CountFilteredPostsParams{PostType: "post", PostStatus: "published"}).Times(1).Return(int64(2), nil)
		store.EXPECT().ListPosts(gomock.Any(), db.ListPostsParams{
			PostType: "post", PostStatus: "published", SortColumn: "created_at", SortDirection: "desc", LimitCount: 20,
		}).Times(1).Return([]db.ListPostsRow{
			{
				ID: 1, Title: "Working title", Description: "Working excerpt", PostStatus: "published",
				PublishedBlockDoc: pqtype.NullRawMessage{RawMessage: validBlockDoc(), Valid: true},
				PublishedSettings: publishedSettings(publishedSettingsJSON),
			},
			{ID: 2, Title: "Never snapshotted", Description: "Live excerpt", PostStatus: "published"},
		}, nil)

		recorder := serveSettingsGET(t, newTestServer(t, store), "/public/posts?type=post&sort=date_desc&limit=20")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var resp struct {
			Posts []map[string]interface{} `json:"posts"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
		require.Len(t, resp.Posts, 2)
		require.Equal(t, "Published title", resp.Posts[0]["title"])
		require.Equal(t, "Published excerpt", resp.Posts[0]["description"])
		require.NotContains(t, resp.Posts[0], "published_blocks")
		require.Equal(t, "Never snapshotted", resp.Posts[1]["title"])
	})

	for _, tc := range []struct {
		name  string
		query string
		stubs func(store *mockdb.MockStore)
		want  int
	}{
		{"NoType", "", func(store *mockdb.MockStore) {}, http.StatusBadRequest},
		{"BadSort", "type=post&sort=nope", func(store *mockdb.MockStore) {}, http.StatusBadRequest},
		{"BadLimit", "type=post&limit=0", func(store *mockdb.MockStore) {}, http.StatusBadRequest},
		{"BadOffset", "type=post&offset=-1", func(store *mockdb.MockStore) {}, http.StatusBadRequest},
		{"UnknownType", "type=nope", func(store *mockdb.MockStore) {
			store.EXPECT().GetPostType(gomock.Any(), "nope").Return(db.PostType{}, sql.ErrNoRows)
		}, http.StatusNotFound},
		{"PrivateType", "type=secret", func(store *mockdb.MockStore) {
			store.EXPECT().GetPostType(gomock.Any(), "secret").Return(db.PostType{Name: "secret", Public: false, IsActive: true}, nil)
		}, http.StatusNotFound},
		{"CountError", "type=post", func(store *mockdb.MockStore) {
			store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicType, nil)
			store.EXPECT().CountFilteredPosts(gomock.Any(), gomock.Any()).Return(int64(0), fmt.Errorf("db down"))
		}, http.StatusInternalServerError},
		{"ListError", "type=post", func(store *mockdb.MockStore) {
			store.EXPECT().GetPostType(gomock.Any(), "post").Return(publicType, nil)
			store.EXPECT().CountFilteredPosts(gomock.Any(), gomock.Any()).Return(int64(0), nil)
			store.EXPECT().ListPosts(gomock.Any(), gomock.Any()).Return(nil, fmt.Errorf("db down"))
		}, http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			tc.stubs(store)
			require.Equal(t, tc.want, serveSettingsGET(t, newTestServer(t, store), "/public/posts?"+tc.query).Code)
		})
	}
}

func settingsRequest(t *testing.T, server *Server, method, url string, user db.User) *httptest.ResponseRecorder {
	t.Helper()
	request, err := http.NewRequest(method, url, nil)
	require.NoError(t, err)
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func TestRestorePostVersionSettings(t *testing.T) {
	contributor := db.User{ID: 2, Username: "contrib", Role: RoleContributor}
	url := "/api/v1/posts/7/versions/1/restore-settings"

	t.Run("Restores", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubLivePost(store)
		stubRoleLookup(store, publishEditor)
		store.EXPECT().GetPostVersion(gomock.Any(), db.GetPostVersionParams{PostID: 7, VersionNo: 1}).Times(1).
			Return(db.GetPostVersionRow{ID: 11, VersionNo: 1, Settings: publishedSettings(publishedSettingsJSON)}, nil)
		server := newTestServer(t, store)
		store.EXPECT().RestorePostSettingsTx(gomock.Any(), gomock.Any()).Times(1).
			DoAndReturn(func(_ any, arg db.RestorePostSettingsTxParams) (db.Post, error) {
				require.Equal(t, int64(7), arg.PostID)
				require.Equal(t, "Published title", arg.Settings.Title)
				require.Equal(t, "Published excerpt", arg.Settings.Description)
				require.Equal(t, int64(5), *arg.Settings.FeaturedImageID)
				require.Equal(t, []int64{3}, arg.Settings.TermIDs)
				// The stored thumbnail URL is the media row's, as /uploads serves it.
				stored := filepath.Join(server.config.UploadPath, "x.jpg")
				require.Equal(t, "/uploads/media/x.jpg", arg.Settings.ThumbnailURL(db.Medium{MediaPath: stored}))
				return db.Post{ID: 7, Title: arg.Settings.Title}, nil
			})

		recorder := settingsRequest(t, server, http.MethodPost, url, publishEditor)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		var resp struct {
			Restored bool         `json:"restored"`
			Post     PostResponse `json:"post"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
		require.True(t, resp.Restored)
		require.Equal(t, "Published title", resp.Post.Title)
	})

	t.Run("VersionWithoutSettings", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubLivePost(store)
		stubRoleLookup(store, publishEditor)
		store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Times(1).Return(db.GetPostVersionRow{ID: 11, VersionNo: 1}, nil)
		store.EXPECT().RestorePostSettingsTx(gomock.Any(), gomock.Any()).Times(0)
		recorder := settingsRequest(t, newTestServer(t, store), http.MethodPost, url, publishEditor)
		require.Equal(t, http.StatusOK, recorder.Code)
		require.JSONEq(t, `{"restored": false}`, recorder.Body.String())
	})

	for _, tc := range []struct {
		name  string
		url   string
		user  db.User
		stubs func(store *mockdb.MockStore)
		want  int
	}{
		{"Contributor", url, contributor, func(store *mockdb.MockStore) {
			store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Times(0)
		}, http.StatusForbidden},
		{"VersionMissing", url, publishEditor, func(store *mockdb.MockStore) {
			store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Return(db.GetPostVersionRow{}, sql.ErrNoRows)
		}, http.StatusNotFound},
		{"VersionError", url, publishEditor, func(store *mockdb.MockStore) {
			store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Return(db.GetPostVersionRow{}, fmt.Errorf("db down"))
		}, http.StatusInternalServerError},
		{"PostMissing", url, publishEditor, func(store *mockdb.MockStore) {
			store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Return(db.GetPostVersionRow{Settings: publishedSettings(publishedSettingsJSON)}, nil)
			store.EXPECT().RestorePostSettingsTx(gomock.Any(), gomock.Any()).Return(db.Post{}, sql.ErrNoRows)
		}, http.StatusNotFound},
		{"RestoreError", url, publishEditor, func(store *mockdb.MockStore) {
			store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Return(db.GetPostVersionRow{Settings: publishedSettings(publishedSettingsJSON)}, nil)
			store.EXPECT().RestorePostSettingsTx(gomock.Any(), gomock.Any()).Return(db.Post{}, fmt.Errorf("db down"))
		}, http.StatusInternalServerError},
		{"BadVersion", "/api/v1/posts/7/versions/0/restore-settings", publishEditor, func(store *mockdb.MockStore) {}, http.StatusBadRequest},
		{"BadPost", "/api/v1/posts/x/versions/1/restore-settings", publishEditor, func(store *mockdb.MockStore) {}, http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			stubLivePost(store)
			stubRoleLookup(store, tc.user)
			tc.stubs(store)
			require.Equal(t, tc.want, settingsRequest(t, newTestServer(t, store), http.MethodPost, tc.url, tc.user).Code)
		})
	}
}

func TestGetPostSettingsState(t *testing.T) {
	contributor := db.User{ID: 2, Username: "contrib", Role: RoleContributor}
	// Post 7 is the contributor's own draft, which canReadPost lets them read (#393).
	ownPost := func(store *mockdb.MockStore) {
		store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(db.Post{ID: 7, UserID: contributor.ID, PostStatus: "draft"}, nil).AnyTimes()
	}
	working := `{"title": "Working title", "description": "Working excerpt", "featured_image": null, "term_ids": [3]}`

	t.Run("Changed", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubRoleLookup(store, contributor)
		ownPost(store)
		store.EXPECT().GetPostSettingsState(gomock.Any(), int64(7)).Times(1).Return(db.GetPostSettingsStateRow{
			Working: json.RawMessage(working), PublishedSettings: publishedSettings(publishedSettingsJSON), Changed: true,
		}, nil)
		// A pending scheduled update (#335) comes with the state, so other tabs follow.
		updateAt := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
		store.EXPECT().GetPostScheduledUpdate(gomock.Any(), int64(7)).Return(db.PostScheduledUpdateRow{PostID: 7, UpdateAt: updateAt}, nil)
		recorder := settingsRequest(t, newTestServer(t, store), http.MethodGet, "/api/v1/posts/7/settings", contributor)
		require.Equal(t, http.StatusOK, recorder.Code)
		var resp PostSettingsStateResponse
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
		require.True(t, resp.Changed)
		require.NotNil(t, resp.ScheduledUpdate)
		require.True(t, updateAt.Equal(resp.ScheduledUpdate.UpdateAt))
		require.Equal(t, "Working title", resp.Working.Title)
		require.Equal(t, "Published title", resp.Published.Title)
	})

	t.Run("Draft", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubRoleLookup(store, contributor)
		ownPost(store)
		store.EXPECT().GetPostSettingsState(gomock.Any(), int64(7)).Times(1).Return(db.GetPostSettingsStateRow{Working: json.RawMessage(working)}, nil)
		recorder := settingsRequest(t, newTestServer(t, store), http.MethodGet, "/api/v1/posts/7/settings", contributor)
		require.Equal(t, http.StatusOK, recorder.Code)
		// A snapshot without the SEO keys reads as their defaults (#357).
		withSEO := `{"title": "Working title", "description": "Working excerpt", "featured_image": null, "term_ids": [3],
			"seo_title": "", "seo_description": "", "social_image_id": null, "noindex": false, "canonical_url": ""}`
		require.JSONEq(t, `{"working": `+withSEO+`, "published": null, "changed": false, "blocks_changed": false, "has_unpublished_changes": false, "scheduled_update": null}`, recorder.Body.String())
	})

	// The body half (#326): the editor's publish bar reads both.
	t.Run("BlocksChanged", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubRoleLookup(store, contributor)
		ownPost(store)
		store.EXPECT().GetPostSettingsState(gomock.Any(), int64(7)).Times(1).Return(db.GetPostSettingsStateRow{
			Working: json.RawMessage(working), PublishedSettings: publishedSettings(publishedSettingsJSON),
			BlocksChanged: true, HasUnpublishedChanges: true,
		}, nil)
		store.EXPECT().GetPostScheduledUpdate(gomock.Any(), int64(7)).Return(db.PostScheduledUpdateRow{}, sql.ErrNoRows)
		recorder := settingsRequest(t, newTestServer(t, store), http.MethodGet, "/api/v1/posts/7/settings", contributor)
		require.Equal(t, http.StatusOK, recorder.Code)
		var resp PostSettingsStateResponse
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
		require.False(t, resp.Changed)
		require.True(t, resp.BlocksChanged)
		require.True(t, resp.HasUnpublishedChanges)
	})

	for _, tc := range []struct {
		name string
		row  db.GetPostSettingsStateRow
		err  error
		want int
	}{
		{"Missing", db.GetPostSettingsStateRow{}, sql.ErrNoRows, http.StatusNotFound},
		{"DBError", db.GetPostSettingsStateRow{}, fmt.Errorf("db down"), http.StatusInternalServerError},
		{"Unreadable", db.GetPostSettingsStateRow{Working: json.RawMessage(`null`)}, nil, http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			stubRoleLookup(store, contributor)
			ownPost(store)
			store.EXPECT().GetPostSettingsState(gomock.Any(), int64(7)).Return(tc.row, tc.err)
			require.Equal(t, tc.want, settingsRequest(t, newTestServer(t, store), http.MethodGet, "/api/v1/posts/7/settings", contributor).Code)
		})
	}

	// Someone else's draft: its working title and excerpt are not theirs to read (#393).
	t.Run("OthersDraft", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		stubRoleLookup(store, contributor)
		store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(db.Post{ID: 7, UserID: contributor.ID + 1, PostStatus: "draft"}, nil)
		store.EXPECT().GetPostSettingsState(gomock.Any(), gomock.Any()).Times(0)
		recorder := settingsRequest(t, newTestServer(t, store), http.MethodGet, "/api/v1/posts/7/settings", contributor)
		require.Equal(t, http.StatusForbidden, recorder.Code)
		require.NotContains(t, recorder.Body.String(), "Working title")
	})
}

// A version's response carries its settings; one from before #358 has none.
func TestGetPostVersionSettings(t *testing.T) {
	for _, tc := range []struct {
		name     string
		settings pqtype.NullRawMessage
		want     string
	}{
		{"Recorded", publishedSettings(publishedSettingsJSON), "Published title"},
		{"BeforeSnapshots", pqtype.NullRawMessage{}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			stubRoleLookup(store, publishEditor)
			store.EXPECT().GetPostVersion(gomock.Any(), gomock.Any()).Return(db.GetPostVersionRow{
				ID: 1, VersionNo: 1, Status: "published", BlockDoc: validBlockDoc(), Settings: tc.settings,
			}, nil)
			recorder := settingsRequest(t, newTestServer(t, store), http.MethodGet, "/api/v1/posts/7/versions/1", publishEditor)
			require.Equal(t, http.StatusOK, recorder.Code)
			var resp PostVersionResponse
			require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &resp))
			if tc.want == "" {
				require.Nil(t, resp.Settings)
				return
			}
			require.Equal(t, tc.want, resp.Settings.Title)
		})
	}
}

// Menus show a post's published title (#358).
func TestResolveMenuItemPublishedTitle(t *testing.T) {
	row := db.ListMenuItemsWithTargetsRow{
		ItemType:              "post",
		PostID:                sql.NullInt64{Int64: 7, Valid: true},
		PostTitle:             sql.NullString{String: "Working title", Valid: true},
		PostSlug:              sql.NullString{String: "the-post", Valid: true},
		PostPostType:          sql.NullString{String: "post", Valid: true},
		PostStatus:            sql.NullString{String: "published", Valid: true},
		PostTypePublic:        sql.NullBool{Bool: true, Valid: true},
		PostTypeActive:        sql.NullBool{Bool: true, Valid: true},
		PostPublishedSettings: publishedSettings(publishedSettingsJSON),
	}
	require.Equal(t, "Published title", resolveMenuItem(row, "id").Title)
	row.PostPublishedSettings = pqtype.NullRawMessage{}
	require.Equal(t, "Working title", resolveMenuItem(row, "id").Title)
	// A label of its own still wins.
	row.Label = "Custom"
	require.Equal(t, "Custom", resolveMenuItem(row, "id").Title)
}
