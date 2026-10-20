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

// TestInternalUserRoleAPI covers GET /api/v1/internal/users/:id/role, the
// collab WS server's role lookup (#223): shared-secret auth instead of a user
// token, the role read from the DB, and the password-change cutoff.
func TestInternalUserRoleAPI(t *testing.T) {
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
			path:          fmt.Sprintf("/api/v1/internal/users/%d/role?issued_at=%d", user.ID, ticketIssuedAt),
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
			path:          fmt.Sprintf("/api/v1/internal/users/%d/role?issued_at=%d", user.ID, ticketIssuedAt),
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
			path:          fmt.Sprintf("/api/v1/internal/users/%d/role?issued_at=%d", user.ID, ticketIssuedAt),
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
			path:          fmt.Sprintf("/api/v1/internal/users/abc/role?issued_at=%d", ticketIssuedAt),
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
			path:          fmt.Sprintf("/api/v1/internal/users/%d/role", user.ID),
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
			path:          fmt.Sprintf("/api/v1/internal/users/%d/role?issued_at=%d", user.ID, ticketIssuedAt),
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
			path:          fmt.Sprintf("/api/v1/internal/users/%d/role?issued_at=%d", user.ID, user.PasswordChangedAt.Add(-time.Minute).Unix()),
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
			path:          fmt.Sprintf("/api/v1/internal/users/%d/role?issued_at=%d", user.ID, ticketIssuedAt),
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

			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(t, recorder)
		})
	}
}

// A user access token is not a substitute for the shared secret.
func TestInternalUserRoleRejectsUserToken(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()

	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().GetUser(gomock.Any(), gomock.Any()).Times(0)
	server := newTestServer(t, store)

	request, err := http.NewRequest(http.MethodGet, "/api/v1/internal/users/1/role?issued_at=1", nil)
	require.NoError(t, err)
	addAuthorization(t, request, server.tokenMaker, authorizationTypeBearer, 1, "someone", time.Minute)

	recorder := httptest.NewRecorder()
	server.router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusUnauthorized, recorder.Code)
}

func TestNewServerRequiresRoleLookupSecret(t *testing.T) {
	server := newTestServer(t, nil)
	config := server.config
	config.RoleLookupSecret = "  "

	_, err := NewServer(config, nil)
	require.ErrorContains(t, err, "ROLE_LOOKUP_SECRET")
}
