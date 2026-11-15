package api

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/google/uuid"
	"github.com/lib/pq"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The template-<id> collab document kind on the API's side (#490, design 7.2): the doc
// name, the access lookup, tickets, the internal load and store routes, and Customize, on
// the mock store. site_templates_db_test.go runs the same against the database.

func TestCollabDocRef(t *testing.T) {
	for name, want := range map[string]struct {
		kind collabDocKind
		id   int64
	}{
		"post-12":                      {collabDocPost, 12},
		"template-3":                   {collabDocTemplate, 3},
		"template-9223372036854775807": {collabDocTemplate, 9223372036854775807},
	} {
		kind, id, ok := collabDocRef(name)
		require.True(t, ok, name)
		require.Equal(t, want.kind, kind, name)
		require.Equal(t, want.id, id, name)
	}
	for _, bad := range []string{"", "template-", "template-0", "template-01", "Template-1", "templates-1", "part-1", "template-9223372036854775808", "template-1?x"} {
		_, _, ok := collabDocRef(bad)
		require.False(t, ok, bad)
	}
	_, ok := postIDFromCollabDoc("template-3")
	require.False(t, ok, "a template name is not a post's")
	id, ok := postIDFromCollabDoc("post-3")
	require.True(t, ok)
	require.Equal(t, int64(3), id)
	require.Equal(t, "template-41", siteTemplateDocName(41))
}

func TestInternalDocAccessTemplate(t *testing.T) {
	issuedAt := time.Now().Unix()
	admin := db.User{ID: 61, Username: "admin", Role: RoleAdmin}
	editor := db.User{ID: 62, Username: "editor", Role: RoleEditor}

	for _, tc := range []struct {
		name   string
		user   db.User
		lookup error
		status int
		body   string
	}{
		{name: "AdminEdits", user: admin, status: http.StatusOK, body: `{"role":"admin","can_edit":true}`},
		// can_edit false: the collab server's kind-aware accessMode denies it (never read-only).
		{name: "EditorDoesNot", user: editor, status: http.StatusOK, body: `{"role":"editor","can_edit":false}`},
		{name: "MissingTemplate", user: admin, lookup: sql.ErrNoRows, status: http.StatusNotFound},
		{name: "LookupFails", user: admin, lookup: errors.New("db down"), status: http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			store.EXPECT().GetUser(gomock.Any(), tc.user.ID).Return(tc.user, nil)
			store.EXPECT().GetSiteTemplate(gomock.Any(), int64(7)).Return(db.SiteTemplate{ID: 7}, tc.lookup)
			store.EXPECT().GetPost(gomock.Any(), gomock.Any()).Times(0)
			server := newTestServer(t, store)
			path := fmt.Sprintf("/internal/users/%d/access?doc=template-7&issued_at=%d", tc.user.ID, issuedAt)
			recorder := internalCollabRequest(t, server, http.MethodGet, path, nil, "Bearer "+testRoleLookupSecret)
			require.Equal(t, tc.status, recorder.Code, recorder.Body.String())
			if tc.body != "" {
				require.JSONEq(t, tc.body, recorder.Body.String())
			}
		})
	}

	t.Run("PasswordChangedSinceTheTicket", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		changed := admin
		changed.PasswordChangedAt = time.Now().Add(time.Hour)
		store.EXPECT().GetUser(gomock.Any(), admin.ID).Return(changed, nil)
		store.EXPECT().GetSiteTemplate(gomock.Any(), gomock.Any()).Times(0)
		server := newTestServer(t, store)
		path := fmt.Sprintf("/internal/users/%d/access?doc=template-7&issued_at=%d", admin.ID, issuedAt)
		require.Equal(t, http.StatusForbidden, internalCollabRequest(t, server, http.MethodGet, path, nil, "Bearer "+testRoleLookupSecret).Code)
	})
}

func TestCollabTicketForTemplate(t *testing.T) {
	admin := randomUserNew()
	admin.Role = RoleAdmin
	editor := randomUserNew()
	editor.ID = admin.ID + 1
	editor.Role = RoleEditor

	store := mockdb.NewMockStore(gomock.NewController(t))
	stubRoleLookup(store, admin)
	stubRoleLookup(store, editor)
	store.EXPECT().GetSiteTemplate(gomock.Any(), int64(4)).Return(db.SiteTemplate{ID: 4}, nil).AnyTimes()
	store.EXPECT().GetSiteTemplate(gomock.Any(), int64(5)).Return(db.SiteTemplate{}, sql.ErrNoRows).AnyTimes()
	store.EXPECT().GetSiteTemplate(gomock.Any(), int64(6)).Return(db.SiteTemplate{}, errors.New("db down")).AnyTimes()
	server := newTestServer(t, store)

	recorder := postCollabTicket(t, server, gin.H{"doc": "template-4"}, &admin)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var res struct {
		Ticket string `json:"ticket"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &res))
	payload, err := server.collabTickets.VerifyWSTicket(res.Ticket)
	require.NoError(t, err)
	require.Equal(t, "template-4", payload.Doc)

	require.Equal(t, http.StatusForbidden, postCollabTicket(t, server, gin.H{"doc": "template-4"}, &editor).Code)
	require.Equal(t, http.StatusNotFound, postCollabTicket(t, server, gin.H{"doc": "template-5"}, &admin).Code)
	require.Equal(t, http.StatusInternalServerError, postCollabTicket(t, server, gin.H{"doc": "template-6"}, &admin).Code)
	require.Equal(t, http.StatusBadRequest, postCollabTicket(t, server, gin.H{"doc": "template-0"}, &admin).Code)
}

func TestGetInternalSiteTemplateCollab(t *testing.T) {
	epoch := uuid.New()
	doc := json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`)
	auth := "Bearer " + testRoleLookupSecret
	row := func(revision, stateRevision int64) db.GetSiteTemplateCollabRow {
		return db.GetSiteTemplateCollabRow{
			Kind:              "part",
			BlockDoc:          doc,
			BlockRevision:     revision,
			YdocState:         []byte{1, 2, 3},
			YdocEpoch:         uuid.NullUUID{UUID: epoch, Valid: true},
			YdocBlockRevision: sql.NullInt64{Int64: stateRevision, Valid: true},
		}
	}
	for _, tc := range []struct {
		name   string
		path   string
		stub   func(store *mockdb.MockStore)
		status int
		body   string
	}{
		{
			name: "StateMatchesRevision", path: "/internal/site-templates/7/collab",
			stub: func(store *mockdb.MockStore) {
				store.EXPECT().GetSiteTemplateCollab(gomock.Any(), int64(7)).Return(row(4, 4), nil)
			},
			status: http.StatusOK,
			body: fmt.Sprintf(`{"doc_kind":"part","block_doc":%s,"block_revision":4,"ydoc_state":%q,"epoch":%q}`,
				doc, base64.StdEncoding.EncodeToString([]byte{1, 2, 3}), epoch),
		},
		{
			// Rule 12: block_doc was written around the collab server, so the state is withheld.
			name: "StaleStateOmitted", path: "/internal/site-templates/7/collab",
			stub: func(store *mockdb.MockStore) {
				store.EXPECT().GetSiteTemplateCollab(gomock.Any(), int64(7)).Return(row(5, 4), nil)
			},
			status: http.StatusOK,
			body:   fmt.Sprintf(`{"doc_kind":"part","block_doc":%s,"block_revision":5}`, doc),
		},
		{
			name: "NotFound", path: "/internal/site-templates/7/collab",
			stub: func(store *mockdb.MockStore) {
				store.EXPECT().GetSiteTemplateCollab(gomock.Any(), int64(7)).Return(db.GetSiteTemplateCollabRow{}, sql.ErrNoRows)
			},
			status: http.StatusNotFound,
		},
		{
			name: "DatabaseError", path: "/internal/site-templates/7/collab",
			stub: func(store *mockdb.MockStore) {
				store.EXPECT().GetSiteTemplateCollab(gomock.Any(), int64(7)).Return(db.GetSiteTemplateCollabRow{}, errors.New("down"))
			},
			status: http.StatusInternalServerError,
		},
		{name: "InvalidID", path: "/internal/site-templates/0/collab", stub: func(*mockdb.MockStore) {}, status: http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			tc.stub(store)
			server := newTestServer(t, store)
			recorder := internalCollabRequest(t, server, http.MethodGet, tc.path, nil, auth)
			require.Equal(t, tc.status, recorder.Code, recorder.Body.String())
			if tc.body != "" {
				require.JSONEq(t, tc.body, recorder.Body.String())
			}
		})
	}

	t.Run("NeedsTheSecret", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server := newTestServer(t, store)
		require.Equal(t, http.StatusUnauthorized, internalCollabRequest(t, server, http.MethodGet, "/internal/site-templates/7/collab", nil, "").Code)
		require.Equal(t, http.StatusUnauthorized, internalCollabRequest(t, server, http.MethodPut, "/internal/site-templates/7/collab", nil, "Bearer "+testCollabInternalSecret).Code)
	})
}

// templateStoreBody is a store of a template whose block_doc holds a template_part: valid
// in a template, refused in a part.
func templateStoreBody(t *testing.T, fields map[string]any) []byte {
	t.Helper()
	body := map[string]any{
		"state": base64.StdEncoding.EncodeToString([]byte{1, 2, 3}),
		"epoch": "6f1c5f4e-9a59-4d55-9a4d-2b8f0d9e1a01",
		"block_doc": map[string]any{
			"doc_version":  1,
			"blocks_order": []string{"part-header1", "part-header1"},
			"blocks": map[string]any{
				"part-header1": map[string]any{"id": "part-header1", "type": "template_part", "version": 1, "attrs": map[string]any{"slug": "header", "html": "<script>"}},
			},
		},
		"last_editor_id": 3,
		"base_revision":  4,
	}
	for k, v := range fields {
		if v == nil {
			delete(body, k)
		} else {
			body[k] = v
		}
	}
	data, err := json.Marshal(body)
	require.NoError(t, err)
	return data
}

func TestPutInternalSiteTemplateCollab(t *testing.T) {
	const path = "/internal/site-templates/7/collab"
	auth := "Bearer " + testRoleLookupSecret
	template := db.SiteTemplate{ID: 7, Kind: "template"}
	part := db.SiteTemplate{ID: 7, Kind: "part"}

	for _, tc := range []struct {
		name   string
		body   []byte
		stub   func(t *testing.T, store *mockdb.MockStore)
		status int
		body2  string
	}{
		{
			name: "TemplateStores",
			body: templateStoreBody(t, nil),
			stub: func(t *testing.T, store *mockdb.MockStore) {
				store.EXPECT().GetSiteTemplate(gomock.Any(), int64(7)).Return(template, nil)
				store.EXPECT().StoreSiteTemplateCollabTx(gomock.Any(), gomock.Any()).
					DoAndReturn(func(_ any, arg db.StoreSiteTemplateCollabTxParams) (db.StoreSiteTemplateCollabTxResult, error) {
						require.Equal(t, int64(7), arg.TemplateID)
						require.Equal(t, []byte{1, 2, 3}, arg.State)
						require.Equal(t, sql.NullInt64{Int64: 3, Valid: true}, arg.LastEditorID)
						require.Equal(t, activityEditWindow, arg.EditActivityWindow)
						require.Equal(t, sql.NullInt64{Int64: 4, Valid: true}, arg.BaseRevision)
						var doc BlockDocV1
						require.NoError(t, json.Unmarshal(arg.BlockDoc, &doc))
						require.Equal(t, []string{"part-header1"}, doc.BlocksOrder)
						require.NotContains(t, string(arg.BlockDoc), "<script>")
						return db.StoreSiteTemplateCollabTxResult{BlockRevision: 5}, nil
					})
			},
			status: http.StatusOK,
			body2:  `{"block_revision":5,"epoch":"6f1c5f4e-9a59-4d55-9a4d-2b8f0d9e1a01"}`,
		},
		{
			// The kind's rules (design 4.2): a part never holds a template_part.
			name: "PartRefusesATemplatePart",
			body: templateStoreBody(t, nil),
			stub: func(t *testing.T, store *mockdb.MockStore) {
				store.EXPECT().GetSiteTemplate(gomock.Any(), int64(7)).Return(part, nil)
				store.EXPECT().StoreSiteTemplateCollabTx(gomock.Any(), gomock.Any()).Times(0)
			},
			status: http.StatusBadRequest,
		},
		{
			name: "StateOnly",
			body: templateStoreBody(t, map[string]any{"block_doc": nil, "last_editor_id": nil}),
			stub: func(t *testing.T, store *mockdb.MockStore) {
				store.EXPECT().GetSiteTemplate(gomock.Any(), gomock.Any()).Times(0)
				store.EXPECT().StoreSiteTemplateCollabTx(gomock.Any(), gomock.Any()).
					DoAndReturn(func(_ any, arg db.StoreSiteTemplateCollabTxParams) (db.StoreSiteTemplateCollabTxResult, error) {
						require.Nil(t, arg.BlockDoc)
						require.Zero(t, arg.EditActivityWindow)
						return db.StoreSiteTemplateCollabTxResult{BlockRevision: 4}, nil
					})
			},
			status: http.StatusOK,
		},
		{
			name:   "StateOnlyNeedsABaseRevision",
			body:   templateStoreBody(t, map[string]any{"block_doc": nil, "base_revision": nil}),
			stub:   func(t *testing.T, store *mockdb.MockStore) {},
			status: http.StatusBadRequest,
		},
		{
			name:   "NoBlockEditsOnATemplate",
			body:   templateStoreBody(t, map[string]any{"block_edits": []any{}}),
			stub:   func(t *testing.T, store *mockdb.MockStore) {},
			status: http.StatusBadRequest,
		},
		{
			name:   "BadEpoch",
			body:   templateStoreBody(t, map[string]any{"epoch": "nope"}),
			stub:   func(t *testing.T, store *mockdb.MockStore) {},
			status: http.StatusBadRequest,
		},
		{
			name:   "NoState",
			body:   templateStoreBody(t, map[string]any{"state": ""}),
			stub:   func(t *testing.T, store *mockdb.MockStore) {},
			status: http.StatusBadRequest,
		},
		{
			name: "Conflict",
			body: templateStoreBody(t, map[string]any{"block_doc": nil}),
			stub: func(t *testing.T, store *mockdb.MockStore) {
				store.EXPECT().StoreSiteTemplateCollabTx(gomock.Any(), gomock.Any()).Return(db.StoreSiteTemplateCollabTxResult{}, db.ErrCollabRevisionConflict)
			},
			status: http.StatusConflict,
		},
		{
			name: "GoneDuringTheStore",
			body: templateStoreBody(t, map[string]any{"block_doc": nil}),
			stub: func(t *testing.T, store *mockdb.MockStore) {
				store.EXPECT().StoreSiteTemplateCollabTx(gomock.Any(), gomock.Any()).Return(db.StoreSiteTemplateCollabTxResult{}, sql.ErrNoRows)
			},
			status: http.StatusNotFound,
		},
		{
			name: "MissingTemplate",
			body: templateStoreBody(t, nil),
			stub: func(t *testing.T, store *mockdb.MockStore) {
				store.EXPECT().GetSiteTemplate(gomock.Any(), int64(7)).Return(db.SiteTemplate{}, sql.ErrNoRows)
			},
			status: http.StatusNotFound,
		},
		{
			name: "LookupFails",
			body: templateStoreBody(t, nil),
			stub: func(t *testing.T, store *mockdb.MockStore) {
				store.EXPECT().GetSiteTemplate(gomock.Any(), int64(7)).Return(db.SiteTemplate{}, errors.New("down"))
			},
			status: http.StatusInternalServerError,
		},
		{
			name: "StoreFails",
			body: templateStoreBody(t, map[string]any{"block_doc": nil}),
			stub: func(t *testing.T, store *mockdb.MockStore) {
				store.EXPECT().StoreSiteTemplateCollabTx(gomock.Any(), gomock.Any()).Return(db.StoreSiteTemplateCollabTxResult{}, errors.New("down"))
			},
			status: http.StatusInternalServerError,
		},
		{
			name: "BaseRevisionRequiredFromTheTx",
			body: templateStoreBody(t, map[string]any{"block_doc": nil}),
			stub: func(t *testing.T, store *mockdb.MockStore) {
				store.EXPECT().StoreSiteTemplateCollabTx(gomock.Any(), gomock.Any()).Return(db.StoreSiteTemplateCollabTxResult{}, db.ErrCollabBaseRevisionRequired)
			},
			status: http.StatusBadRequest,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := mockdb.NewMockStore(gomock.NewController(t))
			tc.stub(t, store)
			server := newTestServer(t, store)
			recorder := internalCollabRequest(t, server, http.MethodPut, path, tc.body, auth)
			require.Equal(t, tc.status, recorder.Code, recorder.Body.String())
			if tc.body2 != "" {
				require.JSONEq(t, tc.body2, recorder.Body.String())
			}
		})
	}
	t.Run("InvalidID", func(t *testing.T) {
		server := newTestServer(t, mockdb.NewMockStore(gomock.NewController(t)))
		require.Equal(t, http.StatusBadRequest, internalCollabRequest(t, server, http.MethodPut, "/internal/site-templates/x/collab", templateStoreBody(t, nil), auth).Code)
	})
}

func createTemplateRequest(t *testing.T, server *Server, caller db.User, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/site-design/templates", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, caller.ID, caller.Username, time.Minute)
	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	return recorder
}

func TestCreateSiteTemplate(t *testing.T) {
	admin := db.User{ID: 71, Username: "admin", Role: RoleAdmin}
	shipped, err := validateThemeBlockTemplate(themeBlockTemplateFile{Kind: "template", Slug: "single", Raw: []byte(shippedTemplate)}, ThemeBlockManifest{})
	require.NoError(t, err)
	config, err := json.Marshal(map[string]any{"block_templates": map[string]ThemeBlockTemplate{"single": shipped}})
	require.NoError(t, err)
	theme := db.Theme{ID: 3, Slug: "shipping", Config: config}

	setup := func(t *testing.T) (*mockdb.MockStore, *Server) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		store.EXPECT().GetUser(gomock.Any(), admin.ID).Return(admin, nil).AnyTimes()
		return store, newTestServer(t, store)
	}
	created := func(store *mockdb.MockStore, check func(arg db.CreateSiteTemplateParams)) {
		store.EXPECT().CreateSiteTemplate(gomock.Any(), gomock.Any()).DoAndReturn(func(_ any, arg db.CreateSiteTemplateParams) (db.SiteTemplate, error) {
			check(arg)
			return db.SiteTemplate{ID: 41, ThemeSlug: arg.ThemeSlug, Kind: arg.Kind, Slug: arg.Slug, Title: arg.Title, BlockDoc: arg.BlockDoc,
				BlockRevision: 1, WorkingState: "custom", Source: arg.Source, SourceHash: arg.SourceHash}, nil
		})
	}

	t.Run("FromTheThemeDefault", func(t *testing.T) {
		store, server := setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(theme, nil)
		created(store, func(arg db.CreateSiteTemplateParams) {
			require.Equal(t, "shipping", arg.ThemeSlug)
			require.Equal(t, "theme", arg.Source)
			require.Equal(t, shipped.Hash, arg.SourceHash)
			require.Equal(t, "Single post", arg.Title)
			require.Equal(t, sql.NullInt64{Int64: admin.ID, Valid: true}, arg.CreatedBy)
			var doc BlockDocV1
			require.NoError(t, json.Unmarshal(arg.BlockDoc, &doc))
			require.Len(t, doc.BlocksOrder, 2)
			// Fresh block ids: a copy never shares the theme file's.
			require.NotContains(t, doc.Blocks, "part-header-01")
		})
		recorder := createTemplateRequest(t, server, admin, `{"kind":"template","slug":"single","from":"theme"}`)
		require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
		var res SiteTemplateResponse
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &res))
		require.Equal(t, "template-41", res.DocName)
		require.Equal(t, "theme", res.Source)
		require.False(t, res.Published)
		require.Equal(t, []string{db.ActivitySiteTemplateCreated + " site_design:41"}, activityOf(t, server).verbs())
	})

	t.Run("FromAStarterWithATitle", func(t *testing.T) {
		store, server := setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(theme, nil)
		created(store, func(arg db.CreateSiteTemplateParams) {
			require.Equal(t, "header", arg.Slug)
			require.Equal(t, "part", arg.Kind)
			require.Equal(t, "starter", arg.Source)
			require.Equal(t, "Top bar", arg.Title)
			require.Len(t, arg.SourceHash, 64)
			require.NotContains(t, string(arg.BlockDoc), "starter-header-logo")
			require.Contains(t, string(arg.BlockDoc), `"navigation"`)
		})
		recorder := createTemplateRequest(t, server, admin, `{"kind":"part","slug":"header","from":"starter","title":"  Top bar "}`)
		require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
	})

	t.Run("ATemplateStarterIsTitledFromItsSlug", func(t *testing.T) {
		store, server := setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(theme, nil)
		created(store, func(arg db.CreateSiteTemplateParams) {
			require.Equal(t, "single-case_study", arg.Slug)
			require.Equal(t, humanizeTemplateName("single-case_study"), arg.Title)
			require.Contains(t, string(arg.BlockDoc), `"template_part"`)
		})
		recorder := createTemplateRequest(t, server, admin, `{"kind":"template","slug":"single-case_study","from":"starter"}`)
		require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
	})

	t.Run("Blank", func(t *testing.T) {
		store, server := setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(theme, nil)
		created(store, func(arg db.CreateSiteTemplateParams) {
			require.JSONEq(t, `{}`, string(arg.BlockDoc))
			require.Equal(t, "blank", arg.Source)
			require.Empty(t, arg.SourceHash)
		})
		recorder := createTemplateRequest(t, server, admin, `{"kind":"template","slug":"custom-landing","from":"blank"}`)
		require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
		var res SiteTemplateResponse
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &res))
		// {} comes back as a well-formed empty doc (#304).
		require.JSONEq(t, `{"doc_version":1,"blocks_order":[],"blocks":{}}`, string(res.BlockDoc))
	})

	t.Run("Refusals", func(t *testing.T) {
		for _, tc := range []struct {
			name, body string
			status     int
			code       string
			theme      bool
		}{
			{name: "BadSlug", body: `{"kind":"template","slug":"Single","from":"blank"}`, status: http.StatusBadRequest, code: "invalid_slug"},
			{name: "PathSlug", body: `{"kind":"template","slug":"../x","from":"blank"}`, status: http.StatusBadRequest, code: "invalid_slug"},
			{name: "UnknownKind", body: `{"kind":"page","slug":"single","from":"blank"}`, status: http.StatusBadRequest},
			{name: "UnknownSource", body: `{"kind":"template","slug":"single","from":"web"}`, status: http.StatusBadRequest},
			{name: "UnknownField", body: `{"kind":"template","slug":"single","from":"blank","block_doc":{}}`, status: http.StatusBadRequest},
			{name: "TwoLineTitle", body: `{"kind":"template","slug":"single","from":"blank","title":"a\nb"}`, status: http.StatusBadRequest, code: "invalid_title", theme: true},
			{name: "LongTitle", body: `{"kind":"template","slug":"single","from":"blank","title":"` + strings.Repeat("a", 121) + `"}`, status: http.StatusBadRequest, code: "invalid_title", theme: true},
			{name: "NoThemeDefault", body: `{"kind":"template","slug":"archive","from":"theme"}`, status: http.StatusNotFound, code: "no_theme_default", theme: true},
			{name: "NoThemePart", body: `{"kind":"part","slug":"single","from":"theme"}`, status: http.StatusNotFound, code: "no_theme_default", theme: true},
			{name: "NoStarter", body: `{"kind":"part","slug":"sidebar","from":"starter"}`, status: http.StatusNotFound, code: "no_starter", theme: true},
		} {
			t.Run(tc.name, func(t *testing.T) {
				store, server := setup(t)
				if tc.theme {
					store.EXPECT().GetActiveTheme(gomock.Any()).Return(theme, nil)
				}
				store.EXPECT().CreateSiteTemplate(gomock.Any(), gomock.Any()).Times(0)
				recorder := createTemplateRequest(t, server, admin, tc.body)
				require.Equal(t, tc.status, recorder.Code, recorder.Body.String())
				if tc.code != "" {
					requireCode(t, recorder, tc.status, tc.code)
				}
			})
		}
	})

	t.Run("NoActiveTheme", func(t *testing.T) {
		store, server := setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, sql.ErrNoRows)
		require.Equal(t, http.StatusNotFound, createTemplateRequest(t, server, admin, `{"kind":"template","slug":"single","from":"blank"}`).Code)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{}, errors.New("down"))
		require.Equal(t, http.StatusInternalServerError, createTemplateRequest(t, server, admin, `{"kind":"template","slug":"single","from":"blank"}`).Code)
	})

	t.Run("AShippedDefaultThatNoLongerValidates", func(t *testing.T) {
		store, server := setup(t)
		bad, err := json.Marshal(map[string]any{"block_parts": map[string]ThemeBlockTemplate{"header": {
			Title: "Header",
			Doc:   json.RawMessage(`{"doc_version":1,"blocks_order":["p-00000001"],"blocks":{"p-00000001":{"id":"p-00000001","type":"template_part","version":1,"attrs":{"slug":"x"}}}}`),
		}}})
		require.NoError(t, err)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(db.Theme{Slug: "shipping", Config: bad}, nil)
		store.EXPECT().CreateSiteTemplate(gomock.Any(), gomock.Any()).Times(0)
		requireCode(t, createTemplateRequest(t, server, admin, `{"kind":"part","slug":"header","from":"theme"}`), http.StatusBadRequest, "template_invalid")
	})

	t.Run("AlreadyCustomized", func(t *testing.T) {
		store, server := setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(theme, nil)
		store.EXPECT().CreateSiteTemplate(gomock.Any(), gomock.Any()).Return(db.SiteTemplate{}, &pq.Error{Code: "23505"})
		store.EXPECT().GetSiteTemplateBySlug(gomock.Any(), db.GetSiteTemplateBySlugParams{ThemeSlug: "shipping", Kind: "template", Slug: "single"}).
			Return(db.SiteTemplate{ID: 9}, nil)
		recorder := createTemplateRequest(t, server, admin, `{"kind":"template","slug":"single","from":"blank"}`)
		rsp := requireCode(t, recorder, http.StatusConflict, "template_exists")
		require.JSONEq(t, "9", string(rsp["id"]))
		require.Empty(t, activityOf(t, server).verbs())
	})

	t.Run("CreateFails", func(t *testing.T) {
		store, server := setup(t)
		store.EXPECT().GetActiveTheme(gomock.Any()).Return(theme, nil)
		store.EXPECT().CreateSiteTemplate(gomock.Any(), gomock.Any()).Return(db.SiteTemplate{}, errors.New("down"))
		require.Equal(t, http.StatusInternalServerError, createTemplateRequest(t, server, admin, `{"kind":"template","slug":"single","from":"blank"}`).Code)
	})

	t.Run("EditorsCant", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		editor := db.User{ID: 72, Username: "editor", Role: RoleEditor}
		store.EXPECT().GetUser(gomock.Any(), editor.ID).Return(editor, nil).AnyTimes()
		store.EXPECT().CreateSiteTemplate(gomock.Any(), gomock.Any()).Times(0)
		server := newTestServer(t, store)
		require.Equal(t, http.StatusForbidden, createTemplateRequest(t, server, editor, `{"kind":"template","slug":"single","from":"blank"}`).Code)
	})
}

func TestFlushCollabTemplate(t *testing.T) {
	var path atomic.Value
	collab := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path.Store(r.URL.Path)
		if r.Header.Get(authorizationHeaderKey) != "Bearer "+testCollabInternalSecret {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if strings.Contains(r.URL.Path, "template-9") {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer collab.Close()
	server := newCollabTestServer(t, mockdb.NewMockStore(gomock.NewController(t)), collab.URL)
	require.NoError(t, server.flushCollabTemplate(t.Context(), 4, "req-1234567890"))
	require.Equal(t, "/internal/documents/template-4/flush", path.Load())
	require.Error(t, server.flushCollabTemplate(t.Context(), 9, "req-1234567890"))
}
