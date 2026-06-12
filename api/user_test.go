package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/brianvoe/gofakeit/v6"
	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/token"
	"github.com/go-live-cms/go-live-cms/util"
)

func randomUserNew() db.User {
	gofakeit.Seed(0)
	return db.User{
		ID:                gofakeit.Int64(),
		Username:          gofakeit.Username(),
		FullName:          gofakeit.Name(),
		Email:             gofakeit.Email(),
		HashedPassword:    gofakeit.Password(true, true, true, true, false, 12),
		PasswordChangedAt: gofakeit.Date(),
		CreatedAt:         gofakeit.Date(),
		Role:              "contributor",
	}
}

func TestCreateUserAPI(t *testing.T) {
	user := randomUserNew()
	adminUser := randomUserNew()
	adminUser.Role = "admin"
	password := "password123"

	testCases := []struct {
		name          string
		body          gin.H
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			body: gin.H{
				"username":  user.Username,
				"email":     user.Email,
				"full_name": user.FullName,
				"password":  password,
				"role":      user.Role,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				arg := db.CreateUserParams{
					Username: user.Username,
					Email:    user.Email,
					FullName: user.FullName,
					Role:     user.Role,
				}
				store.EXPECT().
					CreateUser(gomock.Any(), EqCreateUserParams(arg, password)).
					Times(1).
					Return(user, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusCreated, recorder.Code)
				requireBodyMatchUser(t, recorder.Body.String(), user)
			},
		},
		{
			name: "NoAuthorization",
			body: gin.H{
				"username":  user.Username,
				"email":     user.Email,
				"full_name": user.FullName,
				"password":  password,
				"role":      user.Role,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// no auth
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					CreateUser(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "DuplicateUser",
			body: gin.H{
				"username":  user.Username,
				"email":     user.Email,
				"full_name": user.FullName,
				"password":  password,
				"role":      user.Role,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				store.EXPECT().
					CreateUser(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.User{}, fmt.Errorf("duplicate key value violates unique constraint"))
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
			},
		},
		{
			name: "InvalidEmail",
			body: gin.H{
				"username":  user.Username,
				"email":     "invalid-email",
				"full_name": user.FullName,
				"password":  password,
				"role":      user.Role,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				store.EXPECT().
					CreateUser(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "ShortPassword",
			body: gin.H{
				"username":  user.Username,
				"email":     user.Email,
				"full_name": user.FullName,
				"password":  "123",
				"role":      user.Role,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				store.EXPECT().
					CreateUser(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
		},
		{
			name: "InvalidRole",
			body: gin.H{
				"username":  user.Username,
				"email":     user.Email,
				"full_name": user.FullName,
				"password":  password,
				"role":      "invalid_role",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				store.EXPECT().
					CreateUser(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
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
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := "/api/v1/users"
			request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetUserAPI(t *testing.T) {
	user := randomUserNew()
	adminUser := randomUserNew()
	adminUser.Role = "admin"
	adminUser.ID = user.ID + 100

	testCases := []struct {
		name          string
		userID        int64
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK",
			userID: user.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(user, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchUser(t, recorder.Body.String(), user)
			},
		},
		{
			name:   "NotFound",
			userID: user.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(db.User{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "InternalError",
			userID: user.ID,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(db.User{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:   "InvalidID",
			userID: 0,
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
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
			recorder := httptest.NewRecorder()

			var url string
			if tc.name == "InvalidID" {
				url = "/api/v1/users/id/invalid_id"
			} else {
				url = fmt.Sprintf("/api/v1/users/id/%d", tc.userID)
			}

			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestListUsersAPI(t *testing.T) {
	n := 5
	users := make([]db.User, n)
	for i := range n {
		users[i] = randomUserNew()
		users[i].ID = int64(i + 1)
	}
	adminUser := randomUserNew()
	adminUser.Role = "admin"
	adminUser.ID = 999

	testCases := []struct {
		name          string
		query         string
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:  "OK",
			query: "?limit=5&offset=0",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				store.EXPECT().
					ListUsers(gomock.Any(), db.ListUsersParams{
						SortBy:      "date_desc",
						LimitCount:  5,
						OffsetCount: 0,
					}).
					Times(1).
					Return(users, nil)
				store.EXPECT().
					CountTotalUsers(gomock.Any()).
					Times(1).
					Return(int64(100), nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchUsers(t, recorder.Body.String(), users, int64(100))
			},
		},
		{
			name:  "InternalError",
			query: "?limit=5&offset=0",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				store.EXPECT().
					ListUsers(gomock.Any(), gomock.Any()).
					Times(1).
					Return([]db.User{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:  "InvalidLimit",
			query: "?limit=0",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				store.EXPECT().
					ListUsers(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusBadRequest, recorder.Code)
			},
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
			recorder := httptest.NewRecorder()

			url := "/api/v1/users" + tc.query
			request, err := http.NewRequest(http.MethodGet, url, nil)
			require.NoError(t, err)

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestUpdateUserAPI(t *testing.T) {
	user := randomUserNew()
	newUsername := gofakeit.Username()
	newEmail := gofakeit.Email()

	testCases := []struct {
		name          string
		userID        int64
		body          gin.H
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK_SelfUpdate",
			userID: user.ID,
			body: gin.H{
				"username": newUsername,
				"email":    newEmail,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				// Called twice: caller role check + existing-user fetch
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(2).
					Return(user, nil)

				updatedUser := user
				updatedUser.Username = newUsername
				updatedUser.Email = newEmail

				store.EXPECT().
					UpdateUserTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.UpdateUserTxResult{User: updatedUser}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:   "OK_AdminUpdatesOtherUserRole",
			userID: user.ID,
			body: gin.H{
				"role": "editor",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID+50, "admin_caller", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				adminCaller := randomUserNew()
				adminCaller.ID = user.ID + 50
				adminCaller.Role = "admin"
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminCaller.ID)).
					Times(1).
					Return(adminCaller, nil)
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(user, nil)

				updatedUser := user
				updatedUser.Role = "editor"
				store.EXPECT().
					UpdateUserTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.UpdateUserTxResult{User: updatedUser}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:   "ConflictDemoteLastAdmin",
			userID: user.ID + 50,
			body: gin.H{
				"role": "contributor",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID+50, "admin_caller", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				adminCaller := randomUserNew()
				adminCaller.ID = user.ID + 50
				adminCaller.Role = "admin"
				// Caller check + target fetch hit the same (sole admin) row
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminCaller.ID)).
					Times(2).
					Return(adminCaller, nil)
				store.EXPECT().
					CountUsersByRole(gomock.Any(), gomock.Eq(RoleAdmin)).
					Times(1).
					Return(int64(1), nil)
				store.EXPECT().
					UpdateUserTx(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
			},
		},
		{
			name:   "InternalErrorAdminCountOnDemote",
			userID: user.ID + 50,
			body: gin.H{
				"role": "contributor",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID+50, "admin_caller", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				adminCaller := randomUserNew()
				adminCaller.ID = user.ID + 50
				adminCaller.Role = RoleAdmin
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminCaller.ID)).
					Times(2).
					Return(adminCaller, nil)
				store.EXPECT().
					CountUsersByRole(gomock.Any(), gomock.Eq(RoleAdmin)).
					Times(1).
					Return(int64(0), fmt.Errorf("connection refused"))
				store.EXPECT().
					UpdateUserTx(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:   "OK_DemoteAdminWhenAnotherExists",
			userID: user.ID + 51,
			body: gin.H{
				"role": "editor",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID+50, "admin_caller", time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				adminCaller := randomUserNew()
				adminCaller.ID = user.ID + 50
				adminCaller.Role = "admin"
				otherAdmin := randomUserNew()
				otherAdmin.ID = user.ID + 51
				otherAdmin.Role = "admin"
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminCaller.ID)).
					Times(1).
					Return(adminCaller, nil)
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(otherAdmin.ID)).
					Times(1).
					Return(otherAdmin, nil)
				store.EXPECT().
					CountUsersByRole(gomock.Any(), gomock.Eq(RoleAdmin)).
					Times(1).
					Return(int64(2), nil)

				demoted := otherAdmin
				demoted.Role = "editor"
				store.EXPECT().
					UpdateUserTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.UpdateUserTxResult{User: demoted}, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:   "ForbiddenUpdateOtherUser",
			userID: user.ID + 99,
			body: gin.H{
				"username": newUsername,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				// Non-admin caller targeting someone else: blocked after the
				// caller role check, before any target fetch or update.
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(user, nil)
				store.EXPECT().
					UpdateUserTx(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:   "ForbiddenSelfRoleChange",
			userID: user.ID,
			body: gin.H{
				"role": "admin",
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				// The privilege-escalation hole: a contributor promoting
				// themselves must get 403, never reaching the update.
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(user, nil)
				store.EXPECT().
					UpdateUserTx(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:   "NoAuthorization",
			userID: user.ID,
			body: gin.H{
				"username": newUsername,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name:   "UserNotFound",
			userID: user.ID,
			body: gin.H{
				"username": newUsername,
			},
			buildStubs: func(store *mockdb.MockStore) {
				// First call (caller role check) succeeds; second call
				// (target fetch) misses. gomock consumes identical
				// matchers in declaration order.
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(user, nil)
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(db.User{}, sql.ErrNoRows)
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "DuplicateUsername",
			userID: user.ID,
			body: gin.H{
				"username": newUsername,
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(2).
					Return(user, nil)

				store.EXPECT().
					UpdateUserTx(gomock.Any(), gomock.Any()).
					Times(1).
					Return(db.UpdateUserTxResult{}, fmt.Errorf("username already exists"))
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
			},
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
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := fmt.Sprintf("/api/v1/users/%d", tc.userID)
			request, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestDeleteUserAPI(t *testing.T) {
	user := randomUserNew()
	adminUser := randomUserNew()
	adminUser.ID = user.ID + 1
	adminUser.Role = "admin"

	testCases := []struct {
		name          string
		userID        int64
		body          gin.H
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name:   "OK_Nuclear",
			userID: user.ID,
			body:   gin.H{},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				// requireSiteAdmin middleware looks up the caller
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(user, nil)
				store.EXPECT().
					DeleteUserTx(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:   "OK_WithTransfer",
			userID: user.ID,
			body: gin.H{
				"transfer_to_id": adminUser.ID,
			},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(user, nil)
				store.EXPECT().
					DeleteUserWithTransferTx(gomock.Any(), db.DeleteUserWithTransferTxParams{
						UserID:       user.ID,
						TransferToID: adminUser.ID,
					}).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:   "UserNotFound",
			userID: user.ID,
			body:   gin.H{},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(db.User{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name:   "ConflictDeleteLastAdmin",
			userID: adminUser.ID,
			body:   gin.H{},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				// Middleware caller check + handler target fetch on the sole admin
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(2).
					Return(adminUser, nil)
				store.EXPECT().
					CountUsersByRole(gomock.Any(), gomock.Eq(RoleAdmin)).
					Times(1).
					Return(int64(1), nil)
				store.EXPECT().
					DeleteUserTx(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusConflict, recorder.Code)
			},
		},
		{
			name:   "InternalErrorAdminCountOnDelete",
			userID: adminUser.ID,
			body:   gin.H{},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(2).
					Return(adminUser, nil)
				store.EXPECT().
					CountUsersByRole(gomock.Any(), gomock.Eq(RoleAdmin)).
					Times(1).
					Return(int64(0), fmt.Errorf("connection refused"))
				store.EXPECT().
					DeleteUserTx(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusInternalServerError, recorder.Code)
			},
		},
		{
			name:   "OK_DeleteAdminWhenAnotherExists",
			userID: adminUser.ID + 1,
			body:   gin.H{},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, adminUser.ID, adminUser.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				secondAdmin := randomUserNew()
				secondAdmin.ID = adminUser.ID + 1
				secondAdmin.Role = "admin"
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(adminUser.ID)).
					Times(1).
					Return(adminUser, nil)
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(secondAdmin.ID)).
					Times(1).
					Return(secondAdmin, nil)
				store.EXPECT().
					CountUsersByRole(gomock.Any(), gomock.Eq(RoleAdmin)).
					Times(1).
					Return(int64(2), nil)
				store.EXPECT().
					DeleteUserTx(gomock.Any(), gomock.Eq(secondAdmin.ID)).
					Times(1).
					Return(nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
			},
		},
		{
			name:   "ForbiddenNonAdmin",
			userID: adminUser.ID,
			body:   gin.H{},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				// Contributor caller is rejected by requireSiteAdmin
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Eq(user.ID)).
					Times(1).
					Return(user, nil)
				store.EXPECT().
					DeleteUserTx(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusForbidden, recorder.Code)
			},
		},
		{
			name:   "NoAuthorization",
			userID: user.ID,
			body:   gin.H{},
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				// No authorization
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), gomock.Any()).
					Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
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
			recorder := httptest.NewRecorder()

			data, err := json.Marshal(tc.body)
			require.NoError(t, err)

			url := fmt.Sprintf("/api/v1/users/%d", tc.userID)
			request, err := http.NewRequest(http.MethodDelete, url, bytes.NewReader(data))
			require.NoError(t, err)
			request.Header.Set("Content-Type", "application/json")

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func TestGetMeAPI(t *testing.T) {
	user := randomUserNew()

	testCases := []struct {
		name          string
		setupAuth     func(t *testing.T, request *http.Request, tokenMaker token.Maker)
		buildStubs    func(store *mockdb.MockStore)
		checkResponse func(recorder *httptest.ResponseRecorder)
	}{
		{
			name: "OK",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), user.ID).
					Times(1).
					Return(user, nil)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusOK, recorder.Code)
				requireBodyMatchUser(t, recorder.Body.String(), user)
			},
		},
		{
			name:      "NoAuthorization",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().GetUser(gomock.Any(), gomock.Any()).Times(0)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusUnauthorized, recorder.Code)
			},
		},
		{
			name: "UserNotFound",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), user.ID).
					Times(1).
					Return(db.User{}, sql.ErrNoRows)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
				require.Equal(t, http.StatusNotFound, recorder.Code)
			},
		},
		{
			name: "InternalError",
			setupAuth: func(t *testing.T, request *http.Request, tokenMaker token.Maker) {
				addAuthorization(t, request, tokenMaker, authorizationTypeBearer, user.ID, user.Username, time.Minute)
			},
			buildStubs: func(store *mockdb.MockStore) {
				store.EXPECT().
					GetUser(gomock.Any(), user.ID).
					Times(1).
					Return(db.User{}, sql.ErrConnDone)
			},
			checkResponse: func(recorder *httptest.ResponseRecorder) {
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

			request, err := http.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
			require.NoError(t, err)

			tc.setupAuth(t, request, server.tokenMaker)
			server.router.ServeHTTP(recorder, request)
			tc.checkResponse(recorder)
		})
	}
}

func requireBodyMatchUser(t *testing.T, body string, user db.User) {
	var response struct {
		User PrivateUserResponse `json:"user"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, user.ID, response.User.ID)
	require.Equal(t, user.Username, response.User.Username)
	require.Equal(t, user.Email, response.User.Email)
	require.Equal(t, user.FullName, response.User.FullName)
	require.Equal(t, user.Role, response.User.Role)

}

func requireBodyMatchUsers(t *testing.T, body string, users []db.User, expectedTotal int64) {
	var response struct {
		Users []PrivateUserResponse `json:"users"`
		Meta  struct {
			Total  int64 `json:"total"`
			Limit  int   `json:"limit"`
			Offset int   `json:"offset"`
			Count  int   `json:"count"`
		} `json:"meta"`
	}
	err := json.Unmarshal([]byte(body), &response)
	require.NoError(t, err)

	require.Equal(t, len(users), len(response.Users))
	require.Equal(t, expectedTotal, response.Meta.Total)
	for i, user := range users {
		require.Equal(t, user.ID, response.Users[i].ID)
		require.Equal(t, user.Username, response.Users[i].Username)
		require.Equal(t, user.Email, response.Users[i].Email)
		require.Equal(t, user.FullName, response.Users[i].FullName)
		require.Equal(t, user.Role, response.Users[i].Role)
	}
}

type eqCreateUserParamsMatcher struct {
	expected db.CreateUserParams
	password string
}

func (e eqCreateUserParamsMatcher) Matches(x interface{}) bool {
	arg, ok := x.(db.CreateUserParams)
	if !ok {
		return false
	}

	err := util.CheckPassword(e.password, arg.HashedPassword)
	if err != nil {
		return false
	}

	return arg.Username == e.expected.Username &&
		arg.Email == e.expected.Email &&
		arg.FullName == e.expected.FullName &&
		arg.Role == e.expected.Role
}

func (e eqCreateUserParamsMatcher) String() string {
	return "matches CreateUserParams with password validation"
}

func EqCreateUserParams(expected db.CreateUserParams, password string) gomock.Matcher {
	return eqCreateUserParamsMatcher{expected, password}
}
