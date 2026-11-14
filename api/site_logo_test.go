package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The site logo (#488, site_logo.go): PUT /settings site_logo_media_id, and GET /settings'
// site_logo, what the Site logo block renders.

func TestSiteLogoUpdate(t *testing.T) {
	id := func(n int64) *int64 { return &n }
	for _, tc := range []struct {
		raw string
		set bool
		id  *int64
		err bool
	}{
		{"", false, nil, false},
		{"null", true, nil, false},
		{"7", true, id(7), false},
		{"0", false, nil, true},
		{"-1", false, nil, true},
		{`"7"`, false, nil, true},
		{"2.5", false, nil, true},
	} {
		set, got, err := UpdateSettingsRequest{SiteLogoMediaID: json.RawMessage(tc.raw)}.siteLogoUpdate()
		require.Equal(t, tc.err, err != nil, tc.raw)
		require.Equal(t, tc.set, set, tc.raw)
		require.Equal(t, tc.id, got, tc.raw)
	}
}

// logoMedia is an image stored under uploadPath, as uploads are.
func logoMedia(uploadPath string) db.Medium {
	return db.Medium{
		ID:               7,
		Name:             "Leaf mark",
		Alt:              "A green leaf",
		MediaPath:        filepath.Join(uploadPath, "leaf-mark-0123.png"),
		MimeType:         "image/png",
		Width:            512,
		Height:           256,
		OriginalFilename: "leaf-mark.png",
		Variants:         json.RawMessage(`{}`),
	}
}

func TestUpdateSettingsSiteLogo(t *testing.T) {
	admin := db.User{ID: 41, Username: "logo_admin", Role: RoleAdmin}
	editor := db.User{ID: 42, Username: "logo_editor", Role: RoleEditor}
	withLogo := func(id sql.NullInt64) db.Setting {
		s := randomSetting()
		s.SiteLogoMediaID = id
		return s
	}

	for _, tc := range []struct {
		name  string
		user  db.User
		body  string
		stubs func(store *mockdb.MockStore, uploadPath string)
		want  int
		check func(t *testing.T, body, uploadPath string)
	}{
		{"SetsAnImage", admin, `{"site_logo_media_id": 7}`, func(store *mockdb.MockStore, uploadPath string) {
			store.EXPECT().GetMedia(gomock.Any(), int64(7)).Return(logoMedia(uploadPath), nil).Times(2)
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(1).
				DoAndReturn(func(_ any, arg db.UpdateSettingsParams) (db.Setting, error) {
					require.True(t, arg.SetSiteLogo)
					require.Equal(t, sql.NullInt64{Int64: 7, Valid: true}, arg.SiteLogoMediaID)
					return withLogo(arg.SiteLogoMediaID), nil
				})
		}, http.StatusOK, func(t *testing.T, body, uploadPath string) {
			require.Contains(t, body, `"site_logo_media_id":7`)
			// The public path, never the stored filesystem path.
			require.Contains(t, body, `"media_path":"/uploads/`+filepath.Base(uploadPath)+`/leaf-mark-0123.png"`)
			require.Contains(t, body, `"alt":"A green leaf"`)
		}},
		{"NullRemovesIt", admin, `{"site_logo_media_id": null}`, func(store *mockdb.MockStore, uploadPath string) {
			store.EXPECT().GetMedia(gomock.Any(), gomock.Any()).Times(0)
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(1).
				DoAndReturn(func(_ any, arg db.UpdateSettingsParams) (db.Setting, error) {
					require.True(t, arg.SetSiteLogo)
					require.False(t, arg.SiteLogoMediaID.Valid)
					return withLogo(arg.SiteLogoMediaID), nil
				})
		}, http.StatusOK, func(t *testing.T, body, _ string) {
			require.Contains(t, body, `"site_logo_media_id":null`)
			require.Contains(t, body, `"site_logo":null`)
		}},
		{"AbsentKeeps", admin, `{"site_title": "Renamed"}`, func(store *mockdb.MockStore, uploadPath string) {
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(1).
				DoAndReturn(func(_ any, arg db.UpdateSettingsParams) (db.Setting, error) {
					require.False(t, arg.SetSiteLogo)
					return withLogo(sql.NullInt64{}), nil
				})
		}, http.StatusOK, nil},
		{"NotAnImage", admin, `{"site_logo_media_id": 7}`, func(store *mockdb.MockStore, uploadPath string) {
			pdf := logoMedia(uploadPath)
			pdf.MimeType = "application/pdf"
			store.EXPECT().GetMedia(gomock.Any(), int64(7)).Return(pdf, nil)
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(0)
		}, http.StatusBadRequest, func(t *testing.T, body, _ string) { require.Contains(t, body, `"code":"invalid_site_logo"`) }},
		{"MissingMedia", admin, `{"site_logo_media_id": 7}`, func(store *mockdb.MockStore, uploadPath string) {
			store.EXPECT().GetMedia(gomock.Any(), int64(7)).Return(db.Medium{}, sql.ErrNoRows)
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(0)
		}, http.StatusBadRequest, func(t *testing.T, body, _ string) { require.Contains(t, body, `"code":"invalid_site_logo"`) }},
		{"LookupError", admin, `{"site_logo_media_id": 7}`, func(store *mockdb.MockStore, uploadPath string) {
			store.EXPECT().GetMedia(gomock.Any(), int64(7)).Return(db.Medium{}, fmt.Errorf("db down"))
		}, http.StatusInternalServerError, nil},
		{"NotAnID", admin, `{"site_logo_media_id": "logo.png"}`, func(store *mockdb.MockStore, uploadPath string) {
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(0)
		}, http.StatusBadRequest, func(t *testing.T, body, _ string) { require.Contains(t, body, `"code":"invalid_site_logo"`) }},
		{"Editor", editor, `{"site_logo_media_id": 7}`, func(store *mockdb.MockStore, uploadPath string) {
			store.EXPECT().UpdateSettings(gomock.Any(), gomock.Any()).Times(0)
		}, http.StatusForbidden, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			server := newTestServer(t, store)
			tc.stubs(store, server.config.UploadPath)
			stubRoleLookup(store, tc.user)
			recorder := seoRequest(t, server, http.MethodPut, "/api/v1/settings", tc.body, tc.user)
			require.Equal(t, tc.want, recorder.Code, recorder.Body.String())
			if tc.check != nil {
				tc.check(t, recorder.Body.String(), server.config.UploadPath)
			}
		})
	}

	t.Run("RecordsTheField", func(t *testing.T) {
		require.Equal(t, []string{"site_logo_media_id"}, UpdateSettingsRequest{SiteLogoMediaID: json.RawMessage(`null`)}.setFields())
	})
}

func TestGetSettingsSiteLogo(t *testing.T) {
	t.Run("the logo's media, for the block", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		setting := randomSetting()
		setting.SiteLogoMediaID = sql.NullInt64{Int64: 7, Valid: true}
		server := newTestServer(t, store)
		store.EXPECT().GetSettings(gomock.Any()).Return(setting, nil)
		store.EXPECT().GetMedia(gomock.Any(), int64(7)).Return(logoMedia(server.config.UploadPath), nil)
		recorder := serveSettingsGET(t, server, "/api/v1/settings")
		require.Equal(t, http.StatusOK, recorder.Code)
		var body struct {
			SiteLogoMediaID *int64            `json:"site_logo_media_id"`
			SiteLogo        *SiteLogoResponse `json:"site_logo"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		require.Equal(t, int64(7), *body.SiteLogoMediaID)
		require.NotNil(t, body.SiteLogo)
		require.Equal(t, "/uploads/"+filepath.Base(server.config.UploadPath)+"/leaf-mark-0123.png", body.SiteLogo.MediaPath)
		require.Equal(t, int32(512), body.SiteLogo.Width)
		require.Equal(t, int32(256), body.SiteLogo.Height)
		require.Equal(t, "leaf-mark.png", body.SiteLogo.Filename)
	})

	t.Run("none: no lookup, null", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetSettings(gomock.Any()).Return(randomSetting(), nil)
		store.EXPECT().GetMedia(gomock.Any(), gomock.Any()).Times(0)
		recorder := serveSettingsGET(t, newTestServer(t, store), "/api/v1/settings")
		require.Equal(t, http.StatusOK, recorder.Code)
		require.Contains(t, recorder.Body.String(), `"site_logo":null`)
	})

	t.Run("a failed lookup still answers, without the logo", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		setting := randomSetting()
		setting.SiteLogoMediaID = sql.NullInt64{Int64: 7, Valid: true}
		store.EXPECT().GetSettings(gomock.Any()).Return(setting, nil)
		store.EXPECT().GetMedia(gomock.Any(), int64(7)).Return(db.Medium{}, fmt.Errorf("db down"))
		recorder := serveSettingsGET(t, newTestServer(t, store), "/api/v1/settings")
		require.Equal(t, http.StatusOK, recorder.Code)
		require.Contains(t, recorder.Body.String(), `"site_logo_media_id":7`)
		require.Contains(t, recorder.Body.String(), `"site_logo":null`)
	})
}
