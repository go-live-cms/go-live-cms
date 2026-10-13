package api

import (
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
)

// TestRequireRoleMiddleware exercises requireRole in isolation on synthetic
// routes, covering the variadic role set, case-insensitivity, and the
// DB-lookup failure modes.
func TestRequireRoleMiddleware(t *testing.T) {
	user := randomUserNew()

	testCases := []struct {
		name           string
		allowedRoles   []string
		setupAuth      func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs     func(store *mockdb.MockStore)
		expectedStatus int
	}{
		{
			name:         "AdminPassesAdminOnly",
			allowedRoles: []string{RoleAdmin},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				admin := user
				admin.Role = RoleAdmin
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(admin, nil)
			},
			expectedStatus: http.StatusOK,
		},
		{
			name:         "EditorBlockedFromAdminOnly",
			allowedRoles: []string{RoleAdmin},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				editor := user
				editor.Role = RoleEditor
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(editor, nil)
			},
			expectedStatus: http.StatusForbidden,
		},
		{
			name:         "ContributorBlockedFromEditorRoutes",
			allowedRoles: []string{RoleAdmin, RoleEditor},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				contributor := user
				contributor.Role = RoleContributor
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(contributor, nil)
			},
			expectedStatus: http.StatusForbidden,
		},
		{
			name:         "EditorPassesEditorRoutes",
			allowedRoles: []string{RoleAdmin, RoleEditor},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				editor := user
				editor.Role = RoleEditor
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(editor, nil)
			},
			expectedStatus: http.StatusOK,
		},
		{
			name:         "RoleMatchIsCaseInsensitive",
			allowedRoles: []string{RoleAdmin},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				admin := user
				admin.Role = "Admin"
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(admin, nil)
			},
			expectedStatus: http.StatusOK,
		},
		{
			name:         "DeletedUserForbidden",
			allowedRoles: []string{RoleAdmin},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(db.User{}, sql.ErrNoRows)
			},
			expectedStatus: http.StatusForbidden,
		},
		{
			name:         "DatabaseErrorReturns500",
			allowedRoles: []string{RoleAdmin},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(db.User{}, errors.New("connection refused"))
			},
			expectedStatus: http.StatusInternalServerError,
		},
		{
			name:         "NoAuthorizationRejectedByAuthMiddleware",
			allowedRoles: []string{RoleAdmin},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth header
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Any()).
					Times(0)
			},
			expectedStatus: http.StatusUnauthorized,
		},
	}

	for i := range testCases {
		tc := testCases[i]

		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()

			store := mockdb.NewMockStore(ctrl)
			tc.buildStubs(store)

			server := newTestServer(t, store)
			server.router.GET(
				"/rbac-test",
				authMiddleware(server.tokenMaker),
				requireRole(server, tc.allowedRoles...),
				func(c *gin.Context) { c.Status(http.StatusOK) },
			)

			recorder := httptest.NewRecorder()
			request, err := http.NewRequest(http.MethodGet, "/rbac-test", nil)
			require.NoError(t, err)

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			require.Equal(t, tc.expectedStatus, recorder.Code)
		})
	}
}
