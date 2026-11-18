package api

import (
	"database/sql"
	"encoding/json"
	"errors"
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

// The design preview routes (#486, design 8.3 and 12) on a mock store.

func decodePreview(t *testing.T, recorder *httptest.ResponseRecorder) DesignPreviewResponse {
	t.Helper()
	var rsp DesignPreviewResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp), recorder.Body.String())
	return rsp
}

func TestCreateDesignPreview(t *testing.T) {
	t.Run("an admin gets a token for the active theme", func(t *testing.T) {
		server, store := siteDesignServer(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(siteDesignTheme, nil)
		recorder := siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/preview", "")
		requireStatus(t, recorder, http.StatusOK)
		require.Equal(t, designPreviewCacheControl, recorder.Header().Get("Cache-Control"))

		rsp := decodePreview(t, recorder)
		require.Equal(t, siteDesignTheme.Slug, rsp.Theme)
		require.WithinDuration(t, time.Now().Add(15*time.Minute), rsp.ExpiresAt, 5*time.Second)

		payload, err := server.designPreviews.VerifyDesignPreviewToken(rsp.Token)
		require.NoError(t, err)
		require.Equal(t, siteDesignAdmin.ID, payload.UserID)
		require.Equal(t, siteDesignTheme.Slug, payload.Theme)

		// Never an API bearer token.
		_, err = server.tokenMaker.VerifyToken(rsp.Token)
		require.Error(t, err)
	})

	t.Run("no active theme", func(t *testing.T) {
		server, store := siteDesignServer(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, sql.ErrNoRows)
		recorder := siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/preview", "")
		requireStatus(t, recorder, http.StatusNotFound)
	})

	t.Run("a database error", func(t *testing.T) {
		server, store := siteDesignServer(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, errors.New("boom"))
		recorder := siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/preview", "")
		requireStatus(t, recorder, http.StatusInternalServerError)
	})
}

// draftRequest reads GET /site-design/draft with the given Authorization header ("" = none).
func draftRequest(server *Server, authorization string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "/api/v1/site-design/draft", nil)
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func previewBearer(t *testing.T, server *Server, userID int64, theme string, ttl time.Duration) string {
	t.Helper()
	tok, _, err := server.designPreviews.CreateDesignPreviewToken(userID, theme, ttl)
	require.NoError(t, err)
	return "Bearer " + tok
}

func TestDesignDraftRead(t *testing.T) {
	admin := siteDesignAdmin
	admin.PasswordChangedAt = time.Now().Add(-time.Hour)

	t.Run("an admin's token reads the draft", func(t *testing.T) {
		server, store := siteDesignServer(t)
		store.EXPECT().GetUser(gomock.Any(), admin.ID).Return(admin, nil)
		expectStylesRow(store, stylesRow(`{"colors":{"light":{"primary":"#225544"}}}`, `{}`, 3))
		recorder := draftRequest(server, previewBearer(t, server, admin.ID, siteDesignTheme.Slug, time.Minute))
		requireStatus(t, recorder, http.StatusOK)
		require.Equal(t, designPreviewCacheControl, recorder.Header().Get("Cache-Control"))

		var rsp DesignDraftResponse
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
		require.Equal(t, siteDesignTheme.Slug, rsp.Theme)
		require.JSONEq(t, `{"colors":{"light":{"primary":"#225544"}}}`, string(rsp.GlobalStyles))
		require.WithinDuration(t, time.Now().Add(time.Minute), rsp.ExpiresAt, 5*time.Second)
	})

	t.Run("a theme never saved has an empty draft", func(t *testing.T) {
		server, store := siteDesignServer(t)
		store.EXPECT().GetUser(gomock.Any(), admin.ID).Return(admin, nil)
		expectStylesRow(store, nil)
		recorder := draftRequest(server, previewBearer(t, server, admin.ID, siteDesignTheme.Slug, time.Minute))
		requireStatus(t, recorder, http.StatusOK)
		var rsp DesignDraftResponse
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
		require.JSONEq(t, `{}`, string(rsp.GlobalStyles))
	})

	t.Run("refused before the database", func(t *testing.T) {
		server, _ := siteDesignServer(t)
		access, err := server.tokenMaker.CreateToken(admin.ID, admin.Username, time.Minute)
		require.NoError(t, err)
		ticket, _, err := server.collabTickets.CreateWSTicket(admin.ID, admin.Username, "post-1", time.Minute)
		require.NoError(t, err)
		valid := previewBearer(t, server, admin.ID, siteDesignTheme.Slug, time.Minute)
		for name, header := range map[string]string{
			"no bearer":         "",
			"not bearer":        "Basic " + strings.TrimPrefix(valid, "Bearer "),
			"an extra field":    valid + " x",
			"garbage":           "Bearer not-a-token",
			"an admin's access": "Bearer " + access,
			"a collab ticket":   "Bearer " + ticket,
			"another server's":  previewBearer(t, newTestServer(t, mockdb.NewMockStore(gomock.NewController(t))), admin.ID, siteDesignTheme.Slug, time.Minute),
		} {
			recorder := draftRequest(server, header)
			require.Equal(t, http.StatusUnauthorized, recorder.Code, name)
			require.Equal(t, designPreviewCacheControl, recorder.Header().Get("Cache-Control"), name)
		}
	})

	t.Run("an expired token", func(t *testing.T) {
		server, _ := siteDesignServer(t)
		recorder := draftRequest(server, previewBearer(t, server, admin.ID, siteDesignTheme.Slug, -time.Second))
		requireCode(t, recorder, http.StatusUnauthorized, "preview_expired")
	})

	t.Run("a demoted admin's token stops working at once", func(t *testing.T) {
		server, store := siteDesignServer(t)
		bearer := previewBearer(t, server, admin.ID, siteDesignTheme.Slug, time.Minute)
		demoted := admin
		demoted.Role = RoleEditor
		store.EXPECT().GetUser(gomock.Any(), admin.ID).Return(demoted, nil)
		requireStatus(t, draftRequest(server, bearer), http.StatusForbidden)
	})

	t.Run("a removed member's token", func(t *testing.T) {
		server, store := siteDesignServer(t)
		store.EXPECT().GetUser(gomock.Any(), admin.ID).Return(db.User{}, sql.ErrNoRows)
		requireStatus(t, draftRequest(server, previewBearer(t, server, admin.ID, siteDesignTheme.Slug, time.Minute)), http.StatusForbidden)
	})

	t.Run("a password change ends it", func(t *testing.T) {
		server, store := siteDesignServer(t)
		bearer := previewBearer(t, server, admin.ID, siteDesignTheme.Slug, time.Minute)
		changed := admin
		changed.PasswordChangedAt = time.Now().Add(2 * time.Second)
		store.EXPECT().GetUser(gomock.Any(), admin.ID).Return(changed, nil)
		requireStatus(t, draftRequest(server, bearer), http.StatusUnauthorized)
	})

	t.Run("another theme was activated", func(t *testing.T) {
		server, store := siteDesignServer(t)
		store.EXPECT().GetUser(gomock.Any(), admin.ID).Return(admin, nil)
		expectStylesRow(store, stylesRow(`{}`, `{}`, 1))
		recorder := draftRequest(server, previewBearer(t, server, admin.ID, "another-theme", time.Minute))
		requireCode(t, recorder, http.StatusConflict, "preview_theme_inactive")
	})

	// #493: the Site editor's preview frame renders the working copies (design 8.3).
	t.Run("slugs: the working copies, a reset one left to the theme", func(t *testing.T) {
		server, store := siteDesignServer(t)
		store.EXPECT().GetUser(gomock.Any(), admin.ID).Return(admin, nil)
		expectStylesRow(store, nil)
		working := resolveDoc(t, [2]string{"title-0001", `{"type":"site_title","attrs":{}}`}, [2]string{"part-00001", `{"type":"template_part","attrs":{"slug":"header"}}`})
		store.EXPECT().ListSiteTemplatesByTheme(gomock.Any(), siteDesignTheme.Slug).Return([]db.SiteTemplate{
			{Kind: "template", Slug: "single", Title: "Single post", WorkingState: siteTemplateCustom, BlockDoc: working},
			// Reset: what renders after the next publish is the theme's (here core's starter).
			{Kind: "part", Slug: "header", Title: "My header", WorkingState: siteTemplateReset, BlockDoc: resolveDoc(t, [2]string{"tagline-01", `{"type":"site_tagline","attrs":{}}`})},
		}, nil)
		request := httptest.NewRequest(http.MethodGet, "/api/v1/site-design/draft?slugs=single-post,single", nil)
		request.Header.Set("Authorization", previewBearer(t, server, admin.ID, siteDesignTheme.Slug, time.Minute))
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, request)
		requireStatus(t, recorder, http.StatusOK)
		require.Equal(t, designPreviewCacheControl, recorder.Header().Get("Cache-Control"))

		var rsp DesignDraftResponse
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
		require.NotNil(t, rsp.Template)
		require.Equal(t, "single", rsp.Template.Slug)
		require.Equal(t, 1, rsp.Template.Rank)
		require.Equal(t, siteDesignSourceOverride, rsp.Template.Source)
		require.Contains(t, rsp.Template.Doc["blocks"], "title-0001")
		require.Equal(t, siteDesignSourceStarter, rsp.Parts["header"].Source, "a reset part renders the theme's default")
	})

	t.Run("slugs: refused when malformed, and a failed read", func(t *testing.T) {
		server, store := siteDesignServer(t)
		bearer := previewBearer(t, server, admin.ID, siteDesignTheme.Slug, time.Minute)
		for _, query := range []string{"slugs=Not%20a%20slug", "slugs=a,a"} {
			store.EXPECT().GetUser(gomock.Any(), admin.ID).Return(admin, nil)
			expectStylesRow(store, nil)
			request := httptest.NewRequest(http.MethodGet, "/api/v1/site-design/draft?"+query, nil)
			request.Header.Set("Authorization", bearer)
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, request)
			requireCode(t, recorder, http.StatusBadRequest, "invalid_slugs")
		}
		store.EXPECT().GetUser(gomock.Any(), admin.ID).Return(admin, nil)
		expectStylesRow(store, nil)
		store.EXPECT().ListSiteTemplatesByTheme(gomock.Any(), siteDesignTheme.Slug).Return(nil, errors.New("boom"))
		request := httptest.NewRequest(http.MethodGet, "/api/v1/site-design/draft?slugs=single", nil)
		request.Header.Set("Authorization", bearer)
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, request)
		requireStatus(t, recorder, http.StatusInternalServerError)
	})

	t.Run("database errors", func(t *testing.T) {
		server, store := siteDesignServer(t)
		store.EXPECT().GetUser(gomock.Any(), admin.ID).Return(db.User{}, errors.New("boom"))
		requireStatus(t, draftRequest(server, previewBearer(t, server, admin.ID, siteDesignTheme.Slug, time.Minute)), http.StatusInternalServerError)

		store.EXPECT().GetUser(gomock.Any(), admin.ID).Return(admin, nil)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, errors.New("boom"))
		requireStatus(t, draftRequest(server, previewBearer(t, server, admin.ID, siteDesignTheme.Slug, time.Minute)), http.StatusInternalServerError)
	})
}

// The token is never written to a log line: not when it's minted, read, refused or
// expired (design 8.3, the acceptance list).
func TestDesignPreviewTokenNeverLogged(t *testing.T) {
	logs := captureLogs(t)
	server, store := siteDesignServer(t)

	store.EXPECT().GetActiveTheme(gomock.Any()).Return(siteDesignTheme, nil)
	recorder := siteDesignRequest(t, server, store, http.MethodPost, "/api/v1/site-design/preview", "")
	requireStatus(t, recorder, http.StatusOK)
	minted := decodePreview(t, recorder).Token

	// The sign-in above already answers GetUser for the admin; the read finds them.
	expectStylesRow(store, nil)
	requireStatus(t, draftRequest(server, "Bearer "+minted), http.StatusOK)

	// Another admin's token, whose user lookup fails: the error is logged, the token isn't.
	failing := siteDesignAdmin.ID + 1
	store.EXPECT().GetUser(gomock.Any(), failing).Return(db.User{}, errors.New("boom"))
	other := previewBearer(t, server, failing, siteDesignTheme.Slug, time.Minute)
	requireStatus(t, draftRequest(server, other), http.StatusInternalServerError)

	expired := previewBearer(t, server, siteDesignAdmin.ID, siteDesignTheme.Slug, -time.Second)
	requireStatus(t, draftRequest(server, expired), http.StatusUnauthorized)
	requireStatus(t, draftRequest(server, "Bearer "+minted+"x"), http.StatusUnauthorized)

	lines := logs()
	require.NotEmpty(t, lines, "the request logger wrote nothing: the test isn't seeing the logs")
	for _, line := range lines {
		text := fmt.Sprint(line)
		for _, tok := range []string{minted, strings.TrimPrefix(other, "Bearer "), strings.TrimPrefix(expired, "Bearer ")} {
			require.NotContains(t, text, tok)
			// Nor any recognizable piece of it (the signed body starts after "v4.public.").
			require.NotContains(t, text, strings.TrimPrefix(tok, "v4.public.")[:24])
		}
	}
}
