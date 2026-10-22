package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

const testRoleLookupSecret = "test-role-lookup-secret"

// TestInternalDocAccessAPI covers GET /internal/users/:id/access, the
// collab WS server's access check (#223, #135): shared-secret auth instead of a
// user token, the role read from the DB, and the password-change cutoff. An
// editor's access needs no post lookup; per-post cases are below.
func TestInternalDocAccessAPI(t *testing.T) {
	user := randomUserNew()
	user.ID = 42
	user.Role = RoleEditor
	user.PasswordChangedAt = time.Now().Add(-time.Hour).UTC()

	ticketIssuedAt := user.PasswordChangedAt.Add(10 * time.Minute).Unix()

	testCases := []struct {
		name          string
		path          string
		authorization string
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(t *testing.T, recorder *httptest.ResponseRecorder)
	}{
		{
			name:          "OK",
			path:          fmt.Sprintf("/internal/users/%d/access?doc=post-5&issued_at=%d", user.ID, ticketIssuedAt),
			authorization: "Bearer " + testRoleLookupSecret,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(user, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				var body struct {
					Role string `json:"role"`
				}
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
				require.Equal(t, RoleEditor, body.Role)
			},
		},
		{
			name:          "MissingSecret",
			path:          fmt.Sprintf("/internal/users/%d/access?doc=post-5&issued_at=%d", user.ID, ticketIssuedAt),
			authorization: "",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:          "WrongSecret",
			path:          fmt.Sprintf("/internal/users/%d/access?doc=post-5&issued_at=%d", user.ID, ticketIssuedAt),
			authorization: "Bearer not-the-secret",
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:          "InvalidID",
			path:          fmt.Sprintf("/internal/users/abc/access?doc=post-5&issued_at=%d", ticketIssuedAt),
			authorization: "Bearer " + testRoleLookupSecret,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:          "MissingIssuedAt",
			path:          fmt.Sprintf("/internal/users/%d/access?doc=post-5", user.ID),
			authorization: "Bearer " + testRoleLookupSecret,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name:          "UserNotFound",
			path:          fmt.Sprintf("/internal/users/%d/access?doc=post-5&issued_at=%d", user.ID, ticketIssuedAt),
			authorization: "Bearer " + testRoleLookupSecret,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(db.User{}, sql.ErrNoRows)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:          "IssuedBeforePasswordChange",
			path:          fmt.Sprintf("/internal/users/%d/access?doc=post-5&issued_at=%d", user.ID, user.PasswordChangedAt.Add(-time.Minute).Unix()),
			authorization: "Bearer " + testRoleLookupSecret,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(user, nil)
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:          "InternalError",
			path:          fmt.Sprintf("/internal/users/%d/access?doc=post-5&issued_at=%d", user.ID, ticketIssuedAt),
			authorization: "Bearer " + testRoleLookupSecret,
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(db.User{}, errors.New("db down"))
			},
			checkResponse: func(t *testing.T, recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			recorder := httptest.NewRecorder()

			request, err := http.NewRequest(http.MethodGet, tc.path, nil)
			require.NoError(t, err)
			if tc.authorization != "" {
				request.Header.Set(authorizationHeaderKey, tc.authorization)
			}

			server.internalRouter.ServeHTTP(recorder, request)
			tc.checkResponse(t, recorder)
		})
	}
}

// A user access token is not a substitute for the shared secret.
func TestInternalDocAccessRejectsUserToken(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetUser(gomock.Any(), gomock.Any()).Times(0)
	server := newTestServer(t, store)

	request, err := http.NewRequest(http.MethodGet, "/internal/users/1/access?doc=post-5&issued_at=1", nil)
	require.NoError(t, err)
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, 1, "someone", time.Minute)

	recorder := httptest.NewRecorder()
	server.internalRouter.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusUnauthorized, recorder.Code)
}

func TestNewServerRequiresRoleLookupSecret(t *testing.T) {
	server := newTestServer(t, nil)
	config := server.config
	config.RoleLookupSecret = "  "

	_, err := NewServer(config, nil)
	require.ErrorContains(t, err, "ROLE_LOOKUP_SECRET")
}

// The internal routes must not be reachable on the public listener at all,
// even with the right secret.
func TestInternalRoutesNotOnPublicRouter(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetUser(gomock.Any(), gomock.Any()).Times(0)
	server := newTestServer(t, store)

	for _, path := range []string{"/internal/users/1/access?doc=post-5&issued_at=1", "/api/v1/internal/users/1/access?doc=post-5&issued_at=1"} {
		request, err := http.NewRequest(http.MethodGet, path, nil)
		require.NoError(t, err)
		request.Header.Set(authorizationHeaderKey, "Bearer "+testRoleLookupSecret)

		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, request)
		require.Equal(t, http.StatusNotFound, recorder.Code, path)
	}
}

// Whitespace around the configured secret is trimmed once in NewServer, so the
// WS server (which trims its copy too) still matches.
func TestInternalSecretIsTrimmed(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	user := randomUserNew()
	user.ID = 9
	user.Role = RoleAdmin
	user.PasswordChangedAt = time.Now().Add(-time.Hour)

	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetUser(gomock.Any(), gomock.Eq(user.ID)).Times(1).Return(user, nil)

	config := newTestServer(t, nil).config
	config.RoleLookupSecret = "  " + testRoleLookupSecret + " \n"
	server, err := NewServer(config, store)
	require.NoError(t, err)

	request, err := http.NewRequest(http.MethodGet, fmt.Sprintf("/internal/users/%d/access?doc=post-5&issued_at=%d", user.ID, time.Now().Unix()), nil)
	require.NoError(t, err)
	request.Header.Set(authorizationHeaderKey, "Bearer "+testRoleLookupSecret)

	recorder := httptest.NewRecorder()
	server.internalRouter.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)
}

// The per-post half of the access check (#135): a contributor may open only
// their own post's collab doc; the owner comes from the DB.
func TestInternalDocAccessPerPost(t *testing.T) {
	contributor := randomUserNew()
	contributor.ID = 50
	contributor.Role = RoleContributor
	contributor.PasswordChangedAt = time.Now().Add(-time.Hour).UTC()
	issuedAt := time.Now().Unix()

	testCases := []struct {
		name        string
		doc         string
		post        db.Post
		postErr     error
		wantStatus  int
		wantCanEdit bool
	}{
		{name: "OwnPost", doc: "post-7", post: db.Post{ID: 7, UserID: contributor.ID, PostStatus: "draft"}, wantStatus: http.StatusOK, wantCanEdit: true},
		{name: "OwnPublishedPost", doc: "post-7", post: db.Post{ID: 7, UserID: contributor.ID, PostStatus: "published"}, wantStatus: http.StatusOK, wantCanEdit: true},
		{name: "SomeoneElsesPost", doc: "post-7", post: db.Post{ID: 7, UserID: contributor.ID + 1}, wantStatus: http.StatusOK, wantCanEdit: false},
		{name: "MissingPost", doc: "post-7", postErr: sql.ErrNoRows, wantStatus: http.StatusNotFound},
		{name: "PostLookupFails", doc: "post-7", postErr: errors.New("db down"), wantStatus: http.StatusInternalServerError},
		{name: "InvalidDoc", doc: "settings", wantStatus: http.StatusBadRequest},
		{name: "MissingDoc", doc: "", wantStatus: http.StatusBadRequest},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().GetUser(gomock.Any(), contributor.ID).Return(contributor, nil).AnyTimes()
			store.EXPECT().GetPost(gomock.Any(), int64(7)).Return(tc.post, tc.postErr).AnyTimes()

			server := newTestServer(t, store)
			request, err := http.NewRequest(http.MethodGet,
				fmt.Sprintf("/internal/users/%d/access?doc=%s&issued_at=%d", contributor.ID, tc.doc, issuedAt), nil)
			require.NoError(t, err)
			request.Header.Set(authorizationHeaderKey, "Bearer "+testRoleLookupSecret)

			recorder := httptest.NewRecorder()
			server.internalRouter.ServeHTTP(recorder, request)
			require.Equal(t, tc.wantStatus, recorder.Code, recorder.Body.String())
			if tc.wantStatus == http.StatusOK {
				var body struct {
					Role    string `json:"role"`
					CanEdit bool   `json:"can_edit"`
				}
				require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
				require.Equal(t, RoleContributor, body.Role)
				require.Equal(t, tc.wantCanEdit, body.CanEdit)
			}
		})
	}
}

// Moderators may edit any post, so their check never loads one.
func TestInternalDocAccessModeratorSkipsPostLookup(t *testing.T) {
	for _, role := range []string{RoleAdmin, RoleEditor} {
		t.Run(role, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			user := randomUserNew()
			user.ID = 60
			user.Role = role
			user.PasswordChangedAt = time.Now().Add(-time.Hour).UTC()

			store := mockdb.NewMockStore(ctrl)
			store.EXPECT().GetUser(gomock.Any(), user.ID).Return(user, nil).Times(1)
			store.EXPECT().GetPost(gomock.Any(), gomock.Any()).Times(0)

			server := newTestServer(t, store)
			request, err := http.NewRequest(http.MethodGet,
				fmt.Sprintf("/internal/users/%d/access?doc=post-7&issued_at=%d", user.ID, time.Now().Unix()), nil)
			require.NoError(t, err)
			request.Header.Set(authorizationHeaderKey, "Bearer "+testRoleLookupSecret)

			recorder := httptest.NewRecorder()
			server.internalRouter.ServeHTTP(recorder, request)
			require.Equal(t, http.StatusOK, recorder.Code)
			require.JSONEq(t, fmt.Sprintf(`{"role":%q,"can_edit":true}`, role), recorder.Body.String())
		})
	}
}