package api

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// "Used in" for the site design (#496) on a mock store: GET /media/:id/posts lists the
// templates and parts showing a media (admins see working copies too, others only the
// published ones), a captions file through its videos, and the site logo.
// site_template_media_db_test.go checks the sync against the real database.

// stubNoSiteDesignUses: the media is in no template or part and isn't the site logo.
func stubNoSiteDesignUses(store *mockdb.MockStore, mediaID int64) {
	store.EXPECT().ListSiteTemplatesByMedia(gomock.Any(), mediaID).Return(nil, nil)
	store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, nil)
}

type mediaUsedInBody struct {
	Posts         []PostWithMediaOrderResponse `json:"posts"`
	SiteTemplates []MediaSiteTemplateUse       `json:"site_templates"`
	SiteLogo      bool                         `json:"site_logo"`
}

func getMediaUsedIn(t *testing.T, server *Server, user db.User, mediaID string) (*httptest.ResponseRecorder, mediaUsedInBody) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/media/"+mediaID+"/posts", nil)
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	var body mediaUsedInBody
	if recorder.Code == http.StatusOK {
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	}
	return recorder, body
}

func TestGetMediaPostsSiteDesign(t *testing.T) {
	admin := db.User{ID: 9601, Username: "admin", Role: RoleAdmin}
	editor := db.User{ID: 9602, Username: "editor", Role: RoleEditor}
	rows := []db.ListSiteTemplatesByMediaRow{
		// The header part shows it, published and in its working copy, by the same block.
		{ID: 5, ThemeSlug: "default", Kind: "part", Slug: "header", Title: "Header", BlockID: "logo-img-01", BlockType: "image", Published: true},
		{ID: 5, ThemeSlug: "default", Kind: "part", Slug: "header", Title: "Header", BlockID: "logo-img-01", BlockType: "image", Published: false},
		{ID: 5, ThemeSlug: "default", Kind: "part", Slug: "header", Title: "Header", BlockID: "cover-0001", BlockType: "cover", Published: false},
		// A template not published yet: only its working copy shows it.
		{ID: 8, ThemeSlug: "default", Kind: "template", Slug: "single", Title: "Single post", BlockID: "img-000001", BlockType: "image", Published: false},
	}

	for _, tc := range []struct {
		user db.User
		want []MediaSiteTemplateUse
	}{
		{admin, []MediaSiteTemplateUse{
			{ID: 5, Theme: "default", Kind: "part", Slug: "header", Title: "Header", Published: true, Working: true, Usages: []MediaUsage{
				{Type: MediaUsageBlock, BlockID: "logo-img-01", BlockType: "image"},
				{Type: MediaUsageBlock, BlockID: "cover-0001", BlockType: "cover"},
			}},
			{ID: 8, Theme: "default", Kind: "template", Slug: "single", Title: "Single post", Working: true, Usages: []MediaUsage{
				{Type: MediaUsageBlock, BlockID: "img-000001", BlockType: "image"},
			}},
		}},
		// Not an admin: what the site shows only, never a working copy.
		{editor, []MediaSiteTemplateUse{
			{ID: 5, Theme: "default", Kind: "part", Slug: "header", Title: "Header", Published: true, Usages: []MediaUsage{
				{Type: MediaUsageBlock, BlockID: "logo-img-01", BlockType: "image"},
			}},
		}},
	} {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		stubRoleLookup(store, tc.user)
		store.EXPECT().GetMedia(gomock.Any(), int64(40)).Return(db.Medium{ID: 40, MimeType: "image/png"}, nil)
		store.EXPECT().GetPostsByMedia(gomock.Any(), int64(40)).Return(nil, nil)
		store.EXPECT().ListSiteTemplatesByMedia(gomock.Any(), int64(40)).Return(rows, nil)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{SiteLogoMediaID: sql.NullInt64{Int64: 40, Valid: true}}, nil)
		server := newTestServer(t, store)

		recorder, body := getMediaUsedIn(t, server, tc.user, "40")
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Equal(t, tc.want, body.SiteTemplates, tc.user.Username)
		require.True(t, body.SiteLogo, "the site logo is its own entry")
		require.Empty(t, body.Posts)
		ctrl.Finish()
	}
}

// A captions file is used where a video it captions is shown by a video block.
func TestGetMediaPostsSiteDesignCaptions(t *testing.T) {
	admin := db.User{ID: 9601, Username: "admin", Role: RoleAdmin}
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	stubRoleLookup(store, admin)
	store.EXPECT().GetMedia(gomock.Any(), int64(31)).Return(db.Medium{ID: 31, MimeType: captionsMimeType}, nil)
	store.EXPECT().GetPostsByMedia(gomock.Any(), int64(31)).Return(nil, nil)
	store.EXPECT().GetPostsByCaptionsMedia(gomock.Any(), int64(31)).Return(nil, nil)
	store.EXPECT().ListSiteTemplatesByMedia(gomock.Any(), gomock.Any()).Times(0)
	store.EXPECT().ListSiteTemplatesByCaptionsMedia(gomock.Any(), int64(31)).Return([]db.ListSiteTemplatesByCaptionsMediaRow{
		{ID: 6, ThemeSlug: "default", Kind: "part", Slug: "footer", Title: "Footer", BlockID: "video-0001", BlockType: "video", Published: true},
	}, nil)
	store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{SiteLogoMediaID: sql.NullInt64{Int64: 99, Valid: true}}, nil)
	server := newTestServer(t, store)

	recorder, body := getMediaUsedIn(t, server, admin, "31")
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Equal(t, []MediaSiteTemplateUse{{ID: 6, Theme: "default", Kind: "part", Slug: "footer", Title: "Footer", Published: true, Usages: []MediaUsage{
		{Type: MediaUsageCaptions, BlockID: "video-0001", BlockType: "video"},
	}}}, body.SiteTemplates)
	require.False(t, body.SiteLogo)
}

// No use at all is an empty list and false, never null; a failed lookup is a 500.
func TestGetMediaPostsSiteDesignEmptyAndFailures(t *testing.T) {
	admin := db.User{ID: 9601, Username: "admin", Role: RoleAdmin}
	for _, tc := range []struct {
		name  string
		stubs func(store *mockdb.MockStore)
		code  int
	}{
		{"Empty", func(store *mockdb.MockStore) { stubNoSiteDesignUses(store, 41) }, http.StatusOK},
		{"TemplatesFail", func(store *mockdb.MockStore) {
			store.EXPECT().ListSiteTemplatesByMedia(gomock.Any(), int64(41)).Return(nil, sql.ErrConnDone)
		}, http.StatusInternalServerError},
		{"SettingsFail", func(store *mockdb.MockStore) {
			store.EXPECT().ListSiteTemplatesByMedia(gomock.Any(), int64(41)).Return(nil, nil)
			store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, sql.ErrConnDone)
		}, http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			stubRoleLookup(store, admin)
			store.EXPECT().GetMedia(gomock.Any(), int64(41)).Return(db.Medium{ID: 41, MimeType: "image/png"}, nil)
			store.EXPECT().GetPostsByMedia(gomock.Any(), int64(41)).Return(nil, nil)
			tc.stubs(store)
			server := newTestServer(t, store)

			recorder, _ := getMediaUsedIn(t, server, admin, "41")
			require.Equal(t, tc.code, recorder.Code, recorder.Body.String())
			if tc.code == http.StatusOK {
				require.Contains(t, recorder.Body.String(), `"site_templates":[]`)
				require.Contains(t, recorder.Body.String(), `"site_logo":false`)
			}
		})
	}
}

// The publish hook syncs the published copy's media; a reset (NULL) syncs none.
func TestPublishedSiteTemplateHookUses(t *testing.T) {
	require.Equal(t, []db.ContentMediaUse{{MediaID: 7, BlockID: "img-000001", BlockType: "image"}},
		publishedContentMedia(json.RawMessage(`{"doc_version":1,"blocks_order":["img-000001"],"blocks":{"img-000001":{"id":"img-000001","type":"image","version":2,"attrs":{"mediaId":7,"src":"/uploads/a.png"}}}}`)))
	params := db.SiteTemplateMediaParams(3, true, nil)
	require.Equal(t, int64(3), params.TemplateID)
	require.True(t, params.Published)
	require.Empty(t, params.MediaIds, "a reset publishes no media: its published rows go")
}
